import path from "node:path";

import { runLegacyPlatformMigration, type MigrationMode } from "../../platform/legacy_migration.js";

type CliOptions = {
  mode: MigrationMode;
  source: string;
  target: string;
  confirmFresh: boolean;
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
    mode: "dry-run",
    source: defaultSourceRoot(),
    target: defaultTargetRoot(),
    confirmFresh: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const next = argv[index + 1] ?? "";
    if (arg === "--mode") {
      if (!["dry-run", "fresh", "validate"].includes(next)) throw new Error("--mode must be dry-run, fresh, or validate");
      options.mode = next as MigrationMode;
      index += 1;
    } else if (arg === "--source") {
      if (!next) throw new Error("--source requires a path");
      options.source = path.resolve(process.cwd(), next);
      index += 1;
    } else if (arg === "--target") {
      if (!next) throw new Error("--target requires a path");
      options.target = path.resolve(process.cwd(), next);
      index += 1;
    } else if (arg === "--confirm-fresh") {
      options.confirmFresh = true;
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
  console.log(`FirstMate Platform legacy migration

Usage:
  tsx src/scripts/platform_migration.ts --mode dry-run
  tsx src/scripts/platform_migration.ts --mode fresh --confirm-fresh
  tsx src/scripts/platform_migration.ts --mode validate

Options:
  --mode dry-run|fresh|validate
  --source <path>          Legacy measure/internal/storage root
  --target <path>          Platform storage root to validate/write
  --confirm-fresh          Required for fresh mode because it deletes target
  --json                   Print full JSON report

Defaults:
  source: ${defaultSourceRoot()}
  target: ${defaultTargetRoot()}
`);
}

function printHumanReport(report: Awaited<ReturnType<typeof runLegacyPlatformMigration>>) {
  console.log(`Mode: ${report.mode}`);
  console.log(`Source: ${report.sourceRoot}`);
  console.log(`Target: ${report.targetRoot}`);
  console.log(`OK: ${report.ok ? "yes" : "no"}`);
  console.log("");
  console.log("Counts:");
  for (const [key, value] of Object.entries(report.counts)) {
    console.log(`  ${key}: ${value}`);
  }
  if (report.validation) {
    console.log("");
    console.log("Validation:");
    console.log(`  checked: ${report.validation.checked}`);
    console.log(`  failed: ${report.validation.failed}`);
    for (const failure of report.validation.failures.slice(0, 25)) {
      console.log(`  - ${failure}`);
    }
    if (report.validation.failures.length > 25) {
      console.log(`  ... ${report.validation.failures.length - 25} more`);
    }
  }
  if (report.issues.length) {
    console.log("");
    console.log("Issues:");
    for (const issue of report.issues.slice(0, 50)) {
      console.log(`  [${issue.level}] ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ""}`);
    }
    if (report.issues.length > 50) {
      console.log(`  ... ${report.issues.length - 50} more`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runLegacyPlatformMigration({
    sourceRoot: options.source,
    targetRoot: options.target,
    mode: options.mode,
    confirmFresh: options.confirmFresh
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
