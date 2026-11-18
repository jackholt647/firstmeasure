// The CRM in the shared FirstMate assistant (FM-551, docs/architecture/crm.md, "The assistant").
//
// There is no CRM agent. The global assistant gets these tools everywhere, and the CRM tab's
// magic button opens the same assistant as a bar at the bottom of the tab, in the person's
// private `crm` conversation. Every read goes through the collection reader the tab uses
// (branch scope and department access included); a save is the person's own Save as new view.
// The tab sends what is on screen as untrusted UI context; crm_show changes it.

import { getAgentsDatabase, createAgentThread } from "../agents/storage.js";
import type { AgentRun, AgentTool } from "../agents/types.js";
import { asObject, cleanText, errorMessage, parseJsonArg, toolError, type JsonObject } from "../agents/util.js";
import { can, hasPermission, requireCapability, type PlatformAuthContext } from "../platform/auth.js";
import { forbidden } from "../platform/errors.js";
import { resolveOrganizationTimezone, zonedParts } from "../platform/timezone.js";
import { validateConditions } from "../work/conditions.js";
import { CRM_COLLECTIONS, type CollectionResult, type CrmCollection, type CrmField, type CrmRow } from "./records.js";
import { collectionPermission, listViews, readView, runQuery, saveView, viewDefinitionSchema, type ViewDefinition } from "./views.js";

export const CRM_SUBJECT = "crm";
const READ_PERMISSION = "view_projects|view_contacts";
const MAX_ROWS = 200;
const MAX_GROUPS = 100;
const MAX_OPTIONS = 60;

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const inCrm = (run: AgentRun) => cleanText(run.scratch.threadSubjectId || run.subjectId) === CRM_SUBJECT;

const OPERATORS: Record<string, string[]> = {
  text: ["contains", "not_contains", "equals", "not_equals", "starts_with", "ends_with", "is_present", "is_missing"],
  contact: ["contains", "not_contains", "equals", "is_present", "is_missing"],
  number: ["greater_or_equal", "less_or_equal", "greater_than", "less_than", "equals", "not_equals", "is_present", "is_missing"],
  money: ["greater_or_equal", "less_or_equal", "greater_than", "less_than", "equals", "is_present", "is_missing"],
  date: ["after", "before", "is_present", "is_missing"],
  select: ["in", "not_in", "equals", "not_equals", "is_present", "is_missing"],
  multi: ["contains", "not_contains", "is_present", "is_missing"],
  user: ["contains", "not_contains", "in", "is_present", "is_missing"],
  bool: ["equals"]
};

const GUIDE = `A CRM view is { collection, filter, sort, group_by, layout, columns } over one collection of read-only rows: opportunities (leads, open sales and won or lost ones, one row per project), contacts, follow_ups (open follow-up to-dos and call-list entries) and appointments.

- filter: the platform condition contract, { match: "all"|"any", rules: [...] }. A rule is { field, operator, value }; a rule may itself be a group { match, rules } to nest any/all. Use only field keys from crm_fields and the operators listed for the field's type.
- Values: select fields take option values (not labels), usually with "in"/"not_in" and an array. Booleans use "equals" with "true" or "false". Dates take an ISO date or a relative time: "now", "now-7d", "now+30d", "now-12h" ("created in the last 30 days" is created_at after now-30d). Money fields hold cents: $5,000 is 500000. Person fields (type user) take user ids from the field's options; "$me" is whoever looks at the view, so one shared view works for every rep. "$my_branches" and "$my_departments" work the same way.
- sort: up to 4 of { key, dir: "asc"|"desc" }. group_by: one groupable field key, or "". layout: "list" or "board" (a board needs group_by; stage_id for leads), and "calendar" (an agenda by day) for appointments only. columns: the field keys shown as list columns in order; [] means the collection's default columns.
- A filter that matches nothing is not an error: check with crm_rows or crm_stats before you show it, and say so if nothing matches.`;

export const crmInstructions = `## CRM
The CRM tab shows saved views (filtered, sorted and grouped lists, boards and agendas) of leads, contacts, follow-ups and appointments. With crm_fields (the fields, their values and the view format; call it before your first filter on a collection), crm_rows (fetch matching rows) and crm_stats (counts, sums, averages, medians, percentiles and breakdowns by any field or by day, week or month) you can answer questions about the pipeline and decide on filters from the data itself. crm_views lists saved views. crm_show changes what the CRM tab shows (only in the CRM tab's own conversation); crm_save_view saves a view for the user, private unless they ask to share it. Describe filters in plain words, never as JSON or field keys.`;

function auth(run: AgentRun): PlatformAuthContext {
  if (!run.ctx) throw forbidden("crm_user", "A signed-in user is required to work with the CRM.");
  return run.ctx;
}

async function readable(run: AgentRun, collection: unknown) {
  const ctx = auth(run);
  if (!(await can(ctx, "crm.views").catch(() => false))) throw forbidden("crm_views_off", "CRM views are turned off for this company.");
  const id = cleanText(collection) as CrmCollection;
  if (!CRM_COLLECTIONS.includes(id)) throw forbidden("crm_collection_unknown", `Choose one of: ${CRM_COLLECTIONS.join(", ")}.`);
  if (!hasPermission(ctx, collectionPermission(id))) throw forbidden("crm_collection_denied", "You cannot see that collection.");
  return { ctx, collection: id };
}

/** One build of a collection per turn: several reads in a turn share it. */
async function collectionOf(run: AgentRun, collection: unknown): Promise<{ ctx: PlatformAuthContext; collection: CrmCollection; result: CollectionResult }> {
  const access = await readable(run, collection);
  const cache = (run.scratch.crmCollections ||= {}) as Record<string, CollectionResult>;
  if (!cache[access.collection]) {
    const { collectionFor } = await import("./api.js");
    cache[access.collection] = await collectionFor(access.ctx, run.orgId, access.collection, { withMilestones: await can(access.ctx, "crm.funnel").catch(() => false) });
  }
  return { ...access, result: cache[access.collection]! };
}

function fieldKeys(filter: unknown, out: string[] = []) {
  const node = asObject(filter);
  for (const rule of [...list(node.rules), ...list(node.conditions)].map(asObject)) {
    if (Array.isArray(rule.rules) || Array.isArray(rule.conditions)) fieldKeys(rule, out);
    else if (cleanText(rule.field || rule.path)) out.push(cleanText(rule.field || rule.path));
  }
  return out;
}

const defaultGroup = (collection: CrmCollection) => collection === "opportunities" ? "stage_id" : collection === "contacts" ? "state" : collection === "follow_ups" ? "list_key" : "type";

/**
 * A definition from the model: checked against the view schema, the condition contract and the
 * collection's fields. Unknown columns are dropped; anything else wrong comes back as errors to fix.
 */
function definitionFrom(value: unknown, collection: CrmCollection, fields: CrmField[]) {
  const raw = asObject(typeof value === "string" ? parseJsonArg(value, "definition") : value);
  const { search: _search, origin: _origin, ...rest } = raw;
  const parsed = viewDefinitionSchema.safeParse(rest);
  if (!parsed.success) return { errors: parsed.error.issues.slice(0, 10).map(issue => `${issue.path.join(".") || "definition"}: ${issue.message}`), warnings: [] as string[] };
  const definition = parsed.data;
  const known = new Map(fields.map(f => [f.key, f]));
  const errors = validateConditions(definition.filter, "filter");
  const warnings: string[] = [];
  for (const key of new Set(fieldKeys(definition.filter))) if (!known.has(key)) errors.push(`filter: "${key}" is not a field of ${collection}. Use crm_fields for the keys.`);
  for (const sort of definition.sort) if (!known.has(sort.key)) errors.push(`sort: "${sort.key}" is not a field of ${collection}.`);
  if (definition.group_by) {
    const field = known.get(definition.group_by);
    if (!field) errors.push(`group_by: "${definition.group_by}" is not a field of ${collection}.`);
    else if (field.groupable === false) errors.push(`group_by: "${field.label}" cannot group a view. Use crm_stats to break it down instead.`);
  }
  const dropped = definition.columns.filter(key => !known.has(key));
  if (dropped.length) { definition.columns = definition.columns.filter(key => known.has(key)); warnings.push(`Left out unknown columns: ${dropped.join(", ")}.`); }
  if (definition.layout === "calendar" && collection !== "appointments") errors.push("layout: the agenda (calendar) is only for appointments.");
  if (definition.layout === "board" && !definition.group_by) definition.group_by = defaultGroup(collection);
  return { definition, errors, warnings };
}

function optionLabel(field: CrmField | undefined, value: unknown, labels: Record<string, string>) {
  const raw = cleanText(value);
  if (!field || !raw) return "";
  if (field.type === "user") return field.options?.find(o => o.value === raw)?.label || labels[`user:${raw}`] || "";
  if (field.type === "select" || field.type === "multi") return field.options?.find(o => o.value === raw)?.label || "";
  return "";
}

/** A row for the model: the requested fields, with select and person values named. */
function present(row: CrmRow, keys: string[], fields: Map<string, CrmField>, labels: Record<string, string>) {
  const out: JsonObject = { id: row.id };
  for (const key of keys) {
    const value = row[key], field = fields.get(key);
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (Array.isArray(value)) {
      const named = value.map(v => optionLabel(field, v, labels) || v);
      out[key] = named as JsonObject[keyof JsonObject];
    } else {
      const label = optionLabel(field, value, labels);
      out[key] = label && label !== cleanText(value) ? `${label} (${cleanText(value)})` : value as JsonObject[keyof JsonObject];
    }
  }
  return out;
}

// ---- Statistics ---------------------------------------------------------------

const MEASURES = ["count", "sum", "avg", "min", "max", "median", "p25", "p75", "p90", "stddev", "distinct", "filled", "empty", "true_count", "true_share"] as const;
type Measure = { op: typeof MEASURES[number]; field: string };
const BUCKETS = ["day", "week", "month", "quarter", "year", "weekday", "hour"] as const;

function numeric(field: CrmField | undefined, value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (field?.type === "date") { const t = Date.parse(cleanText(value)); return Number.isFinite(t) ? t : null; }
  if (field?.type === "bool") return value === true || value === "true" ? 1 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const empty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q, low = Math.floor(at), high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

function measure(rows: CrmRow[], m: Measure, field: CrmField | undefined) {
  if (m.op === "count") return rows.length;
  const values = rows.map(row => row[m.field]);
  if (m.op === "filled") return values.filter(v => !empty(v)).length;
  if (m.op === "empty") return values.filter(empty).length;
  if (m.op === "distinct") return new Set(values.flatMap(v => Array.isArray(v) ? v : [v]).filter(v => !empty(v)).map(v => cleanText(v))).size;
  if (m.op === "true_count" || m.op === "true_share") {
    const yes = values.filter(v => v === true || v === "true").length;
    return m.op === "true_count" ? yes : rows.length ? Math.round((yes / rows.length) * 10000) / 100 : null;
  }
  const numbers = values.map(v => numeric(field, v)).filter((n): n is number => n !== null).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const sum = numbers.reduce((total, n) => total + n, 0);
  const round = (n: number | null) => n === null ? null : field?.type === "date" ? new Date(n).toISOString() : Math.round(n * 100) / 100;
  switch (m.op) {
    case "sum": return field?.type === "date" ? null : round(sum);
    case "avg": return round(sum / numbers.length);
    case "min": return round(numbers[0]!);
    case "max": return round(numbers.at(-1)!);
    case "median": return round(quantile(numbers, 0.5));
    case "p25": return round(quantile(numbers, 0.25));
    case "p75": return round(quantile(numbers, 0.75));
    case "p90": return round(quantile(numbers, 0.9));
    case "stddev": {
      if (field?.type === "date") return null;
      const mean = sum / numbers.length;
      return round(Math.sqrt(numbers.reduce((total, n) => total + (n - mean) ** 2, 0) / numbers.length));
    }
  }
  return null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

/** The group keys a row falls in for one dimension: list values count in each of their groups. */
function groupKeys(row: CrmRow, field: CrmField | undefined, key: string, options: { bucket?: string; binSize?: number; timezone: string }) {
  const value = row[key];
  const values = Array.isArray(value) ? (value.length ? value : [""]) : [value];
  return values.map(v => {
    if (empty(v)) return "";
    if (field?.type === "date") {
      const t = Date.parse(cleanText(v));
      if (!Number.isFinite(t)) return "";
      const p = zonedParts(new Date(t), options.timezone);
      const day = new Date(Date.UTC(p.year, p.month - 1, p.day));
      switch (options.bucket || "day") {
        case "year": return String(p.year);
        case "quarter": return `${p.year}-Q${Math.ceil(p.month / 3)}`;
        case "month": return `${p.year}-${pad(p.month)}`;
        case "week": { const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000); return `week of ${monday.toISOString().slice(0, 10)}`; }
        case "weekday": return `${day.getUTCDay()} ${WEEKDAYS[day.getUTCDay()]}`;
        case "hour": return `${pad(p.hour)}:00`;
        default: return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
      }
    }
    if ((field?.type === "number" || field?.type === "money") && options.binSize) {
      const n = Number(v);
      if (!Number.isFinite(n)) return "";
      const low = Math.floor(n / options.binSize) * options.binSize;
      return `${low}–${low + options.binSize}`;
    }
    if (typeof v === "boolean") return String(v);
    return cleanText(v);
  });
}

async function statistics(run: AgentRun, args: JsonObject) {
  const { ctx, collection, result } = await collectionOf(run, args.collection);
  const fields = new Map(result.fields.map(f => [f.key, f]));
  const filter = typeof args.filter === "string" ? parseJsonArg(args.filter, "filter") : asObject(args.filter);
  const checked = definitionFrom({ filter: Object.keys(filter).length ? filter : { match: "all", rules: [] } }, collection, result.fields);
  if (checked.errors.length || !checked.definition) return toolError(...checked.errors);
  // runQuery pages; statistics need every matching row, so walk it at the largest page.
  const matching: CrmRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = runQuery(result, { definition: checked.definition, search: cleanText(args.search), offset, limit: 1000 }, ctx);
    matching.push(...page.rows);
    if (offset + 1000 >= page.total) break;
  }
  const measures: Measure[] = [];
  const errors: string[] = [];
  for (const entry of list(args.measures).map(asObject)) {
    const op = cleanText(entry.op) as Measure["op"], key = cleanText(entry.field);
    if (!MEASURES.includes(op)) { errors.push(`measures: "${op}" is not one of ${MEASURES.join(", ")}.`); continue; }
    if (op !== "count" && !fields.has(key)) { errors.push(`measures: "${key}" is not a field of ${collection}.`); continue; }
    measures.push({ op, field: op === "count" ? "" : key });
  }
  if (!measures.some(m => m.op === "count")) measures.unshift({ op: "count", field: "" });
  const dimensions = list(args.group_by).map(cleanText).filter(Boolean).slice(0, 2);
  for (const key of dimensions) if (!fields.has(key)) errors.push(`group_by: "${key}" is not a field of ${collection}.`);
  const bucket = cleanText(args.bucket);
  if (bucket && !BUCKETS.includes(bucket as typeof BUCKETS[number])) errors.push(`bucket: use one of ${BUCKETS.join(", ")}.`);
  if (errors.length) return toolError(...errors);
  const timezone = await resolveOrganizationTimezone(run.orgId, run.branchId).catch(() => "UTC");
  const binSize = Number(args.bin_size) > 0 ? Number(args.bin_size) : 0;
  const named = (m: Measure) => m.op === "count" ? "count" : `${m.op}_${m.field}`;
  const summarize = (subset: CrmRow[]) => Object.fromEntries(measures.map(m => [named(m), measure(subset, m, fields.get(m.field))]));
  const out: JsonObject = {
    collection, matching: matching.length, timezone,
    overall: summarize(matching),
    notes: [
      ...checked.warnings,
      ...(measures.some(m => fields.get(m.field)?.type === "money") ? ["Money is in cents: divide by 100 for dollars."] : []),
      ...(dimensions.some(key => fields.get(key)?.type === "date") ? [`Dates are grouped by ${bucket || "day"} in ${timezone}.`] : [])
    ]
  };
  if (dimensions.length) {
    const groups = new Map<string, { keys: string[]; rows: CrmRow[] }>();
    for (const row of matching) {
      const perDimension = dimensions.map(key => groupKeys(row, fields.get(key), key, { bucket, binSize, timezone }));
      const combos = perDimension.reduce<string[][]>((acc, keys) => acc.flatMap(prefix => keys.map(k => [...prefix, k])), [[]]);
      for (const combo of combos) {
        const id = JSON.stringify(combo);
        const group = groups.get(id) || { keys: combo, rows: [] };
        group.rows.push(row);
        groups.set(id, group);
      }
    }
    const ordered = [...groups.values()].sort((a, b) => {
      const timeLike = dimensions.every(key => ["date", "number", "money"].includes(fields.get(key)?.type || ""));
      return timeLike ? a.keys.join("|").localeCompare(b.keys.join("|"), undefined, { numeric: true }) : b.rows.length - a.rows.length;
    });
    out.groups = ordered.slice(0, MAX_GROUPS).map(group => ({
      ...Object.fromEntries(dimensions.map((key, i) => [key, group.keys[i] ? (optionLabel(fields.get(key), group.keys[i], result.labels) || group.keys[i]!.replace(/^\d /, "")) : "(none)"])),
      share_percent: matching.length ? Math.round((group.rows.length / matching.length) * 10000) / 100 : 0,
      ...summarize(group.rows)
    }));
    if (ordered.length > MAX_GROUPS) out.groups_left_out = ordered.length - MAX_GROUPS;
  }
  return out;
}

// ---- Tools ---------------------------------------------------------------------

function tool(name: string, description: string, properties: JsonObject, required: string[], effect: "read" | "write", execute: AgentTool["execute"]): AgentTool {
  return {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    permission: READ_PERMISSION,
    ...(effect === "read" ? { publication: { effect: "read" as const } } : {}),
    async execute(run, args, key) {
      try {
        return await execute(run, args, key);
      } catch (error) {
        return toolError(errorMessage(error));
      }
    }
  };
}

const string = { type: "string" };
const collectionArg = { type: "string", enum: CRM_COLLECTIONS, description: "opportunities (leads and sales), contacts, follow_ups or appointments." };
const definitionArg = { type: "string", description: "The view as a JSON object string: { filter, sort, group_by, layout, columns }. See crm_fields for the format." };

async function viewSummary(run: AgentRun, collection: CrmCollection, definition: ViewDefinition) {
  const { ctx, result } = await collectionOf(run, collection);
  const page = runQuery(result, { definition, limit: 1 }, ctx);
  return { matching: page.total, ...(page.value_cents ? { value_cents: page.value_cents } : {}) };
}

export const crmTools: AgentTool[] = [
  tool("crm_fields", "The CRM view format and one collection's fields: keys, types, the operators each type takes and the values of choice and person fields. Call before your first filter, sort, grouping or statistic on a collection.", { collection: collectionArg }, ["collection"], "read", async (run, args) => {
    const { collection, result } = await collectionOf(run, args.collection);
    return {
      guide: GUIDE,
      collection,
      rows: result.rows.length,
      fields: result.fields.map(field => ({
        key: field.key, label: field.label, type: field.type, operators: OPERATORS[field.type] || OPERATORS.text,
        ...(field.group ? { group: field.group } : {}),
        ...(field.column ? { default_column: true } : {}),
        ...(field.groupable === false ? { groupable: false } : {}),
        ...(field.options?.length ? { values: field.options.slice(0, MAX_OPTIONS).map(o => ({ value: o.value, label: o.label })), ...(field.options.length > MAX_OPTIONS ? { values_left_out: field.options.length - MAX_OPTIONS } : {}) } : {})
      }))
    };
  }),
  tool("crm_views", "The user's saved CRM views: id, name, collection, whether they are pinned, editable or were made by the assistant, and each one's definition.", {}, [], "read", async (run) => {
    const ctx = auth(run);
    if (!(await can(ctx, "crm.views").catch(() => false))) return toolError("CRM views are turned off for this company.");
    const views = (await listViews(ctx)).filter(view => hasPermission(ctx, collectionPermission(view.collection)));
    return { views: views.map(view => ({ view_id: view.id, name: view.name, collection: view.collection, pinned: view.pinned, hidden: view.hidden, editable: view.editable, shared: view.visibility !== "private", ai_generated: view.definition.origin === "ai", definition: { filter: view.definition.filter, sort: view.definition.sort, group_by: view.definition.group_by, layout: view.definition.layout, columns: view.definition.columns } })) };
  }),
  tool("crm_rows", "Fetch the rows of a collection that match a view definition (or a saved view), with the fields you ask for, to look at the data and decide. Returns the total, the summed value and up to 200 rows.", {
    collection: collectionArg,
    definition: definitionArg,
    view_id: { type: "string", description: "Read through a saved view instead of (or under) a definition." },
    search: { type: "string", description: "Optional text search over the rows' text fields." },
    fields: { type: "array", items: string, description: "Field keys to return for each row. Default: the default columns." },
    limit: { type: "integer", description: "Rows to return, at most 200. Default 25." },
    offset: { type: "integer" }
  }, ["collection"], "read", async (run, args) => {
    const view = cleanText(args.view_id) ? await readView(auth(run), cleanText(args.view_id)) : null;
    const { ctx, collection, result } = await collectionOf(run, view?.collection || args.collection);
    const given = cleanText(args.definition) ? asObject(parseJsonArg(args.definition, "definition")) : {};
    const checked = definitionFrom({ ...(view?.definition || {}), ...given }, collection, result.fields);
    if (checked.errors.length || !checked.definition) return toolError(...checked.errors);
    const limit = Math.min(MAX_ROWS, Math.max(1, Number(args.limit) || 25));
    const page = runQuery(result, { definition: checked.definition, search: cleanText(args.search), offset: Math.max(0, Number(args.offset) || 0), limit }, ctx);
    const fields = new Map(result.fields.map(f => [f.key, f]));
    const asked = list(args.fields).map(cleanText).filter(key => fields.has(key));
    const keys = asked.length ? asked : (checked.definition.columns.length ? checked.definition.columns : result.fields.filter(f => f.column).map(f => f.key));
    return {
      collection, total: page.total, offset: page.offset, returned: page.rows.length,
      ...(page.value_cents ? { value_cents: page.value_cents } : {}),
      ...(page.groups.length ? { groups: page.groups.map(g => ({ value: g.value, label: g.label, count: g.count, ...(g.value_cents ? { value_cents: g.value_cents } : {}) })) } : {}),
      rows: page.rows.map(row => present(row, keys, fields, result.labels)),
      ...(checked.warnings.length ? { notes: checked.warnings } : {})
    };
  }),
  tool("crm_stats", "Statistics over a collection's rows that match a filter: count, sum, avg, min, max, median, p25, p75, p90, stddev, distinct, filled, empty, true_count and true_share (percent) of any field, overall and broken down by up to two fields (dates by day, week, month, quarter, year, weekday or hour; numbers in bins). Use it to answer questions and to choose thresholds for filters.", {
    collection: collectionArg,
    filter: { type: "string", description: "Optional filter as a JSON object string in the condition format; empty for every row." },
    search: string,
    measures: { type: "array", items: { type: "object", properties: { op: { type: "string", enum: [...MEASURES] }, field: string }, required: ["op"], additionalProperties: false }, description: "What to compute. count is always included." },
    group_by: { type: "array", items: string, description: "Up to two field keys to break the numbers down by." },
    bucket: { type: "string", enum: [...BUCKETS], description: "How date fields in group_by are grouped. Default day." },
    bin_size: { type: "number", description: "Bin width for number or money fields in group_by (money in cents)." }
  }, ["collection"], "read", async (run, args) => await statistics(run, args)),
  tool("crm_show", "Change what the CRM tab shows: a definition (filters, sort, grouping, layout, columns) as an unsaved change the user can keep, save or discard, or a saved view by view_id. Only in the CRM tab's own conversation. Check the definition with crm_rows or crm_stats first.", {
    collection: collectionArg,
    definition: definitionArg,
    view_id: { type: "string", description: "Open this saved view instead." },
    name: { type: "string", description: "A short name for a view on another collection than the one on screen." }
  }, [], "read", async (run, args) => {
    if (!inCrm(run)) return toolError("The CRM tab is not beside this conversation. Save the view with crm_save_view instead, or tell the user to open the CRM and use its magic button.");
    if (cleanText(args.view_id)) {
      const view = await readView(auth(run), cleanText(args.view_id));
      await readable(run, view.collection);
      run.renders.push({ type: "crm_view", view_id: view.id, title: view.name });
      return { ok: true, status: "shown", view: view.name, ...(await viewSummary(run, view.collection, view.definition)) };
    }
    const { collection, result } = await collectionOf(run, args.collection);
    const checked = definitionFrom(args.definition, collection, result.fields);
    if (checked.errors.length || !checked.definition) return toolError(...checked.errors);
    const definition = { filter: checked.definition.filter, sort: checked.definition.sort, group_by: checked.definition.group_by, layout: checked.definition.layout, columns: checked.definition.columns };
    run.renders.splice(0, run.renders.length, ...run.renders.filter(render => asObject(render).type !== "crm_view"));
    run.renders.push({ type: "crm_view", collection, definition, title: cleanText(args.name).slice(0, 120) });
    return { ok: true, status: "shown", note: "The user sees it as an unsaved change of the view on screen, with Save and Discard.", ...(await viewSummary(run, collection, checked.definition)), ...(checked.warnings.length ? { notes: checked.warnings } : {}) };
  }),
  tool("crm_save_view", "Save a CRM view for the user, marked as made by the assistant: a new view (pinned for them), or changes to one of their saved views by view_id. New views are private; share with everyone only when the user asks and may share views. Opens the view when the CRM tab is beside the conversation.", {
    name: { type: "string", description: "The view's name, short and in the user's words." },
    collection: collectionArg,
    definition: definitionArg,
    view_id: { type: "string", description: "Update this saved view instead of creating one." },
    visibility: { type: "string", enum: ["private", "everyone"], description: "Default private." },
    description: { type: "string", description: "One sentence on what the view shows." }
  }, ["name", "definition"], "write", async (run, args) => {
    const ctx = auth(run);
    const existing = cleanText(args.view_id) ? await readView(ctx, cleanText(args.view_id)) : null;
    const { collection, result } = await collectionOf(run, existing?.collection || args.collection);
    const checked = definitionFrom(args.definition, collection, result.fields);
    if (checked.errors.length || !checked.definition) return toolError(...checked.errors);
    const definition: ViewDefinition = {
      ...checked.definition,
      icon: checked.definition.icon || existing?.definition.icon || "",
      description: cleanText(args.description).slice(0, 1000) || existing?.definition.description || "",
      origin: existing ? existing.definition.origin : "ai"
    };
    const visibility = cleanText(args.visibility) === "everyone" ? "everyone" : existing?.visibility || "private";
    const saved = await saveView(ctx, existing?.id || "", {
      name: cleanText(args.name).slice(0, 120) || existing?.name || "New view", collection, definition, visibility,
      role_ids: existing?.role_ids || [], default_role_ids: existing?.default_role_ids || [],
      ...(existing ? { expected_revision: existing.revision } : {})
    });
    run.changeLog.push(`${existing ? "Updated" : "Saved"} the CRM view "${saved.name}".`);
    run.renders.splice(0, run.renders.length, ...run.renders.filter(render => asObject(render).type !== "crm_view"));
    run.renders.push({ type: "crm_view", view_id: saved.id, saved: true, title: saved.name });
    return { ok: true, view_id: saved.id, name: saved.name, shared: saved.visibility !== "private", ...(await viewSummary(run, collection, saved.definition)), ...(inCrm(run) ? { status: "opened in the CRM tab" } : {}) };
  })
];

/** The person's private CRM conversation, the one the CRM tab's magic button opens. */
export async function ensureCrmConversation(ctx: PlatformAuthContext) {
  await requireCapability(ctx, "apps.assistant");
  return getAgentsDatabase().transaction(async (database) => {
    const existing = await database
      .prepare("SELECT * FROM agent_threads WHERE agent_id=? AND organization_id=? AND created_by_user_id=? AND subject_id=? ORDER BY created_at LIMIT 1")
      .get("assistant", ctx.orgId, ctx.userId, CRM_SUBJECT);
    return existing || createAgentThread({ agent_id: "assistant", organization_id: ctx.orgId, branch_id: ctx.branchId || "default", subject_id: CRM_SUBJECT, title: "CRM", created_by_user_id: ctx.userId });
  }, `crm-thread:${ctx.orgId}:${ctx.userId}`);
}

/** Prompt context for the CRM conversation. */
export async function crmConversationContext(ctx: PlatformAuthContext | null, subject: string) {
  if (subject !== CRM_SUBJECT) return "";
  if (!ctx) throw forbidden("crm_user", "Sign in to use the CRM.");
  return `## CRM tab
You are the bar at the bottom of the CRM tab, in the user's private conversation about it. The navigation metadata of each message carries what the tab shows ("crm": the open view, its collection, its definition, whether it has unsaved changes, and how many rows match). Requests here are about that view unless the user says otherwise: "only the ones from Google" adds to its filter; "start over" replaces it. To change the screen, build the whole definition from the one on screen, check it with crm_rows or crm_stats, then call crm_show; the user keeps, saves or discards it. Save only when asked (crm_save_view; with view_id to change the open view when it is theirs). When the data decides the filter ("my best sources", "leads that have gone cold"), read it with crm_stats or crm_rows first and say what you chose and why in one sentence. Keep replies short: the screen shows the result.`;
}
