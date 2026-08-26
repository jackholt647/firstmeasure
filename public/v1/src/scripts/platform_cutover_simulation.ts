import path from "node:path";

import { runPlatformCutoverSimulation, type CutoverSimulationReport } from "../../platform/cutover_simulation.js";

type CliOptions = {
  source: string;
  target: string;
  confirmFresh: boolean;
  runtimeSmoke: boolean;
  json: boolean;
};

function defaultSourceRoot() {
  return path.resolve(process.cwd(), "../measure/internal/storage");
}

function defaultTargetRoot() {
  return path.resolve(process.cwd(), "./storage/platform-migration-dev");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    source: defaultSourceRoot(),
    target: defaultTargetRoot(),
    confirmFresh: false,
    runtimeSmoke: true,
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
    } else if (arg === "--confirm-fresh") {
      options.confirmFresh = true;
    } else if (arg === "--skip-runtime-smoke") {
      options.runtimeSmoke = false;
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
  console.log(`FirstMate Platform cutover simulation

Usage:
  node --experimental-sqlite --import tsx src/scripts/platform_cutover_simulation.ts --confirm-fresh

Options:
  --source <path>          Legacy measure/internal/storage root
  --target <path>          Disposable Platform storage root to rebuild
  --confirm-fresh          Required because simulation deletes and rebuilds target
  --skip-runtime-smoke     Rebuild and validate storage without booting the API
  --json                   Print full JSON report

Defaults:
  source: ${defaultSourceRoot()}
  target: ${defaultTargetRoot()}
`);
}

function printHumanReport(report: CutoverSimulationReport) {
  console.log("FirstMate Platform cutover simulation");
  console.log(`Source: ${report.sourceRoot}`);
  console.log(`Target: ${report.targetRoot}`);
  console.log(`OK: ${report.ok ? "yes" : "no"}`);
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
  console.log("");
  console.log("Migrated storage:");
  for (const [key, value] of Object.entries(report.storage)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log("");
  console.log("Runtime smoke:");
  if (report.smoke.skipped) {
    console.log("  skipped");
  } else {
    for (const check of report.smoke.checks) {
      console.log(`  ${check.ok ? "pass" : "fail"}: ${check.name}${check.statusCode ? ` (${check.statusCode})` : ""}${check.detail ? ` - ${check.detail}` : ""}`);
    }
  }
  if (report.migration.issues.length) {
    console.log("");
    console.log("Migration issues:");
    for (const issue of report.migration.issues.slice(0, 50)) {
      console.log(`  [${issue.level}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
    }
    if (report.migration.issues.length > 50) {
      console.log(`  ... ${report.migration.issues.length - 50} more`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPlatformCutoverSimulation({
    sourceRoot: options.source,
    targetRoot: options.target,
    confirmFresh: options.confirmFresh,
    runtimeSmoke: options.runtimeSmoke
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
