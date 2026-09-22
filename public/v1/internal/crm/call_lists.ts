import { createHash, randomBytes } from "node:crypto";

import { badRequest, notFound } from "../../platform/errors.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../../platform/storage.js";
import { readWorkConfiguration } from "../../work/config.js";
import { emitWorkEvent } from "../../work/engine.js";
import { createFollowUpTodo, isFollowUpWorkNode, nextFollowUpPolicySchedule, resolveFollowUpOutcome } from "../../work/followups.js";
import { listNodeRecords, readNodeRecord } from "../../work/storage.js";
import path from "node:path";
import { env } from "../../src/config/env.js";
import { openSqlStore, type SqlStore } from "../../platform/sql_store.js";
let callListDb: SqlStore | undefined;
function database() {
  return callListDb ??= openSqlStore({ id: "crm-call-lists", filename: path.resolve(env.platformStorageRoot, "crm-call-lists.sqlite"),
    initialize: initializeCallListDatabase });
}
export function getCallListDatabase() { return database(); }
async function withCallListDb<T>(operation: (db: SqlStore) => T | Promise<T>) { return (await database().transaction(operation)); }

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map(cleanText).filter(Boolean))] : [];
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson(value: unknown, fallback: unknown) {
  try { return JSON.parse(cleanText(value) || json(fallback)); } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

function dueTimestamp(value: unknown) {
  const dueAt = cleanText(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dueAt) ? new Date(`${dueAt}T00:00:00`) : new Date(dueAt);
  return date.getTime();
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dueCalendarKey(value: unknown) {
  const dueAt = cleanText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) return dueAt;
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime()) ? "" : localDateKey(date);
}

function sortFollowUpEntries(entries: JsonObject[], now = Date.now()) {
  return entries.sort((left, right) => {
    const leftTimed = /T\d{2}:\d{2}/.test(cleanText(left.due_at));
    const rightTimed = /T\d{2}:\d{2}/.test(cleanText(right.due_at));
    const leftDue = dueTimestamp(left.due_at);
    const rightDue = dueTimestamp(right.due_at);
    const leftRank = leftTimed ? (leftDue <= now ? 0 : 2) : 1;
    const rightRank = rightTimed ? (rightDue <= now ? 0 : 2) : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftTimed && rightTimed && leftDue !== rightDue) return leftDue - rightDue;
    return Number(right.priority || 0) - Number(left.priority || 0);
  });
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 22)}`;
}

function listKey(value: unknown) {
  const key = cleanText(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!key) throw badRequest("call_list_key_required", "A call-list key is required.");
  return key;
}

function rowObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? { ...(value as JsonObject) } : {};
}

function normalizeList(rowValue: unknown) {
  const row = rowObject(rowValue);
  return {
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    key: cleanText(row.list_key),
    title: cleanText(row.title),
    description: cleanText(row.description),
    kind: cleanText(row.kind),
    icon: cleanText(row.icon) || "fa-phone",
    tone: cleanText(row.tone) || "default",
    status: cleanText(row.status) || "active",
    sort_order: Number(row.sort_order || 0),
    assigned_user_ids: stringArray(parseJson(row.assigned_user_ids_json, [])),
    assigned_role_ids: stringArray(parseJson(row.assigned_role_ids_json, [])),
    metadata: asObject(parseJson(row.metadata_json, {})),
    // Per-list workflow configuration (dispositions, outcomes, retry-policy
    // overrides...) — the Calls tab renders each list's workflow from this.
    settings: asObject(asObject(parseJson(row.metadata_json, {})).settings),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at)
  };
}

function normalizeEntry(rowValue: unknown) {
  const row = rowObject(rowValue);
  return {
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    call_list_id: cleanText(row.call_list_id),
    list_key: cleanText(row.list_key),
    source_key: cleanText(row.source_key),
    subject_type: cleanText(row.subject_type),
    subject_id: cleanText(row.subject_id),
    project_id: cleanText(row.project_id),
    work_plan_id: cleanText(row.work_plan_id),
    work_node_id: cleanText(row.work_node_id),
    title: cleanText(row.title),
    status: cleanText(row.status),
    priority: Number(row.priority || 0),
    due_at: cleanText(row.due_at),
    payload: asObject(parseJson(row.payload_json, {})),
    metadata: asObject(parseJson(row.metadata_json, {})),
    result: asObject(parseJson(row.result_json, {})),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    completed_at: cleanText(row.completed_at)
  };
}

export async function ensureCallListDatabase() { await database().prepare("SELECT 1").get(); }
async function initializeCallListDatabase(db: SqlStore) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS crm_call_lists (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      list_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      kind TEXT DEFAULT '',
      icon TEXT DEFAULT 'fa-phone',
      tone TEXT DEFAULT 'default',
      status TEXT DEFAULT 'active',
      sort_order INTEGER DEFAULT 0,
      assigned_user_ids_json TEXT DEFAULT '[]',
      assigned_role_ids_json TEXT DEFAULT '[]',
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by_email TEXT DEFAULT '',
      updated_by_email TEXT DEFAULT '',
      UNIQUE (organization_id, list_key)
    );
    CREATE TABLE IF NOT EXISTS crm_call_list_entries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      call_list_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      subject_type TEXT DEFAULT 'project',
      subject_id TEXT DEFAULT '',
      project_id TEXT DEFAULT '',
      work_plan_id TEXT DEFAULT '',
      work_node_id TEXT DEFAULT '',
      title TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      due_at TEXT DEFAULT '',
      payload_json TEXT DEFAULT '{}',
      metadata_json TEXT DEFAULT '{}',
      result_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT DEFAULT '',
      UNIQUE (organization_id, call_list_id, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_call_lists_org ON crm_call_lists (organization_id, status, sort_order);
    CREATE INDEX IF NOT EXISTS idx_crm_call_entries_queue ON crm_call_list_entries (organization_id, call_list_id, status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_crm_call_entries_node ON crm_call_list_entries (organization_id, work_node_id);
    CREATE TABLE IF NOT EXISTS crm_call_entry_sources (
      organization_id TEXT NOT NULL, entry_id TEXT NOT NULL, work_node_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(organization_id,entry_id,work_node_id)
    );
  `);
}

export async function ensureCallList(orgIdValue: unknown, inputValue: JsonObject = {}) {
  await ensureCallListDatabase();
  const orgId = cleanText(orgIdValue);
  if (!orgId) throw badRequest("organization_id_required", "An organization id is required.");
  const input = asObject(inputValue);
  if (input.settings !== undefined) {
    input.metadata = { ...asObject(input.metadata), settings: asObject(input.settings) };
  }
  const key = listKey(input.key || input.list_key || input.id);
  const now = nowIso();
  const actor = cleanText(input.actor_email).toLowerCase();
  return (await withCallListDb(async (db) => {
    const current = (await db.prepare("SELECT * FROM crm_call_lists WHERE organization_id = ? AND list_key = ?").get(orgId, key));
    if (!current) {
      (await db.prepare(`INSERT INTO crm_call_lists (id, organization_id, list_key, title, description, kind, icon, tone, status, sort_order,
        assigned_user_ids_json, assigned_role_ids_json, metadata_json, created_at, updated_at, created_by_email, updated_by_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          stableId("call_list", `${orgId}:${key}`), orgId, key, cleanText(input.title) || key.replace(/[._-]+/g, " "), cleanText(input.description),
          cleanText(input.kind), cleanText(input.icon) || "fa-phone", cleanText(input.tone) || "default", cleanText(input.status) || "active",
          Number(input.sort_order || 0), json(stringArray(input.assigned_user_ids)), json(stringArray(input.assigned_role_ids)), json(asObject(input.metadata)),
          now, now, actor, actor
        ));
    } else if (input.create_only !== true) {
      const row = rowObject(current);
      (await db.prepare(`UPDATE crm_call_lists SET title=?, description=?, kind=?, icon=?, tone=?, status=?, sort_order=?, assigned_user_ids_json=?,
        assigned_role_ids_json=?, metadata_json=?, updated_at=?, updated_by_email=? WHERE id=?`).run(
          Object.hasOwn(input, "title") ? cleanText(input.title) : cleanText(row.title),
          Object.hasOwn(input, "description") ? cleanText(input.description) : cleanText(row.description),
          Object.hasOwn(input, "kind") ? cleanText(input.kind) : cleanText(row.kind),
          Object.hasOwn(input, "icon") ? cleanText(input.icon) : cleanText(row.icon),
          Object.hasOwn(input, "tone") ? cleanText(input.tone) : cleanText(row.tone),
          Object.hasOwn(input, "status") ? cleanText(input.status) : cleanText(row.status),
          Object.hasOwn(input, "sort_order") ? Number(input.sort_order || 0) : Number(row.sort_order || 0),
          Object.hasOwn(input, "assigned_user_ids") ? json(stringArray(input.assigned_user_ids)) : cleanText(row.assigned_user_ids_json),
          Object.hasOwn(input, "assigned_role_ids") ? json(stringArray(input.assigned_role_ids)) : cleanText(row.assigned_role_ids_json),
          Object.hasOwn(input, "metadata") ? json({ ...asObject(parseJson(row.metadata_json, {})), ...asObject(input.metadata) }) : cleanText(row.metadata_json),
          now, actor, cleanText(row.id)
        ));
    }
    return normalizeList((await db.prepare("SELECT * FROM crm_call_lists WHERE organization_id = ? AND list_key = ?").get(orgId, key)));
  }));
}

export async function upsertCallListEntry(orgIdValue: unknown, listKeyValue: unknown, inputValue: JsonObject = {}) {
  const orgId = cleanText(orgIdValue);
  const input = asObject(inputValue);
  const list = await ensureCallList(orgId, { ...asObject(input.list), key: listKeyValue });
  const sourceKey = cleanText(input.source_key || input.work_node_id || `${cleanText(input.subject_type || "project")}:${cleanText(input.subject_id || input.project_id)}`);
  if (!sourceKey) throw badRequest("call_list_source_required", "A stable source_key, work_node_id, or subject id is required.");
  const now = nowIso();
  return (await withCallListDb(async (db) => {
    const entryId = stableId("call_entry", `${orgId}:${list.id}:${sourceKey}`);
    if (cleanText(input.work_node_id)) (await db.prepare("INSERT INTO crm_call_entry_sources(organization_id,entry_id,work_node_id,created_at) VALUES(?,?,?,?) ON CONFLICT(organization_id,entry_id,work_node_id) DO NOTHING")
      .run(orgId,entryId,cleanText(input.work_node_id),now));
    const current = (await db.prepare("SELECT * FROM crm_call_list_entries WHERE organization_id = ? AND call_list_id = ? AND source_key = ?")
      .get(orgId, list.id, sourceKey));
    if (!current) {
      (await db.prepare(`INSERT INTO crm_call_list_entries (id, organization_id, call_list_id, source_key, subject_type, subject_id, project_id,
        work_plan_id, work_node_id, title, status, priority, due_at, payload_json, metadata_json, result_json, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, '{}', ?, ?, '')`).run(
          stableId("call_entry", `${orgId}:${list.id}:${sourceKey}`), orgId, list.id, sourceKey, cleanText(input.subject_type || "project"),
          cleanText(input.subject_id || input.project_id), cleanText(input.project_id || input.subject_id), cleanText(input.work_plan_id),
          cleanText(input.work_node_id), cleanText(input.title), Number(input.priority || 0), cleanText(input.due_at), json(asObject(input.payload)),
          json(asObject(input.metadata)), now, now
        ));
    } else {
      const row = rowObject(current);
      if (input.reopen === false && cleanText(row.status) !== "pending") {
        return normalizeEntry((await db.prepare("SELECT e.*, l.list_key FROM crm_call_list_entries e JOIN crm_call_lists l ON l.id=e.call_list_id WHERE e.organization_id=? AND e.call_list_id=? AND e.source_key=?").get(orgId, list.id, sourceKey)));
      }
      (await db.prepare(`UPDATE crm_call_list_entries SET subject_type=?, subject_id=?, project_id=?, work_plan_id=?, work_node_id=?, title=?,
        status='pending', priority=?, due_at=?, payload_json=?, metadata_json=?, result_json='{}', updated_at=?, completed_at='' WHERE id=?`).run(
          cleanText(input.subject_type || row.subject_type || "project"), cleanText(input.subject_id || row.subject_id || input.project_id),
          cleanText(input.project_id || row.project_id || input.subject_id), cleanText(input.work_plan_id || row.work_plan_id),
          cleanText(input.work_node_id || row.work_node_id), cleanText(input.title || row.title),
          Object.hasOwn(input, "priority") ? Number(input.priority || 0) : Number(row.priority || 0), cleanText(input.due_at || row.due_at),
          json({ ...asObject(parseJson(row.payload_json, {})), ...asObject(input.payload) }),
          json({ ...asObject(parseJson(row.metadata_json, {})), ...asObject(input.metadata) }), now, cleanText(row.id)
        ));
    }
    return normalizeEntry((await db.prepare("SELECT e.*, l.list_key FROM crm_call_list_entries e JOIN crm_call_lists l ON l.id=e.call_list_id WHERE e.organization_id=? AND e.call_list_id=? AND e.source_key=?").get(orgId, list.id, sourceKey)));
  }));
}

export async function removeCallListEntry(orgIdValue: unknown, inputValue: JsonObject = {}) {
  await ensureCallListDatabase();
  const orgId = cleanText(orgIdValue);
  const input = asObject(inputValue);
  const now = nowIso();
  const conditions: string[] = ["organization_id = ?", "status = 'pending'"];
  const params: string[] = [orgId];
  for (const [column, value] of [["id", input.entry_id], ["work_node_id", input.work_node_id], ["source_key", input.source_key]] as const) {
    if (!cleanText(value)) continue;
    conditions.push(`${column} = ?`);
    params.push(cleanText(value));
  }
  if (conditions.length === 2) throw badRequest("call_list_entry_reference_required", "An entry_id, work_node_id, or source_key is required.");
  if (cleanText(input.list_key)) {
    conditions.push("call_list_id IN (SELECT id FROM crm_call_lists WHERE organization_id = ? AND list_key = ?)");
    params.push(orgId, cleanText(input.list_key));
  }
  return (await withCallListDb(async (db) => {
    const result = (await db.prepare(`UPDATE crm_call_list_entries SET status='removed', updated_at=?, completed_at=? WHERE ${conditions.join(" AND ")}`)
      .run(now, now, ...params));
    return { ok: true, success: true, removed: Number(result.changes || 0) };
  }));
}

function listVisibleTo(list: ReturnType<typeof normalizeList>, viewer: JsonObject) {
  if (viewer.include_all === true) return true;
  const users = new Set(stringArray(viewer.user_ids || [viewer.user_id]));
  const roles = new Set(stringArray(viewer.role_ids));
  if (!list.assigned_user_ids.length && !list.assigned_role_ids.length) return true;
  return list.assigned_user_ids.some((id) => users.has(id)) || list.assigned_role_ids.some((id) => roles.has(id));
}

function contactForProject(project: JsonObject) {
  const contacts = Array.isArray(project.contacts) ? project.contacts.map(asObject) : [];
  const contact = contacts.find((item) => item.primary === true && cleanText(item.phone || item.mobile || item.phone_number)) || contacts.find((item) => cleanText(item.phone || item.mobile || item.phone_number)) || contacts[0] || {};
  return {
    name: cleanText(contact.name || contact.full_name || project.customer_name || project.customer || project.title) || "Contact",
    phone: cleanText(contact.phone || contact.mobile || contact.phone_number || project.customer_phone || project.phone),
    address: cleanText(project.address || project.property_address),
    city: cleanText(project.city), state: cleanText(project.state), postal_code: cleanText(project.postal_code)
  };
}

// No blessed lists: every call list is data, created by automations
// (crm.callLists.add.v1 bindings and org rules), the follow-up projection
// below, or the call-list settings API.
async function syncProjectBackedLists(orgId: string) {
  const projects = await listDocuments(orgId, "projects");
  const projectsById = new Map(projects.map(document => [document.id, document]));
  const desired = new Set<string>();
  const now = Date.now();
  const todayKey = localDateKey(new Date(now));
  // New-lead calls are published by the pipeline scope's `contact_lead` node
  // through `crm.callLists.add.v1` bindings — no stage inference here.
  for (const document of projects) {
    const project: JsonObject = { id: document.id, ...asObject(document.data) };
    if (!contactForProject(project).phone) continue;
    const legacyFollowupAt = cleanText(project.call_followup_at || project.followup_at || project.next_followup_at);
    if (legacyFollowupAt && Number.isFinite(Date.parse(legacyFollowupAt))) {
      await createFollowUpTodo(orgId, {
        branch_id: cleanText(project.branch_id || "default") || "default",
        project_id: document.id,
        source_key: `follow_up:legacy_project:${document.id}:${legacyFollowupAt}`,
        due_at: legacyFollowupAt,
        origin: "legacy_project_field",
        metadata: { legacy_follow_up_at: legacyFollowupAt }
      });
      await upsertDocument(orgId, "projects", {
        id: document.id,
        expected_revision: document.revision,
        data: { ...project, call_followup_at: null, followup_at: null, next_followup_at: null, updated_at: nowIso() },
        metadata: document.metadata
      });
    }
  }
  const followUps = (await listNodeRecords(orgId, { actionable: true, open_only: true })).filter(isFollowUpWorkNode)
    .filter(node => ["ready","active"].includes(cleanText(node.status)) && cleanText(asObject(asObject(node.metadata).follow_up).channel || "call") === "call");
  for (const node of followUps) {
    const followUp = asObject(asObject(node.metadata).follow_up);
    const dueAt = cleanText(node.due_at);
    const dueAtTimestamp = dueTimestamp(dueAt);
    let nodeToday = todayKey;
    if (cleanText(followUp.timezone)) {
      try { nodeToday = new Intl.DateTimeFormat("en-CA", { timeZone:cleanText(followUp.timezone),year:"numeric",month:"2-digit",day:"2-digit" }).format(new Date(now)); } catch { /* legacy invalid zones retain branch/server behavior */ }
    }
    if (!dueAt || !Number.isFinite(dueAtTimestamp) || dueCalendarKey(dueAt) > nodeToday) continue;
    const projectId = cleanText(node.project_id);
    const projectDocument = projectsById.get(projectId);
    const project = projectDocument ? { id: projectDocument.id, ...asObject(projectDocument.data) } : {};
    if (!contactForProject(project).phone && !cleanText(followUp.phone)) continue;
    const sourceKey = `work_follow_up:${cleanText(node.id)}`;
    desired.add(sourceKey);
    await upsertCallListEntry(orgId, "follow_ups", {
      list: {
        key: "follow_ups", title: "Follow-ups", description: "Due call follow-ups.", kind: "follow_up",
        icon: "fa-clock", tone: "followup", sort_order: 20, create_only: true,
        metadata: { managed_by: "follow_up_projection" }
      },
      source_key: sourceKey,
      project_id: projectId,
      work_plan_id: node.plan_id,
      work_node_id: node.id,
      title: cleanText(node.title || "Follow-up call"),
      due_at: dueAt,
      priority: Number(node.priority || 0),
      payload: { phone:cleanText(followUp.phone),contact_id:cleanText(followUp.contact_id),name:cleanText(followUp.contact_name || node.title) },
      metadata: { work_follow_up_projection: true, follow_up: asObject(asObject(node.metadata).follow_up) }
    });
  }
  (await withCallListDb(async (db) => {
    const legacyPending = (await db.prepare(`SELECT e.id, e.source_key FROM crm_call_list_entries e
      JOIN crm_call_lists l ON l.id=e.call_list_id WHERE e.organization_id=? AND e.status='pending'
      AND l.list_key IN ('new_leads','follow_ups') AND (e.source_key LIKE 'project_stage:new_lead:%' OR e.source_key LIKE 'project_followup:%' OR e.source_key LIKE 'work_follow_up:%')`).all(orgId)) as unknown[];
    const nowValue = nowIso();
    for (const value of legacyPending) {
      const row = rowObject(value);
      if (!desired.has(cleanText(row.source_key))) (await db.prepare("UPDATE crm_call_list_entries SET status='removed', updated_at=?, completed_at=? WHERE id=?").run(nowValue, nowValue, cleanText(row.id)));
    }
  }));
  return projects;
}

export async function callListQueue(orgIdValue: unknown, viewerValue: JsonObject = {}) {
  await ensureCallListDatabase();
  const orgId = cleanText(orgIdValue);
  const viewer = asObject(viewerValue);
  const projectDocuments = await syncProjectBackedLists(orgId);
  const raw = (await withCallListDb(async (db) => {
    const lists = ((await db.prepare("SELECT * FROM crm_call_lists WHERE organization_id=? AND status='active' ORDER BY sort_order ASC, created_at ASC").all(orgId)) as unknown[])
      .map(normalizeList).filter((list) => listVisibleTo(list, viewer));
    return (await Promise.all(lists.map(async (list) => ({
      ...list,
      entries: ((await db.prepare("SELECT e.*, ? AS list_key FROM crm_call_list_entries e WHERE e.organization_id=? AND e.call_list_id=? AND e.status='pending' ORDER BY priority DESC, COALESCE(NULLIF(due_at,''), created_at) ASC").all(list.key, orgId, list.id)) as unknown[]).map(normalizeEntry)
    }))));
  }));
  // Reuse the projection's snapshot instead of reading every queued project again.
  const projects = new Map<string, JsonObject>(projectDocuments.map(document => [document.id, { id:document.id, ...asObject(document.data) }]));
  const branchId = cleanText(viewer.branch_id || viewer.branchId || "default") || "default";
  const configuration = await readWorkConfiguration(orgId, branchId);
  return {
    ok: true, success: true,
    follow_up_configuration: configuration.follow_ups,
    columns: (await Promise.all(raw.map(async (list) => {
      const tasks = (await Promise.all(list.entries.map(async (entry) => {
        const project = projects.get(entry.project_id) || {};
        const contact=contactForProject(project);
        const sourceIds=(await withCallListDb(async db=>(await db.prepare("SELECT work_node_id FROM crm_call_entry_sources WHERE organization_id=? AND entry_id=?").all(orgId,entry.id)))) as unknown[];
        return { ...entry, ...contact,phone:cleanText(asObject(entry.payload).phone)||contact.phone,name:cleanText(asObject(entry.payload).name)||contact.name,
          work_node_ids:[...new Set([...sourceIds.map(row=>cleanText(rowObject(row).work_node_id)),entry.work_node_id].filter(Boolean))],project, meta: cleanText(entry.title || list.title) };
      })));
      return { ...list, tasks: list.kind === "follow_up" ? sortFollowUpEntries(tasks) : tasks };
    })))
  };
}

export async function recordCallListDisposition(orgIdValue: unknown, entryIdValue: unknown, inputValue: JsonObject = {}) {
  await ensureCallListDatabase();
  const orgId = cleanText(orgIdValue);
  const entryId = cleanText(entryIdValue);
  const input = asObject(inputValue);
  const disposition = cleanText(input.disposition).toLowerCase();
  if (!["answered", "voicemail", "no_answer", "skipped"].includes(disposition)) throw badRequest("invalid_disposition", "A valid call disposition is required.");
  const entry = (await withCallListDb(async (db) => normalizeEntry((await db.prepare("SELECT e.*, l.list_key FROM crm_call_list_entries e JOIN crm_call_lists l ON l.id=e.call_list_id WHERE e.organization_id=? AND e.id=?").get(orgId, entryId)))));
  if (!entry.id) throw notFound("call_list_entry_not_found", "The call-list entry was not found.");
  // Skipping is navigation within a work session, never an attempt or a Work completion.
  if (disposition === "skipped") return { ok:true,success:true,skipped:true,entry,note:null,follow_up_result:null };
  const linkedNode = entry.work_node_id ? (await readNodeRecord(orgId, entry.work_node_id)) : null;
  const branchId = cleanText(input.branch_id || linkedNode?.branch_id || "default") || "default";
  const configuration = await readWorkConfiguration(orgId, branchId);
  const requestedOutcome = cleanText(input.outcome_id || input.outcome);
  let normalizedOutcome = requestedOutcome === "appointment_booked" ? "scheduled"
    : requestedOutcome === "not_interested" ? "lost"
      : requestedOutcome;
  const policyTrigger = ["voicemail", "no_answer"].includes(disposition) ? disposition
    : normalizedOutcome === "follow_up" ? "manual_follow_up" : "";
  const policySchedule = policyTrigger ? nextFollowUpPolicySchedule(configuration.follow_ups, linkedNode, policyTrigger) : null;
  if (!normalizedOutcome && policySchedule && ["voicemail", "no_answer"].includes(disposition)) normalizedOutcome = "follow_up";
  if (linkedNode && isFollowUpWorkNode(linkedNode) && !normalizedOutcome) {
    throw badRequest("follow_up_outcome_required", "Choose whether to follow up again, schedule the appointment, or mark the lead lost.");
  }
  const completedAt = cleanText(input.completed_at) || nowIso();
  const noteText = cleanText(input.note_text || input.note);
  const noteId = noteText ? (cleanText(input.call_id) ? `note_${cleanText(input.call_id)}` : `note_${randomBytes(8).toString("hex")}`) : "";
  const event = {
    id: cleanText(input.call_id) || `call_${randomBytes(8).toString("hex")}`, created_at: completedAt, owner_email: cleanText(input.actor_email).toLowerCase(),
    disposition, outcome: cleanText(input.outcome), note_id: noteId,
    followup_at: cleanText(asObject(input.followup).due_at || input.followup_at || policySchedule?.due_at), call_list_key: entry.list_key, call_list_entry_id: entry.id
  };
  const callNote = noteText ? {
    id: noteId,
    text: noteText,
    created_at: completedAt,
    updated_at: completedAt,
    created_by: {
      id: cleanText(input.actor_user_id || input.actor_id),
      name: cleanText(input.actor_name) || cleanText(input.actor_email),
      email: cleanText(input.actor_email).toLowerCase()
    },
    tagged_people: [],
    mention_users: [],
    visibility: ["office", "crew", "sales"],
    type_tags: ["call_note"],
    metadata: { call: event }
  } : null;
  // Call notes are messages in the project's channel (the shared internal
  // messaging backend), tagged call_note — not project-document JSON.
  if (entry.project_id && callNote) {
    const document = await readDocument(orgId, "projects", entry.project_id).catch(() => null);
    if (document) {
      const project = asObject(document.data);
      const { ensureProjectChannelRecord } = await import("../../channels/service.js");
      const { createMessageRecord } = await import("../../channels/storage.js");
      const channel = (await ensureProjectChannelRecord(orgId, document.id, cleanText(project.title || project.name || project.project_title)));
      (await createMessageRecord({
        organization_id: orgId,
        channel_id: channel.id,
        author_id: cleanText(input.actor_user_id || input.actor_id) || cleanText(input.actor_email).toLowerCase() || "system",
        text: noteText,
        tags: ["call_note"],
        client_msg_id: `call_disposition:${noteId}`,
        metadata: { call: event }
      }));
    }
  }
  let followUpResult: JsonObject | null = null;
  if (linkedNode && isFollowUpWorkNode(linkedNode)) {
    followUpResult = await resolveFollowUpOutcome(orgId, entry.work_node_id, {
      outcome: normalizedOutcome,
      due_at: event.followup_at,
      use_policy: !!policySchedule,
      policy_trigger: policyTrigger,
      appointment_scheduled: input.appointment_scheduled === true,
      actor_user_id: input.actor_user_id,
      actor_email: input.actor_email
    });
  } else if (event.followup_at) {
    const created = await createFollowUpTodo(orgId, {
      branch_id: branchId,
      project_id: entry.project_id,
      due_at: event.followup_at,
      origin: "call_disposition",
      channel: "call",
      assigned_user_ids: cleanText(input.actor_user_id) ? [cleanText(input.actor_user_id)] : [],
      source_key: `follow_up:call_disposition:${entry.id}:${event.id}`,
      metadata: {
        originating_call_list_key: entry.list_key,
        originating_call_list_entry_id: entry.id,
        follow_up: policySchedule || {}
      }
    });
    followUpResult = { successor: created.node };
  } else if (entry.work_node_id) {
    const { transitionWorkNode } = await import("../../work/service.js");
    await transitionWorkNode(orgId, entry.work_node_id, "completed", {
      reason: "call_list_disposition", actor_email: cleanText(input.actor_email), payload: { disposition, call_list_key: entry.list_key, call_list_entry_id: entry.id }
    });
  }
  (await withCallListDb(async (db) => (await db.prepare("UPDATE crm_call_list_entries SET status='completed', result_json=?, updated_at=?, completed_at=? WHERE organization_id=? AND id=?")
    .run(json(event), completedAt, completedAt, orgId, entryId))));
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: branchId,
    project_id: entry.project_id,
    type: "call.completed",
    idempotency_key: `call.completed:${event.id}`,
    payload: {
      call_id: event.id,
      disposition,
      outcome: normalizedOutcome,
      contact_name: cleanText(asObject(entry.payload).contact_name || asObject(entry.payload).name || entry.title),
      phone: cleanText(asObject(entry.payload).phone),
      call_list_key: entry.list_key
    },
    context: {
      actor_user_id: cleanText(input.actor_user_id || input.actor_id),
      actor_email: cleanText(input.actor_email),
      actor_name: cleanText(input.actor_name)
    }
  });
  return { ok: true, success: true, note: callNote, follow_up_result: followUpResult, entry: { ...entry, status: "completed", result: event, completed_at: completedAt } };
}

export async function listCallLists(orgIdValue: unknown) {
  await ensureCallListDatabase();
  const orgId = cleanText(orgIdValue);
  await syncProjectBackedLists(orgId);
  return (await withCallListDb(async (db) => ({
    ok: true, success: true,
    call_lists: ((await db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM crm_call_list_entries e WHERE e.call_list_id=l.id AND e.status='pending') AS pending_count
      FROM crm_call_lists l WHERE l.organization_id=? ORDER BY l.sort_order ASC, l.created_at ASC`).all(orgId)) as unknown[]).map((row) => ({ ...normalizeList(row), pending_count: Number(rowObject(row).pending_count || 0) }))
  })));
}
