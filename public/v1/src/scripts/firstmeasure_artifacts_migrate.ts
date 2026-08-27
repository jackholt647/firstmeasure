import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";
import { ArtifactSyncLedger, type ArtifactSyncRunSummary } from "../migration/artifact_sync_ledger.js";
import {
  PRODUCTION_CLONE_CONFIRMATION,
  assertCloneTargetContract,
  parseDataEnvironment
} from "../migration/clone_contract.js";
import {
  headProjectArtifact,
  isSpacesArtifactStorageEnabled,
  listProjectArtifactInventory,
  projectArtifactKey,
  putProjectArtifactFile,
  validateArtifactStorageConfiguration
} from "../storage/project_artifacts.js";

type ArtifactFile = {
  projectId: string;
  relativePath: string;
  absolutePath: string;
  objectKey: string;
  size: number;
  mtimeMs: number;
};

type Options = {
  apply: boolean;
  verify: boolean;
  allowEmptySource: boolean;
  concurrency: number;
  sourceRoot: string;
  sourceId: string;
  stateFile: string;
  reportPath: string;
  targetEnvironment: ReturnType<typeof parseDataEnvironment>;
  productionConfirmation: string;
};

const options = parseOptions(process.argv.slice(2));

async function main() {
  if (!isSpacesArtifactStorageEnabled()) {
    throw new Error("Set FIRSTMEASURE_ARTIFACT_STORAGE=spaces before running artifact migration.");
  }
  validateArtifactStorageConfiguration();
  assertCloneTargetContract({
    targetEnvironment: options.targetEnvironment,
    configuredEnvironment: env.dataEnvironment,
    configuredEnvironmentExplicit: env.dataEnvironmentExplicit,
    spacesPrefix: env.spacesPrefix,
    productionConfirmation: options.productionConfirmation,
    writeOperation: options.apply
  });
  if (options.apply && !options.sourceId) {
    throw new Error("--source-id is required for an applied artifact synchronization.");
  }

  const remoteFiles = await listProjectArtifactInventory();
  const remoteByKey = new Map(remoteFiles.map((file) => [file.key, { file, sourceSeen: false }]));
  const runId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const summary: ArtifactSyncRunSummary = {
    discovered: 0,
    uploaded: 0,
    skipped: 0,
    verified: 0,
    failed: 0,
    orphaned: 0,
    sourceBytes: 0,
    uploadedBytes: 0
  };

  // Keep the source walk memory-bounded. Large legacy volumes can contain
  // millions of files, so retaining one object per file can exhaust the Node
  // heap before synchronization begins. The first streaming pass produces the
  // exact plan; applied runs make a second streaming pass to do the work.
  for await (const file of iterateArtifacts(options.sourceRoot, options.allowEmptySource)) {
    summary.discovered += 1;
    summary.sourceBytes += file.size;
    const remoteEntry = remoteByKey.get(file.objectKey);
    if (remoteEntry) remoteEntry.sourceSeen = true;
    if (!options.apply) {
      if (remoteEntry?.file.size === file.size) summary.skipped += 1;
      else {
        summary.uploaded += 1;
        summary.uploadedBytes += file.size;
      }
    }
  }
  if (!summary.discovered && options.apply && !options.allowEmptySource) {
    throw new Error(`No project artifacts were found under '${options.sourceRoot}'. Refusing an empty applied synchronization.`);
  }
  for (const entry of remoteByKey.values()) {
    if (!entry.sourceSeen) summary.orphaned += 1;
  }

  console.info(JSON.stringify({
    mode: options.apply ? "apply" : "dry-run",
    run_id: runId,
    source_id: options.sourceId || null,
    source_root: options.sourceRoot,
    target_environment: options.targetEnvironment,
    spaces_bucket: env.spacesBucket,
    spaces_prefix: env.spacesPrefix,
    files: summary.discovered,
    bytes: summary.sourceBytes,
    existing_objects: remoteFiles.length,
    orphaned_objects: summary.orphaned,
    concurrency: options.concurrency
  }));

  if (!options.apply) {
    await writeReport(options.reportPath, { run_id: runId, mode: "dry-run", summary });
    console.info(JSON.stringify({ ok: true, mode: "dry-run", summary }));
    return;
  }

  const ledger = new ArtifactSyncLedger(options.stateFile, options.targetEnvironment);
  ledger.startRun(runId, options.sourceId, options.sourceRoot);
  try {
    let completed = 0;
    await mapWithConcurrency(iterateArtifacts(options.sourceRoot, options.allowEmptySource), options.concurrency, async (file) => {
      try {
        const remote = remoteByKey.get(file.objectKey)?.file;
        const previous = ledger.get(file.objectKey);
        const unchanged = previous
          && previous.status === "verified"
          && previous.source_size === file.size
          && previous.source_mtime_ms === Math.floor(file.mtimeMs)
          && remote?.size === file.size
          && remote.etag === previous.remote_etag;

        if (unchanged) {
          summary.skipped += 1;
          summary.verified += 1;
          ledger.save({ ...previous, last_seen_run: runId });
        } else {
          const sourceSha256 = await sha256File(file.absolutePath);
          await assertSourceFileUnchanged(file);
          const remoteHead = remote?.size === file.size
            ? await headProjectArtifact(file.projectId, file.relativePath)
            : null;
          const remoteMatches = remoteHead?.exists
            && remoteHead.size === file.size
            && remoteHead.metadata["source-sha256"] === sourceSha256
            && remoteHead.checksum_sha256 === sha256Base64(sourceSha256);

          if (remoteMatches) {
            summary.skipped += 1;
            summary.verified += 1;
            ledger.save({
              object_key: file.objectKey,
              source_size: file.size,
              source_mtime_ms: Math.floor(file.mtimeMs),
              source_sha256: sourceSha256,
              remote_size: remoteHead.size,
              remote_etag: remoteHead.etag,
              status: "verified",
              last_seen_run: runId,
              verified_at: new Date().toISOString()
            });
          } else {
            await putProjectArtifactFile(file.projectId, file.relativePath, file.absolutePath, {
              size: file.size,
              sourceSha256,
              sourceMtimeMs: file.mtimeMs,
              syncRunId: runId
            });
            const stored = options.verify
              ? await headProjectArtifact(file.projectId, file.relativePath)
              : {
                exists: true,
                size: file.size,
                etag: "",
                checksum_sha256: sha256Base64(sourceSha256),
                metadata: { "source-sha256": sourceSha256 }
              };
            if (
              !stored.exists
              || stored.size !== file.size
              || stored.metadata["source-sha256"] !== sourceSha256
              || stored.checksum_sha256 !== sha256Base64(sourceSha256)
            ) {
              throw new Error(`Verification failed for ${file.projectId}/${file.relativePath}.`);
            }
            summary.uploaded += 1;
            summary.uploadedBytes += file.size;
            summary.verified += 1;
            ledger.save({
              object_key: file.objectKey,
              source_size: file.size,
              source_mtime_ms: Math.floor(file.mtimeMs),
              source_sha256: sourceSha256,
              remote_size: stored.size,
              remote_etag: stored.etag,
              status: "verified",
              last_seen_run: runId,
              verified_at: new Date().toISOString()
            });
          }
        }
      } catch (error) {
        summary.failed += 1;
        throw error;
      } finally {
        completed += 1;
        if (completed % 100 === 0 || completed === summary.discovered) {
          console.info(JSON.stringify({
            progress: completed,
            total: summary.discovered,
            uploaded: summary.uploaded,
            skipped: summary.skipped,
            failed: summary.failed,
            uploaded_bytes: summary.uploadedBytes
          }));
        }
      }
    });
    ledger.finishRun(runId, "complete", summary);
    await writeReport(options.reportPath, { run_id: runId, mode: "apply", source_id: options.sourceId, summary });
    console.info(JSON.stringify({ ok: true, run_id: runId, summary }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ledger.finishRun(runId, "failed", summary, message);
    await writeReport(options.reportPath, { run_id: runId, mode: "apply", source_id: options.sourceId, summary, error: message });
    throw error;
  } finally {
    ledger.close();
  }
}

async function* iterateArtifacts(projectsRoot: string, allowEmptySource: boolean): AsyncGenerator<ArtifactFile> {
  const rootInfo = await stat(projectsRoot).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    if (allowEmptySource) return;
    throw new Error(`Project artifact source does not exist: ${projectsRoot}`);
  }
  const projectEntries = await readdir(projectsRoot, { withFileTypes: true });
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectId = projectEntry.name;
    const projectRoot = path.join(projectsRoot, projectId);
    yield* walk(projectRoot, "", projectId);
  }
}

async function* walk(root: string, relativeRoot: string, projectId: string): AsyncGenerator<ArtifactFile> {
  const entries = await readdir(path.join(root, relativeRoot), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!relativeRoot && entry.isDirectory() && ["manifest_backups", "_thumbnails"].includes(entry.name)) continue;
    if (!relativeRoot && entry.isFile() && entry.name === "manifest.json") continue;
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (entry.isDirectory()) {
      yield* walk(root, relativePath, projectId);
      continue;
    }
    if (!entry.isFile()) continue;
    const information = await stat(absolutePath);
    yield {
      projectId,
      relativePath,
      absolutePath,
      objectKey: projectArtifactKey(projectId, relativePath),
      size: information.size,
      mtimeMs: information.mtimeMs
    };
  }
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sha256Base64(sha256Hex: string) {
  return Buffer.from(sha256Hex, "hex").toString("base64");
}

async function assertSourceFileUnchanged(file: ArtifactFile) {
  const current = await stat(file.absolutePath);
  if (current.size !== file.size || Math.floor(current.mtimeMs) !== Math.floor(file.mtimeMs)) {
    throw new Error(`Source file changed during synchronization: ${file.absolutePath}`);
  }
}

async function mapWithConcurrency<T>(values: AsyncIterable<T>, limit: number, operation: (value: T) => Promise<void>) {
  const active = new Set<Promise<void>>();
  try {
    for await (const value of values) {
      let task!: Promise<void>;
      task = operation(value).finally(() => active.delete(task));
      active.add(task);
      if (active.size >= limit) await Promise.race(active);
    }
    await Promise.all(active);
  } catch (error) {
    await Promise.allSettled(active);
    throw error;
  }
}

function parseOptions(argv: string[]): Options {
  const argument = (name: string, fallback = "") => {
    const index = argv.indexOf(name);
    return index >= 0 ? String(argv[index + 1] ?? fallback) : fallback;
  };
  const integerArgument = (name: string, fallback: number, minimum: number, maximum: number) => {
    const parsed = Number(argument(name, String(fallback)));
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return parsed;
  };
  const sourceStorageRoot = path.resolve(argument("--source-root", env.firstmeasureStorageRoot));
  return {
    apply: argv.includes("--apply"),
    verify: argv.includes("--verify"),
    allowEmptySource: argv.includes("--allow-empty-source"),
    concurrency: integerArgument("--concurrency", 4, 1, 32),
    sourceRoot: path.basename(sourceStorageRoot) === "projects" ? sourceStorageRoot : path.join(sourceStorageRoot, "projects"),
    sourceId: argument("--source-id"),
    stateFile: path.resolve(argument("--state-file", env.cloneSyncStatePath)),
    reportPath: argument("--report") ? path.resolve(argument("--report")) : "",
    targetEnvironment: parseDataEnvironment(argument("--target-environment", env.dataEnvironment)),
    productionConfirmation: argument("--confirm-production")
  };
}

async function writeReport(reportPath: string, report: Record<string, unknown>) {
  if (!reportPath) return;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (options.targetEnvironment === "production" && !options.productionConfirmation) {
    process.stderr.write(`Production confirmation phrase: ${PRODUCTION_CLONE_CONFIRMATION}\n`);
  }
  process.exitCode = 1;
});
