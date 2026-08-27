import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";
import {
  PRODUCTION_CLONE_CONFIRMATION,
  assertCloneTargetContract,
  parseDataEnvironment
} from "../migration/clone_contract.js";
import { closePostgresPools, queryPostgres, withPostgresTransaction } from "../database/postgres.js";

type CloneProfile = "development-clone" | "cutover";
type Options = {
  apply: boolean;
  verify: boolean;
  allowExistingTarget: boolean;
  allowEmptySource: boolean;
  confirmReadOnlySource: boolean;
  concurrency: number;
  sourceStorageRoot: string;
  sourceId: string;
  targetEnvironment: ReturnType<typeof parseDataEnvironment>;
  productionConfirmation: string;
  profile: CloneProfile;
  reportDirectory: string;
  sourcePublicRoot: string;
  legacyTargetRoot: string;
};

const options = parseOptions(process.argv.slice(2));
const runId = `clone-${Date.now()}-${randomBytes(6).toString("hex")}`;

async function main() {
  assertCloneTargetContract({
    targetEnvironment: options.targetEnvironment,
    configuredEnvironment: env.dataEnvironment,
    configuredEnvironmentExplicit: env.dataEnvironmentExplicit,
    spacesPrefix: env.spacesPrefix,
    productionConfirmation: options.productionConfirmation,
    writeOperation: options.apply
  });
  if (!options.sourceId) throw new Error("--source-id is required and should identify the immutable volume snapshot.");
  if (options.apply && !options.confirmReadOnlySource) {
    throw new Error("Applied clone runs require --confirm-read-only-source after the restored snapshot is mounted read-only.");
  }
  if (options.targetEnvironment === "development" && options.profile !== "development-clone") {
    throw new Error("Development targets must use --profile development-clone.");
  }
  if (options.targetEnvironment === "production" && options.profile !== "cutover") {
    throw new Error("Production targets must use --profile cutover.");
  }
  const roots = await validateSourceLayout(options.sourceStorageRoot, options.allowEmptySource);
  if (Boolean(options.sourcePublicRoot) !== Boolean(options.legacyTargetRoot)) {
    throw new Error("--source-public-root and --legacy-target-root must be supplied together.");
  }
  await mkdir(options.reportDirectory, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    FIRSTMEASURE_STORAGE_ROOT: roots.firstmeasure,
    FIRSTMEASURE_INDEX_DB_PATH: path.join(roots.firstmeasure, "projects_index.sqlite"),
    PLATFORM_STORAGE_ROOT: roots.platform,
    INTERNAL_STORAGE_ROOT: roots.internal,
    CRM_STORAGE_ROOT: roots.crm,
    CANVASSING_STORAGE_ROOT: roots.canvassing,
    PRICEBOOK_STORAGE_ROOT: roots.pricebook,
    WEATHER_STORAGE_ROOT: roots.weather,
    CODE_REPORT_STORAGE_ROOT: roots.codeReports,
    COMMUNICATIONS_STORAGE_ROOT: roots.communications,
    POSTGRES_AUTO_MIGRATE: "false"
  };
  const report: Record<string, unknown> = {
    run_id: runId,
    mode: options.apply ? "apply" : "dry-run",
    source_id: options.sourceId,
    source_storage_root: options.sourceStorageRoot,
    target_environment: options.targetEnvironment,
    profile: options.profile,
    spaces_bucket: env.spacesBucket,
    spaces_prefix: env.spacesPrefix,
    started_at: new Date().toISOString(),
    project_manifests: await countProjectManifests(path.join(roots.firstmeasure, "projects")),
    steps: []
  };

  try {
    if (options.apply) {
      const target = await prepareTargetDatabase();
      report.target_database = target;
      await recordCloneRun("running", report);
      (report.steps as unknown[]).push(await runStep("projects", "src/scripts/firstmeasure_reindex.ts", [], environment));
    }

    const stateArguments = ["--profile", options.profile, "--concurrency", String(options.concurrency)];
    if (options.apply) stateArguments.push("--apply");
    if (options.verify) stateArguments.push("--verify");
    (report.steps as unknown[]).push(await runStep("state", "src/scripts/cluster_state_migrate.ts", stateArguments, environment));

    const artifactReport = path.join(options.reportDirectory, `${runId}-artifacts.json`);
    const artifactArguments = [
      "--source-root", roots.firstmeasure,
      "--source-id", options.sourceId,
      "--target-environment", options.targetEnvironment,
      "--concurrency", String(options.concurrency),
      "--report", artifactReport
    ];
    if (options.apply) artifactArguments.push("--apply");
    if (options.verify) artifactArguments.push("--verify");
    if (options.allowEmptySource) artifactArguments.push("--allow-empty-source");
    if (options.targetEnvironment === "production") {
      artifactArguments.push("--confirm-production", options.productionConfirmation);
    }
    (report.steps as unknown[]).push(await runStep("artifacts", "src/scripts/firstmeasure_artifacts_migrate.ts", artifactArguments, environment));

    if (options.legacyTargetRoot) {
      const legacyArguments = [
        path.resolve(import.meta.dirname, "../../../../deploy/digitalocean/sync-legacy-clone.sh"),
        "--source-storage-root", options.sourceStorageRoot,
        "--source-public-root", options.sourcePublicRoot,
        "--source-id", options.sourceId,
        "--target-environment", options.targetEnvironment,
        "--target-root", options.legacyTargetRoot
      ];
      if (options.apply) legacyArguments.push("--apply", "--confirm-read-only-source");
      if (options.targetEnvironment === "production") {
        legacyArguments.push("--confirm-production", options.productionConfirmation);
      }
      (report.steps as unknown[]).push(await runExternalStep("legacy", "bash", legacyArguments, environment));
    }

    if (options.apply && options.verify) {
      (report.steps as unknown[]).push(await runStep("postgres-verification", "src/scripts/firstmeasure_postgres_verify.ts", [], environment));
    }
    report.ok = true;
    report.finished_at = new Date().toISOString();
    if (options.apply) await recordCloneRun("complete", report);
    await writeMainReport(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.ok = false;
    report.error = message;
    report.finished_at = new Date().toISOString();
    if (options.apply) await recordCloneRun("failed", report).catch(() => undefined);
    await writeMainReport(report);
    throw error;
  }
}

async function validateSourceLayout(storageRoot: string, allowEmptySource: boolean) {
  const information = await stat(storageRoot).catch(() => null);
  if (!information?.isDirectory()) throw new Error(`Snapshot storage root does not exist: ${storageRoot}`);
  const roots = {
    firstmeasure: path.join(storageRoot, "firstmeasure"),
    platform: path.join(storageRoot, "platform"),
    internal: path.join(storageRoot, "internal"),
    crm: path.join(storageRoot, "crm"),
    canvassing: path.join(storageRoot, "canvassing"),
    pricebook: path.join(storageRoot, "pricebook"),
    weather: path.join(storageRoot, "weather"),
    codeReports: path.join(storageRoot, "code-reports"),
    communications: path.join(storageRoot, "communications")
  };
  for (const required of [roots.firstmeasure, roots.platform, roots.internal, roots.crm]) {
    const found = await stat(required).catch(() => null);
    if (!found?.isDirectory() && !allowEmptySource) throw new Error(`Required snapshot directory is missing: ${required}`);
  }
  return roots;
}

async function countProjectManifests(projectsRoot: string) {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await stat(path.join(projectsRoot, entry.name, "manifest.json")).catch(() => null);
    if (manifest?.isFile()) count += 1;
  }
  return count;
}

async function prepareTargetDatabase() {
  const identity = await queryPostgres<{ database: string; username: string }>(
    "SELECT current_database() AS database, current_user AS username"
  );
  const existingMarker = await queryPostgres<{ environment: string }>(`
    SELECT environment
    FROM firstmeasure_data_environment
    WHERE singleton = true
  `).catch((error: unknown) => {
    if (String((error as { code?: string })?.code ?? "") === "42P01") return { rows: [] } as { rows: Array<{ environment: string }> };
    throw error;
  });
  const markedEnvironment = String(existingMarker.rows[0]?.environment ?? "");
  if (markedEnvironment && markedEnvironment !== options.targetEnvironment) {
    throw new Error(
      `Database is marked '${markedEnvironment}' but this operation targets '${options.targetEnvironment}'.`
    );
  }
  const recordCount = await countKnownTargetRecords();
  if (recordCount > 0 && !options.allowExistingTarget) {
    throw new Error(
      `Target database already contains ${recordCount} known record(s). Use --allow-existing-target only for an intentional resynchronization.`
    );
  }
  await withPostgresTransaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS firstmeasure_data_environment (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        environment text NOT NULL CHECK (environment IN ('development','production','test')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      INSERT INTO firstmeasure_data_environment(singleton,environment)
      VALUES(true,$1)
      ON CONFLICT(singleton) DO UPDATE SET environment=EXCLUDED.environment,updated_at=now()
      WHERE firstmeasure_data_environment.environment=EXCLUDED.environment
    `, [options.targetEnvironment]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS firstmeasure_clone_runs (
        run_id text PRIMARY KEY,
        source_id text NOT NULL,
        source_environment text NOT NULL DEFAULT 'production',
        target_environment text NOT NULL,
        status text NOT NULL,
        report_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )
    `);
  });
  return {
    name: identity.rows[0]?.database,
    user: identity.rows[0]?.username,
    environment: options.targetEnvironment,
    records_before: recordCount
  };
}

async function countKnownTargetRecords() {
  const tables = [
    "projects", "platform_identities", "platform_organizations", "platform_documents",
    "internal_users_index", "internal_documents", "app_shared_documents"
  ];
  let count = 0;
  for (const table of tables) {
    const exists = await queryPostgres<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${table}`]);
    if (!exists.rows[0]?.exists) continue;
    const result = await queryPostgres<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
    count += Number(result.rows[0]?.count ?? 0);
  }
  return count;
}

async function recordCloneRun(status: "running" | "complete" | "failed", report: Record<string, unknown>) {
  await queryPostgres(`
    INSERT INTO firstmeasure_clone_runs(run_id,source_id,target_environment,status,report_json,finished_at)
    VALUES($1,$2,$3,$4,$5::jsonb,CASE WHEN $4='running' THEN NULL ELSE now() END)
    ON CONFLICT(run_id) DO UPDATE SET status=EXCLUDED.status,report_json=EXCLUDED.report_json,finished_at=EXCLUDED.finished_at
  `, [runId, options.sourceId, options.targetEnvironment, status, JSON.stringify(report)]);
}

async function runStep(name: string, script: string, argumentsList: string[], environment: NodeJS.ProcessEnv) {
  return runExternalStep(name, process.execPath, ["--experimental-sqlite", "--import", "tsx", script, ...argumentsList], environment);
}

async function runExternalStep(name: string, command: string, argumentsList: string[], environment: NodeJS.ProcessEnv) {
  const startedAt = new Date().toISOString();
  const child = spawn(command, argumentsList, {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (signal) reject(new Error(`${name} terminated with signal ${signal}.`));
      else resolve(exitCode ?? 1);
    });
  });
  await writeFile(path.join(options.reportDirectory, `${runId}-${name}.stdout.log`), stdout, "utf8");
  await writeFile(path.join(options.reportDirectory, `${runId}-${name}.stderr.log`), stderr, "utf8");
  const result = { name, code, started_at: startedAt, finished_at: new Date().toISOString() };
  if (code !== 0) throw new Error(`${name} failed with exit status ${code}.`);
  return result;
}

async function writeMainReport(report: Record<string, unknown>) {
  await writeFile(
    path.join(options.reportDirectory, `${runId}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}

function parseOptions(argv: string[]): Options {
  const argument = (name: string, fallback = "") => {
    const index = argv.indexOf(name);
    return index >= 0 ? String(argv[index + 1] ?? fallback) : fallback;
  };
  const targetEnvironment = parseDataEnvironment(argument("--target-environment", env.dataEnvironment));
  const profileValue = argument("--profile", targetEnvironment === "development" ? "development-clone" : "cutover");
  if (profileValue !== "development-clone" && profileValue !== "cutover") {
    throw new Error("--profile must be development-clone or cutover.");
  }
  const concurrency = Number(argument("--concurrency", "4"));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("--concurrency must be an integer between 1 and 16.");
  }
  return {
    apply: argv.includes("--apply"),
    verify: argv.includes("--verify"),
    allowExistingTarget: argv.includes("--allow-existing-target"),
    allowEmptySource: argv.includes("--allow-empty-source"),
    confirmReadOnlySource: argv.includes("--confirm-read-only-source"),
    concurrency,
    sourceStorageRoot: path.resolve(argument("--source-storage-root", "./storage")),
    sourceId: argument("--source-id"),
    targetEnvironment,
    productionConfirmation: argument("--confirm-production"),
    profile: profileValue,
    reportDirectory: path.resolve(argument("--report-directory", "./clone-reports")),
    sourcePublicRoot: argument("--source-public-root") ? path.resolve(argument("--source-public-root")) : "",
    legacyTargetRoot: argument("--legacy-target-root") ? path.resolve(argument("--legacy-target-root")) : ""
  };
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    if (options.targetEnvironment === "production" && !options.productionConfirmation) {
      process.stderr.write(`Production confirmation phrase: ${PRODUCTION_CLONE_CONFIRMATION}\n`);
    }
    process.exitCode = 1;
  })
  .finally(() => closePostgresPools().catch(() => undefined));
