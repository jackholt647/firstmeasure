import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { runLegacyPlatformMigration } from "../../platform/legacy_migration.js";

type CliOptions = {
  source: string;
  target: string;
  backupRoot: string;
  confirmProduction: boolean;
  skipBackup: boolean;
  json: boolean;
};

type ProductionCutoverReport = {
  ok: boolean;
  sourceRoot: string;
  targetRoot: string;
  backupPath: string | null;
  preflight: { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
  migration: Awaited<ReturnType<typeof runLegacyPlatformMigration>> | null;
};

function defaultSourceRoot() {
  return path.resolve(process.cwd(), "../measure/internal/storage");
}

function defaultTargetRoot() {
  return path.resolve(process.cwd(), "./storage/platform");
}

function defaultBackupRoot() {
  return path.resolve(process.cwd(), "./storage/platform-cutover-backups");
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    source: defaultSourceRoot(),
    target: defaultTargetRoot(),
    backupRoot: defaultBackupRoot(),
    confirmProduction: false,
    skipBackup: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const next = argv[index + 1] ?? "";
    if (arg === "--source") {
      if (!next) throw new Error("--source requires a path");
      options.source = path.resolve(process.cwd(), next);
      index += 1;
    } else if (arg === "--target") {
      if (!next) throw new Error("--target requires a path");
      options.target = path.resolve(process.cwd(), next);
      index += 1;
    } else if (arg === "--backup-root") {
      if (!next) throw new Error("--backup-root requires a path");
      options.backupRoot = path.resolve(process.cwd(), next);
      index += 1;
    } else if (arg === "--confirm-production") {
      options.confirmProduction = true;
    } else if (arg === "--skip-backup") {
      options.skipBackup = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`FirstMate Platform production cutover

Usage:
  node --experimental-sqlite --import tsx src/scripts/platform_production_cutover.ts --confirm-production

Options:
  --source <path>              Legacy measure/internal/storage root
  --target <path>              Platform production storage root to rebuild
  --backup-root <path>         Where existing target backups are written
  --confirm-production         Required because this rebuilds target storage
  --skip-backup                Allow rebuilding target without backing it up
  --json                       Print full JSON report

Defaults:
  source: ${defaultSourceRoot()}
  target: ${defaultTargetRoot()}
  backup-root: ${defaultBackupRoot()}
`);
}

async function preflight(options: CliOptions) {
  const checks: ProductionCutoverReport["preflight"]["checks"] = [];
  const source = path.resolve(options.source);
  const target = path.resolve(options.target);
  const backupRoot = path.resolve(options.backupRoot);

  checks.push({
    name: "confirmation flag",
    ok: options.confirmProduction,
    detail: options.confirmProduction ? undefined : "Pass --confirm-production to run production cutover."
  });
  checks.push({
    name: "source root exists",
    ok: await pathExists(source),
    detail: source
  });
  checks.push({
    name: "source users directory exists",
    ok: await pathExists(path.join(source, "users")),
    detail: path.join(source, "users")
  });
  checks.push({
    name: "source organizations directory exists",
    ok: await pathExists(path.join(source, "organizations")),
    detail: path.join(source, "organizations")
  });
  checks.push({
    name: "target differs from source",
    ok: source !== target && !target.startsWith(`${source}${path.sep}`),
    detail: target
  });
  checks.push({
    name: "backup root differs from target",
    ok: backupRoot !== target && !backupRoot.startsWith(`${target}${path.sep}`),
    detail: backupRoot
  });

  if (await pathExists(path.join(source, "users"))) {
    const users = await readdir(path.join(source, "users"));
    checks.push({
      name: "source has user files",
      ok: users.some((name) => name.endsWith(".json")),
      detail: `${users.filter((name) => name.endsWith(".json")).length} JSON files`
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function backupTarget(options: CliOptions) {
  const target = path.resolve(options.target);
  if (options.skipBackup || !(await pathExists(target))) return null;
  await mkdir(options.backupRoot, { recursive: true });
  const backupPath = path.join(options.backupRoot, `platform-${timestampId()}`);
  await cp(target, backupPath, { recursive: true, force: false, errorOnExist: true });
  return backupPath;
}

async function runProductionCutover(options: CliOptions): Promise<ProductionCutoverReport> {
  const sourceRoot = path.resolve(options.source);
  const targetRoot = path.resolve(options.target);
  const checks = await preflight(options);
  if (!checks.ok) {
    return { ok: false, sourceRoot, targetRoot, backupPath: null, preflight: checks, migration: null };
  }

  const backupPath = await backupTarget(options);
  const migration = await runLegacyPlatformMigration({
    sourceRoot,
    targetRoot,
    mode: "fresh",
    confirmFresh: true
  });

  return {
    ok: migration.ok,
    sourceRoot,
    targetRoot,
    backupPath,
    preflight: checks,
    migration
  };
}

function printHumanReport(report: ProductionCutoverReport) {
  console.log("FirstMate Platform production cutover");
  console.log(`Source: ${report.sourceRoot}`);
  console.log(`Target: ${report.targetRoot}`);
  console.log(`Backup: ${report.backupPath || "none"}`);
  console.log(`OK: ${report.ok ? "yes" : "no"}`);
  console.log("");
  console.log("Preflight:");
  for (const check of report.preflight.checks) {
    console.log(`  ${check.ok ? "pass" : "fail"}: ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  if (report.migration) {
    console.log("");
    console.log("Migration:");
    console.log(`  ok: ${report.migration.ok ? "yes" : "no"}`);
    for (const [key, value] of Object.entries(report.migration.counts)) {
      console.log(`  ${key}: ${value}`);
    }
    if (report.migration.validation) {
      console.log(`  validation_checked: ${report.migration.validation.checked}`);
      console.log(`  validation_failed: ${report.migration.validation.failed}`);
    }
    if (report.migration.issues.length) {
      console.log("");
      console.log("Migration issues:");
      for (const issue of report.migration.issues.slice(0, 50)) {
        console.log(`  [${issue.level}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
      }
      if (report.migration.issues.length > 50) console.log(`  ... ${report.migration.issues.length - 50} more`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runProductionCutover(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
