import { env } from "../src/config/env.js";
import { platformTaskStatus, runPlatformTask, withPlatformTaskLease } from "../platform/worker_tasks.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { platformBackgroundAllowed } from "../platform/runtime.js";
// Keeps the stats warehouse fresh without ever rescanning everything on read.
//
// Strategy, in order of preference:
//   1. Backfill once per org (chunked) when stats are first used.
//   2. Incrementally tail the work-engine event log by rowid cursor: new
//      events are mirrored into stats_events and their project ids marked
//      dirty, then only those fact rows are rebuilt.
//   3. A rolling reconcile sweep rebuilds the stalest fact rows a few at a
//      time, healing drift the event tail cannot see (e.g. payment edits
//      that emit no work event) and removing rows for deleted projects.
//
// All three paths run through refreshProjectFacts, which batch-loads the
// supporting data (plans/nodes from work.sqlite, money docs grouped by
// project) once per call rather than per project.

import {
  listDocuments,
  readDocument,
  type JsonObject
} from "../platform/storage.js";
import {
  PAYMENT_OBLIGATION_COLLECTION,
  PAYMENT_PAYABLE_COLLECTION,
  PAYMENT_TRANSACTION_COLLECTION
} from "../payments/storage.js";
import { projectLifecycleFacts } from "../work/service.js";
import { getWorkDatabase, planFromRow } from "../work/storage.js";
import {
  bumpDataVersion,
  deleteProjectFacts,
  ensureSyncState,
  insertStatsEvents,
  listActiveStatsOrgIds,
  listFactProjectIds,
  readSyncState,
  stalestProjectFacts,
  updateSyncState,
  upsertProjectFact
} from "./storage.js";

const EVENT_BATCH = 2_000;
const FACT_BATCH = 400;
const RECONCILE_CHUNK = 100;
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const INCREMENTAL_MIN_INTERVAL_MS = 5_000;
const SCHEDULER_INTERVAL_MS = 15_000;

const syncing = new Set<string>();

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function documentView(doc: unknown): JsonObject {
  const source = asObject(doc);
  const data = asObject(source.data);
  return {
    ...data,
    id: cleanText(data.id || source.id),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

function groupByProject(items: JsonObject[]) {
  const grouped = new Map<string, JsonObject[]>();
  for (const item of items) {
    const projectId = cleanText(item.project_id);
    if (!projectId) continue;
    grouped.set(projectId, [...(grouped.get(projectId) || []), item]);
  }
  return grouped;
}

// ── Money facts (batched: whole collections loaded once per call) ──────────

type MoneyGroups = {
  obligations: Map<string, JsonObject[]>;
  payments: Map<string, JsonObject[]>;
  payables: Map<string, JsonObject[]>;
  materialLists: Map<string, JsonObject[]>;
  materialOrders: Map<string, JsonObject[]>;
};

async function loadMoneyGroups(orgId: string): Promise<MoneyGroups> {
  const load = async (collection: string) => {
    try {
      return (await listDocuments(orgId, collection)).map(documentView);
    } catch {
      return [] as JsonObject[];
    }
  };
  const [obligations, payments, payables, materialLists, materialOrders] = await Promise.all([
    load(PAYMENT_OBLIGATION_COLLECTION),
    load(PAYMENT_TRANSACTION_COLLECTION),
    load(PAYMENT_PAYABLE_COLLECTION),
    load("material_lists"),
    load("material_orders")
  ]);
  return {
    obligations: groupByProject(obligations),
    payments: groupByProject(payments),
    payables: groupByProject(payables.filter((item) => cleanText(item.status) !== "void")),
    materialLists: groupByProject(materialLists),
    materialOrders: groupByProject(materialOrders)
  };
}

function materialTotals(lists: JsonObject[], orders: JsonObject[]) {
  const active = lists.filter((list) => cleanText(list.status) !== "archived"
    && !["labor", "equipment"].includes(cleanText(list.resource_type).toLowerCase()));
  const sumItems = (key: string) => active.reduce((total, list) => total + asArray(list.current_items).map(asObject).reduce((sum, item) => {
    const value = Number(item[key]);
    return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0);
  }, 0), 0);
  const paidOrders = orders.reduce((total, order) => {
    const paid = asObject(order.paid_price);
    const paidPrice = cents(paid.amount_cents ?? paid.cents ?? (Number(paid.amount) * 100));
    const paidTotal = Math.round(Number(asObject(order.totals).paid_total || 0) * 100);
    return total + Math.max(paidPrice, paidTotal, 0);
  }, 0);
  return { projected: sumItems("projected_total"), paid: Math.max(sumItems("paid_total"), paidOrders) };
}

function projectMoneyFacts(projectId: string, groups: MoneyGroups) {
  const obligations = (groups.obligations.get(projectId) || []).filter((item) => cleanText(item.status) !== "void");
  const payments = groups.payments.get(projectId) || [];
  const payables = groups.payables.get(projectId) || [];
  const materials = materialTotals(groups.materialLists.get(projectId) || [], groups.materialOrders.get(projectId) || []);
  const contract = obligations.reduce((sum, item) => sum + Math.max(0, cents(item.amount_cents)), 0);
  const allocated = obligations.reduce((sum, item) => sum + Math.max(0, cents(item.allocated_cents)), 0);
  const refunds = payments
    .filter((payment) => cleanText(payment.direction) === "outbound" && cleanText(payment.kind) === "customer_refund")
    .reduce((sum, payment) => sum + Math.max(0, cents(payment.amount_cents)), 0);
  const collected = payments
    .filter((payment) => cleanText(payment.direction) === "inbound"
      && ["settled", "partially_refunded", "refunded"].includes(cleanText(payment.status)))
    .reduce((sum, payment) => sum + Math.max(0, cents(payment.amount_cents)), 0) - refunds;
  const payableProjected = payables.reduce((sum, payable) => sum + Math.max(0, cents(payable.amount_cents)), 0);
  const payablePaid = payables.reduce((sum, payable) => sum + Math.max(0, cents(payable.paid_cents)), 0);
  const projectedExpenses = payableProjected + materials.projected;
  const expenses = payablePaid + materials.paid;
  return {
    contract_cents: contract,
    collected_cents: collected,
    outstanding_cents: Math.max(0, contract - allocated),
    projected_expenses_cents: projectedExpenses,
    expenses_cents: expenses,
    projected_profit_cents: contract - projectedExpenses,
    profit_cents: collected - expenses
  };
}

// ── Work-engine facts (batched SQL over work.sqlite) ───────────────────────

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function loadPlansByProject(orgId: string, projectIds: string[]) {
  const db = getWorkDatabase();
  const grouped = new Map<string, JsonObject[]>();
  for (const ids of chunk(projectIds, FACT_BATCH)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = (await db.prepare(`SELECT * FROM work_plans WHERE organization_id = ? AND project_id IN (${placeholders})`)
      .all(orgId, ...ids)).map(planFromRow);
    for (const plan of rows) {
      const projectId = cleanText(plan.project_id);
      grouped.set(projectId, [...(grouped.get(projectId) || []), plan]);
    }
  }
  return grouped;
}

async function loadStagesByProject(orgId: string, projectIds: string[]) {
  const db = getWorkDatabase();
  const stages = new Map<string, { key: string; title: string }>();
  for (const ids of chunk(projectIds, FACT_BATCH)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = (await db.prepare(`SELECT project_id, template_node_id, title FROM work_nodes
      WHERE organization_id = ? AND status = 'active' AND terminology_key LIKE '%stage' AND project_id IN (${placeholders})
      ORDER BY depth ASC, sort_order ASC`).all(orgId, ...ids));
    for (const raw of rows) {
      const row = asObject(raw);
      const projectId = cleanText(row.project_id);
      if (!stages.has(projectId)) stages.set(projectId, { key: cleanText(row.template_node_id), title: cleanText(row.title) });
    }
  }
  return stages;
}

async function loadAssignedByProject(orgId: string, projectIds: string[]) {
  const db = getWorkDatabase();
  const assigned = new Map<string, string[]>();
  for (const ids of chunk(projectIds, FACT_BATCH)) {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = (await db.prepare(`SELECT project_id, assigned_user_ids_json FROM work_nodes
      WHERE organization_id = ? AND assigned_user_ids_json <> '[]' AND project_id IN (${placeholders})`).all(orgId, ...ids));
    for (const raw of rows) {
      const row = asObject(raw);
      const projectId = cleanText(row.project_id);
      let users: string[] = [];
      try {
        users = asArray(JSON.parse(String(row.assigned_user_ids_json || "[]"))).map(cleanText).filter(Boolean);
      } catch {}
      if (!users.length) continue;
      const current = assigned.get(projectId) || [];
      assigned.set(projectId, [...new Set([...current, ...users])]);
    }
  }
  return assigned;
}

async function loadTemplateTitles(orgId: string) {
  const titles = new Map<string, string>();
  const rows = (await getWorkDatabase().prepare("SELECT id, name FROM scope_templates WHERE organization_id = ?").all(orgId));
  for (const raw of rows) {
    const row = asObject(raw);
    titles.set(cleanText(row.id), cleanText(row.name));
  }
  return titles;
}

// ── Fact building ──────────────────────────────────────────────────────────

function projectAttrs(data: JsonObject) {
  const attrs: JsonObject = {};
  const custom = asObject(data.custom_fields);
  let count = 0;
  for (const [rawKey, value] of Object.entries(custom)) {
    if (count >= 40) break;
    const key = rawKey.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
    if (!key) continue;
    if (typeof value === "number" && Number.isFinite(value)) attrs[key] = value;
    else if (typeof value === "boolean") attrs[key] = value ? 1 : 0;
    else {
      const text = cleanText(value);
      if (!text || text.length > 120) continue;
      const numeric = Number(text);
      attrs[key] = Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(text) ? numeric : text;
    }
    count += 1;
  }
  return attrs;
}

function primaryTemplate(plans: JsonObject[], templateTitles: Map<string, string>) {
  const visible = plans.filter((plan) => asObject(plan.metadata).hide_from_boards !== true);
  const considered = visible.length ? visible : plans;
  const active = considered.find((plan) => cleanText(plan.status) === "active") || considered[0];
  const templateId = cleanText(active?.template_id);
  return {
    template_id: templateId,
    template_title: templateTitles.get(templateId) || cleanText(active?.title)
  };
}

export async function refreshProjectFacts(orgId: string, projectIds: string[], options: { moneyGroups?: MoneyGroups; assertLease?: () => Promise<void> } = {}) {
  const ids = [...new Set(projectIds.map(cleanText).filter(Boolean))];
  if (!ids.length) return 0;
  const moneyGroups = options.moneyGroups ?? await loadMoneyGroups(orgId);
  const plansByProject = (await loadPlansByProject(orgId, ids));
  const stagesByProject = (await loadStagesByProject(orgId, ids));
  const assignedByProject = (await loadAssignedByProject(orgId, ids));
  const templateTitles = (await loadTemplateTitles(orgId));

  let changed = 0;
  const missing: string[] = [];
  const concurrency = 16;
  for (const batch of chunk(ids, concurrency)) {
    await options.assertLease?.();
    const docs = await Promise.all(batch.map(async (projectId) => ({
      projectId,
      doc: await readDocument(orgId, "projects", projectId).catch(() => null)
    })));
    for (const { projectId, doc } of docs) {
      if (!doc) {
        missing.push(projectId);
        continue;
      }
      const data = asObject(asObject(doc).data);
      const plans = plansByProject.get(projectId) || [];
      const lifecycle = plans.length
        ? projectLifecycleFacts(plans)
        : {
          status: cleanText(data.lead_status) === "lost" ? "lost" : "open",
          sold_at: "",
          completed_at: "",
          canceled_at: ""
        };
      const stage = stagesByProject.get(projectId);
      const template = primaryTemplate(plans, templateTitles);
      const assigned = assignedByProject.get(projectId) || [];
      // created_by_user_id is deliberately excluded: system/API creators
      // (e.g. notification or intake robots) must not be credited as reps.
      const primaryUser = cleanText(
        data.assigned_user_id || data.salesperson_id || data.sales_rep_id || data.owner_user_id
        || assigned[0]
      );
      await options.assertLease?.();
      (await withPlatformTaskLease(() => upsertProjectFact({
        organization_id: orgId,
        project_id: projectId,
        branch_id: cleanText(data.branch_id || "default") || "default",
        title: cleanText(data.title || data.project_title || data.project_name || data.address || data.customer_name),
        status: lifecycle.status,
        source: cleanText(data.source || data.source_kind || data.lead_source).toLowerCase(),
        template_id: template.template_id,
        template_title: template.template_title,
        stage_key: cleanText(stage?.key),
        stage_title: cleanText(stage?.title),
        primary_user_id: primaryUser,
        assigned_user_ids: assigned,
        created_at: cleanText(asObject(doc).created_at || data.created_at),
        sold_at: cleanText(lifecycle.sold_at),
        completed_at: cleanText(lifecycle.completed_at),
        canceled_at: cleanText(lifecycle.canceled_at),
        updated_at: cleanText(asObject(doc).updated_at || data.updated_at),
        attrs: projectAttrs(data),
        ...projectMoneyFacts(projectId, moneyGroups)
      })));
      changed += 1;
    }
  }
  if (missing.length) {
    await options.assertLease?.();
    (await withPlatformTaskLease(() => deleteProjectFacts(orgId, missing)));
    changed += missing.length;
  }
  return changed;
}

// ── Event tail ─────────────────────────────────────────────────────────────

async function maxWorkEventRowid(orgId: string) {
  const row = asObject((await getWorkDatabase().prepare("SELECT MAX(rowid) AS max_rowid FROM work_events WHERE organization_id = ?", "SELECT MAX(event_sequence) AS max_rowid FROM work_events WHERE organization_id = ?").get(orgId)));
  return Number(row.max_rowid || 0);
}

async function readEventTail(orgId: string, afterRowid: number, limit: number) {
  return (await getWorkDatabase().prepare(`SELECT rowid AS row_id, id, organization_id, branch_id, project_id, type, actor_user_id, visibility, created_at
    FROM work_events WHERE organization_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`, `SELECT event_sequence AS row_id, id, organization_id, branch_id, project_id, type, actor_user_id, visibility, created_at FROM work_events WHERE organization_id = ? AND event_sequence > ? ORDER BY event_sequence ASC LIMIT ?`)
    .all(orgId, afterRowid, Math.max(1, limit))).map((row) => asObject(row));
}

// ── Sync orchestration ─────────────────────────────────────────────────────

export type StatsSyncResult = {
  ran: boolean;
  backfilled: boolean;
  events_processed: number;
  projects_refreshed: number;
};

export async function syncOrganizationStats(orgId: string, options: { force?: boolean } = {}): Promise<StatsSyncResult> {
  const idle: StatsSyncResult = { ran: false, backfilled: false, events_processed: 0, projects_refreshed: 0 };
  await ensureSyncState(orgId);
  if (env.deploymentTopology === "cluster" && process.env.PLATFORM_PROCESS_ROLE !== "worker") return idle;
  const result = await runPlatformTask(`stats:${orgId}`, 0, assertLease => syncClaimedOrganizationStats(orgId, options, assertLease));
  return result.ran ? result.value : idle;
}
async function syncClaimedOrganizationStats(orgId: string, options: { force?: boolean }, assertLease: () => Promise<void>): Promise<StatsSyncResult> {
  const result: StatsSyncResult = { ran: false, backfilled: false, events_processed: 0, projects_refreshed: 0 };
  if (syncing.has(orgId)) return result;
  const state = (await ensureSyncState(orgId));
  const lastSyncAt = Date.parse(cleanText(state.last_sync_at)) || 0;
  if (!options.force && Number(state.backfill_done) && Date.now() - lastSyncAt < INCREMENTAL_MIN_INTERVAL_MS) return result;
  syncing.add(orgId);
  try {
    result.ran = true;
    if (!Number(state.backfill_done)) {
      await runBackfill(orgId, result, assertLease);
      return result;
    }
    let cursor = Number(state.last_event_rowid || 0);
    let changed = 0;
    for (let round = 0; round < 5; round += 1) {
      await assertLease();
      const tail = (await readEventTail(orgId, cursor, EVENT_BATCH));
      if (!tail.length) break;
      (await withPlatformTaskLease(() => insertStatsEvents(tail)));
      cursor = Number(tail[tail.length - 1]?.row_id ?? cursor);
      result.events_processed += tail.length;
      const dirty = [...new Set(tail.map((event) => cleanText(event.project_id)).filter(Boolean))];
      if (dirty.length) {
        const refreshed = await refreshProjectFacts(orgId, dirty, { assertLease });
        result.projects_refreshed += refreshed;
        changed += refreshed;
      }
      if (tail.length < EVENT_BATCH) break;
    }
    // A forced sync (the explicit refresh endpoint) also rebuilds existing
    // rows so fact-shape changes apply immediately, capped to protect huge
    // orgs — the remainder heals via the rolling reconcile.
    if (options.force) {
      const allIds = (await listFactProjectIds(orgId)).slice(0, 2_000);
      if (allIds.length) {
        const refreshed = await refreshProjectFacts(orgId, allIds, { assertLease });
        result.projects_refreshed += refreshed;
        changed += refreshed;
      }
    }
    // Rolling reconcile: rebuild the stalest rows so money drift and missed
    // deletions heal within hours even with no event traffic.
    const lastReconcile = Date.parse(cleanText(state.last_reconcile_at)) || 0;
    let reconciledAt = cleanText(state.last_reconcile_at);
    if (Date.now() - lastReconcile > RECONCILE_INTERVAL_MS) {
      const stalest = (await stalestProjectFacts(orgId, RECONCILE_CHUNK));
      if (stalest.length) {
        const refreshed = await refreshProjectFacts(orgId, stalest, { assertLease });
        result.projects_refreshed += refreshed;
      }
      reconciledAt = new Date().toISOString();
    }
    await assertLease();
    (await withPlatformTaskLease(() => updateSyncState(orgId, {
      last_event_rowid: cursor,
      last_sync_at: new Date().toISOString(),
      last_reconcile_at: reconciledAt
    })));
    if (changed || result.events_processed) (await withPlatformTaskLease(() => bumpDataVersion(orgId)));
    return result;
  } finally {
    syncing.delete(orgId);
  }
}

async function runBackfill(orgId: string, result: StatsSyncResult, assertLease: () => Promise<void>) {
  // Capture the event cursor BEFORE reading documents so nothing written
  // during the backfill is skipped by the first incremental pass.
  const cursor = (await maxWorkEventRowid(orgId));
  const documents = await listDocuments(orgId, "projects").catch(() => []);
  const projectIds = documents.map((doc) => cleanText(asObject(doc).id)).filter(Boolean);
  const moneyGroups = await loadMoneyGroups(orgId);
  for (const ids of chunk(projectIds, FACT_BATCH)) {
    await assertLease();
    result.projects_refreshed += await refreshProjectFacts(orgId, ids, { moneyGroups, assertLease });
  }
  // Mirror the historical event log (chunked by rowid).
  let eventCursor = 0;
  for (;;) {
    await assertLease();
    const tail = (await readEventTail(orgId, eventCursor, EVENT_BATCH));
    if (!tail.length) break;
    (await withPlatformTaskLease(() => insertStatsEvents(tail)));
    eventCursor = Number(tail[tail.length - 1]?.row_id ?? eventCursor);
    result.events_processed += tail.length;
    if (eventCursor >= cursor && tail.length < EVENT_BATCH) break;
  }
  await assertLease();
  (await withPlatformTaskLease(() => updateSyncState(orgId, {
    last_event_rowid: Math.max(cursor, eventCursor),
    backfill_done: 1,
    project_count: projectIds.length,
    last_sync_at: new Date().toISOString(),
    last_reconcile_at: new Date().toISOString()
  })));
  (await withPlatformTaskLease(() => bumpDataVersion(orgId)));
  result.backfilled = true;
}

// Called by read endpoints: activates the org on first use and keeps reads
// near-real-time without ever blocking a request on a full rebuild.
export async function ensureStatsFreshness(orgId: string, options: { wait?: boolean } = {}) {
  const state = (await ensureSyncState(orgId));
  if (!Number(state.backfill_done)) {
    const promise = syncOrganizationStats(orgId, { force: true }).catch(() => null);
    if (options.wait) await promise;
    return (await readSyncState(orgId));
  }
  const lastSyncAt = Date.parse(cleanText(state.last_sync_at)) || 0;
  if (Date.now() - lastSyncAt >= INCREMENTAL_MIN_INTERVAL_MS) {
    await syncOrganizationStats(orgId).catch(() => null);
  }
  return (await readSyncState(orgId));
}

export async function statsSyncStatus(orgId: string) {
  const state = (await ensureSyncState(orgId));
  return {
    backfill_done: Boolean(Number(state.backfill_done)),
    syncing: (await platformTaskStatus(`stats:${orgId}`)).running,
    data_version: Number(state.data_version || 1),
    project_count: Number(state.project_count || 0),
    last_sync_at: cleanText(state.last_sync_at),
    last_reconcile_at: cleanText(state.last_reconcile_at)
  };
}

// ── Scheduler ──────────────────────────────────────────────────────────────

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;

function schedulerDisabled() {
  return process.env.STATS_SCHEDULER_DISABLED === "1"
    || process.env.PLATFORM_HEARTBEAT_DISABLED === "1"
    || process.env.NODE_ENV === "test";
}

export async function runStatsSchedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    for (const orgId of (await listActiveStatsOrgIds())) {
      try {
        if (!(await isCapabilityEnabled(orgId, "platform.expanded_access"))) continue;
        await syncOrganizationStats(orgId);
      } catch {
        // One org's failure must not stall the others.
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

export function startStatsScheduler() {
  if (!platformBackgroundAllowed()) return;
  if (schedulerTimer || schedulerDisabled()) return;
  schedulerTimer = setInterval(() => {
    void runStatsSchedulerTick();
  }, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref();
}

export function stopStatsScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}
