import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  asObject,
  ensureInternalStorage,
  readInternalDocument,
  readInternalUser,
  saveInternalDocument,
  saveInternalUser
} from "./storage.js";

export type InternalMigrationMode = "dry-run" | "fresh" | "validate";

export type InternalMigrationOptions = {
  sourceRoot: string;
  targetRoot?: string;
  mode?: InternalMigrationMode;
  confirmFresh?: boolean;
};

type LegacyInternalRecord =
  | { kind: "user"; id: string; data: Record<string, unknown> }
  | { kind: "state"; collection: string; id: string; data: Record<string, unknown> };

const STATE_DIRECTORIES = [
  "coupons",
  "feature_flags",
  "portal_status",
  "server_config",
  "shifts",
  "tutorials_curriculum",
  "tutorials_progress",
  "tutorials_projects",
  "data_agent",
  "data_agent_sessions",
  "data_agent_runs"
];

const EMPLOYEE_ROLES = new Set(["admin", "manager", "qa", "technician", "sales_manager", "salesperson", "trainee"]);
const INTERNAL_PERMISSION_KEYS = new Set([
  "view_all_projects",
  "view_team_projects",
  "manage_users",
  "manage_sales_users",
  "create_users",
  "assign_teams",
  "manage_tutorials",
  "manage_queue",
  "manage_qa",
  "manage_qa_queue",
  "manage_apple_key",
  "create_filler_projects",
  "manage_payroll",
  "shift_view",
  "shift_edit"
]);

export async function runLegacyInternalMigration(options: InternalMigrationOptions) {
  const mode = options.mode ?? "dry-run";
  if (options.targetRoot) process.env.INTERNAL_STORAGE_ROOT = options.targetRoot;
  const records = await readLegacyInternalRecords(options.sourceRoot);
  const summary = {
    ok: true,
    mode,
    source_root: options.sourceRoot,
    target_root: options.targetRoot ?? process.env.INTERNAL_STORAGE_ROOT ?? "",
    counts: {
      legacy_records_read: records.length,
      internal_records_expected: records.length,
      internal_records_written: 0
    },
    validation: null as null | Awaited<ReturnType<typeof validateRecords>>
  };

  if (mode === "fresh") {
    if (!options.confirmFresh) throw new Error("confirmFresh is required for fresh internal migration.");
    if (options.targetRoot) await rm(options.targetRoot, { recursive: true, force: true });
    await ensureInternalStorage();
    for (const record of records) {
      if (record.kind === "user") {
        await saveInternalUser(record.data);
      } else {
        await saveInternalDocument(record.collection, record.id, {
          data: record.data,
          metadata: {
            migrated_from: "legacy_internal",
            migrated_at: new Date().toISOString()
          }
        }, { replace: true });
      }
      summary.counts.internal_records_written += 1;
    }
  }

  if (mode === "fresh" || mode === "validate") {
    summary.validation = await validateRecords(records);
    summary.ok = summary.validation.failed === 0;
  }

  return summary;
}

async function readLegacyInternalRecords(sourceRoot: string) {
  const root = path.resolve(sourceRoot);
  const records: LegacyInternalRecord[] = [];
  const storageRoot = await exists(path.join(root, "storage")) ? path.join(root, "storage") : root;
  await readUsers(path.join(storageRoot, "users"), records);
  for (const collection of STATE_DIRECTORIES) {
    await readStateCollection(path.join(storageRoot, collection), collection, records);
  }
  await readLegacyConfig(path.join(storageRoot, "config"), records);
  await readLegacyMeta(path.join(storageRoot, "meta"), records);
  await readLegacyTutorials(path.join(storageRoot, "tutorials"), records);
  await readLegacyDataAgent(path.join(storageRoot, "meta", "data_agent"), records);
  await readLegacyCommissions(path.join(storageRoot, "databases", "commissions.sqlite"), records);
  return records;
}

async function readUsers(root: string, records: LegacyInternalRecord[]) {
  if (!(await exists(root))) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed = await readJsonObject(path.join(root, entry.name));
    if (!parsed) continue;
    if (!isLegacyEmployeeUser(parsed)) continue;
    records.push({ kind: "user", id: String(parsed.id ?? parsed.email ?? path.basename(entry.name, ".json")), data: parsed });
  }
}

async function readStateCollection(root: string, collection: string, records: LegacyInternalRecord[]) {
  if (!(await exists(root))) return;
  await mkdir(root, { recursive: true });
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed = await readJsonObject(path.join(root, entry.name));
    if (!parsed) continue;
    records.push({
      kind: "state",
      collection,
      id: String(parsed.id ?? parsed.key ?? path.basename(entry.name, ".json")),
      data: asObject(parsed.data ?? parsed)
    });
  }
}

async function readLegacyConfig(root: string, records: LegacyInternalRecord[]) {
  if (!(await exists(root))) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = path.basename(entry.name, ".json");
    const parsed = await readJsonObject(path.join(root, entry.name));
    if (!parsed) continue;
    if (id === "server_config") {
      const settings = asObject(parsed.settings ?? parsed);
      for (const [key, value] of Object.entries(settings)) {
        records.push({ kind: "state", collection: "server_config", id: key, data: { key, value } });
      }
      records.push({ kind: "state", collection: "server_config_raw", id, data: parsed });
      continue;
    }
    records.push({ kind: "state", collection: "config", id, data: parsed });
  }
}

async function readLegacyMeta(root: string, records: LegacyInternalRecord[]) {
  if (!(await exists(root))) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = path.basename(entry.name, ".json");
    const parsed = await readJsonObject(path.join(root, entry.name));
    if (!parsed) continue;
    records.push({ kind: "state", collection: "meta", id, data: parsed });
  }
}

async function readLegacyTutorials(root: string, records: LegacyInternalRecord[]) {
  if (!(await exists(root))) return;
  await readStateCollection(path.join(root, "curriculum"), "tutorials_curriculum", records);
  await readStateCollection(path.join(root, "progress"), "tutorials_progress", records);
  await readStateCollection(path.join(root, "projects"), "tutorials_projects", records);
}

async function readLegacyDataAgent(root: string, records: LegacyInternalRecord[]) {
  if (!(await exists(root))) return;
  await readStateCollection(root, "data_agent", records);
  await readStateCollection(path.join(root, "sessions"), "data_agent_sessions", records);
  await readStateCollection(path.join(root, "runs"), "data_agent_runs", records);
}

async function readLegacyCommissions(databasePath: string, records: LegacyInternalRecord[]) {
  if (!(await exists(databasePath))) return;
  const sqlite = await import("node:sqlite").catch(() => null);
  const DatabaseSync = (sqlite as unknown as { DatabaseSync?: new (path: string, options?: Record<string, unknown>) => unknown })?.DatabaseSync;
  if (!DatabaseSync) return;
  const db = new DatabaseSync(databasePath, { readOnly: true }) as {
    prepare: (sql: string) => { all: () => Array<Record<string, unknown>> };
    close: () => void;
  };
  try {
    const tables = [
      "commission_events",
      "commission_meta",
      "commission_milestones",
      "commission_payrolls",
      "commission_user_settings"
    ];
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const id = String(row.id ?? row.meta_key ?? row.user_email ?? `${table}_${records.length}`);
        records.push({ kind: "state", collection: table, id, data: normalizeSqliteJson(row) });
      }
    }
  } finally {
    db.close();
  }
}

function normalizeSqliteJson(row: Record<string, unknown>) {
  const next = { ...row };
  for (const key of ["metadata_json", "meta_value"]) {
    if (typeof next[key] !== "string") continue;
    const raw = String(next[key]);
    if (!raw.trim().startsWith("{") && !raw.trim().startsWith("[")) continue;
    try {
      next[key.replace(/_json$/, "")] = JSON.parse(raw);
    } catch {
      // Keep the original string if legacy data is not valid JSON.
    }
  }
  return next;
}

function isLegacyEmployeeUser(user: Record<string, unknown>) {
  const accountType = String(user.account_type ?? "").toLowerCase();
  if (accountType === "employee") return true;
  const role = String(user.role ?? "").toLowerCase();
  if (EMPLOYEE_ROLES.has(role)) return true;
  if (user.is_admin === true) return true;
  if (String(user.email ?? "").toLowerCase().endsWith("@1m8.ai")) return true;
  const permissions = asObject(user.permissions);
  if (Object.keys(permissions).some((key) => INTERNAL_PERMISSION_KEYS.has(key))) return true;
  if (String(user.department ?? "").trim()) return true;
  if (String(user.queue_mode ?? "").trim() && String(user.queue_mode ?? "disabled") !== "disabled") return true;
  return false;
}

async function validateRecords(records: LegacyInternalRecord[]) {
  const failures: Array<Record<string, unknown>> = [];
  for (const record of records) {
    try {
      if (record.kind === "user") {
        const user = await readInternalUser(record.id);
        if (!user) failures.push({ kind: record.kind, id: record.id, reason: "missing_user" });
      } else {
        const document = await readInternalDocument(record.collection, record.id);
        if (!document) failures.push({ kind: record.kind, collection: record.collection, id: record.id, reason: "missing_document" });
      }
    } catch (error) {
      failures.push({ kind: record.kind, id: record.id, reason: error instanceof Error ? error.message : "missing" });
    }
  }
  return {
    checked: records.length,
    failed: failures.length,
    failures
  };
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath: string) {
  try {
    return asObject(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}
