import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";
import {
  getProjectArtifact,
  isSpacesArtifactStorageEnabled,
  putProjectArtifact,
  validateArtifactStorageConfiguration
} from "../storage/project_artifacts.js";

type ArtifactFile = {
  projectId: string;
  relativePath: string;
  absolutePath: string;
  size: number;
};

const apply = process.argv.includes("--apply");
const verify = process.argv.includes("--verify");
const concurrency = integerArgument("--concurrency", 4, 1, 32);
const sourceRoot = path.resolve(argument("--source-root", env.firstmeasureStorageRoot), "projects");

async function main() {
  if (!isSpacesArtifactStorageEnabled()) {
    throw new Error("Set FIRSTMEASURE_ARTIFACT_STORAGE=spaces before running artifact migration.");
  }
  validateArtifactStorageConfiguration();

  const files = await discoverArtifacts(sourceRoot);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.info(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    source_root: sourceRoot,
    files: files.length,
    bytes: totalBytes,
    concurrency
  }));
  if (!apply) return;

  let completed = 0;
  let uploadedBytes = 0;
  await mapWithConcurrency(files, concurrency, async (file) => {
    const content = await readFile(file.absolutePath);
    await putProjectArtifact(file.projectId, file.relativePath, content);
    if (verify) {
      const stored = await getProjectArtifact(file.projectId, file.relativePath);
      if (!stored || stored.length !== content.length) {
        throw new Error(`Verification failed for ${file.projectId}/${file.relativePath}.`);
      }
    }
    completed += 1;
    uploadedBytes += file.size;
    if (completed % 100 === 0 || completed === files.length) {
      console.info(JSON.stringify({ progress: completed, total: files.length, uploaded_bytes: uploadedBytes }));
    }
  });

  console.info(JSON.stringify({ ok: true, uploaded: completed, uploaded_bytes: uploadedBytes, verified: verify }));
}

async function discoverArtifacts(projectsRoot: string) {
  const projectEntries = await readdir(projectsRoot, { withFileTypes: true });
  const files: ArtifactFile[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectId = projectEntry.name;
    const projectRoot = path.join(projectsRoot, projectId);
    await walk(projectRoot, "", projectId, files);
  }
  return files;
}

async function walk(root: string, relativeRoot: string, projectId: string, files: ArtifactFile[]) {
  const entries = await readdir(path.join(root, relativeRoot), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (entry.isDirectory()) {
      await walk(root, relativePath, projectId, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({ projectId, relativePath, absolutePath, size: (await stat(absolutePath)).size });
  }
}

async function mapWithConcurrency<T>(values: T[], limit: number, operation: (value: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      await operation(values[index]!);
    }
  }));
}

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? fallback) : fallback;
}

function integerArgument(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(argument(name, String(fallback)));
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
