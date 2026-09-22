import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { ensureSqlColumn, openSqlStore, type SqlStore } from "../platform/sql_store.js";

import { badRequest, conflict, notFound } from "../platform/errors.js";
import { env } from "../src/config/env.js";
import type { PayrollLedgerEntryInput, PayrollPayeeRef, PayrollPolicySubject, PayrollScheduleInput } from "./schemas.js";

export type JsonObject = Record<string, unknown>;

const DATABASE_SCHEMA_VERSION = 3;
let database: SqlStore | null = null;
let databasePath = "";

export function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function nowIso() {
  return new Date().toISOString();
}

export function generatedId(prefix: string) {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "payroll.sqlite");
}

export async function closePayrollDatabase() {
  await database?.close(); database = null; databasePath = "";
}
export function getPayrollDatabase(): SqlStore {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  if (database) throw new Error("Close payroll storage before changing its directory.");
  database = openSqlStore({ id: "payroll", filename: nextPath, schemaVersion: 2, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_work_outbox (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payroll_schedules (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      currency TEXT NOT NULL DEFAULT 'USD',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      recurrence_json TEXT NOT NULL,
      delay_json TEXT NOT NULL DEFAULT '{}',
      timing_basis TEXT NOT NULL DEFAULT 'worked',
      clawback_cap_percent DOUBLE PRECISION NOT NULL DEFAULT 100,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (organization_id, id)
    );
    CREATE INDEX IF NOT EXISTS payroll_schedules_org_idx
      ON payroll_schedules (organization_id, status, name);

    CREATE TABLE IF NOT EXISTS payroll_policies (
      organization_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      earning_kind TEXT NOT NULL DEFAULT '*',
      schedule_id TEXT NOT NULL,
      timing_basis TEXT,
      clawback_cap_percent DOUBLE PRECISION,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, subject_type, subject_id, earning_kind),
      FOREIGN KEY (organization_id, schedule_id) REFERENCES payroll_schedules (organization_id, id)
    );
    CREATE INDEX IF NOT EXISTS payroll_policies_schedule_idx
      ON payroll_policies (organization_id, schedule_id, subject_type, earning_kind);

    CREATE TABLE IF NOT EXISTS payroll_project_payees (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role_key TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      payees_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, project_id, role_key)
    );

    CREATE TABLE IF NOT EXISTS payroll_ledger_entries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      payee_type TEXT NOT NULL,
      payee_id TEXT NOT NULL,
      payee_name TEXT NOT NULL DEFAULT '',
      worker_type TEXT NOT NULL DEFAULT 'employee',
      schedule_id TEXT,
      kind TEXT NOT NULL,
      subgroup TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'accrued',
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      project_id TEXT NOT NULL DEFAULT '',
      project_title TEXT NOT NULL DEFAULT '',
      worked_at TEXT,
      completed_at TEXT,
      eligible_at TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source_trigger_id TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      voided_at TEXT
    );
    DROP INDEX IF EXISTS payroll_ledger_source_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS payroll_ledger_source_trigger_idx
      ON payroll_ledger_entries (organization_id, source_event_id, source_trigger_id, payee_type, payee_id);
    CREATE INDEX IF NOT EXISTS payroll_ledger_upcoming_idx
      ON payroll_ledger_entries (organization_id, schedule_id, state, eligible_at);
    CREATE INDEX IF NOT EXISTS payroll_ledger_project_idx
      ON payroll_ledger_entries (organization_id, project_id, source_trigger_id);
    CREATE INDEX IF NOT EXISTS payroll_ledger_payee_idx
      ON payroll_ledger_entries (organization_id, payee_type, payee_id, eligible_at, id);

    CREATE TABLE IF NOT EXISTS payroll_batches (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      schedule_id TEXT NOT NULL,
      pay_date TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      currency TEXT NOT NULL DEFAULT 'USD',
      total_cents INTEGER NOT NULL DEFAULT 0,
      employee_total_cents INTEGER NOT NULL DEFAULT 0,
      subcontractor_total_cents INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      run_at TEXT,
      paid_at TEXT,
      voided_at TEXT,
      UNIQUE (organization_id, schedule_id, pay_date),
      FOREIGN KEY (organization_id, schedule_id) REFERENCES payroll_schedules (organization_id, id)
    );
    CREATE INDEX IF NOT EXISTS payroll_batches_history_idx
      ON payroll_batches (organization_id, pay_date DESC, status);

    CREATE TABLE IF NOT EXISTS payroll_batch_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      payee_type TEXT NOT NULL,
      payee_id TEXT NOT NULL,
      payee_name TEXT NOT NULL DEFAULT '',
      worker_type TEXT NOT NULL DEFAULT 'employee',
      status TEXT NOT NULL DEFAULT 'draft',
      gross_cents INTEGER NOT NULL DEFAULT 0,
      commission_cents INTEGER NOT NULL DEFAULT 0,
      deduction_cents INTEGER NOT NULL DEFAULT 0,
      net_cents INTEGER NOT NULL DEFAULT 0,
      subgroup_totals_json TEXT NOT NULL DEFAULT '{}',
      payment_reference TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      run_at TEXT,
      paid_at TEXT,
      UNIQUE (batch_id, payee_type, payee_id),
      FOREIGN KEY (batch_id) REFERENCES payroll_batches (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS payroll_batch_items_payee_idx
      ON payroll_batch_items (organization_id, payee_type, payee_id, paid_at DESC);

    CREATE TABLE IF NOT EXISTS payroll_allocations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      batch_item_id TEXT NOT NULL,
      ledger_entry_id TEXT NOT NULL,
      applied_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (batch_item_id, ledger_entry_id),
      FOREIGN KEY (batch_id) REFERENCES payroll_batches (id) ON DELETE CASCADE,
      FOREIGN KEY (batch_item_id) REFERENCES payroll_batch_items (id) ON DELETE CASCADE,
      FOREIGN KEY (ledger_entry_id) REFERENCES payroll_ledger_entries (id)
    );
    CREATE INDEX IF NOT EXISTS payroll_allocations_ledger_idx
      ON payroll_allocations (organization_id, ledger_entry_id);

    CREATE TABLE IF NOT EXISTS payroll_artifacts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      batch_id TEXT NOT NULL DEFAULT '',
      artifact_type TEXT NOT NULL,
      report_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content_blob ${db.isPostgres ? "BYTEA" : "BLOB"} NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payroll_artifacts_org_idx
      ON payroll_artifacts (organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS payroll_artifacts_batch_idx
      ON payroll_artifacts (organization_id, batch_id, created_at DESC);
  `));
  await ensureSqlColumn(db, "payroll_work_outbox", "state", "TEXT NOT NULL DEFAULT 'pending'");
  await ensureSqlColumn(db, "payroll_work_outbox", "retry_at", "TEXT NOT NULL DEFAULT ''");
  await ensureSqlColumn(db, "payroll_work_outbox", "attempts", "INTEGER NOT NULL DEFAULT 0");
  await ensureSqlColumn(db, "payroll_work_outbox", "last_error", "TEXT NOT NULL DEFAULT ''");
  await db.exec("CREATE INDEX IF NOT EXISTS payroll_work_outbox_due_idx ON payroll_work_outbox(state, retry_at, created_at)");
}

export async function withPayrollTransaction<T>(operation: (db: SqlStore) => T | Promise<T>): Promise<T> {
  return (await getPayrollDatabase().transaction(operation));
}

function scheduleView(rowValue: unknown) {
  const row = asObject(rowValue);
  return {
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    name: cleanText(row.name),
    status: cleanText(row.status || "active"),
    currency: cleanText(row.currency || "USD"),
    timezone: cleanText(row.timezone || "UTC"),
    recurrence: asObject(parseJson(row.recurrence_json)),
    delay: asObject(parseJson(row.delay_json)),
    timing_basis: cleanText(row.timing_basis || "worked"),
    clawback_cap_percent: Number(row.clawback_cap_percent ?? 100),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    archived_at: cleanText(row.archived_at)
  };
}

export async function readPayrollSchedule(orgId: string, scheduleId: string) {
  const row = (await getPayrollDatabase().prepare("SELECT * FROM payroll_schedules WHERE organization_id=? AND id=?").get(orgId, scheduleId));
  if (!row) throw notFound("payroll_schedule_not_found", "Payroll schedule was not found.");
  return scheduleView(row);
}

export async function listPayrollSchedules(orgId: string, includeArchived = false) {
  const rows = includeArchived
    ? (await getPayrollDatabase().prepare("SELECT * FROM payroll_schedules WHERE organization_id=? ORDER BY status ASC, name ASC").all(orgId))
    : (await getPayrollDatabase().prepare("SELECT * FROM payroll_schedules WHERE organization_id=? AND status<>'archived' ORDER BY name ASC").all(orgId));
  return rows.map(scheduleView);
}

export async function createPayrollSchedule(orgId: string, input: PayrollScheduleInput) {
  return (await getPayrollDatabase().transaction(async () => {
  const id = cleanText(asObject(input).id) || generatedId("pay_schedule");
  const now = nowIso();
  try {
    (await getPayrollDatabase().prepare(`INSERT INTO payroll_schedules
      (id, organization_id, name, status, currency, timezone, recurrence_json, delay_json, timing_basis, clawback_cap_percent,
       metadata_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, orgId, input.name, input.status || "active", cleanText(input.currency || "USD").toUpperCase(), input.timezone || "UTC",
        json(input.recurrence), json(input.delay || {}), input.timing_basis || "worked", Number(input.clawback_cap_percent ?? 100),
        json(input.metadata || {}), now, now));
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) throw conflict("payroll_schedule_exists", `Payroll schedule '${id}' already exists.`);
    throw error;
  }
  return (await readPayrollSchedule(orgId, id));

  }));
}

export async function patchPayrollSchedule(orgId: string, scheduleId: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const current = (await readPayrollSchedule(orgId, scheduleId));
  if (Number(input.expected_revision || 0) !== current.revision) {
    throw conflict("payroll_schedule_revision_conflict", "Payroll schedule revision does not match.", { current_revision: current.revision });
  }
  const next = { ...current, ...input };
  const status = cleanText(next.status || "active");
  (await getPayrollDatabase().prepare(`UPDATE payroll_schedules SET name=?, status=?, currency=?, timezone=?, recurrence_json=?, delay_json=?,
    timing_basis=?, clawback_cap_percent=?, metadata_json=?, revision=revision+1, updated_at=?, archived_at=?
    WHERE organization_id=? AND id=?`)
    .run(cleanText(next.name), status, cleanText(next.currency || "USD").toUpperCase(), cleanText(next.timezone || "UTC"),
      json(next.recurrence), json(next.delay), cleanText(next.timing_basis || "worked"), Number(next.clawback_cap_percent ?? 100),
      json(next.metadata), nowIso(), status === "archived" ? nowIso() : null, orgId, scheduleId));
  return (await readPayrollSchedule(orgId, scheduleId));

  }));
}

export async function archivePayrollSchedule(orgId: string, scheduleId: string, expectedRevision: number) {
  return (await patchPayrollSchedule(orgId, scheduleId, { expected_revision: expectedRevision, status: "archived" }));
}

function policyView(rowValue: unknown) {
  const row = asObject(rowValue);
  return {
    organization_id: cleanText(row.organization_id),
    subject_type: cleanText(row.subject_type),
    subject_id: cleanText(row.subject_id),
    earning_kind: cleanText(row.earning_kind || "*"),
    schedule_id: cleanText(row.schedule_id),
    timing_basis: cleanText(row.timing_basis),
    clawback_cap_percent: row.clawback_cap_percent === null || row.clawback_cap_percent === undefined ? null : Number(row.clawback_cap_percent),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at)
  };
}

export async function listPayrollPolicies(orgId: string) {
  return (await getPayrollDatabase().prepare("SELECT * FROM payroll_policies WHERE organization_id=? ORDER BY subject_type, subject_id")
    .all(orgId)).map(policyView);
}

export async function savePayrollPolicy(orgId: string, subjectType: PayrollPolicySubject, subjectId: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  (await readPayrollSchedule(orgId, cleanText(input.schedule_id)));
  const earningKind = cleanText(input.earning_kind || "*") || "*";
  const existing = (await getPayrollDatabase().prepare(`SELECT revision FROM payroll_policies
    WHERE organization_id=? AND subject_type=? AND subject_id=? AND earning_kind=?`).get(orgId, subjectType, subjectId, earningKind));
  if (existing && Number(input.expected_revision || 0) !== Number(asObject(existing).revision || 0)) {
    throw conflict("payroll_policy_revision_conflict", "Payroll policy revision does not match.", { current_revision: Number(asObject(existing).revision || 0) });
  }
  const now = nowIso();
  (await getPayrollDatabase().prepare(`INSERT INTO payroll_policies
    (organization_id, subject_type, subject_id, earning_kind, schedule_id, timing_basis, clawback_cap_percent, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(organization_id, subject_type, subject_id, earning_kind) DO UPDATE SET schedule_id=excluded.schedule_id,
      timing_basis=excluded.timing_basis, clawback_cap_percent=excluded.clawback_cap_percent, metadata_json=excluded.metadata_json,
      revision=payroll_policies.revision+1, updated_at=excluded.updated_at`)
    .run(orgId, subjectType, subjectId, earningKind, cleanText(input.schedule_id), cleanText(input.timing_basis) || null,
      input.clawback_cap_percent === undefined ? null : Number(input.clawback_cap_percent), json(input.metadata || {}), now, now));
  return policyView((await getPayrollDatabase().prepare("SELECT * FROM payroll_policies WHERE organization_id=? AND subject_type=? AND subject_id=? AND earning_kind=?")
    .get(orgId, subjectType, subjectId, earningKind)));

  }));
}

export async function deletePayrollPolicy(orgId: string, subjectType: PayrollPolicySubject, subjectId: string, earningKind = "*") {
  const result = (await getPayrollDatabase().prepare("DELETE FROM payroll_policies WHERE organization_id=? AND subject_type=? AND subject_id=? AND earning_kind=?")
    .run(orgId, subjectType, subjectId, earningKind));
  if (!Number(result.changes || 0)) throw notFound("payroll_policy_not_found", "Payroll policy was not found.");
  return { deleted: true, subject_type: subjectType, subject_id: subjectId };
}

export async function resolvePayrollPolicy(orgId: string, payee: PayrollPayeeRef, earningKind = "*") {
  const rows = (await listPayrollPolicies(orgId));
  const levels: Array<Array<[string, string]>> = [
    [[payee.type, payee.id]],
    (payee.resource_group_ids || []).map((id) => ["resource_group", id] as [string, string]),
    (payee.access_role_ids || []).map((id) => ["access_role", id] as [string, string]),
    [["worker_type", payee.worker_type || (payee.type === "organization_connection" ? "subcontractor" : "employee")]],
    [["organization", orgId]]
  ];
  for (const candidates of levels) {
    const matches = candidates.map(([subjectType, subjectId]) => (
      rows.find((row) => row.subject_type === subjectType && row.subject_id === subjectId && row.earning_kind === earningKind)
      || rows.find((row) => row.subject_type === subjectType && row.subject_id === subjectId && row.earning_kind === "*")
    )).filter((value): value is NonNullable<typeof value> => !!value);
    if (matches.length > 1) {
      const signatures = new Set(matches.map((policy) => `${policy.schedule_id}:${policy.timing_basis}:${policy.clawback_cap_percent}`));
      if (signatures.size > 1) {
        throw conflict("payroll_policy_ambiguous", "Multiple payroll policies match this payee at the same priority.", {
          payee_type: payee.type,
          payee_id: payee.id,
          earning_kind: earningKind,
          policies: matches.map((policy) => ({ subject_type: policy.subject_type, subject_id: policy.subject_id, schedule_id: policy.schedule_id }))
        });
      }
    }
    if (matches[0]) return { ...matches[0], schedule: (await readPayrollSchedule(orgId, matches[0].schedule_id)) };
  }
  return null;
}

function projectPayeeView(rowValue: unknown) {
  const row = asObject(rowValue);
  return {
    organization_id: cleanText(row.organization_id),
    project_id: cleanText(row.project_id),
    role_key: cleanText(row.role_key),
    label: cleanText(row.label),
    payees: asArray(parseJson(row.payees_json, [])),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at)
  };
}

export async function listProjectPayees(orgId: string, projectId: string) {
  return (await getPayrollDatabase().prepare("SELECT * FROM payroll_project_payees WHERE organization_id=? AND project_id=? ORDER BY role_key")
    .all(orgId, projectId)).map(projectPayeeView);
}

export async function readProjectPayeeRole(orgId: string, projectId: string, roleKey: string) {
  const row = (await getPayrollDatabase().prepare("SELECT * FROM payroll_project_payees WHERE organization_id=? AND project_id=? AND role_key=?")
    .get(orgId, projectId, roleKey));
  if (!row) throw notFound("project_payee_role_not_found", "Project payee role was not found.");
  return projectPayeeView(row);
}

export async function saveProjectPayeeRole(orgId: string, projectId: string, roleKey: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const existing = (await getPayrollDatabase().prepare(`SELECT revision FROM payroll_project_payees
    WHERE organization_id=? AND project_id=? AND role_key=?`).get(orgId, projectId, roleKey));
  if (existing && Number(input.expected_revision || 0) !== Number(asObject(existing).revision || 0)) {
    throw conflict("project_payee_revision_conflict", "Project payee role revision does not match.", { current_revision: Number(asObject(existing).revision || 0) });
  }
  const now = nowIso();
  (await getPayrollDatabase().prepare(`INSERT INTO payroll_project_payees
    (organization_id, project_id, role_key, label, payees_json, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(organization_id, project_id, role_key) DO UPDATE SET label=excluded.label, payees_json=excluded.payees_json,
      metadata_json=excluded.metadata_json, revision=payroll_project_payees.revision+1, updated_at=excluded.updated_at`)
    .run(orgId, projectId, roleKey, cleanText(input.label), json(input.payees || []), json(input.metadata || {}), now, now));
  return (await readProjectPayeeRole(orgId, projectId, roleKey));

  }));
}

function ledgerEntryView(rowValue: unknown) {
  const row = asObject(rowValue);
  const amountCents = Number(row.amount_cents || 0);
  const appliedCents = Number(row.applied_cents || 0);
  return {
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    payee: {
      type: cleanText(row.payee_type),
      id: cleanText(row.payee_id),
      name: cleanText(row.payee_name),
      worker_type: cleanText(row.worker_type)
    },
    schedule_id: cleanText(row.schedule_id),
    kind: cleanText(row.kind),
    subgroup: cleanText(row.subgroup),
    state: cleanText(row.state),
    amount_cents: amountCents,
    applied_cents: appliedCents,
    remaining_cents: amountCents - appliedCents,
    currency: cleanText(row.currency || "USD"),
    project_id: cleanText(row.project_id),
    project_title: cleanText(row.project_title),
    worked_at: cleanText(row.worked_at),
    completed_at: cleanText(row.completed_at),
    eligible_at: cleanText(row.eligible_at),
    source_event_id: cleanText(row.source_event_id),
    source_trigger_id: cleanText(row.source_trigger_id),
    description: cleanText(row.description),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    voided_at: cleanText(row.voided_at)
  };
}

function ledgerSelect() {
  return `SELECT l.*, COALESCE((SELECT SUM(a.applied_cents) FROM payroll_allocations a
    JOIN payroll_batches b ON b.id=a.batch_id WHERE a.ledger_entry_id=l.id AND b.status<>'void'), 0) AS applied_cents
    FROM payroll_ledger_entries l`;
}

export async function readPayrollLedgerEntry(orgId: string, entryId: string) {
  const row = (await getPayrollDatabase().prepare(`${ledgerSelect()} WHERE l.organization_id=? AND l.id=?`).get(orgId, entryId));
  if (!row) throw notFound("payroll_ledger_entry_not_found", "Payroll ledger entry was not found.");
  return ledgerEntryView(row);
}

export async function findPayrollLedgerSourceEntries(orgId: string, sourceEventId: string) {
  return (await getPayrollDatabase().prepare(`${ledgerSelect()} WHERE l.organization_id=? AND l.source_event_id=? ORDER BY l.created_at, l.id`)
    .all(orgId, sourceEventId)).map(ledgerEntryView);
}

export async function listPayrollLedgerEntries(orgId: string, options: JsonObject = {}) {
  const conditions = ["l.organization_id=?"];
  const params: SQLInputValue[] = [orgId];
  const mapping: Array<[string, string]> = [
    ["schedule_id", "l.schedule_id"], ["state", "l.state"], ["kind", "l.kind"], ["project_id", "l.project_id"],
    ["payee_id", "l.payee_id"], ["payee_type", "l.payee_type"], ["source_event_id", "l.source_event_id"]
  ];
  for (const [key, column] of mapping) {
    const value = cleanText(options[key]);
    if (value) { conditions.push(`${column}=?`); params.push(value); }
  }
  if (cleanText(options.eligible_through)) { conditions.push("l.eligible_at<=?"); params.push(cleanText(options.eligible_through)); }
  if (cleanText(options.eligible_from)) { conditions.push("l.eligible_at>=?"); params.push(cleanText(options.eligible_from)); }
  if (options.open_only === true || cleanText(options.open_only) === "1") {
    conditions.push(`l.state<>'void' AND (l.amount_cents - COALESCE((SELECT SUM(a2.applied_cents) FROM payroll_allocations a2
      JOIN payroll_batches b2 ON b2.id=a2.batch_id WHERE a2.ledger_entry_id=l.id AND b2.status<>'void'), 0)) <> 0`);
  }
  const limit = Math.max(1, Math.min(5000, Math.floor(Number(options.limit || 500))));
  params.push(limit);
  return (await getPayrollDatabase().prepare(`${ledgerSelect()} WHERE ${conditions.join(" AND ")} ORDER BY l.eligible_at ASC, l.created_at ASC LIMIT ?`)
    .all(...params)).map(ledgerEntryView);
}

function normalizedEarningsPayees(payees: PayrollPayeeRef[]) {
  const seen = new Set<string>();
  return payees.map((payee) => ({
    type: payee.type === "organization_connection" ? "organization_connection" : "organization_user",
    id: cleanText(payee.id),
    name: cleanText(payee.name),
    worker_type: ["subcontractor", "independent_contractor"].includes(cleanText(payee.worker_type))
      ? cleanText(payee.worker_type) as PayrollPayeeRef["worker_type"] : "employee"
  } as PayrollPayeeRef)).filter((payee) => {
    const key = `${payee.type}:${payee.id}`;
    if (!payee.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function earningsPayeeCondition(alias: string, payees: PayrollPayeeRef[], params: SQLInputValue[]) {
  const conditions = payees.map((payee) => {
    params.push(payee.type, payee.id);
    return `(${alias}.payee_type=? AND ${alias}.payee_id=?)`;
  });
  return `(${conditions.join(" OR ")})`;
}

/**
 * Fetches the ledger and payment records used by self-service earnings views.
 * All requested payees are resolved in one ledger query and one payment query;
 * callers are responsible for authorizing the requested subjects.
 */
export async function listPayrollEarningsRecords(orgId: string, payeeValues: PayrollPayeeRef[], options: JsonObject = {}) {
  const payees = normalizedEarningsPayees(payeeValues);
  if (!payees.length) throw badRequest("payroll_payee_required", "At least one payroll payee is required.");
  if (payees.length > 100) throw badRequest("payroll_payee_limit", "At most 100 payroll payees can be requested at once.");

  const projectId = cleanText(options.project_id);
  const from = cleanText(options.from || options.eligible_from);
  const through = cleanText(options.through || options.to || options.eligible_through);
  const includeProjected = options.include_projected !== false && cleanText(options.include_projected) !== "0";
  const entryLimit = Math.max(1, Math.min(10_000, Math.floor(Number(options.entry_limit || options.limit || 2_000))));
  const paymentLimit = Math.max(1, Math.min(2_000, Math.floor(Number(options.payment_limit || options.limit || 500))));

  const entryConditions = ["l.organization_id=?", "l.state<>'void'"];
  const entryParams: SQLInputValue[] = [orgId];
  entryConditions.push(earningsPayeeCondition("l", payees, entryParams));
  if (!includeProjected) entryConditions.push("l.state<>'projected'");
  if (projectId) { entryConditions.push("l.project_id=?"); entryParams.push(projectId); }
  if (from) { entryConditions.push("l.eligible_at>=?"); entryParams.push(from); }
  if (through) { entryConditions.push("l.eligible_at<=?"); entryParams.push(/^\d{4}-\d{2}-\d{2}$/.test(through) ? `${through}T23:59:59.999Z` : through); }
  entryParams.push(entryLimit + 1);
  const entryRows = (await getPayrollDatabase().prepare(`${ledgerSelect()} WHERE ${entryConditions.join(" AND ")}
    ORDER BY l.eligible_at DESC, l.created_at DESC, l.id DESC LIMIT ?`).all(...entryParams));
  const entriesTruncated = entryRows.length > entryLimit;
  const entries = entryRows.slice(0, entryLimit).map(ledgerEntryView);

  const paymentConditions = ["i.organization_id=?", "b.status<>'void'"];
  const paymentParams: SQLInputValue[] = [orgId];
  paymentConditions.push(earningsPayeeCondition("i", payees, paymentParams));
  if (projectId) {
    paymentConditions.push(`EXISTS (SELECT 1 FROM payroll_allocations project_allocation
      JOIN payroll_ledger_entries project_entry ON project_entry.id=project_allocation.ledger_entry_id
      WHERE project_allocation.batch_item_id=i.id AND project_entry.project_id=?)`);
    paymentParams.push(projectId);
  }
  if (from) { paymentConditions.push("b.pay_date>=?"); paymentParams.push(from.slice(0, 10)); }
  if (through) { paymentConditions.push("b.pay_date<=?"); paymentParams.push(through.slice(0, 10)); }
  paymentParams.push(paymentLimit + 1);
  const paymentRows = (await getPayrollDatabase().prepare(`SELECT i.*, b.schedule_id, b.pay_date, b.period_start, b.period_end,
      b.status AS batch_status, b.currency AS batch_currency, s.name AS schedule_name
    FROM payroll_batch_items i
    JOIN payroll_batches b ON b.id=i.batch_id AND b.organization_id=i.organization_id
    LEFT JOIN payroll_schedules s ON s.organization_id=b.organization_id AND s.id=b.schedule_id
    WHERE ${paymentConditions.join(" AND ")}
    ORDER BY b.pay_date DESC, i.created_at DESC, i.id DESC LIMIT ?`).all(...paymentParams));
  const paymentsTruncated = paymentRows.length > paymentLimit;
  const selectedPaymentRows = paymentRows.slice(0, paymentLimit);
  const itemIds = selectedPaymentRows.map((row) => cleanText(asObject(row).id));
  const allocationsByItem = new Map<string, JsonObject[]>();
  if (itemIds.length) {
    const allocationParams: SQLInputValue[] = [orgId, ...itemIds];
    const allocationConditions = ["a.organization_id=?", `a.batch_item_id IN (${itemIds.map(() => "?").join(",")})`];
    if (projectId) { allocationConditions.push("l.project_id=?"); allocationParams.push(projectId); }
    const allocationRows = (await getPayrollDatabase().prepare(`SELECT a.batch_item_id, a.ledger_entry_id, a.applied_cents,
        l.project_id, l.project_title, l.kind, l.subgroup, l.description, l.eligible_at
      FROM payroll_allocations a
      JOIN payroll_ledger_entries l ON l.id=a.ledger_entry_id
      WHERE ${allocationConditions.join(" AND ")}
      ORDER BY a.batch_item_id, l.eligible_at, l.created_at, l.id`).all(...allocationParams));
    for (const rowValue of allocationRows) {
      const row = asObject(rowValue);
      const itemId = cleanText(row.batch_item_id);
      const allocation = {
        ledger_entry_id: cleanText(row.ledger_entry_id),
        amount_cents: Number(row.applied_cents || 0),
        project_id: cleanText(row.project_id),
        project_title: cleanText(row.project_title),
        kind: cleanText(row.kind),
        subgroup: cleanText(row.subgroup),
        description: cleanText(row.description),
        eligible_at: cleanText(row.eligible_at)
      };
      allocationsByItem.set(itemId, [...(allocationsByItem.get(itemId) || []), allocation]);
    }
  }
  const payments = selectedPaymentRows.map((rowValue) => {
    const row = asObject(rowValue);
    return {
      ...batchItemView(row),
      batch_status: cleanText(row.batch_status),
      pay_date: cleanText(row.pay_date),
      period_start: cleanText(row.period_start),
      period_end: cleanText(row.period_end),
      currency: cleanText(row.batch_currency || "USD"),
      schedule: { id: cleanText(row.schedule_id), name: cleanText(row.schedule_name) },
      allocations: allocationsByItem.get(cleanText(row.id)) || []
    };
  });

  return {
    payees,
    entries,
    payments,
    filters: { project_id: projectId, from, through, include_projected: includeProjected },
    truncated: entriesTruncated || paymentsTruncated,
    entries_truncated: entriesTruncated,
    payments_truncated: paymentsTruncated
  };
}

export async function upsertPayrollLedgerEntry(orgId: string, input: PayrollLedgerEntryInput & JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const payee = input.payee;
  const existing = (await getPayrollDatabase().prepare(`SELECT id, state FROM payroll_ledger_entries
    WHERE organization_id=? AND source_event_id=? AND source_trigger_id=? AND payee_type=? AND payee_id=?`)
    .get(orgId, input.source_event_id, cleanText(input.source_trigger_id), payee.type, payee.id));
  const existingValue = asObject(existing);
  const now = nowIso();
  if (cleanText(existingValue.id)) {
    const existingState = cleanText(existingValue.state);
    if (existingState === "accrued" && input.state === "projected") return (await readPayrollLedgerEntry(orgId, cleanText(existingValue.id)));
    if (existingState === "accrued") {
      const current = (await readPayrollLedgerEntry(orgId, cleanText(existingValue.id)));
      const retryIsIdentical = current.amount_cents === input.amount_cents
        && current.kind === input.kind
        && current.schedule_id === cleanText(input.schedule_id)
        && current.eligible_at === cleanText(input.eligible_at)
        && cleanText(input.state || "accrued") === "accrued";
      if (retryIsIdentical) return current;
      throw conflict("payroll_ledger_entry_immutable", "Accrued payroll ledger entries are immutable; append an adjustment or clawback instead.");
    }
    if (existingState === "void") {
      const current = (await readPayrollLedgerEntry(orgId, cleanText(existingValue.id)));
      if (input.state !== "projected" || asObject(current.metadata).commission_payee_removed !== true) {
        throw conflict("payroll_ledger_entry_immutable", "Voided payroll ledger entries are immutable.");
      }
    }
    (await getPayrollDatabase().prepare(`UPDATE payroll_ledger_entries SET payee_name=?, worker_type=?, schedule_id=?, kind=?, subgroup=?, state=?,
      amount_cents=?, currency=?, project_id=?, project_title=?, worked_at=?, completed_at=?, eligible_at=?, source_trigger_id=?, description=?,
      metadata_json=?, revision=revision+1, updated_at=?, voided_at=? WHERE organization_id=? AND id=?`)
      .run(cleanText(payee.name), cleanText(payee.worker_type || (payee.type === "organization_connection" ? "subcontractor" : "employee")),
        cleanText(input.schedule_id) || null, input.kind, cleanText(input.subgroup || input.kind), input.state || "accrued", input.amount_cents,
        cleanText(input.currency || "USD").toUpperCase(), cleanText(input.project_id), cleanText(input.project_title), cleanText(input.worked_at) || null,
        cleanText(input.completed_at) || null, cleanText(input.eligible_at), cleanText(input.source_trigger_id), cleanText(input.description),
        json(input.metadata || {}), now, input.state === "void" ? now : null, orgId, cleanText(existingValue.id)));
    return (await readPayrollLedgerEntry(orgId, cleanText(existingValue.id)));
  }
  const id = cleanText(input.id) || generatedId("pay_entry");
  (await getPayrollDatabase().prepare(`INSERT INTO payroll_ledger_entries
    (id, organization_id, payee_type, payee_id, payee_name, worker_type, schedule_id, kind, subgroup, state, amount_cents, currency,
     project_id, project_title, worked_at, completed_at, eligible_at, source_event_id, source_trigger_id, description, metadata_json,
     revision, created_at, updated_at, voided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, orgId, payee.type, payee.id, cleanText(payee.name), cleanText(payee.worker_type || (payee.type === "organization_connection" ? "subcontractor" : "employee")),
      cleanText(input.schedule_id) || null, input.kind, cleanText(input.subgroup || input.kind), input.state || "accrued", input.amount_cents,
      cleanText(input.currency || "USD").toUpperCase(), cleanText(input.project_id), cleanText(input.project_title), cleanText(input.worked_at) || null,
      cleanText(input.completed_at) || null, cleanText(input.eligible_at), input.source_event_id, cleanText(input.source_trigger_id),
      cleanText(input.description), json(input.metadata || {}), now, now, input.state === "void" ? now : null));
  return (await readPayrollLedgerEntry(orgId, id));

  }));
}

export async function voidPayrollLedgerEntry(orgId: string, entryId: string, metadataPatch: JsonObject = {}) {
  return (await getPayrollDatabase().transaction(async () => {
  const current = (await readPayrollLedgerEntry(orgId, entryId));
  if (current.applied_cents !== 0) throw badRequest("payroll_entry_already_allocated", "Allocated payroll entries cannot be voided; create an adjustment or clawback instead.");
  const now = nowIso();
  (await getPayrollDatabase().prepare("UPDATE payroll_ledger_entries SET state='void', metadata_json=?, voided_at=?, updated_at=?, revision=revision+1 WHERE organization_id=? AND id=?")
    .run(json({ ...asObject(current.metadata), ...metadataPatch }), now, now, orgId, entryId));
  return (await readPayrollLedgerEntry(orgId, entryId));

  }));
}

function batchView(rowValue: unknown) {
  const row = asObject(rowValue);
  const metadata = asObject(parseJson(row.metadata_json));
  return {
    id: cleanText(row.id), organization_id: cleanText(row.organization_id), schedule_id: cleanText(row.schedule_id),
    pay_date: cleanText(row.pay_date), period_start: cleanText(row.period_start), period_end: cleanText(row.period_end),
    status: cleanText(row.status), currency: cleanText(row.currency || "USD"), total_cents: Number(row.total_cents || 0),
    employee_total_cents: Number(row.employee_total_cents || 0), subcontractor_total_cents: Number(row.subcontractor_total_cents || 0),
    metadata, run_type: cleanText(metadata.run_type || "regular"), approval: asObject(metadata.approval),
    revision: Number(row.revision || 1), created_by: cleanText(row.created_by),
    created_at: cleanText(row.created_at), updated_at: cleanText(row.updated_at), run_at: cleanText(row.run_at),
    paid_at: cleanText(row.paid_at), voided_at: cleanText(row.voided_at)
  };
}

function batchItemView(rowValue: unknown) {
  const row = asObject(rowValue);
  return {
    id: cleanText(row.id), batch_id: cleanText(row.batch_id), organization_id: cleanText(row.organization_id),
    payee: { type: cleanText(row.payee_type), id: cleanText(row.payee_id), name: cleanText(row.payee_name), worker_type: cleanText(row.worker_type) },
    status: cleanText(row.status), gross_cents: Number(row.gross_cents || 0), commission_cents: Number(row.commission_cents || 0),
    deduction_cents: Number(row.deduction_cents || 0), net_cents: Number(row.net_cents || 0),
    subgroup_totals: asObject(parseJson(row.subgroup_totals_json)), payment_reference: cleanText(row.payment_reference),
    metadata: asObject(parseJson(row.metadata_json)), revision: Number(row.revision || 1), created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at), run_at: cleanText(row.run_at), paid_at: cleanText(row.paid_at)
  };
}

export async function readPayrollBatch(orgId: string, batchId: string) {
  const row = (await getPayrollDatabase().prepare("SELECT * FROM payroll_batches WHERE organization_id=? AND id=?").get(orgId, batchId));
  if (!row) throw notFound("payroll_batch_not_found", "Payroll batch was not found.");
  const batch = batchView(row);
  const items = (await Promise.all((await getPayrollDatabase().prepare("SELECT * FROM payroll_batch_items WHERE organization_id=? AND batch_id=? ORDER BY worker_type, payee_name, payee_id")
    .all(orgId, batchId)).map(async (itemRow) => {
      const item = batchItemView(itemRow);
      const entries = (await getPayrollDatabase().prepare(`SELECT l.*, a.applied_cents AS allocation_cents
        FROM payroll_allocations a JOIN payroll_ledger_entries l ON l.id=a.ledger_entry_id
        WHERE a.organization_id=? AND a.batch_item_id=? ORDER BY l.eligible_at, l.created_at`)
        .all(orgId, item.id)).map((entryRow) => ({ ...ledgerEntryView(entryRow), allocation_cents: Number(asObject(entryRow).allocation_cents || 0) }));
      return { ...item, entries };
    })));
  return { ...batch, items };
}

export async function listPayrollBatches(orgId: string, options: JsonObject = {}) {
  const conditions = ["organization_id=?"];
  const params: SQLInputValue[] = [orgId];
  if (cleanText(options.schedule_id)) { conditions.push("schedule_id=?"); params.push(cleanText(options.schedule_id)); }
  if (cleanText(options.status)) { conditions.push("status=?"); params.push(cleanText(options.status)); }
  if (cleanText(options.from)) { conditions.push("pay_date>=?"); params.push(cleanText(options.from)); }
  if (cleanText(options.through)) { conditions.push("pay_date<=?"); params.push(cleanText(options.through)); }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(options.limit || 100))));
  params.push(limit);
  const rows = (await getPayrollDatabase().prepare(`SELECT * FROM payroll_batches WHERE ${conditions.join(" AND ")} ORDER BY pay_date DESC, created_at DESC LIMIT ?`).all(...params));
  return (await Promise.all(rows.map(async (row) => (await readPayrollBatch(orgId, cleanText(asObject(row).id))))));
}

export async function readPayrollBatchItem(orgId: string, batchId: string, itemId: string) {
  const row = (await getPayrollDatabase().prepare("SELECT * FROM payroll_batch_items WHERE organization_id=? AND batch_id=? AND id=?")
    .get(orgId, batchId, itemId));
  if (!row) throw notFound("payroll_batch_item_not_found", "Payroll batch item was not found.");
  return batchItemView(row);
}

function payrollArtifactView(rowValue: unknown, includeContent = false) {
  const row = asObject(rowValue);
  const content = row.content_blob instanceof Uint8Array ? Buffer.from(row.content_blob) : row.content_blob;
  return {
    id: cleanText(row.id), organization_id: cleanText(row.organization_id), batch_id: cleanText(row.batch_id),
    artifact_type: cleanText(row.artifact_type), report_type: cleanText(row.report_type), file_name: cleanText(row.file_name),
    content_type: cleanText(row.content_type), metadata: asObject(parseJson(row.metadata_json)), created_by: cleanText(row.created_by),
    created_at: cleanText(row.created_at), size_bytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(cleanText(content)),
    ...(includeContent ? { content: Buffer.isBuffer(content) ? content : Buffer.from(cleanText(content)) } : {})
  };
}

export async function createPayrollArtifact(orgId: string, input: JsonObject, actorUserId = "") {
  return (await getPayrollDatabase().transaction(async () => {
  const id = cleanText(input.id) || generatedId("payroll_artifact");
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(String(input.content ?? ""));
  const createdAt = nowIso();
  (await getPayrollDatabase().prepare(`INSERT INTO payroll_artifacts
    (id, organization_id, batch_id, artifact_type, report_type, file_name, content_type, content_blob, metadata_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, cleanText(input.batch_id), cleanText(input.artifact_type || "export"), cleanText(input.report_type),
      cleanText(input.file_name), cleanText(input.content_type || "application/octet-stream"), content,
      json(asObject(input.metadata)), actorUserId, createdAt));
  return (await readPayrollArtifact(orgId, id));

  }));
}

export async function readPayrollArtifact(orgId: string, artifactId: string, includeContent = false) {
  const row = (await getPayrollDatabase().prepare("SELECT * FROM payroll_artifacts WHERE organization_id=? AND id=?").get(orgId, artifactId));
  if (!row) throw notFound("payroll_artifact_not_found", "Payroll export or report was not found.");
  return payrollArtifactView(row, includeContent);
}

export async function listPayrollArtifacts(orgId: string, options: JsonObject = {}) {
  const conditions = ["organization_id=?"];
  const params: SQLInputValue[] = [orgId];
  if (cleanText(options.batch_id)) { conditions.push("batch_id=?"); params.push(cleanText(options.batch_id)); }
  if (cleanText(options.artifact_type)) { conditions.push("artifact_type=?"); params.push(cleanText(options.artifact_type)); }
  if (cleanText(options.report_type)) { conditions.push("report_type=?"); params.push(cleanText(options.report_type)); }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(options.limit || 100))));
  params.push(limit);
  return (await getPayrollDatabase().prepare(`SELECT * FROM payroll_artifacts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)).map((row) => payrollArtifactView(row));
}

export const payrollViews = { scheduleView, policyView, projectPayeeView, ledgerEntryView, batchView, batchItemView };
