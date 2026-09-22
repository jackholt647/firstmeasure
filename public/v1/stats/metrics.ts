// The stats metric DSL: a small, safe JSON query language that widgets and
// the stats agent both speak. Specs validate against a field whitelist and
// compile to parameterized SQL over the stats warehouse — no caller-supplied
// SQL ever runs. Formula metrics (e.g. close rate = sold / leads) evaluate a
// tiny arithmetic expression over named sub-queries, combined per group and
// time bucket. Results are memoized in the query cache keyed by the org's
// data version, so cache entries self-invalidate whenever the warehouse
// changes and repeated dashboard loads cost nothing.

import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { createHash } from "node:crypto";

import { badRequest } from "../platform/errors.js";
import {
  ensureSyncState,
  getStatsDatabase,
  readCachedQuery,
  writeCachedQuery,
  type JsonObject
} from "./storage.js";

const DAY_MS = 86_400_000;
const MAX_GROUPS = 500;
const MAX_RESULT_ROWS = 2_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

type FieldDef = {
  key: string;
  sql: string;
  kind: "dimension" | "measure" | "date";
  label: string;
  description: string;
  labelSql?: string;
  join?: "project";
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// ── Field catalogs ─────────────────────────────────────────────────────────

const PROJECT_FIELDS: FieldDef[] = [
  { key: "status", sql: "status", kind: "dimension", label: "Lifecycle status", description: "open, completed, canceled, or lost" },
  { key: "branch_id", sql: "branch_id", kind: "dimension", label: "Branch", description: "Branch the project belongs to" },
  { key: "source", sql: "source", kind: "dimension", label: "Lead source", description: "Where the project came from (website, referral, canvassing, ...)" },
  { key: "template_id", sql: "template_id", kind: "dimension", label: "Project type", description: "The scope/pipeline template (project type)", labelSql: "MAX(template_title)" },
  { key: "stage_title", sql: "stage_title", kind: "dimension", label: "Current stage", description: "The active pipeline stage title (open projects)" },
  { key: "primary_user_id", sql: "primary_user_id", kind: "dimension", label: "Owner / rep", description: "The user credited with the project (sales rep or owner)" },
  { key: "created_at", sql: "created_at", kind: "date", label: "Created", description: "When the project/lead was created" },
  { key: "sold_at", sql: "sold_at", kind: "date", label: "Sold", description: "When the project was sold (production work started)" },
  { key: "completed_at", sql: "completed_at", kind: "date", label: "Completed", description: "When the project completed" },
  { key: "canceled_at", sql: "canceled_at", kind: "date", label: "Canceled/Lost", description: "When the project was canceled or marked lost" },
  { key: "contract_cents", sql: "contract_cents", kind: "measure", label: "Contract value", description: "Total contract value in cents (payment obligations)" },
  { key: "collected_cents", sql: "collected_cents", kind: "measure", label: "Collected", description: "Cash collected in cents" },
  { key: "outstanding_cents", sql: "outstanding_cents", kind: "measure", label: "Outstanding", description: "Contract value not yet allocated/paid, in cents" },
  { key: "expenses_cents", sql: "expenses_cents", kind: "measure", label: "Expenses to date", description: "Expenses paid to date in cents" },
  { key: "projected_expenses_cents", sql: "projected_expenses_cents", kind: "measure", label: "Projected expenses", description: "Projected total expenses in cents" },
  { key: "profit_cents", sql: "profit_cents", kind: "measure", label: "Profit to date", description: "Collected minus expenses to date, in cents" },
  { key: "projected_profit_cents", sql: "projected_profit_cents", kind: "measure", label: "Projected profit", description: "Contract value minus projected expenses, in cents" },
  {
    key: "days_to_sale", kind: "measure", label: "Days to sale",
    sql: "CASE WHEN sold_at IS NOT NULL AND created_at IS NOT NULL THEN julianday(sold_at) - julianday(created_at) END",
    description: "Days from creation to sale (null until sold)"
  },
  {
    key: "days_to_complete", kind: "measure", label: "Days to complete",
    sql: "CASE WHEN completed_at IS NOT NULL AND sold_at IS NOT NULL THEN julianday(completed_at) - julianday(sold_at) END",
    description: "Days from sale to completion (null until completed)"
  },
  {
    key: "days_open", kind: "measure", label: "Days open",
    sql: "CASE WHEN created_at IS NOT NULL THEN julianday(COALESCE(completed_at, canceled_at, 'now')) - julianday(created_at) END",
    description: "Age in days from creation until close (or today while open)"
  }
];

const EVENT_FIELDS: FieldDef[] = [
  { key: "type", sql: "e.type", kind: "dimension", label: "Event type", description: "The activity/event type (e.g. project.created, node.completed)" },
  { key: "actor_user_id", sql: "e.actor_user_id", kind: "dimension", label: "Actor", description: "User who performed the action" },
  { key: "visibility", sql: "e.visibility", kind: "dimension", label: "Visibility", description: "activity (customer-meaningful) or system" },
  { key: "branch_id", sql: "e.branch_id", kind: "dimension", label: "Branch", description: "Branch the event belongs to" },
  { key: "project_id", sql: "e.project_id", kind: "dimension", label: "Project", description: "The project the event belongs to" },
  { key: "created_at", sql: "e.created_at", kind: "date", label: "Occurred", description: "When the event happened" },
  { key: "project_template_id", sql: "p.template_id", kind: "dimension", label: "Project type", description: "Template of the project the event belongs to", labelSql: "MAX(p.template_title)", join: "project" },
  { key: "project_status", sql: "p.status", kind: "dimension", label: "Project status", description: "Lifecycle status of the project the event belongs to", join: "project" },
  { key: "project_source", sql: "p.source", kind: "dimension", label: "Project source", description: "Lead source of the project the event belongs to", join: "project" },
  { key: "project_user_id", sql: "p.primary_user_id", kind: "dimension", label: "Project owner", description: "Owner/rep of the project the event belongs to", join: "project" }
];

const AGGS = new Set(["count", "count_distinct", "sum", "avg", "min", "max"]);
const OPS = new Set(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between", "contains", "is_set", "not_set"]);
const BUCKETS = new Set(["day", "week", "month", "quarter", "year"]);

export const TIME_PRESETS = [
  "today", "yesterday", "this_week", "last_week", "this_month", "last_month",
  "this_quarter", "last_quarter", "this_year", "last_year",
  "last_7_days", "last_30_days", "last_90_days", "last_180_days", "last_365_days", "all_time"
] as const;

function fieldCatalog(source: string) {
  return source === "events" ? EVENT_FIELDS : PROJECT_FIELDS;
}

function attrField(key: string, source: string): FieldDef | null {
  if (source === "events") return null;
  const match = key.match(/^attr:([a-z0-9_]{1,64})$/i);
  if (!match || !match[1]) return null;
  const name = match[1].toLowerCase();
  return {
    key,
    sql: isFirstMeasurePostgresEnabled() ? `CASE WHEN jsonb_typeof(attrs_json::jsonb->'${name}')='number' THEN (attrs_json::jsonb->>'${name}')::numeric END` : `json_extract(attrs_json, '$.${name}')`,
    kind: "measure",
    label: `Custom: ${name}`,
    description: `Custom project field '${name}'`
  };
}

function resolveField(key: string, source: string): FieldDef {
  const clean = cleanText(key);
  const found = fieldCatalog(source).find((field) => field.key === clean) || attrField(clean, source);
  if (!found) throw badRequest("stats_unknown_field", `Unknown ${source} field '${clean}'.`);
  if (!isFirstMeasurePostgresEnabled()) return found;
  return { ...found, sql: found.sql
    .replace("julianday(sold_at) - julianday(created_at)", "(EXTRACT(EPOCH FROM (NULLIF(sold_at,'')::timestamptz - NULLIF(created_at,'')::timestamptz)) / 86400.0)")
    .replace("julianday(completed_at) - julianday(sold_at)", "(EXTRACT(EPOCH FROM (NULLIF(completed_at,'')::timestamptz - NULLIF(sold_at,'')::timestamptz)) / 86400.0)")
    .replace("julianday(COALESCE(completed_at, canceled_at, 'now')) - julianday(created_at)", "(EXTRACT(EPOCH FROM (COALESCE(NULLIF(completed_at,'')::timestamptz, NULLIF(canceled_at,'')::timestamptz, CURRENT_TIMESTAMP) - NULLIF(created_at,'')::timestamptz)) / 86400.0)") };

}

export function describeStatsFields() {
  const shape = (field: FieldDef) => ({ key: field.key, kind: field.kind, label: field.label, description: field.description });
  return {
    projects: PROJECT_FIELDS.map(shape),
    events: EVENT_FIELDS.map(shape),
    custom_attributes: "Numeric custom project fields are addressable as 'attr:<name>' (filter or measure).",
    time_presets: [...TIME_PRESETS],
    buckets: [...BUCKETS],
    aggregations: [...AGGS],
    filter_ops: [...OPS]
  };
}

// ── Time resolution ────────────────────────────────────────────────────────

function dayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function utcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function mondayOf(day: Date) {
  const weekday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - weekday * DAY_MS);
}

export function resolveTimeRange(time: JsonObject, now = new Date()): { from: string; through: string } | null {
  const preset = cleanText(time.preset);
  const today = utcDay(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const quarter = Math.floor(today.getUTCMonth() / 3);
  if (preset === "all_time") return null;
  if (preset) {
    switch (preset) {
      case "today": return { from: dayKey(today), through: dayKey(tomorrow) };
      case "yesterday": return { from: dayKey(new Date(today.getTime() - DAY_MS)), through: dayKey(today) };
      case "this_week": return { from: dayKey(mondayOf(today)), through: dayKey(tomorrow) };
      case "last_week": {
        const monday = mondayOf(today);
        return { from: dayKey(new Date(monday.getTime() - 7 * DAY_MS)), through: dayKey(monday) };
      }
      case "this_month": return { from: dayKey(monthStart), through: dayKey(tomorrow) };
      case "last_month": return {
        from: dayKey(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))),
        through: dayKey(monthStart)
      };
      case "this_quarter": return { from: dayKey(new Date(Date.UTC(today.getUTCFullYear(), quarter * 3, 1))), through: dayKey(tomorrow) };
      case "last_quarter": return {
        from: dayKey(new Date(Date.UTC(today.getUTCFullYear(), (quarter - 1) * 3, 1))),
        through: dayKey(new Date(Date.UTC(today.getUTCFullYear(), quarter * 3, 1)))
      };
      case "this_year": return { from: dayKey(new Date(Date.UTC(today.getUTCFullYear(), 0, 1))), through: dayKey(tomorrow) };
      case "last_year": return {
        from: dayKey(new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1))),
        through: dayKey(new Date(Date.UTC(today.getUTCFullYear(), 0, 1)))
      };
      default: {
        const days = preset.match(/^last_(\d+)_days$/);
        if (!days || !TIME_PRESETS.includes(preset as never)) {
          throw badRequest("stats_unknown_time_preset", `Unknown time preset '${preset}'.`);
        }
        return { from: dayKey(new Date(today.getTime() - Number(days[1]) * DAY_MS)), through: dayKey(tomorrow) };
      }
    }
  }
  const from = cleanText(time.from).slice(0, 10);
  const through = cleanText(time.through).slice(0, 10);
  if (!from && !through) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(through) || through <= from) {
    throw badRequest("stats_time_invalid", "Custom time ranges need from and through as YYYY-MM-DD with through after from.");
  }
  return { from, through };
}

function bucketExpression(bucket: string, column: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const timestamp = `(NULLIF(${column}, '')::timestamptz AT TIME ZONE 'UTC')`;
    const format = { day: "YYYY-MM-DD", month: "YYYY-MM", quarter: 'YYYY"-Q"Q', year: "YYYY" }[bucket];
    if (bucket === "week") return `to_char(date_trunc('week', ${timestamp}), 'YYYY-MM-DD')`;
    if (format) return `to_char(${timestamp}, '${format}')`;
    throw badRequest("stats_unknown_bucket", `Unknown time bucket '${bucket}'.`);
  }
  switch (bucket) {
    case "day": return `strftime('%Y-%m-%d', ${column})`;
    case "week": return `date(${column}, '-6 days', 'weekday 1')`;
    case "month": return `strftime('%Y-%m', ${column})`;
    case "quarter": return `strftime('%Y', ${column}) || '-Q' || CAST((CAST(strftime('%m', ${column}) AS INTEGER) + 2) / 3 AS TEXT)`;
    case "year": return `strftime('%Y', ${column})`;
    default: throw badRequest("stats_unknown_bucket", `Unknown time bucket '${bucket}'.`);
  }
}

// ── Compilation ────────────────────────────────────────────────────────────

type Compiled = {
  sql: string;
  params: unknown[];
  hasGroup: boolean;
  hasBucket: boolean;
};

function likeEscape(value: string) {
  return value.replace(/[!%_]/g, char => `!${char}`);
}

function compileFilters(filters: unknown, source: string, where: string[], params: unknown[], joins: Set<string>) {
  for (const raw of asArray(filters).slice(0, 24)) {
    const filter = asObject(raw);
    const field = resolveField(cleanText(filter.field), source);
    if (field.join) joins.add(field.join);
    const op = cleanText(filter.op || "eq");
    if (!OPS.has(op)) throw badRequest("stats_unknown_op", `Unknown filter op '${op}'.`);
    const values = (Array.isArray(filter.values) ? filter.values : filter.value !== undefined ? [filter.value] : [])
      .map((value) => (typeof value === "number" ? value : cleanText(value)));
    const column = field.sql;
    switch (op) {
      case "eq": where.push(`${column} = ?`); params.push(values[0] ?? ""); break;
      case "neq": where.push(`(${column} IS NULL OR ${column} <> ?)`); params.push(values[0] ?? ""); break;
      case "in":
      case "not_in": {
        if (!values.length) throw badRequest("stats_filter_values_required", `Filter op '${op}' needs values.`);
        const list = values.slice(0, 100);
        const placeholders = list.map(() => "?").join(", ");
        where.push(op === "in" ? `${column} IN (${placeholders})` : `(${column} IS NULL OR ${column} NOT IN (${placeholders}))`);
        params.push(...list);
        break;
      }
      case "gt": where.push(`${column} > ?`); params.push(values[0] ?? 0); break;
      case "gte": where.push(`${column} >= ?`); params.push(values[0] ?? 0); break;
      case "lt": where.push(`${column} < ?`); params.push(values[0] ?? 0); break;
      case "lte": where.push(`${column} <= ?`); params.push(values[0] ?? 0); break;
      case "between":
        if (values.length < 2) throw badRequest("stats_filter_values_required", "Filter op 'between' needs two values.");
        where.push(`${column} BETWEEN ? AND ?`);
        params.push(values[0], values[1]);
        break;
      case "contains":
        where.push(`${column} ${isFirstMeasurePostgresEnabled() ? 'ILIKE' : 'LIKE'} ? ESCAPE '!'`);
        params.push(`%${likeEscape(cleanText(values[0]))}%`);
        break;
      case "is_set": where.push(`(${column} IS NOT NULL AND ${column} <> '')`); break;
      case "not_set": where.push(`(${column} IS NULL OR ${column} = '')`); break;
    }
  }
}

function compileMetric(orgId: string, spec: JsonObject, now: Date): Compiled {
  const source = cleanText(spec.source || "projects") === "events" ? "events" : "projects";
  const agg = cleanText(spec.agg || "count");
  if (!AGGS.has(agg)) throw badRequest("stats_unknown_agg", `Unknown aggregation '${agg}'.`);

  let measureSql = "*";
  if (agg !== "count" || cleanText(spec.measure)) {
    const measureKey = cleanText(spec.measure);
    if (agg === "count" && !measureKey) {
      measureSql = "*";
    } else {
      if (!measureKey) throw badRequest("stats_measure_required", `Aggregation '${agg}' needs a measure field.`);
      const field = resolveField(measureKey, source);
      if (agg !== "count_distinct" && field.kind === "dimension") {
        throw badRequest("stats_measure_invalid", `'${measureKey}' is a dimension; use it with group_by, filters, or count_distinct.`);
      }
      measureSql = field.sql;
    }
  }
  const aggSql = agg === "count"
    ? `COUNT(${measureSql === "*" ? "*" : measureSql})`
    : agg === "count_distinct"
      ? `COUNT(DISTINCT ${measureSql})`
      : `${agg.toUpperCase()}(${measureSql})`;

  const joins = new Set<string>();
  const select: string[] = [];
  const groupBy: string[] = [];
  const where: string[] = [source === "events" ? "e.organization_id = ?" : "organization_id = ?"];
  const params: unknown[] = [orgId];

  const time = asObject(spec.time);
  const timeFieldKey = cleanText(time.field || "created_at");
  const timeField = resolveField(timeFieldKey, source);
  if (timeField.kind !== "date") throw badRequest("stats_time_field_invalid", `'${timeFieldKey}' is not a date field.`);
  const range = resolveTimeRange(time, now);
  if (range) {
    where.push(`${timeField.sql} >= ? AND ${timeField.sql} < ?`);
    params.push(`${range.from}T00:00:00`, `${range.through}T00:00:00`);
  }
  const bucket = cleanText(time.bucket);
  if (bucket) {
    if (!BUCKETS.has(bucket)) throw badRequest("stats_unknown_bucket", `Unknown time bucket '${bucket}'.`);
    where.push(`${timeField.sql} IS NOT NULL`);
    select.push(`${bucketExpression(bucket, timeField.sql)} AS bucket`);
    groupBy.push("bucket");
  }

  const groupKey = cleanText(spec.group_by);
  let groupField: FieldDef | null = null;
  if (groupKey) {
    groupField = resolveField(groupKey, source);
    if (groupField.join) joins.add(groupField.join);
    select.push(`COALESCE(CAST(${groupField.sql} AS TEXT), '') AS grp`);
    if (groupField.labelSql) select.push(`${groupField.labelSql} AS grp_label`);
    groupBy.push("grp");
  }

  compileFilters(spec.filters, source, where, params, joins);

  select.push(`${aggSql} AS value`, "COUNT(*) AS row_count");

  const from = source === "events"
    ? `stats_events e${joins.has("project")
      ? " LEFT JOIN stats_projects p ON p.organization_id = e.organization_id AND p.project_id = e.project_id"
      : ""}`
    : "stats_projects";

  const limit = Math.min(MAX_GROUPS, Math.max(1, Math.floor(Number(spec.limit) || 50)));
  const sortKey = cleanText(spec.sort || (bucket ? "bucket_asc" : groupKey ? "value_desc" : ""));
  const order = sortKey === "value_asc" ? "value ASC"
    : sortKey === "group_asc" ? "grp ASC"
      : sortKey === "bucket_asc" ? (groupBy.length ? groupBy.join(", ") : "value DESC")
        : groupBy.length ? "value DESC" : "";

  const sql = `SELECT ${select.join(", ")} FROM ${from} WHERE ${where.join(" AND ")}`
    + (groupBy.length ? ` GROUP BY ${groupBy.join(", ")}` : "")
    + (order ? ` ORDER BY ${order}` : "")
    + (groupBy.length ? ` LIMIT ${groupKey && !bucket ? limit : MAX_RESULT_ROWS}` : "");

  return { sql, params, hasGroup: Boolean(groupKey), hasBucket: Boolean(bucket) };
}

// ── Formula evaluation ─────────────────────────────────────────────────────

type Token = { type: "num" | "name" | "op" | "paren"; value: string };

function tokenizeFormula(expr: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(\d+(?:\.\d+)?|[a-zA-Z_][a-zA-Z0-9_]*|[+\-*/()])/y;
  let index = 0;
  while (index < expr.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(expr);
    if (!match || !match[1]) throw badRequest("stats_formula_invalid", `Formula has an invalid token near '${expr.slice(index, index + 8)}'.`);
    const value = match[1];
    tokens.push({
      type: /^\d/.test(value) ? "num" : /^[a-zA-Z_]/.test(value) ? "name" : value === "(" || value === ")" ? "paren" : "op",
      value
    });
    index = pattern.lastIndex;
  }
  if (!tokens.length) throw badRequest("stats_formula_invalid", "Formula is empty.");
  return tokens;
}

function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const stack: Token[] = [];
  const precedence: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
  for (const token of tokens) {
    if (token.type === "num" || token.type === "name") output.push(token);
    else if (token.value === "(") stack.push(token);
    else if (token.value === ")") {
      while (stack.length && stack[stack.length - 1]?.value !== "(") output.push(stack.pop() as Token);
      if (!stack.length) throw badRequest("stats_formula_invalid", "Formula has unbalanced parentheses.");
      stack.pop();
    } else {
      for (;;) {
        const top = stack[stack.length - 1];
        if (!top || top.type !== "op" || (precedence[top.value] ?? 0) < (precedence[token.value] ?? 0)) break;
        output.push(stack.pop() as Token);
      }
      stack.push(token);
    }
  }
  while (stack.length) {
    const token = stack.pop() as Token;
    if (token.value === "(") throw badRequest("stats_formula_invalid", "Formula has unbalanced parentheses.");
    output.push(token);
  }
  return output;
}

function evaluateRpn(rpn: Token[], values: Record<string, number>): number | null {
  const stack: Array<number | null> = [];
  for (const token of rpn) {
    if (token.type === "num") stack.push(Number(token.value));
    else if (token.type === "name") {
      if (!(token.value in values)) throw badRequest("stats_formula_invalid", `Formula references unknown input '${token.value}'.`);
      stack.push(values[token.value] ?? 0);
    } else {
      const right = stack.pop();
      const left = stack.pop();
      if (left === undefined || right === undefined) throw badRequest("stats_formula_invalid", "Formula is malformed.");
      if (left === null || right === null) {
        stack.push(null);
        continue;
      }
      if (token.value === "/") stack.push(right === 0 ? null : left / right);
      else if (token.value === "*") stack.push(left * right);
      else if (token.value === "+") stack.push(left + right);
      else stack.push(left - right);
    }
  }
  if (stack.length !== 1) throw badRequest("stats_formula_invalid", "Formula is malformed.");
  const result = stack[0] ?? null;
  return result === null || !Number.isFinite(result) ? null : result;
}

// ── Execution ──────────────────────────────────────────────────────────────

export type MetricRow = {
  bucket?: string;
  group?: string;
  group_label?: string;
  value: number | null;
  row_count?: number;
};

async function runCompiled(compiled: Compiled): Promise<MetricRow[]> {
  const rows = (await getStatsDatabase().prepare(compiled.sql).all(...(compiled.params as never[])));
  if (rows.length > MAX_RESULT_ROWS) {
    throw badRequest("stats_result_too_large", "This query returns too many rows; use a coarser time bucket or add filters.");
  }
  return rows.map((raw) => {
    const row = asObject(raw);
    const value = row.value === null || row.value === undefined ? null : Number(row.value);
    const result: MetricRow = { value: value !== null && Number.isFinite(value) ? value : null, row_count: Number(row.row_count || 0) };
    if (compiled.hasBucket) result.bucket = cleanText(row.bucket);
    if (compiled.hasGroup) {
      result.group = cleanText(row.grp);
      if (row.grp_label !== undefined) result.group_label = cleanText(row.grp_label);
    }
    return result;
  });
}

function rowKey(row: MetricRow) {
  return `${row.bucket ?? ""}\u0000${row.group ?? ""}`;
}

export async function executeMetricSpec(orgId: string, specValue: unknown, now = new Date()): Promise<MetricRow[]> {
  const spec = asObject(specValue);
  if (cleanText(spec.formula)) {
    const inputs = asObject(spec.inputs);
    const names = Object.keys(inputs).slice(0, 8);
    if (!names.length) throw badRequest("stats_formula_invalid", "Formula metrics need an inputs map of named sub-queries.");
    const rpn = toRpn(tokenizeFormula(cleanText(spec.formula)));
    const inputRows = new Map<string, MetricRow[]>();
    let shapeSignature = "";
    for (const name of names) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw badRequest("stats_formula_invalid", `Input name '${name}' is invalid.`);
      const inputSpec = asObject(inputs[name]);
      const signature = `${cleanText(inputSpec.group_by)}|${cleanText(asObject(inputSpec.time).bucket)}`;
      if (!shapeSignature) shapeSignature = signature;
      else if (signature !== shapeSignature) {
        throw badRequest("stats_formula_invalid", "Formula inputs must share the same group_by and time bucket.");
      }
      inputRows.set(name, (await executeMetricSpec(orgId, inputSpec, now)));
    }
    const keys = new Map<string, MetricRow>();
    for (const rows of inputRows.values()) {
      for (const row of rows) {
        if (!keys.has(rowKey(row))) {
          keys.set(rowKey(row), { ...(row.bucket !== undefined ? { bucket: row.bucket } : {}), ...(row.group !== undefined ? { group: row.group, group_label: row.group_label } : {}), value: null });
        }
      }
    }
    const results: MetricRow[] = [];
    for (const [key, base] of keys) {
      const values: Record<string, number> = {};
      let missing: string | null = null;
      for (const name of names) {
        const match = (inputRows.get(name) || []).find((row) => rowKey(row) === key);
        if (match && match.value !== null) values[name] = match.value;
        else values[name] = 0;
        if (!match) missing = name;
      }
      void missing;
      results.push({ ...base, value: evaluateRpn(rpn, values) });
    }
    results.sort((a, b) => cleanText(a.bucket).localeCompare(cleanText(b.bucket)) || cleanText(a.group).localeCompare(cleanText(b.group)));
    return results;
  }
  return (await runCompiled(compileMetric(orgId, spec, now)));
}

// Validates a spec without running it (used before saving views).
export function validateMetricSpec(specValue: unknown) {
  const spec = asObject(specValue);
  if (cleanText(spec.formula)) {
    const inputs = asObject(spec.inputs);
    const names = Object.keys(inputs);
    if (!names.length) throw badRequest("stats_formula_invalid", "Formula metrics need an inputs map of named sub-queries.");
    toRpn(tokenizeFormula(cleanText(spec.formula)));
    for (const name of names) validateMetricSpec(inputs[name]);
    return;
  }
  compileMetric("validation", spec, new Date());
}

// Batch execution with the version-keyed query cache. Cache keys embed the
// org's data version and the concretely-resolved time range, so entries are
// naturally invalidated by warehouse changes and by day rollover.
export async function executeStatsQueries(orgId: string, queries: JsonObject, options: { ttlMs?: number; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const state = (await ensureSyncState(orgId));
  const version = Number(state.data_version || 1);
  const results: JsonObject = {};
  const keys = Object.keys(queries).slice(0, 32);
  for (const key of keys) {
    const spec = asObject(queries[key]);
    const resolved = resolveResolvedSpec(spec, now);
    const cacheKey = createHash("sha256")
      .update(`${orgId}\u0000${version}\u0000${JSON.stringify(resolved)}`)
      .digest("base64url");
    const cached = (await readCachedQuery(cacheKey));
    if (cached && cached.payload) {
      results[key] = { rows: cached.payload, cached: true, computed_at: cached.computed_at };
      continue;
    }
    const rows = (await executeMetricSpec(orgId, resolved, now));
    (await writeCachedQuery(orgId, cacheKey, rows, options.ttlMs ?? DEFAULT_CACHE_TTL_MS));
    results[key] = { rows, cached: false, computed_at: now.toISOString() };
  }
  return { results, data_version: version };
}

// Rewrites relative time presets to concrete from/through dates so equivalent
// requests share cache entries (and keys change at day boundaries).
function resolveResolvedSpec(spec: JsonObject, now: Date): JsonObject {
  const clone = JSON.parse(JSON.stringify(spec)) as JsonObject;
  const rewrite = (node: JsonObject) => {
    const time = asObject(node.time);
    if (Object.keys(time).length) {
      const range = resolveTimeRange(time, now);
      node.time = {
        ...(cleanText(time.field) ? { field: cleanText(time.field) } : {}),
        ...(cleanText(time.bucket) ? { bucket: cleanText(time.bucket) } : {}),
        ...(range ? { from: range.from, through: range.through } : {})
      };
    }
    const inputs = asObject(node.inputs);
    for (const key of Object.keys(inputs)) rewrite(asObject(inputs[key]));
  };
  rewrite(clone);
  return clone;
}
