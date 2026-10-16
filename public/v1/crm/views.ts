import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import type { JsonObject } from "../platform/storage.js";
import { evaluateConditions, validateConditions } from "../work/conditions.js";
import { branchScope } from "../workforce/branch-scope.js";
import { relevantDepartmentContext } from "../workforce/department-access.js";
import { CRM_COLLECTIONS, type CollectionResult, type CrmCollection, type CrmField, type CrmRow } from "./records.js";

// Saved views and the view query (docs/architecture/crm.md, "Views"). A view is a
// collection, a filter in the one condition contract, a display, and who sees it. Pins
// and hidden views are per person; a preset installs views once by a stable key and
// never overwrites a person's edits.

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown) => [...new Set(list(value).map(text).filter(Boolean))];
const now = () => new Date().toISOString();
const parse = (value: unknown, fallback: unknown) => { try { return JSON.parse(text(value)) ?? fallback; } catch { return fallback; } };

// The CRM store: saved views and pins, source spend, and recorded results. Raise
// schemaVersion with every table or column change, or Postgres hosts never run it.
let database: SqlStore | undefined;
export function crmViewStore() {
  return database ??= openSqlStore({ id: "crm", filename: path.resolve(env.platformStorageRoot, "crm.sqlite"), schemaVersion: 1, initialize: async db => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS crm_views (
        organization_id TEXT NOT NULL, id TEXT NOT NULL, collection TEXT NOT NULL, name TEXT NOT NULL,
        definition_json TEXT NOT NULL DEFAULT '{}', owner_user_id TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'private', role_ids_json TEXT NOT NULL DEFAULT '[]', default_role_ids_json TEXT NOT NULL DEFAULT '[]',
        preset_key TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS crm_views_org ON crm_views(organization_id, deleted_at, position);
      CREATE TABLE IF NOT EXISTS crm_view_prefs (
        organization_id TEXT NOT NULL, user_id TEXT NOT NULL, view_id TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, user_id, view_id)
      );
      CREATE TABLE IF NOT EXISTS crm_source_spend (
        organization_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL,
        period_start TEXT NOT NULL, period_end TEXT NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS crm_source_spend_source ON crm_source_spend(organization_id, source_id, period_start);
      CREATE TABLE IF NOT EXISTS crm_results (
        organization_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', contact_id TEXT NOT NULL DEFAULT '',
        outcome_id TEXT NOT NULL, action TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT 'call', note TEXT NOT NULL DEFAULT '',
        follow_up_at TEXT NOT NULL DEFAULT '', source_row TEXT NOT NULL DEFAULT '', actor_user_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS crm_results_project ON crm_results(organization_id, project_id, created_at);
    `);
  } });
}

const sortSchema = z.object({ key: z.string().trim().min(1).max(200), dir: z.enum(["asc", "desc"]).default("asc") }).strict();
export const viewDefinitionSchema = z.object({
  filter: z.object({}).passthrough().default({ match: "all", rules: [] }),
  sort: z.array(sortSchema).max(4).default([]),
  group_by: z.string().trim().max(200).default(""),
  layout: z.enum(["list", "board", "calendar"]).default("list"),
  columns: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  search: z.string().max(200).default(""),
  description: z.string().max(1000).default(""),
  icon: z.string().max(60).default("")
}).strict();
export type ViewDefinition = z.infer<typeof viewDefinitionSchema>;
const viewInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  collection: z.enum(CRM_COLLECTIONS as [CrmCollection, ...CrmCollection[]]),
  definition: viewDefinitionSchema.default({}),
  visibility: z.enum(["private", "roles", "everyone"]).default("private"),
  role_ids: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  default_role_ids: z.array(z.string().trim().min(1).max(120)).max(40).default([]),
  position: z.number().int().min(0).max(100000).optional(),
  expected_revision: z.number().int().positive().optional()
}).strict();

export type CrmView = {
  id: string; collection: CrmCollection; name: string; definition: ViewDefinition; owner_user_id: string;
  visibility: "private" | "roles" | "everyone"; role_ids: string[]; default_role_ids: string[]; preset_key: string;
  position: number; revision: number; created_at: string; updated_at: string;
};

function viewFromRow(row: JsonObject): CrmView {
  return {
    id: text(row.id), collection: text(row.collection) as CrmCollection, name: text(row.name),
    definition: viewDefinitionSchema.parse(parse(row.definition_json, {})), owner_user_id: text(row.owner_user_id),
    visibility: (text(row.visibility) || "private") as CrmView["visibility"], role_ids: strings(parse(row.role_ids_json, [])),
    default_role_ids: strings(parse(row.default_role_ids_json, [])), preset_key: text(row.preset_key),
    position: Number(row.position || 0), revision: Number(row.revision || 1), created_at: text(row.created_at), updated_at: text(row.updated_at)
  };
}

export function viewerRoles(ctx: PlatformAuthContext) {
  return strings([...(ctx.accessProfile?.access_role_ids || []), ctx.role]);
}
export function canManageSharedViews(ctx: PlatformAuthContext) {
  return hasPermission(ctx, "manage_company_settings");
}
function canSee(ctx: PlatformAuthContext, view: CrmView) {
  if (view.visibility === "everyone") return true;
  if (view.visibility === "private") return view.owner_user_id === ctx.userId;
  const roles = viewerRoles(ctx);
  return view.owner_user_id === ctx.userId || view.role_ids.some(id => roles.includes(id)) || canManageSharedViews(ctx);
}
function canEdit(ctx: PlatformAuthContext, view: CrmView) {
  if (view.visibility === "private") return view.owner_user_id === ctx.userId;
  return canManageSharedViews(ctx) || (view.owner_user_id === ctx.userId && !view.preset_key);
}
export function collectionPermission(collection: string) {
  return collection === "contacts" ? "view_contacts" : "view_projects";
}

function assertFilter(definition: ViewDefinition) {
  const issues = validateConditions(definition.filter, "view filter");
  if (issues.length) throw badRequest("crm_view_filter_invalid", issues[0]!, { issues });
}

export async function listViews(ctx: PlatformAuthContext) {
  const db = crmViewStore();
  const rows = (await db.prepare("SELECT * FROM crm_views WHERE organization_id=? AND deleted_at='' ORDER BY position, created_at").all(ctx.orgId)).map(viewFromRow);
  const prefs = new Map((await db.prepare("SELECT view_id,pinned,hidden,position FROM crm_view_prefs WHERE organization_id=? AND user_id=?").all(ctx.orgId, ctx.userId))
    .map(row => [text(row.view_id), { pinned: Number(row.pinned) === 1, hidden: Number(row.hidden) === 1, position: Number(row.position || 0) }]));
  const roles = viewerRoles(ctx);
  return rows.filter(view => canSee(ctx, view)).map(view => {
    const pref = prefs.get(view.id);
    // "*" makes a view everyone's default (a pinned preset).
    const isDefault = view.default_role_ids.some(id => id === "*" || roles.includes(id));
    return {
      ...view, editable: canEdit(ctx, view), is_default: isDefault,
      pinned: pref ? pref.pinned && !pref.hidden : isDefault, hidden: pref?.hidden === true,
      pin_position: pref?.position ?? view.position
    };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.pin_position - b.pin_position || a.name.localeCompare(b.name));
}

export async function readView(ctx: PlatformAuthContext, id: string) {
  const row = await crmViewStore().prepare("SELECT * FROM crm_views WHERE organization_id=? AND id=? AND deleted_at=''").get(ctx.orgId, text(id));
  if (!row) throw notFound("crm_view_not_found", "That view no longer exists.");
  const view = viewFromRow(row);
  if (!canSee(ctx, view)) throw notFound("crm_view_not_found", "That view no longer exists.");
  return view;
}

export async function saveView(ctx: PlatformAuthContext, id: string, value: unknown) {
  const input = viewInputSchema.parse(value);
  assertFilter(input.definition);
  if (input.visibility !== "private" && !canManageSharedViews(ctx)) throw forbidden("crm_view_share_denied", "Only someone who manages company settings can share a view.");
  if (input.default_role_ids.length && !canManageSharedViews(ctx)) throw forbidden("crm_view_default_denied", "Only someone who manages company settings can make a view a role's default.");
  const db = crmViewStore(), time = now();
  return await db.transaction(async () => {
    const existing = id ? await db.prepare("SELECT * FROM crm_views WHERE organization_id=? AND id=? AND deleted_at=''").get(ctx.orgId, id) : null;
    if (id && !existing) throw notFound("crm_view_not_found", "That view no longer exists.");
    if (existing) {
      const view = viewFromRow(existing);
      if (!canEdit(ctx, view)) throw forbidden("crm_view_edit_denied", "You can save your changes as a new view.");
      if (input.expected_revision && input.expected_revision !== view.revision) throw conflict("crm_view_changed", "Someone changed this view. Reload it before saving.");
      await db.prepare(`UPDATE crm_views SET name=?,collection=?,definition_json=?,visibility=?,role_ids_json=?,default_role_ids_json=?,position=?,revision=revision+1,updated_at=? WHERE organization_id=? AND id=?`)
        .run(input.name, input.collection, JSON.stringify(input.definition), input.visibility, JSON.stringify(input.role_ids), JSON.stringify(input.default_role_ids), input.position ?? view.position, time, ctx.orgId, id);
      return viewFromRow((await db.prepare("SELECT * FROM crm_views WHERE organization_id=? AND id=?").get(ctx.orgId, id))!);
    }
    const viewId = `view_${randomBytes(8).toString("hex")}`;
    const position = input.position ?? Number(object(await db.prepare("SELECT COALESCE(MAX(position),0)+1 AS p FROM crm_views WHERE organization_id=?").get(ctx.orgId)).p || 0);
    await db.prepare(`INSERT INTO crm_views(organization_id,id,collection,name,definition_json,owner_user_id,visibility,role_ids_json,default_role_ids_json,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ctx.orgId, viewId, input.collection, input.name, JSON.stringify(input.definition), ctx.userId, input.visibility, JSON.stringify(input.role_ids), JSON.stringify(input.default_role_ids), position, time, time);
    await db.prepare("INSERT INTO crm_view_prefs(organization_id,user_id,view_id,pinned,hidden,position,updated_at) VALUES(?,?,?,1,0,?,?) ON CONFLICT(organization_id,user_id,view_id) DO UPDATE SET pinned=1,hidden=0,updated_at=excluded.updated_at")
      .run(ctx.orgId, ctx.userId, viewId, position, time);
    return viewFromRow((await db.prepare("SELECT * FROM crm_views WHERE organization_id=? AND id=?").get(ctx.orgId, viewId))!);
  });
}

export async function deleteView(ctx: PlatformAuthContext, id: string) {
  const view = await readView(ctx, id);
  if (!canEdit(ctx, view)) throw forbidden("crm_view_edit_denied", "You can hide this view instead.");
  await crmViewStore().prepare("UPDATE crm_views SET deleted_at=?,updated_at=? WHERE organization_id=? AND id=?").run(now(), now(), ctx.orgId, view.id);
  return { id: view.id, deleted: true };
}

export async function setViewPreference(ctx: PlatformAuthContext, id: string, value: unknown) {
  const input = z.object({ pinned: z.boolean().optional(), hidden: z.boolean().optional(), position: z.number().int().min(0).max(100000).optional() }).strict().parse(value);
  const view = await readView(ctx, id);
  const db = crmViewStore();
  const prior = object(await db.prepare("SELECT * FROM crm_view_prefs WHERE organization_id=? AND user_id=? AND view_id=?").get(ctx.orgId, ctx.userId, view.id));
  const pinned = input.pinned ?? (Object.keys(prior).length ? Number(prior.pinned) === 1 : false);
  const hidden = input.hidden ?? Number(prior.hidden || 0) === 1;
  await db.prepare(`INSERT INTO crm_view_prefs(organization_id,user_id,view_id,pinned,hidden,position,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(organization_id,user_id,view_id) DO UPDATE SET pinned=excluded.pinned,hidden=excluded.hidden,position=excluded.position,updated_at=excluded.updated_at`)
    .run(ctx.orgId, ctx.userId, view.id, pinned ? 1 : 0, hidden ? 1 : 0, input.position ?? Number(prior.position ?? view.position), now());
  return { id: view.id, pinned, hidden };
}

/** Views a preset ships, installed once by key; a person's later edits are kept. */
export type PresetView = { key: string; name: string; collection: CrmCollection; definition: Partial<ViewDefinition>; pinned?: boolean; default_role_ids?: string[] };

/** Adds the preset views an organization does not have yet. A preset someone deleted stays deleted. */
export async function installPresetViews(orgId: string, presets: PresetView[]) {
  const db = crmViewStore(), time = now();
  let installed = 0;
  for (const [index, preset] of presets.entries()) {
    const exists = await db.prepare("SELECT id FROM crm_views WHERE organization_id=? AND preset_key=?").get(orgId, preset.key);
    if (exists) continue;
    const definition = viewDefinitionSchema.parse(preset.definition || {});
    assertFilter(definition);
    await db.prepare(`INSERT INTO crm_views(organization_id,id,collection,name,definition_json,owner_user_id,visibility,role_ids_json,default_role_ids_json,preset_key,position,created_at,updated_at) VALUES(?,?,?,?,?,'','everyone','[]',?,?,?,?,?)`)
      .run(orgId, `view_${preset.key}`, preset.collection, preset.name, JSON.stringify(definition), JSON.stringify(preset.pinned ? ["*"] : preset.default_role_ids || []), preset.key, index, time, time);
    installed++;
  }
  return installed;
}

// ---- The query -------------------------------------------------------------

/** $me, $my_branches and $my_departments become the viewer's own values before the filter runs. */
export function resolveRelativeValues(filter: unknown, ctx: PlatformAuthContext | null): unknown {
  if (!ctx) return filter;
  const scope = branchScope(ctx), departments = relevantDepartmentContext(ctx);
  const swap = (value: unknown): unknown => {
    if (value === "$me") return ctx.userId;
    if (value === "$my_branches") return scope.own_branch_ids;
    if (value === "$my_departments") return departments.member_department_ids;
    if (Array.isArray(value)) return value.flatMap(v => { const s = swap(v); return Array.isArray(s) ? s : [s]; });
    return value;
  };
  const walk = (node: unknown): unknown => {
    const n = object(node);
    if (Array.isArray(n.rules) || Array.isArray(n.conditions)) return { ...n, ...(Array.isArray(n.rules) ? { rules: list(n.rules).map(walk) } : {}), ...(Array.isArray(n.conditions) ? { conditions: list(n.conditions).map(walk) } : {}) };
    if (text(n.field || n.path)) return { ...n, value: swap(n.value) };
    return node;
  };
  return walk(filter);
}

/** A flat row as nested paths, so `cf.assignments.estimator` and `milestone.set` read as the condition contract expects. */
export function nestRow(row: CrmRow) {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) { if (!node[part] || typeof node[part] !== "object" || Array.isArray(node[part])) node[part] = {}; node = node[part] as JsonObject; }
    node[parts[parts.length - 1]!] = value;
  }
  return out;
}

function comparable(field: CrmField | undefined, value: unknown) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null;
  if (!field) return text(value).toLowerCase();
  if (field.type === "number" || field.type === "money") { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (field.type === "date") { const t = Date.parse(text(value)); return Number.isFinite(t) ? t : null; }
  if (field.type === "bool") return value === true ? 1 : 0;
  if (field.type === "select" && field.options?.length) { const i = field.options.findIndex(o => o.value === text(value)); return i >= 0 ? i : text(value).toLowerCase(); }
  return text(Array.isArray(value) ? value[0] : value).toLowerCase();
}

export type QueryInput = { definition: Partial<ViewDefinition>; search?: string; offset?: number; limit?: number };

export function runQuery(result: CollectionResult, input: QueryInput, ctx: PlatformAuthContext | null) {
  const definition = viewDefinitionSchema.parse({ ...input.definition, search: input.search ?? input.definition.search ?? "" });
  assertFilter(definition);
  const filter = resolveRelativeValues(definition.filter, ctx);
  const fields = new Map(result.fields.map(f => [f.key, f]));
  const needle = definition.search.toLowerCase();
  const textKeys = result.fields.filter(f => f.type === "text").map(f => f.key);
  let rows = result.rows.filter(row => evaluateConditions(filter, nestRow(row), { caseInsensitive: true, payloadFallback: false }));
  if (needle) rows = rows.filter(row => textKeys.some(key => text(row[key]).toLowerCase().includes(needle)));
  const sort = definition.sort.length ? definition.sort : [{ key: result.fields.find(f => f.type === "date")?.key || "id", dir: "desc" as const }];
  rows = [...rows].sort((a, b) => {
    for (const s of sort) {
      const field = fields.get(s.key), x = comparable(field, a[s.key]), y = comparable(field, b[s.key]);
      if (x === y) continue;
      if (x === null) return 1; if (y === null) return -1;
      const order = x < y ? -1 : 1;
      return s.dir === "desc" ? -order : order;
    }
    return text(a.id).localeCompare(text(b.id));
  });
  const valueKey = fields.has("value_cents") ? "value_cents" : "";
  let groups: { value: string; label: string; color?: string; count: number; value_cents: number }[] = [];
  if (definition.group_by) {
    const field = fields.get(definition.group_by);
    const groupValue = (row: CrmRow) => { const v = row[definition.group_by]; return Array.isArray(v) ? text(v[0]) : typeof v === "boolean" ? String(v) : text(v); };
    const byValue = new Map<string, { count: number; value_cents: number }>();
    for (const option of field?.options || []) byValue.set(option.value, { count: 0, value_cents: 0 });
    for (const row of rows) {
      const g = groupValue(row), entry = byValue.get(g) || { count: 0, value_cents: 0 };
      entry.count++; if (valueKey) entry.value_cents += Number(row[valueKey] || 0);
      byValue.set(g, entry);
    }
    const label = (value: string) => field?.options?.find(o => o.value === value)?.label || (field?.type === "bool" ? (value === "true" ? "Yes" : "No") : value || "None");
    groups = [...byValue].map(([value, entry]) => ({ value, label: label(value), color: field?.options?.find(o => o.value === value)?.color, ...entry }))
      .filter(g => g.count > 0 || (field?.options || []).some(o => o.value === g.value));
  }
  const total = rows.length;
  const offset = Math.max(0, Number(input.offset) || 0), limit = Math.min(1000, Math.max(1, Number(input.limit) || 100));
  return {
    total, offset, limit, rows: rows.slice(offset, offset + limit), groups,
    value_cents: valueKey ? rows.reduce((sum, r) => sum + Number(r[valueKey] || 0), 0) : 0,
    fields: result.fields, labels: result.labels, definition
  };
}
