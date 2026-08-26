import path from "node:path";

import { runLegacyCrmMigration } from "../../internal/crm/migration.js";
import { runLegacyInternalMigration } from "../../internal/migration.js";

type Mode = "dry-run" | "fresh" | "validate";

function argValue(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function parseMode(): Mode {
  const value = argValue("--mode", "dry-run");
  if (value === "dry-run" || value === "fresh" || value === "validate") return value;
  throw new Error("--mode must be dry-run, fresh, or validate.");
}

async function main() {
  const mode = parseMode();
  const sourceRoot = path.resolve(argValue("--source-root", "../measure/internal"));
  const targetRoot = path.resolve(argValue("--target-root", "./storage"));
  const internalSourceRoot = path.resolve(argValue("--internal-source-root", resolveDefaultInternalSourceRoot(sourceRoot)));
  const crmSourceRoot = path.resolve(argValue("--crm-source-root", path.join(sourceRoot, "crm")));
  const include = new Set(
    argValue("--include", "internal,crm")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
  const confirmFresh = hasFlag("--confirm-fresh");
  if (mode === "fresh" && !confirmFresh) {
    throw new Error("Fresh backend migration requires --confirm-fresh.");
  }

  const result: Record<string, unknown> = {
    ok: true,
    mode,
    source_root: sourceRoot,
    target_root: targetRoot,
    migrations: {}
  };

  if (include.has("internal")) {
    (result.migrations as Record<string, unknown>).internal = await runLegacyInternalMigration({
      sourceRoot: internalSourceRoot,
      targetRoot: path.join(targetRoot, "internal"),
      mode,
      confirmFresh
    });
  }

  if (include.has("crm")) {
    (result.migrations as Record<string, unknown>).crm = await runLegacyCrmMigration({
      sourceRoot: crmSourceRoot,
      targetRoot: path.join(targetRoot, "crm"),
      mode,
      confirmFresh
    });
  }

  const migrations = Object.values(result.migrations as Record<string, { ok?: boolean }>);
  result.ok = migrations.every((migration) => migration.ok !== false);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

function resolveDefaultInternalSourceRoot(sourceRoot: string) {
  if (sourceRoot.replace(/\\/g, "/").endsWith("/measure/internal")) return path.join(sourceRoot, "storage");
  return path.join(sourceRoot, "internal");
}
