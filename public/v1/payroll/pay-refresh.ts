import { runModuleCode } from "../documents/modules/runtime.js";
import { readAssignee, type Assignee } from "../labor/assignees.js";
import { backgroundAuthContext } from "../platform/auth.js";
import { userPublicationContext } from "../platform/publication/context.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { describeDataProvider } from "../platform/publication/providers.js";
import { selectPublishedData, type SelectedRow } from "../platform/publication/select.js";
import { contentHash as hashJson } from "../platform/publication/validation.js";
import {
  candidateRuleSlots, distributionOn, draftPayDefault, draftPayPlan, draftPayRule, effectiveRuleSlots, ensurePayRuleSchema, listPayDefaults, listPayPlans, listPayRules, listPaySetups, listPaySplitRules, payDefaultSubjectsFor, payeeKey, payLayersFor, resolvePaySchedule, resolvedParams, versionOn,
  type Actor, type PayDefault, type PayLayer, type PayPlan, type PayRule, type PayRuleDefinition, type PayRuleVersion, type PaySetup, type PaySplitDefinition, type PaySplitRule, type PaySplitRuleVersion
} from "./pay-rules.js";
import type { PayrollLedgerEntryInput, PayrollPayeeRef } from "./schemas.js";
import { badRequest } from "../platform/errors.js";
import { findPayrollLedgerSourceEntries, getPayrollDatabase, nowIso, readPayrollLedgerEntry, voidPayrollLedgerEntry, type JsonObject } from "./storage.js";

/**
 * Works out what each payee has earned from their pay rules and makes the
 * ledger agree. Nothing here edits a posted earning: a difference between what
 * a rule now says and what the ledger holds is posted as a new entry.
 *
 * A record or period is only run again when something it read has changed:
 * the rule version, its parameters, or the revision of any row. Reading the
 * rows is still a scan today (see platform/publication/select.ts).
 */
export type PayLine = { key: string; amount_cents: number; description: string; details?: JsonObject };
/** `payee` is set when the entry belongs to someone other than the payee being refreshed: a member of a group whose pay is split. */
export type PayDifference = { rule_id: string; unit: string; line: string; earned_on: string; posted_cents: number; target_cents: number; delta_cents: number; handling: string; payee?: string };
export type PayUnresolved = { rule_id: string; unit?: string; reason: string };
export type PayRefreshResult = {
  payee: Assignee; payee_name?: string; evaluated: number; unchanged: number; differences: PayDifference[]; unresolved: PayUnresolved[];
  /** Ledger entries written by this refresh. Empty for a preview. */
  posted: JsonObject[];
};
export type PayRefreshOptions = {
  /** Work out and report differences without posting or remembering anything. */
  dryRun?: boolean;
  /** Evaluate as if the payee had this setup. Only with `dryRun`. */
  setup?: Pick<PaySetup, "entries" | "distribution" | "schedules">;
  /** Evaluate as if these rules, plans and defaults had been saved, in place of the stored ones with the same id or subject. Only with `dryRun`. */
  overrides?: { rules?: PayRule[]; plans?: PayPlan[]; defaults?: Pick<PayDefault, "subject" | "entries" | "distribution" | "schedules">[] };
  /** The instant "now" is. Periods that end after it are not earned yet. */
  asOf?: string;
  /** Reads run as each rule's author unless a trusted caller supplies the context. */
  context?: PublicationContext;
};

type Row = SelectedRow;
type Unit = { key: string; date: string; earned_at: string; payload: JsonObject; evidence: [string, string, string][]; project_id: string };
type Params = Record<string, number | boolean | string>;
type Planned = Unit & { version: PayRuleVersion; rule: PayRule; params: Params; digest: string; shared: JsonObject; timezone: string; split: SplitPlan | null };
/** One member's part of one earning line under a split rule: the weight the rule gave them and what it said about why. */
export type PayShare = { id: string; weight: number; reason?: string; details?: JsonObject };
/**
 * Who shares a group's earning. `members` is fixed when the earning is first
 * worked out; `basis` identifies the distribution setting it came from. With
 * `equal` and `shares` the weights in `members` are fixed too. With a split
 * rule the weights live per earning line under `rule.lines` and are worked out
 * again, among the same members, whenever something the rule reads changes.
 */
export type PayAllocation = {
  basis: string; method?: "equal" | "shares" | "rule"; members: { id: string; weight: number }[];
  rule?: { id: string; version: string; params: Params; lines: Record<string, PayShare[]> };
};
type StoredUnit = { rule_id: string; unit_key: string; digest: string; status: string; earned_at: string; lines: PayLine[]; allocation: PayAllocation | null };
/** One row handed to a split rule: the row, the member it is about, and the exact seconds of it inside the earning's window. */
type SplitRow = { row: JsonObject; member?: string; seconds?: number };
/** How one earning will be divided by a split rule, settled before anything runs so its digest can say what the split read. */
type SplitPlan = {
  basis: string; error?: string; rule?: PaySplitRule; version?: PaySplitRuleVersion; params: Params; members: string[];
  span: { from: string; to: string }; rows: Record<string, SplitRow[]>; evidence: [string, string, string][];
};
type SplitRead = { failure: string } | { inputs: Record<string, { fields: [string, string][]; buckets: Map<string, Row[]> }> };

/** Hashes plain data; keys left undefined are not part of it. */
const contentHash = (value: unknown) => hashJson(JSON.parse(JSON.stringify(value)));
const DAY = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown) => String(value ?? "").trim();
const utc = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function localDay(instant: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function readField(row: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as JsonObject)[key] : undefined, row);
}
/** The local day a row's date falls on, and the instant it is treated as earned. */
function rowDate(row: unknown, path: string, timezone: string) {
  const raw = readField(row, path);
  if (typeof raw === "string" && DATE_ONLY.test(raw)) return { date: raw, instant: `${raw}T12:00:00.000Z` };
  const instant = typeof raw === "number" ? raw : typeof raw === "string" && raw ? Date.parse(raw) : NaN;
  return Number.isFinite(instant) ? { date: localDay(instant, timezone), instant: new Date(instant).toISOString() } : null;
}
export function payPeriodOf(date: string, period: NonNullable<PayRuleDefinition["period"]>, weekStarts = 1) {
  const at = new Date(utc(date));
  const year = at.getUTCFullYear(), month = at.getUTCMonth();
  let from: number, through: number;
  if (period === "day") from = through = at.getTime();
  else if (period === "week") { from = at.getTime() - ((at.getUTCDay() - weekStarts + 7) % 7) * DAY; through = from + 6 * DAY; }
  else if (period === "month") { from = Date.UTC(year, month, 1); through = Date.UTC(year, month + 1, 0); }
  else if (period === "quarter") { from = Date.UTC(year, month - month % 3, 1); through = Date.UTC(year, month - month % 3 + 3, 0); }
  else { from = Date.UTC(year, 0, 1); through = Date.UTC(year, 11, 31); }
  return { key: dayOf(from), from: dayOf(from), through: dayOf(through) };
}

/**
 * What a formula may need to know about its period and cannot work out itself,
 * since it has no clock or calendar: how long the period is and where its first
 * day sits. A salary earned by the day divides by `days_in_month` or
 * `days_in_year`, which is also what prorates someone who starts mid-month.
 */
function calendarFacts(from: string, through: string) {
  const start = new Date(utc(from)), year = start.getUTCFullYear(), month = start.getUTCMonth();
  return {
    days: Math.round((utc(through) - utc(from)) / DAY) + 1,
    year, month: month + 1, day_of_month: start.getUTCDate(), weekday: start.getUTCDay(),
    days_in_month: new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
    days_in_year: Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY)
  };
}

/** How far a timezone's wall clock is ahead of UTC at an instant, in milliseconds. */
function zoneOffset(instant: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(instant / 1000) * 1000;
}
/** The exact instant a calendar day starts in a timezone. */
export function zonedDayStart(date: string, timezone: string) {
  const wall = utc(date);
  return wall - zoneOffset(wall - zoneOffset(wall, timezone), timezone);
}
const instantOf = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) : NaN;

function withTokens<T>(value: T, payee: Assignee, more: Record<string, string | string[]> = {}): T {
  const tokens: Record<string, string | string[]> = { "$payee.key": payeeKey(payee), "$payee.type": payee.type, "$payee.id": payee.id, ...more };
  const visit = (entry: unknown): unknown => typeof entry === "string" ? tokens[entry] ?? entry
    : Array.isArray(entry) ? entry.map(visit)
      : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, visit(child)])) : entry;
  return visit(value) as T;
}
/** The parts of a definition that decide which records or periods exist. Versions that agree on them share one read. */
const shapeOf = (definition: PayRuleDefinition) => contentHash({
  grain: definition.grain, period: definition.period, week_starts: definition.week_starts, always: definition.always,
  timezone: definition.timezone, earned_at: definition.earned_at, project: definition.project, inputs: definition.inputs
});

async function payeeRef(orgId: string, payee: Assignee): Promise<PayrollPayeeRef | null> {
  const found = await readAssignee(orgId, payee);
  if (!found) return null;
  const classification = text(found.record.worker_classification);
  const worker_type = payee.type === "organization_connection" ? "subcontractor"
    : classification === "independent_contractor" || classification === "subcontractor" ? classification : "employee";
  return { type: payee.type, id: payee.id, name: found.name, worker_type } as PayrollPayeeRef;
}

/** `projected` names inputs read as their source projects them (`args.projected`); every other input is read as it is. */
async function readInputs(ctx: PublicationContext, orgId: string, definition: PayRuleDefinition, payee: Assignee, projected?: ReadonlySet<string>) {
  const rows: Record<string, Row[]> = {};
  for (const [name, input] of Object.entries(definition.inputs)) {
    const args = projected?.has(name) ? { ...input.source.args, projected: true } : input.source.args;
    const result = await selectPublishedData(ctx, withTokens({
      provider: input.source.provider, export: input.source.export, target: { scope: "organization" as const, organizationId: orgId }, ...(args ? { args } : {})
    }, payee), withTokens({ ...(input.where === undefined ? {} : { where: input.where }), limit: input.limit ?? 5000 }, payee));
    if (result.status !== "ready") return { failure: `${name}: ${result.message}` };
    rows[name] = result.rows;
  }
  return { rows };
}

/** Every record or period one shape of a rule could pay, before asking whether the rule applied on that day. */
function unitsFor(definition: PayRuleDefinition, rows: Record<string, Row[]>, timezone: string, asOfDay: string, firstDay: string) {
  const sharedNames = Object.entries(definition.inputs).filter(([, input]) => definition.grain === "record" ? !input.primary : !input.date).map(([name]) => name);
  const shared: JsonObject = Object.fromEntries(sharedNames.map((name) => [name, rows[name]!.map((row) => row.value)]));
  const sharedEvidence = sharedNames.flatMap((name) => rows[name]!.map((row): [string, string, string] => [name, row.key, row.revision]));
  const units: Unit[] = [];
  if (definition.grain === "record") {
    const [name] = Object.entries(definition.inputs).find(([, input]) => input.primary)!;
    for (const row of rows[name]!) {
      const earned = rowDate(row.value, definition.earned_at!, timezone);
      if (!earned || earned.date > asOfDay) continue;
      units.push({ key: row.key, date: earned.date, earned_at: earned.instant, payload: { record: row.value, earned_at: earned.instant },
        evidence: [[name, row.key, row.revision]], project_id: definition.project ? text(readField(row.value, definition.project)) : "" });
    }
  } else {
    const period = definition.period!;
    const buckets = new Map<string, { from: string; through: string; rows: Record<string, Row[]> }>();
    const bucket = (date: string) => {
      const range = payPeriodOf(date, period, definition.week_starts);
      if (!buckets.has(range.key)) buckets.set(range.key, { from: range.from, through: range.through, rows: {} });
      return buckets.get(range.key)!;
    };
    const dated = Object.entries(definition.inputs).filter(([, input]) => input.date);
    for (const [name, input] of dated) for (const row of rows[name]!) {
      const at = rowDate(row.value, input.date!, timezone);
      if (at) (bucket(at.date).rows[name] ||= []).push(row);
    }
    if (definition.always && firstDay) for (let at = utc(payPeriodOf(firstDay, period, definition.week_starts).from), count = 0; dayOf(at) <= asOfDay && count < 4000; count++) {
      const range = bucket(dayOf(at));
      at = utc(range.through) + DAY;
    }
    for (const [key, entry] of buckets) {
      // A period is earned once its last day is over.
      if (entry.through >= asOfDay) continue;
      units.push({ key, date: entry.through, earned_at: `${entry.through}T12:00:00.000Z`, project_id: "",
        payload: { period: { key, from: entry.from, through: entry.through, ...calendarFacts(entry.from, entry.through) }, rows: Object.fromEntries(dated.map(([name]) => [name, (entry.rows[name] || []).map((row) => row.value)])) },
        evidence: dated.flatMap(([name]) => (entry.rows[name] || []).map((row): [string, string, string] => [name, row.key, row.revision])) });
    }
  }
  return { units, shared, sharedEvidence };
}

function normalizeLines(value: unknown, fallback: string): PayLine[] {
  const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
  const lines = list.map((entry, index): PayLine => {
    const line = typeof entry === "number" ? { amount_cents: entry } : entry && typeof entry === "object" && !Array.isArray(entry) ? entry as JsonObject : null;
    if (!line || !Number.isSafeInteger(line.amount_cents)) throw new Error("Each earning needs a whole number of cents in amount_cents.");
    const key = text(line.key) || (list.length === 1 ? "main" : `line_${index + 1}`);
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(key)) throw new Error("An earning's key uses letters, digits, dots, dashes and underscores.");
    const details = line.details && typeof line.details === "object" && !Array.isArray(line.details) ? line.details as JsonObject : undefined;
    return { key, amount_cents: line.amount_cents as number, description: text(line.description).slice(0, 500) || fallback, ...(details ? { details } : {}) };
  });
  if (new Set(lines.map((line) => line.key)).size !== lines.length) throw new Error("Two earnings from one record or period share a key.");
  return lines;
}

const RUNNER = (code: string) => `const __rule = (unit, params, payee, shared) => { ${code}\n };
const __out = [];
for (const entry of inputs.units) {
  try { const lines = __rule(entry.unit, inputs.params, inputs.payee, inputs.shared); __out.push({ key: entry.key, lines: lines === undefined ? null : lines }); }
  catch (error) { __out.push({ key: entry.key, error: String(error && error.message || error).slice(0, 500) }); }
}
return { outputs: { units: __out } };`;

/** Runs one version of a rule over the records or periods that changed, in the sandbox. It can read nothing but what it is handed. */
async function evaluate(group: Planned[], payee: Assignee, asOf: string): Promise<Map<string, { lines?: PayLine[]; error?: string }>> {
  const results = new Map<string, { lines?: PayLine[]; error?: string }>();
  const first = group[0]!;
  const sharedSize = JSON.stringify(first.shared).length;
  const chunks: Planned[][] = [[]];
  let size = sharedSize;
  for (const unit of group) {
    const length = JSON.stringify(unit.payload).length;
    if (sharedSize + length > 900_000) { results.set(unit.key, { error: "This record or period carries more data than a rule can be handed at once." }); continue; }
    if (size + length > 900_000) { chunks.push([]); size = sharedSize; }
    chunks.at(-1)!.push(unit);
    size += length;
  }
  for (const chunk of chunks.filter((entries) => entries.length)) {
    try {
      const run = await runModuleCode({
        source: RUNNER(first.version.definition.code), mode: "evaluate", now: asOf, limits: { milliseconds: 5000 },
        inputs: { units: chunk.map((unit) => ({ key: unit.key, unit: unit.payload })), params: first.params, payee: { ...payee, key: payeeKey(payee) }, shared: first.shared }
      }, { read: async () => { throw new Error("A pay rule reads only its declared inputs."); }, invoke: async () => { throw new Error("A pay rule cannot act."); } });
      const returned = new Map((Array.isArray(run.outputs.units) ? run.outputs.units as JsonObject[] : []).map((entry) => [text(entry.key), entry]));
      for (const unit of chunk) {
        const entry = returned.get(unit.key);
        if (!entry) results.set(unit.key, { error: "The rule returned nothing for this record or period." });
        else if (entry.error) results.set(unit.key, { error: text(entry.error) });
        else try { results.set(unit.key, { lines: normalizeLines(entry.lines, unit.rule.name) }); } catch (error) { results.set(unit.key, { error: (error as Error).message }); }
      }
    } catch (error) {
      for (const unit of chunk) results.set(unit.key, { error: text((error as Error).message).slice(0, 500) || "The rule could not be run." });
    }
  }
  return results;
}

/**
 * Selects a split rule's inputs once for the whole group and sorts the rows by
 * the fields they are matched to an earning on. Which rows are read is all in
 * the declared selection; handing each earning its rows is an equality lookup
 * and a time range, which an index can answer the same way.
 */
async function readSplitInputs(ctx: PublicationContext, orgId: string, definition: PaySplitDefinition, payee: Assignee, members: string[]): Promise<SplitRead> {
  const tokens = { "$members.keys": members.map((id) => `organization_user:${id}`), "$members.ids": members };
  const inputs: Record<string, { fields: [string, string][]; buckets: Map<string, Row[]> }> = {};
  for (const [name, input] of Object.entries(definition.inputs)) {
    const result = await selectPublishedData(ctx, withTokens({
      provider: input.source.provider, export: input.source.export, target: { scope: "organization" as const, organizationId: orgId }, ...(input.source.args ? { args: input.source.args } : {})
    }, payee, tokens), withTokens({ ...(input.where === undefined ? {} : { where: input.where }), limit: input.limit ?? 5000 }, payee, tokens));
    if (result.status !== "ready") return { failure: `${name}: ${result.message}` };
    const fields = Object.entries(input.match || {}).sort(([a], [b]) => a.localeCompare(b));
    const buckets = new Map<string, Row[]>();
    for (const row of result.rows) {
      const key = fields.map(([path]) => text(readField(row.value, path))).join("\u0000");
      buckets.set(key, [...(buckets.get(key) || []), row]);
    }
    inputs[name] = { fields, buckets };
  }
  return { inputs };
}

/** The rows of a split rule's inputs that belong to one earning: matched to it, about one of its members, and inside its window. */
function splitRowsFor(definition: PaySplitDefinition, read: Extract<SplitRead, { inputs: unknown }>, earning: { rule_id: string; unit: Unit }, members: string[], span: { from: number; to: number }) {
  const memberKeys = new Set(members.map((id) => `organization_user:${id}`));
  const value = (token: string) => token === "$earning.project_id" ? earning.unit.project_id : token === "$earning.unit" ? earning.unit.key : token === "$earning.rule_id" ? earning.rule_id
    : text(readField(earning.unit.payload.record, token.slice("$earning.record.".length)));
  const rows: Record<string, SplitRow[]> = {};
  const evidence: [string, string, string][] = [];
  for (const [name, input] of Object.entries(definition.inputs)) {
    const { fields, buckets } = read.inputs[name]!;
    const wanted = fields.map(([, token]) => value(token));
    // An earning with nothing to match on (no project, say) is given no rows rather than every row that also has none.
    const matched = wanted.some((entry) => !entry) ? [] : buckets.get(wanted.join("\u0000")) || [];
    const from = input.window?.any_time_before ? -Infinity : span.from - (input.window?.days_before || 0) * DAY;
    rows[name] = [];
    for (const row of matched) {
      const member = input.member ? text(readField(row.value, input.member)) : "";
      if (input.member && !memberKeys.has(member)) continue;
      const entry: SplitRow = { row: row.value as JsonObject, ...(input.member ? { member } : {}) };
      if (input.window) {
        const start = instantOf(readField(row.value, input.window.start)), end = input.window.end ? instantOf(readField(row.value, input.window.end)) : start;
        // A row with no start, or no end where one is declared (a shift still on the clock), has no known place in time.
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
        if (!(start < span.to && (end > from || (end === start && start >= from)))) continue;
        if (input.window.end) entry.seconds = Math.max(0, Math.round((Math.min(end, span.to) - Math.max(start, from)) / 1000));
      }
      rows[name]!.push(entry);
      evidence.push([`split:${name}`, row.key, row.revision]);
    }
  }
  return { rows, evidence };
}

const SPLIT_RUNNER = (code: string) => `const __split = (earning, members, rows, params, group) => { ${code}\n };
const __out = [];
for (const entry of inputs.entries) {
  try { const shares = __split(entry.earning, entry.members, entry.rows, inputs.params, inputs.group); __out.push({ key: entry.key, shares: shares === undefined ? null : shares }); }
  catch (error) { __out.push({ key: entry.key, error: String(error && error.message || error).slice(0, 500) }); }
}
return { outputs: { entries: __out } };`;

/** Reads what a split rule returned for one earning line. Anything that would pay nobody, or someone outside the earning's members, is refused. */
function normalizeShares(value: unknown, members: string[]): PayShare[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A split rule returns an object of weights keyed by member.");
  const returned = value as JsonObject;
  const known = new Set(members.map((id) => `organization_user:${id}`));
  for (const key of Object.keys(returned)) if (!known.has(key)) throw new Error(`${key} is not one of the members this earning is divided among.`);
  const shares = members.map((id): PayShare => {
    const entry = returned[`organization_user:${id}`];
    const given = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as JsonObject : { weight: entry ?? 0 };
    if (typeof given.weight !== "number" || !Number.isFinite(given.weight) || given.weight < 0) throw new Error("Each member's weight is a number, 0 or more.");
    const reason = text(given.reason).slice(0, 500);
    const details = given.details && typeof given.details === "object" && !Array.isArray(given.details) ? given.details as JsonObject : undefined;
    return { id, weight: given.weight, ...(reason ? { reason } : {}), ...(details ? { details } : {}) };
  });
  if (!shares.some((share) => share.weight > 0)) throw new Error("The split rule gave every member a weight of 0, so this earning would be paid to nobody.");
  return shares;
}

/**
 * Runs one version of a split rule over the earnings that changed, once per
 * earning line, in the sandbox. Returns each earning's weights by line, or the
 * reason it could not be divided; there is no fallback to an equal split.
 */
async function evaluateSplits(group: { unit: Planned; lines: PayLine[] }[], payee: Assignee & { name?: string }, names: Map<string, string>, asOf: string) {
  const results = new Map<string, { lines?: Record<string, PayShare[]>; error?: string }>();
  const first = group[0]!.unit.split!;
  const jobs = group.flatMap(({ unit, lines }) => lines.map((line) => {
    const period = unit.payload.period as JsonObject | undefined;
    return { unit, line, payload: {
      earning: { rule_id: unit.rule.id, unit: unit.key, ...(period ? { period } : { record: unit.payload.record }), earned_on: unit.date, earned_at: unit.earned_at, project_id: unit.project_id, span: unit.split!.span,
        line: { key: line.key, amount_cents: line.amount_cents, description: line.description } },
      members: unit.split!.members.map((id) => ({ key: `organization_user:${id}`, id, name: names.get(id) || "" })), rows: unit.split!.rows } };
  }));
  const failed = new Map<string, string>();
  const shares = new Map<string, Record<string, PayShare[]>>();
  const chunks: typeof jobs[] = [[]];
  let size = 0;
  for (const job of jobs) {
    const length = JSON.stringify(job.payload).length;
    if (length > 900_000) { failed.set(job.unit.key, "This earning's split reads more data than a split rule can be handed at once."); continue; }
    if (size + length > 900_000) { chunks.push([]); size = 0; }
    chunks.at(-1)!.push(job);
    size += length;
  }
  for (const chunk of chunks.filter((entries) => entries.length)) {
    const fail = (job: typeof jobs[number], reason: string) => { if (!failed.has(job.unit.key)) failed.set(job.unit.key, `${first.rule!.name}: ${reason}`); };
    try {
      const run = await runModuleCode({
        source: SPLIT_RUNNER(first.version!.definition.code), mode: "evaluate", now: asOf, limits: { milliseconds: 5000 },
        inputs: { entries: chunk.map((job, index) => ({ key: String(index), ...job.payload })), params: first.params, group: { ...payee, key: payeeKey(payee) } }
      }, { read: async () => { throw new Error("A split rule reads only its declared inputs."); }, invoke: async () => { throw new Error("A split rule cannot act."); } });
      const returned = new Map((Array.isArray(run.outputs.entries) ? run.outputs.entries as JsonObject[] : []).map((entry) => [text(entry.key), entry]));
      for (const [index, job] of chunk.entries()) {
        const entry = returned.get(String(index));
        if (!entry) fail(job, "The split rule returned nothing for this earning.");
        else if (entry.error) fail(job, text(entry.error));
        else try { shares.set(job.unit.key, { ...shares.get(job.unit.key), [job.line.key]: normalizeShares(entry.shares, job.unit.split!.members) }); } catch (error) { fail(job, (error as Error).message); }
      }
    } catch (error) {
      for (const job of chunk) fail(job, text((error as Error).message).slice(0, 500) || "The split rule could not be run.");
    }
  }
  for (const { unit } of group) results.set(unit.key, failed.has(unit.key) ? { error: failed.get(unit.key)! } : { lines: shares.get(unit.key) || {} });
  return results;
}

/** One earning line of one payee's rule. Every ledger entry for it carries this, whoever the entry pays. */
const sourceId = (owner: string, ruleId: string, unit: string, line: string) => {
  const plain = `pay_rule:${owner}:${ruleId}:${unit}:${line}`;
  return plain.length <= 280 ? plain : `pay_rule:${contentHash(plain)}`;
};
/** Splits whole cents by weight so the parts always add up to the total; leftover cents go to the largest remainders. */
export function splitCentsByWeight(total: number, members: { id: string; weight: number }[]) {
  const weight = members.reduce((sum, member) => sum + member.weight, 0);
  const size = Math.abs(total), sign = total < 0 ? -1 : 1;
  const parts = members.map((member) => ({ id: member.id, exact: size * member.weight / weight }));
  const shares = new Map(parts.map((part) => [part.id, Math.floor(part.exact)]));
  let left = size - [...shares.values()].reduce((sum, value) => sum + value, 0);
  for (const part of [...parts].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.id.localeCompare(b.id))) {
    if (left <= 0) break;
    shares.set(part.id, shares.get(part.id)! + 1); left -= 1;
  }
  return new Map([...shares].map(([id, value]) => [id, sign * value]));
}
type Handling = "normal" | "next_run" | "off_cycle" | "hold";
function correctionPolicy(schedule: JsonObject | null | undefined, increase: boolean): Exclude<Handling, "normal"> {
  const chosen = text(((schedule?.metadata as JsonObject | undefined)?.correction_policy as JsonObject | undefined)?.[increase ? "increase" : "decrease"]);
  return chosen === "next_run" || chosen === "off_cycle" || chosen === "hold" ? chosen : increase ? "next_run" : "hold";
}

/** Exported with `saveUnit` so the storage statements can be exercised on both database backends. */
export async function storedUnits(orgId: string, payee: Assignee): Promise<StoredUnit[]> {
  await ensurePayRuleSchema();
  const rows = await getPayrollDatabase().prepare("SELECT rule_id, unit_key, digest, status, earned_at, lines_json, allocation_json FROM pay_rule_units WHERE organization_id=? AND payee_type=? AND payee_id=?").all(orgId, payee.type, payee.id);
  return rows.map((row) => ({ rule_id: String(row.rule_id), unit_key: String(row.unit_key), digest: String(row.digest), status: String(row.status), earned_at: String(row.earned_at),
    lines: JSON.parse(String(row.lines_json || "[]")), allocation: String(row.allocation_json || "") ? JSON.parse(String(row.allocation_json)) as PayAllocation : null }));
}
export async function saveUnit(orgId: string, payee: Assignee, ruleId: string, unit: { key: string; digest: string; status: string; earned_at: string; version: string; lines: PayLine[]; error: string; evidence: [string, string, string][]; allocation?: PayAllocation | null }) {
  await ensurePayRuleSchema();
  const db = getPayrollDatabase();
  const where = [orgId, payee.type, payee.id, ruleId, unit.key];
  await db.prepare("DELETE FROM pay_rule_units WHERE organization_id=? AND payee_type=? AND payee_id=? AND rule_id=? AND unit_key=?").run(...where);
  await db.prepare(`INSERT INTO pay_rule_units (organization_id, payee_type, payee_id, rule_id, unit_key, digest, status, earned_at, rule_version, lines_json, error, evaluated_at, allocation_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...where, unit.digest, unit.status, unit.earned_at, unit.version, JSON.stringify(unit.lines), unit.error, nowIso(), unit.allocation ? JSON.stringify(unit.allocation) : "");
  // What this earning read, by source row: the index a change feed will use to find the earnings a changed row affects.
  await db.prepare("DELETE FROM pay_rule_evidence WHERE organization_id=? AND payee_type=? AND payee_id=? AND rule_id=? AND unit_key=?").run(...where);
  const seen = new Set<string>();
  for (const [source, rowKey, revision] of unit.evidence) {
    if (seen.has(`${source}\u0000${rowKey}`)) continue;
    seen.add(`${source}\u0000${rowKey}`);
    await db.prepare("INSERT INTO pay_rule_evidence (organization_id, source, row_key, payee_type, payee_id, rule_id, unit_key, row_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(orgId, source, rowKey, payee.type, payee.id, ruleId, unit.key, revision);
  }
}
/** What each rule last worked out for a payee, with any reason a record or period could not be worked out. */
export async function listPayUnits(orgId: string, payee: Assignee) {
  await ensurePayRuleSchema();
  const rows = await getPayrollDatabase().prepare(`SELECT rule_id, unit_key, status, earned_at, rule_version, lines_json, error, evaluated_at, allocation_json FROM pay_rule_units
    WHERE organization_id=? AND payee_type=? AND payee_id=? ORDER BY earned_at DESC, rule_id, unit_key`).all(orgId, payee.type, payee.id);
  return rows.map((row) => {
    const lines = JSON.parse(String(row.lines_json || "[]")) as PayLine[];
    const allocation = String(row.allocation_json || "") ? JSON.parse(String(row.allocation_json)) as PayAllocation : null;
    return { id: `${row.rule_id}:${row.unit_key}`, rule_id: String(row.rule_id), unit: String(row.unit_key), status: String(row.status), earned_at: String(row.earned_at),
      rule_version: String(row.rule_version), lines, error: String(row.error), evaluated_at: String(row.evaluated_at),
      split_among: allocation ? allocation.members : null, split: allocation ? explainSplit(allocation, lines) : null };
  });
}
/**
 * How an earning was divided, line by line, in a form a screen can show: the
 * method, the split rule and its parameters when there is one, and for each
 * member their weight, the cents it came to and the rule's reason.
 */
export function explainSplit(allocation: PayAllocation, lines: PayLine[]) {
  return {
    method: allocation.method || null, members: allocation.members.map((member) => member.id),
    ...(allocation.rule ? { split_rule_id: allocation.rule.id, split_rule_version: allocation.rule.version, params: allocation.rule.params } : {}),
    lines: Object.fromEntries(lines.map((line) => {
      const shares: PayShare[] = allocation.rule ? allocation.rule.lines[line.key] || [] : allocation.members;
      const paid = shares.filter((share) => share.weight > 0);
      const cents = paid.length ? splitCentsByWeight(line.amount_cents, paid) : new Map<string, number>();
      return [line.key, { amount_cents: line.amount_cents, total_weight: paid.reduce((sum, share) => sum + share.weight, 0), shares: shares.map((share) => ({ ...share, cents: cents.get(share.id) || 0 })) }];
    }))
  };
}

export async function refreshPayeeEarnings(orgId: string, payee: Assignee, options: PayRefreshOptions = {}): Promise<PayRefreshResult> {
  const result: PayRefreshResult = { payee, evaluated: 0, unchanged: 0, differences: [], unresolved: [], posted: [] };
  const dryRun = !!options.dryRun;
  const asOf = options.asOf || nowIso();
  const owner = payeeKey(payee);
  const ref = await payeeRef(orgId, payee);
  // Someone who was removed keeps everything already worked out and posted; nothing new is worked out for them.
  if (!ref) { result.unresolved.push({ rule_id: "", reason: "This payee is no longer available in the organization." }); return result; }
  result.payee_name = ref.name || "";
  const overrides = dryRun ? options.overrides : undefined;
  // A refresh that posts also notes which defaults cover the payee today, so a role given or taken away later starts or stops paying from that day.
  const layers = await payLayersFor(orgId, payee, dryRun && options.setup ? options.setup : undefined, { day: asOf.slice(0, 10), record: !dryRun, defaults: overrides?.defaults });
  const rules = new Map((await listPayRules(orgId)).map((rule) => [rule.id, rule]));
  const plans = new Map<string, PayPlan>((await listPayPlans(orgId)).map((plan) => [plan.id, plan]));
  for (const rule of overrides?.rules || []) rules.set(rule.id, rule);
  for (const plan of overrides?.plans || []) plans.set(plan.id, plan);
  const stored = await storedUnits(orgId, payee);
  /** When someone is paid comes from the same layers as what they are paid; a member of a split group has layers of their own. */
  const layersOf = new Map<string, PayLayer[]>([[owner, layers]]);
  const scheduleFor = async (key: string, kind: string, day: string) => {
    const [type, ...rest] = key.split(":");
    const who = { type, id: rest.join(":") } as Assignee;
    if (!layersOf.has(key)) layersOf.set(key, await payLayersFor(orgId, who, undefined, { day: asOf.slice(0, 10), defaults: overrides?.defaults }));
    return resolvePaySchedule(orgId, who, kind, day, layersOf.get(key)!).catch(() => null);
  };
  const desired = new Set<string>();
  const unreadable = new Set<string>();
  // A rule that cannot be read at all is remembered under the unit "*", so it can be listed without refreshing again.
  const WHOLE_RULE = "*";
  const ruleFailed = async (ruleId: string, reason: string) => {
    result.unresolved.push({ rule_id: ruleId, reason }); unreadable.add(ruleId);
    if (!dryRun) await saveUnit(orgId, payee, ruleId, { key: WHOLE_RULE, digest: "", status: "error", earned_at: "", version: "", lines: [], error: reason, evidence: [] });
  };
  const firstDay = layers.flatMap((layer) => layer.entries.map((entry) => entry.effective_from)).sort()[0] || "";
  const slots = candidateRuleSlots(layers, plans);
  const { recordPayrollLedgerEntries } = await import("./service.js");
  const refs = new Map<string, PayrollPayeeRef | null>([[owner, ref]]);
  const refFor = async (key: string) => {
    if (!refs.has(key)) { const [type, ...rest] = key.split(":"); refs.set(key, await payeeRef(orgId, { type, id: rest.join(":") } as Assignee)); }
    return refs.get(key)!;
  };
  const NO_MEMBERS = "This group has no active members to split its pay among.";
  let members: string[] | null = null;
  const currentMembers = async () => {
    if (!members) {
      const group = (await (await import("../workforce/storage.js")).listAssignmentGroups(orgId, true)).find((entry) => text((entry as JsonObject).id) === payee.id) as JsonObject | undefined;
      members = (Array.isArray(group?.members) ? group!.members as JsonObject[] : []).filter((member) => text(member.status || "active") === "active").map((member) => text(member.user_id)).filter(Boolean).sort();
    }
    return members;
  };
  /** Who shares this earning under `equal` or `shares`. Kept from the first time it was worked out unless the distribution setting itself has changed. */
  const allocationFor = async (date: string, prior: PayAllocation | null | undefined): Promise<PayAllocation | null | { error: string }> => {
    const setting = payee.type === "resource_group" ? distributionOn(layers, date) : null;
    if (!setting || setting.mode === "as_one") return null;
    const basis = contentHash(setting);
    if (prior && prior.basis === basis) return prior;
    if (setting.method === "shares") return { basis, method: "shares", members: Object.entries(setting.shares || {}).map(([id, weight]) => ({ id, weight })).sort((a, b) => a.id.localeCompare(b.id)) };
    const active = await currentMembers();
    return active.length ? { basis, method: "equal", members: active.map((id) => ({ id, weight: 1 })) } : { error: NO_MEMBERS };
  };

  // ---- Split rules: weights worked out from data, among the members captured when the earning was first worked out ----
  const splitRules = new Map<string, PaySplitRule>(payee.type === "resource_group" ? (await listPaySplitRules(orgId)).map((rule) => [rule.id, rule]) : []);
  /** Members captured from the group itself (not named in fixed shares), which a split rule keeps dividing among. */
  const captured = (allocation: PayAllocation | null | undefined) => allocation && (allocation.method === "equal" || allocation.method === "rule") && allocation.members.length ? allocation.members.map((member) => member.id) : null;
  let universe: string[] | null = null;
  /** Everyone any of this group's earnings could be divided among: today's members and those captured on earlier earnings. One selection per input covers them all. */
  const memberUniverse = async () => universe ||= [...new Set([...await currentMembers(), ...stored.flatMap((entry) => captured(entry.allocation) || [])])].sort();
  const splitReads = new Map<string, Promise<SplitRead>>();
  const readSplit = (version: PaySplitRuleVersion) => {
    const shape = contentHash(version.definition.inputs);
    if (!splitReads.has(shape)) splitReads.set(shape, (async (): Promise<SplitRead> => {
      let ctx = options.context;
      if (!ctx) try { ctx = userPublicationContext(await backgroundAuthContext(orgId, version.entered_by)); }
      catch { return { failure: "The person who last saved this split rule can no longer read its inputs. Save the split rule again." }; }
      return readSplitInputs(ctx, orgId, version.definition, payee, await memberUniverse());
    })());
    return splitReads.get(shape)!;
  };
  /** Settles how one earning is divided by a split rule, and what the split reads, before anything is run. Null when it is not divided by a rule. */
  const planSplit = async (ruleId: string, unit: Unit, timezone: string, prior: StoredUnit | undefined): Promise<SplitPlan | null> => {
    const setting = payee.type === "resource_group" ? distributionOn(layers, unit.date) : null;
    if (!setting || setting.mode !== "split" || setting.method !== "rule") return null;
    const period = unit.payload.period as { from: string; through: string } | undefined;
    // Exact instants: the earned day, or the whole period, as the rule's timezone cuts it.
    const from = zonedDayStart(period?.from || unit.date, timezone), to = zonedDayStart(dayOf(utc(period?.through || unit.date) + DAY), timezone);
    const plan: SplitPlan = { basis: contentHash(setting), params: {}, members: [], span: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, rows: {}, evidence: [] };
    const rule = splitRules.get(setting.split_rule_id!);
    const version = rule && versionOn(rule.versions, unit.date);
    if (!rule || !version) return { ...plan, error: rule ? `Split rule ${rule.name} has no version in effect on ${unit.date}.` : `Split rule ${setting.split_rule_id} does not exist.` };
    Object.assign(plan, { rule, version, params: resolvedParams(version.definition, setting.params || {}), members: captured(prior?.allocation) || await currentMembers() });
    if (!plan.members.length) return { ...plan, error: NO_MEMBERS };
    const read = await readSplit(version);
    if ("failure" in read) return { ...plan, error: `${rule.name}: ${read.failure}` };
    return { ...plan, ...splitRowsFor(version.definition, read, { rule_id: ruleId, unit }, plan.members, { from, to }) };
  };

  const reconcile = async (ruleId: string, unit: { key: string; date: string; earned_at: string; project_id: string; digest: string }, rule: PayRule | undefined, version: PayRuleVersion | undefined,
    params: JsonObject, lines: PayLine[], previous: PayLine[], allocation: PayAllocation | null) => {
    const kind = version?.definition.kind || "adjustment";
    for (const key of new Set([...lines.map((line) => line.key), ...previous.map((line) => line.key)])) {
      const line = lines.find((entry) => entry.key === key);
      const source = sourceId(owner, ruleId, unit.key, key);
      const all = await findPayrollLedgerSourceEntries(orgId, source);
      const amount = line?.amount_cents || 0;
      // Who this line should have paid, and how much: the payee itself, or each member's share of a split.
      // Under a split rule each line has its own weights, and a member weighted 0 is owed nothing; a line the rule no longer produces is owed to nobody.
      const shares = allocation?.rule ? (line ? allocation.rule.lines[key] || [] : []).filter((share) => share.weight > 0) : allocation?.members;
      const want = new Map<string, number>(!allocation ? [[owner, amount]] : shares!.length ? [...splitCentsByWeight(amount, shares!)].map(([id, cents]) => [`organization_user:${id}`, cents]) : []);
      const totalWeight = allocation?.rule ? shares!.reduce((sum, share) => sum + share.weight, 0) : 0;
      for (const paid of [...new Set([...want.keys(), ...all.map((entry) => `${entry.payee.type}:${entry.payee.id}`)])].sort()) {
        const entries = all.filter((entry) => `${entry.payee.type}:${entry.payee.id}` === paid);
        const counted = entries.filter((entry) => entry.state !== "void" || entry.metadata.pay_rule_declined === true);
        const posted = counted.reduce((sum, entry) => sum + entry.amount_cents, 0);
        const target = want.get(paid) || 0;
        const delta = target - posted;
        if (!delta) continue;
        const paidRef = await refFor(paid);
        if (!paidRef) throw new Error(`${paid} is no longer available in the organization, so their share cannot be posted.`);
        const settled = entries.some((entry) => entry.state !== "void" && entry.applied_cents !== 0);
        // A correction is paid from now on, so the schedule the payee is on today says how it is handled.
        const handling: Handling = settled ? correctionPolicy((await scheduleFor(paid, kind, asOf.slice(0, 10)))?.schedule as JsonObject | undefined, delta > 0) : "normal";
        result.differences.push({ rule_id: ruleId, unit: unit.key, line: key, earned_on: unit.date, posted_cents: posted, target_cents: target, delta_cents: delta, handling, ...(paid === owner ? {} : { payee: paid }) });
        if (dryRun) continue;
        const label = line?.description || previous.find((entry) => entry.key === key)?.description || rule?.name || "Pay rule";
        // Why this member got what they got: the split rule, their weight out of the total, and the rule's own words.
        const share = allocation?.rule && line ? (allocation.rule.lines[key] || []).find((entry) => `organization_user:${entry.id}` === paid) : undefined;
        const explained = allocation?.rule ? {
          method: "rule", split_rule_id: allocation.rule.id, split_rule_version: allocation.rule.version, params: allocation.rule.params,
          weight: share?.weight || 0, total_weight: totalWeight, share_cents: target,
          ...(share?.reason ? { reason: share.reason } : {}), ...(share?.details ? { details: share.details } : {})
        } : {};
        const entry = {
          payee: paidRef, state: handling === "hold" ? "projected" : "accrued", amount_cents: delta,
          kind: delta > 0 ? kind : kind === "commission" ? "clawback" : "adjustment", subgroup: kind,
          ...(unit.project_id ? { project_id: unit.project_id } : {}),
          worked_at: handling === "normal" ? unit.earned_at : asOf, completed_at: handling === "normal" ? unit.earned_at : asOf,
          source_event_id: source, source_trigger_id: `${unit.digest.slice(0, 24) || "withdrawn"}:${entries.length}`,
          description: counted.length ? `Correction: ${label}` : label,
          metadata: {
            source: "pay_rule",
            pay_rule: { payee: owner, rule_id: ruleId, definition_rule_id: rule?.id || "", version: version?.version || "", unit: unit.key, line: key, earned_on: unit.date, earned_at: unit.earned_at, params },
            ...(line?.details ? { details: line.details } : {}),
            ...(paid === owner ? {} : { split: { of: owner, line_cents: amount, members: allocation?.members.length || 0, ...explained } }),
            ...(counted.length ? { correction: { posted_cents: posted, target_cents: target, handling } } : {}),
            ...(handling === "next_run" || handling === "off_cycle" ? { back_pay: true } : {}),
            ...(handling === "off_cycle" ? { off_cycle_requested: true } : {}),
            ...(handling === "hold" ? { review_required: true } : {})
          }
        } as PayrollLedgerEntryInput & JsonObject;
        result.posted.push(...await recordPayrollLedgerEntries(orgId, [entry]));
      }
    }
  };

  for (const [ruleId, definitionIds] of slots) {
    const versions = [...definitionIds].flatMap((definitionId) => (rules.get(definitionId)?.versions || []).map((version) => ({ rule: rules.get(definitionId)!, version })));
    const planned: Planned[] = [];
    const shapes = new Map<string, { rule: PayRule; version: PayRuleVersion }>();
    for (const entry of versions) shapes.set(shapeOf(entry.version.definition), entry);
    for (const [shape, sample] of shapes) {
      const definition = sample.version.definition;
      let ctx = options.context;
      if (!ctx) try { ctx = userPublicationContext(await backgroundAuthContext(orgId, sample.version.entered_by)); }
      catch { await ruleFailed(ruleId, "The person who last saved this rule can no longer read its inputs. Save the rule again."); break; }
      const read = await readInputs(ctx, orgId, definition, payee);
      if (!read.rows) { await ruleFailed(ruleId, read.failure!); break; }
      const schedule = definition.timezone ? null : await scheduleFor(owner, definition.kind, asOf.slice(0, 10));
      const timezone = definition.timezone || text((schedule?.schedule as JsonObject | undefined)?.timezone) || "UTC";
      const built = unitsFor(definition, read.rows, timezone, localDay(Date.parse(asOf), timezone), firstDay);
      const sharedDigest = contentHash(built.sharedEvidence);
      const earlier = new Map(stored.filter((entry) => entry.rule_id === ruleId).map((entry) => [entry.unit_key, entry]));
      for (const unit of built.units) {
        const slot = effectiveRuleSlots(layers, plans, unit.date).get(ruleId);
        const rule = slot && rules.get(slot.definition_rule_id);
        const version = rule && versionOn(rule.versions, unit.date);
        // A record or period belongs to the shape of the rule that applied on its day, and to no other.
        if (!slot || !rule || !version || shapeOf(version.definition) !== shape || planned.some((entry) => entry.key === unit.key)) continue;
        const params = resolvedParams(version.definition, slot.params);
        const split = await planSplit(ruleId, unit, timezone, earlier.get(unit.key));
        planned.push({ ...unit, rule, version, params, shared: built.shared, timezone, split, evidence: [...unit.evidence, ...built.sharedEvidence, ...(split?.evidence || [])],
          digest: contentHash({ rule: version.version, params, payee: owner, unit: unit.key, date: unit.date, earned_at: unit.earned_at, evidence: unit.evidence, shared: sharedDigest,
            distribution: payee.type === "resource_group" ? distributionOn(layers, unit.date) : null,
            // What a split rule read is part of the earning: the same version, parameters, members and rows mean nothing is run again.
            ...(split ? { split: { rule: split.version?.version, params: split.params, members: split.members, evidence: split.evidence, error: split.error } } : {}) }) });
      }
    }
    if (unreadable.has(ruleId)) continue;
    if (!dryRun && stored.some((entry) => entry.rule_id === ruleId && entry.unit_key === WHOLE_RULE)) {
      await getPayrollDatabase().prepare("DELETE FROM pay_rule_units WHERE organization_id=? AND payee_type=? AND payee_id=? AND rule_id=? AND unit_key=?").run(orgId, payee.type, payee.id, ruleId, WHOLE_RULE);
    }
    const before = new Map(stored.filter((entry) => entry.rule_id === ruleId).map((entry) => [entry.unit_key, entry]));
    const changed = planned.filter((unit) => { desired.add(`${ruleId}\u0000${unit.key}`); const prior = before.get(unit.key); return !(prior && prior.status === "ok" && prior.digest === unit.digest); });
    result.unchanged += planned.length - changed.length;
    // Could not be worked out is not zero: what was posted before stays, with who shared it, and the reason is reported.
    const unresolved = async (unit: Planned, reason: string) => {
      const prior = before.get(unit.key);
      result.unresolved.push({ rule_id: ruleId, unit: unit.key, reason });
      if (!dryRun) await saveUnit(orgId, payee, ruleId, { key: unit.key, digest: unit.digest, status: "error", earned_at: unit.earned_at, version: unit.version.version, lines: prior?.lines || [], error: reason, evidence: unit.evidence, allocation: prior?.allocation });
    };
    const groups = new Map<string, Planned[]>();
    for (const unit of changed) {
      // An earning whose split cannot be settled (no such split rule, nobody to share it, an input that cannot be read) is not run at all.
      if (unit.split?.error) { await unresolved(unit, unit.split.error); continue; }
      const key = contentHash({ version: unit.version.version, params: unit.params }); groups.set(key, [...(groups.get(key) || []), unit]);
    }
    for (const group of groups.values()) {
      const outcomes = await evaluate(group, payee, asOf);
      // Earnings divided by a split rule: one sandbox run per version of the split rule and its parameters, over every changed earning line.
      const divided = new Map<string, { lines?: Record<string, PayShare[]>; error?: string }>();
      const splitGroups = new Map<string, { unit: Planned; lines: PayLine[] }[]>();
      for (const unit of group) {
        const lines = outcomes.get(unit.key)!.lines;
        if (!unit.split || !lines) continue;
        const key = contentHash({ rule: unit.split.rule!.id, version: unit.split.version!.version, params: unit.split.params });
        splitGroups.set(key, [...(splitGroups.get(key) || []), { unit, lines }]);
      }
      for (const entries of splitGroups.values()) {
        const names = new Map<string, string>();
        for (const id of new Set(entries.flatMap((entry) => entry.unit.split!.members))) names.set(id, (await refFor(`organization_user:${id}`))?.name || "");
        for (const [key, outcome] of await evaluateSplits(entries, { ...payee, name: ref.name || "" }, names, asOf)) divided.set(key, outcome);
      }
      for (const unit of group) {
        result.evaluated += 1;
        const outcome = outcomes.get(unit.key)!;
        const prior = before.get(unit.key);
        if (!outcome.lines) { await unresolved(unit, outcome.error || "The rule could not be run."); continue; }
        const weights = unit.split ? divided.get(unit.key)! : null;
        if (weights && !weights.lines) { await unresolved(unit, weights.error || "The split rule could not be run."); continue; }
        try {
          const allocation: PayAllocation | null | { error: string } = unit.split
            ? { basis: unit.split.basis, method: "rule", members: unit.split.members.map((id) => ({ id, weight: 1 })), rule: { id: unit.split.rule!.id, version: unit.split.version!.version, params: unit.split.params, lines: weights!.lines! } }
            : await allocationFor(unit.date, prior?.allocation);
          if (allocation && "error" in allocation) throw new Error(allocation.error);
          await reconcile(ruleId, unit, unit.rule, unit.version, unit.params, outcome.lines, prior?.lines || [], allocation);
          if (!dryRun) await saveUnit(orgId, payee, ruleId, { key: unit.key, digest: unit.digest, status: "ok", earned_at: unit.earned_at, version: unit.version.version, lines: outcome.lines, error: "", evidence: unit.evidence, allocation });
        } catch (error) {
          result.unresolved.push({ rule_id: ruleId, unit: unit.key, reason: text((error as Error).message) || "The earning could not be posted." });
        }
      }
    }
  }
  // A record that left the selection, a period that no longer applies, or a rule taken out of the setup: what it posted is taken back.
  for (const prior of stored) {
    if (desired.has(`${prior.rule_id}\u0000${prior.unit_key}`) || unreadable.has(prior.rule_id) || prior.status === "withdrawn" || !prior.lines.length) continue;
    const rule = rules.get(prior.rule_id);
    try {
      await reconcile(prior.rule_id, { key: prior.unit_key, date: prior.earned_at.slice(0, 10), earned_at: prior.earned_at, project_id: "", digest: "" }, rule, rule && versionOn(rule.versions, prior.earned_at.slice(0, 10)) || undefined, {}, [], prior.lines, null);
      if (!dryRun) await saveUnit(orgId, payee, prior.rule_id, { key: prior.unit_key, digest: "", status: "withdrawn", earned_at: prior.earned_at, version: "", lines: [], error: "", evidence: [] });
    } catch (error) {
      result.unresolved.push({ rule_id: prior.rule_id, unit: prior.unit_key, reason: text((error as Error).message) || "The earning could not be taken back." });
    }
  }
  return result;
}

/**
 * Refuses a correction that was held for review. It is kept as a declined
 * entry and still counts as settled, so the next refresh does not raise the
 * same difference again. To accept one instead, accrue it.
 */
export async function declinePayCorrection(orgId: string, entryId: string, actor: { userId: string }, note = "") {
  const entry = await readPayrollLedgerEntry(orgId, entryId);
  if (entry.state !== "projected" || entry.metadata.review_required !== true) throw badRequest("pay_correction_not_held", "Only a correction held for review can be declined.");
  return voidPayrollLedgerEntry(orgId, entryId, { pay_rule_declined: true, declined_by_user_id: actor.userId, declined_at: nowIso(), ...(note ? { declined_note: note.slice(0, 500) } : {}) });
}

/** What saving this setup would change, earning by earning, without changing anything. Use it before backdating. */
export async function previewPaySetup(orgId: string, payee: Assignee, setup: Pick<PaySetup, "entries" | "distribution" | "schedules">, options: Pick<PayRefreshOptions, "asOf" | "context"> = {}) {
  const preview = await refreshPayeeEarnings(orgId, payee, { ...options, dryRun: true, setup });
  return { ...preview, total_delta_cents: preview.differences.reduce((sum, difference) => sum + difference.delta_cents, 0) };
}

type Overrides = NonNullable<PayRefreshOptions["overrides"]>;
type DefaultDraft = NonNullable<Overrides["defaults"]>[number];
/** The most payees one preview works through. Beyond it the preview says it is partial rather than taking minutes. */
export const PAY_PREVIEW_PAYEE_LIMIT = 200;
/**
 * What saving a version of a rule, a plan or a default would change across everyone it applies to, earning by
 * earning, without changing anything. Each payee is worked out twice with the dry run: as things are stored, and as
 * they would be; only what differs between the two is reported, so differences that are already waiting for the next
 * refresh for other reasons are not blamed on this change.
 */
export async function previewPayChange(orgId: string, change: { rule?: PayRule; plan?: PayPlan; default?: DefaultDraft }, options: Pick<PayRefreshOptions, "asOf" | "context"> = {}) {
  const overrides: Overrides = { ...(change.rule ? { rules: [change.rule] } : {}), ...(change.plan ? { plans: [change.plan] } : {}), ...(change.default ? { defaults: [change.default] } : {}) };
  const plans = new Map<string, PayPlan>((await listPayPlans(orgId)).map((plan) => [plan.id, plan]));
  if (change.plan) plans.set(change.plan.id, change.plan);
  const affected: Assignee[] = [];
  for (const payee of await payeesWithPay(orgId, overrides.defaults)) {
    const layers = await payLayersFor(orgId, payee, undefined, { defaults: overrides.defaults });
    const touches = change.default ? layers.some((layer) => layer.source?.type === change.default!.subject.type && layer.source.id === change.default!.subject.id)
      : change.plan ? layers.some((layer) => layer.entries.some((entry) => entry.kind === "plan" && entry.plan_id === change.plan!.id))
        : [...candidateRuleSlots(layers, plans).values()].some((definitions) => definitions.has(change.rule!.id));
    if (touches) affected.push(payee);
  }
  // A default being cleared no longer reaches the people it used to pay, but taking it away changes their pay all the same.
  if (change.default) for (const payee of await payeesWithPay(orgId)) {
    if (affected.some((entry) => payeeKey(entry) === payeeKey(payee))) continue;
    if ((await payLayersFor(orgId, payee)).some((layer) => layer.source?.type === change.default!.subject.type && layer.source.id === change.default!.subject.id)) affected.push(payee);
  }
  const key = (difference: PayDifference) => `${difference.payee || ""}\u0000${difference.rule_id}\u0000${difference.unit}\u0000${difference.line}`;
  const payees = [];
  for (const payee of affected.slice(0, PAY_PREVIEW_PAYEE_LIMIT)) {
    const before = await refreshPayeeEarnings(orgId, payee, { ...options, dryRun: true });
    const after = await refreshPayeeEarnings(orgId, payee, { ...options, dryRun: true, overrides });
    const waiting = new Map(before.differences.map((difference) => [key(difference), difference.target_cents]));
    // What the change itself moves: the amount an earning would come to with it, against what it would come to without it.
    const differences = after.differences.map((difference) => ({ ...difference, without_change_cents: waiting.get(key(difference)) ?? difference.posted_cents }))
      .filter((difference) => difference.target_cents !== difference.without_change_cents)
      .map((difference) => ({ ...difference, change_cents: difference.target_cents - difference.without_change_cents }));
    // A difference that is waiting today and would no longer be there with the change: the change brings the earning back to what is posted.
    for (const difference of before.differences) if (!after.differences.some((entry) => key(entry) === key(difference)) && difference.target_cents !== difference.posted_cents) {
      differences.push({ ...difference, target_cents: difference.posted_cents, delta_cents: 0, without_change_cents: difference.target_cents, change_cents: difference.posted_cents - difference.target_cents });
    }
    const known = new Set(before.unresolved.map((entry) => `${entry.rule_id}\u0000${entry.unit || ""}\u0000${entry.reason}`));
    const unresolved = after.unresolved.filter((entry) => !known.has(`${entry.rule_id}\u0000${entry.unit || ""}\u0000${entry.reason}`));
    if (differences.length || unresolved.length) payees.push({ payee, payee_name: after.payee_name || "", differences, unresolved, change_cents: differences.reduce((sum, difference) => sum + difference.change_cents, 0) });
  }
  const all = payees.flatMap((entry) => entry.differences);
  return {
    payee_count: affected.length, changed_payee_count: payees.length, payees,
    difference_count: all.length, change_cents: all.reduce((sum, difference) => sum + difference.change_cents, 0),
    /** Changes to earnings that have already been in a pay run and would be held for someone to accept. */
    held_count: all.filter((difference) => difference.handling === "hold").length,
    unresolved_count: payees.reduce((sum, entry) => sum + entry.unresolved.length, 0),
    truncated: affected.length > PAY_PREVIEW_PAYEE_LIMIT
  };
}
/** The preview of a rule, plan or default as the save input describes it. Validates exactly as the save would, and writes nothing. */
export async function previewPayRuleSave(orgId: string, input: unknown, actor: Actor, options: Pick<PayRefreshOptions, "asOf" | "context"> = {}) {
  const { data, current } = await draftPayRule(orgId, input, actor);
  return previewPayChange(orgId, { rule: { ...data, revision: current?.revision || 0 } }, options);
}
export async function previewPayPlanSave(orgId: string, input: unknown, actor: Actor, options: Pick<PayRefreshOptions, "asOf" | "context"> = {}) {
  const { data, current } = await draftPayPlan(orgId, input, actor);
  return previewPayChange(orgId, { plan: { ...data, revision: current?.revision || 0 } }, options);
}
export async function previewPayDefaultSave(orgId: string, input: unknown, actor: Actor, options: Pick<PayRefreshOptions, "asOf" | "context"> = {}) {
  const { data } = await draftPayDefault(orgId, input, actor, { lookUpRoles: false });
  return previewPayChange(orgId, { default: data }, options);
}

/** Everyone who could be paid today: users, groups of users and outside companies that have not been removed. Reads only. */
async function everyPayee(orgId: string): Promise<Assignee[]> {
  const { listDocuments } = await import("../platform/storage.js");
  return [
    ...(await listDocuments(orgId, "users")).filter((row) => !["disabled", "deleted", "archived", "removed"].includes(text((row.data as JsonObject).status))).map((row) => ({ type: "organization_user" as const, id: row.id })),
    ...(await (await import("../workforce/storage.js")).listAssignmentGroups(orgId, false)).map((group) => ({ type: "resource_group" as const, id: text((group as JsonObject).id) })),
    ...(await (await import("../connections/storage.js")).listOrganizationConnections(orgId)).map((connection) => ({ type: "organization_connection" as const, id: text((connection as JsonObject).id) }))
  ].filter((payee) => payee.id);
}
/** The payees one default subject covers today, with their names. Reads only. */
export async function payeesCoveredBy(orgId: string, subject: PayDefault["subject"]) {
  const covered: { type: Assignee["type"]; id: string; name: string }[] = [];
  for (const payee of await everyPayee(orgId)) {
    if (!(await payDefaultSubjectsFor(orgId, payee)).some((entry) => entry.type === subject.type && entry.id === subject.id)) continue;
    covered.push({ ...payee, name: (await readAssignee(orgId, payee))?.name || "" });
  }
  return covered;
}

/**
 * Everyone whose pay comes from rules: payees with their own setup, and, when any default exists, every assignee a
 * default covers. A setup closed because its payee was removed is left out. `defaults` stand in for the stored ones
 * with the same subject, for previews.
 */
export async function payeesWithPay(orgId: string, defaults?: Overrides["defaults"]): Promise<Assignee[]> {
  const found = new Map<string, Assignee>((await listPaySetups(orgId)).filter((setup) => setup.entries.length && !setup.closed).map((setup) => [payeeKey(setup.payee), setup.payee]));
  if ([...(await listPayDefaults(orgId)), ...(defaults || [])].some((entry) => entry.entries.length)) {
    for (const payee of await everyPayee(orgId)) if (payee.id && !found.has(payeeKey(payee)) && (await payLayersFor(orgId, payee, undefined, { defaults })).some((layer) => layer.entries.length)) found.set(payeeKey(payee), payee);
  }
  return [...found.values()];
}

/** Refreshes every payee whose pay comes from rules, or the ones named. One payee failing does not stop the rest. */
export async function refreshOrganizationEarnings(orgId: string, options: PayRefreshOptions & { payees?: Assignee[] } = {}) {
  const payees = options.payees?.length ? options.payees : await payeesWithPay(orgId);
  const results: PayRefreshResult[] = [];
  for (const payee of payees) {
    try { results.push(await refreshPayeeEarnings(orgId, payee, { asOf: options.asOf, context: options.context })); }
    catch (error) { results.push({ payee, evaluated: 0, unchanged: 0, differences: [], posted: [], unresolved: [{ rule_id: "", reason: text((error as Error).message) || "Refresh failed." }] }); }
  }
  const posted = results.flatMap((entry) => entry.posted);
  const held = posted.filter((entry) => (entry.metadata as JsonObject | undefined)?.review_required === true);
  // One event per payee whose pay changed, so an automation can tell them or their manager.
  const { publishPayrollWorkEvent } = await import("./service.js");
  for (const entry of results) if (entry.posted.length) await publishPayrollWorkEvent({
    organization_id: orgId, branch_id: "default", type: "payroll.earnings.changed",
    idempotency_key: `payroll.earnings.changed:${contentHash(entry.posted.map((row) => row.id))}`,
    payload: {
      payee_type: entry.payee.type, payee_id: entry.payee.id, payee_name: text((entry.posted[0]!.payee as JsonObject | undefined)?.name),
      posted_count: entry.posted.length, delta_cents: entry.posted.reduce((sum, row) => sum + Number(row.amount_cents || 0), 0),
      held_count: entry.posted.filter((row) => (row.metadata as JsonObject | undefined)?.review_required === true).length
    },
    context: {}
  }).catch(() => undefined);
  // Held corrections are not owed until someone accepts them, so they are counted apart from what was posted.
  return {
    payees: results, posted_count: posted.length - held.length, posted_cents: posted.reduce((sum, entry) => sum + Number(entry.amount_cents || 0), 0) - held.reduce((sum, entry) => sum + Number(entry.amount_cents || 0), 0),
    held_count: held.length, held_cents: held.reduce((sum, entry) => sum + Number(entry.amount_cents || 0), 0),
    unresolved_count: results.reduce((sum, entry) => sum + entry.unresolved.length, 0)
  };
}

/** Every earning that could not be worked out at the last refresh, across the organization, with the reason. Reads only. */
export async function listUnresolvedPay(orgId: string) {
  await ensurePayRuleSchema();
  const rows = await getPayrollDatabase().prepare(`SELECT payee_type, payee_id, rule_id, unit_key, earned_at, error, evaluated_at FROM pay_rule_units
    WHERE organization_id=? AND status='error' ORDER BY evaluated_at DESC, payee_type, payee_id, rule_id, unit_key`).all(orgId);
  const names = new Map<string, string>();
  const items = [];
  for (const row of rows) {
    const payee = { type: String(row.payee_type), id: String(row.payee_id) } as Assignee, key = payeeKey(payee);
    if (!names.has(key)) names.set(key, (await readAssignee(orgId, payee))?.name || "");
    const unit = String(row.unit_key);
    items.push({ id: `${key}:${row.rule_id}:${unit}`, payee, payee_name: names.get(key)!, rule_id: String(row.rule_id), unit: unit === "*" ? "" : unit, whole_rule: unit === "*",
      earned_at: String(row.earned_at), reason: String(row.error), evaluated_at: String(row.evaluated_at) });
  }
  return items;
}

/** Corrections waiting on a person: held for review, and back pay asked to go on an off-cycle run and not yet in one. Reads only. */
export async function listPayReview(orgId: string) {
  const { listPayrollLedgerEntries } = await import("./storage.js");
  const fromRules = (entry: { metadata: JsonObject }) => entry.metadata.source === "pay_rule";
  const held = (await listPayrollLedgerEntries(orgId, { state: "projected", limit: 5000 })).filter((entry) => fromRules(entry) && entry.metadata.review_required === true);
  const offCycle = (await listPayrollLedgerEntries(orgId, { state: "accrued", open_only: true, limit: 5000 })).filter((entry) => fromRules(entry) && entry.metadata.off_cycle_requested === true);
  return { held, off_cycle: offCycle };
}

// ---- Projected earnings: the same rules over the work that is not done yet ----

/**
 * One earning a pay rule is expected to produce once the work it reads is done. Worked out from a source's projected
 * reading (see payroll/pay-sources.ts) by the payee's own rule, parameters and split, never posted to the ledger and
 * never part of a pay run. `expected_on` is the day it is expected to be earned, blank when nothing is scheduled.
 */
export type ProjectedEarning = {
  id: string; projected: true; payee: string; rule_id: string; rule_name: string; kind: string; unit: string; line: string;
  amount_cents: number; description: string; expected_on: string; expected_at: string; expected_from: string;
  project_id: string; project_title: string; record_title: string; projected_from: string; details?: JsonObject;
  /** For a group whose pay is split: how this line would be divided among its members today, or that a split rule decides when it is earned. */
  split?: { method: string; members?: { id: string; cents: number }[]; decided_when_earned?: true };
  /** On a member's own projection: the group line this is their share of. */
  share_of?: { payee: string; payee_name: string; line_cents: number; method: string };
};
export type ProjectedUnresolved = PayUnresolved & { expected_on?: string; project_id?: string; project_title?: string; share_of?: { payee: string; payee_name: string } };
export type PayProjection = {
  payee: Assignee; payee_name: string; as_of: string; projected: true; earnings: ProjectedEarning[]; unresolved: ProjectedUnresolved[]; total_cents: number;
  /** Projected earnings by job, soonest first; work with no expected date comes last. */
  projects: { project_id: string; project_title: string; total_cents: number; count: number; unresolved_count: number; next_expected_on: string }[];
};
export type PayProjectionOptions = Pick<PayRefreshOptions, "asOf" | "context">;

/** A source projects its rows when its options take a boolean `projected`. */
function projectsRows(source: { provider: string; export: string }) {
  const args = describeDataProvider(source.provider)?.exports[source.export]?.argsSchema as { properties?: Record<string, { type?: unknown }> } | undefined;
  return args?.properties?.projected?.type === "boolean";
}
const LAST = "￿";
const byExpected = (a: { expected_on: string }, b: { expected_on: string }) => (a.expected_on || LAST).localeCompare(b.expected_on || LAST);

function summarizeProjection(payee: Assignee, name: string, asOf: string, earnings: ProjectedEarning[], unresolved: ProjectedUnresolved[]): PayProjection {
  earnings.sort((a, b) => byExpected(a, b) || a.id.localeCompare(b.id));
  const projects = new Map<string, PayProjection["projects"][number]>();
  const bucket = (id: string, title: string) => {
    if (!projects.has(id)) projects.set(id, { project_id: id, project_title: title, total_cents: 0, count: 0, unresolved_count: 0, next_expected_on: "" });
    const found = projects.get(id)!;
    if (!found.project_title && title) found.project_title = title;
    return found;
  };
  for (const earning of earnings) {
    const found = bucket(earning.project_id, earning.project_title);
    found.total_cents += earning.amount_cents; found.count += 1;
    if (earning.expected_on && (!found.next_expected_on || earning.expected_on < found.next_expected_on)) found.next_expected_on = earning.expected_on;
  }
  for (const entry of unresolved) bucket(entry.project_id || "", entry.project_title || "").unresolved_count += 1;
  return {
    payee, payee_name: name, as_of: asOf, projected: true, earnings, unresolved, total_cents: earnings.reduce((sum, earning) => sum + earning.amount_cents, 0),
    projects: [...projects.values()].sort((a, b) => byExpected({ expected_on: a.next_expected_on }, { expected_on: b.next_expected_on }) || a.project_title.localeCompare(b.project_title))
  };
}

/**
 * What a payee's pay rules say they are expected to earn from work that is not done yet. Each rule that pays per
 * record and whose primary input publishes a projected reading is run, in the sandbox, exactly as a refresh runs it:
 * the version and parameters in effect on the expected day, its own selection and formula, over the rows as they are
 * expected to look once done. A record the rule has already earned is not projected again. A formula that throws or
 * returns no whole cents is unresolved with its reason, never zero. Reads only: nothing is posted, stored or noted.
 * Rules that pay by period (hours, salary) are not projected.
 */
export async function projectPayeeEarnings(orgId: string, payee: Assignee, options: PayProjectionOptions = {}): Promise<PayProjection> {
  const asOf = options.asOf || nowIso(), day = asOf.slice(0, 10), owner = payeeKey(payee);
  const earnings: ProjectedEarning[] = [], unresolved: ProjectedUnresolved[] = [];
  const ref = await payeeRef(orgId, payee);
  if (!ref) return summarizeProjection(payee, "", asOf, [], [{ rule_id: "", reason: "This payee is no longer available in the organization." }]);
  const layers = await payLayersFor(orgId, payee, undefined, { day });
  const rules = new Map((await listPayRules(orgId)).map((rule) => [rule.id, rule]));
  const plans = new Map<string, PayPlan>((await listPayPlans(orgId)).map((plan) => [plan.id, plan]));
  // Earned already means not projected, whatever a projected reading says about the same record.
  const earned = new Set((await storedUnits(orgId, payee)).filter((unit) => unit.status === "ok" && unit.lines.length).map((unit) => `${unit.rule_id}\u0000${unit.unit_key}`));
  const titles = new Map<string, string>();
  const projectTitle = async (id: string, given: string) => {
    if (given || !id) return given;
    if (!titles.has(id)) {
      const { readDocument } = await import("../platform/storage.js");
      const data = ((await readDocument(orgId, "projects", id).catch(() => null))?.data || {}) as JsonObject;
      titles.set(id, text(data.title || data.address));
    }
    return titles.get(id)!;
  };
  let members: string[] | null = null;
  const currentMembers = async () => {
    if (!members) {
      const group = (await (await import("../workforce/storage.js")).listAssignmentGroups(orgId, true)).find((entry) => text((entry as JsonObject).id) === payee.id) as JsonObject | undefined;
      members = (Array.isArray(group?.members) ? group!.members as JsonObject[] : []).filter((member) => text(member.status || "active") === "active").map((member) => text(member.user_id)).filter(Boolean).sort();
    }
    return members;
  };
  /** How a group's line would be divided if it were earned on that day. Members are today's; a split rule decides when the earning is worked out. */
  const splitOf = async (date: string, cents: number): Promise<ProjectedEarning["split"] | undefined> => {
    const setting = payee.type === "resource_group" ? distributionOn(layers, date) : null;
    if (!setting || setting.mode !== "split") return undefined;
    if (setting.method === "rule") return { method: "rule", decided_when_earned: true };
    const weights = setting.method === "shares" ? Object.entries(setting.shares || {}).map(([id, weight]) => ({ id, weight: Number(weight) })).filter((entry) => entry.weight > 0)
      : (await currentMembers()).map((id) => ({ id, weight: 1 }));
    return { method: setting.method || "equal", members: weights.length ? [...splitCentsByWeight(cents, weights)].map(([id, share]) => ({ id, cents: share })) : [] };
  };

  for (const [ruleId, definitionIds] of candidateRuleSlots(layers, plans)) {
    const shapes = new Map<string, { rule: PayRule; version: PayRuleVersion }>();
    for (const definitionId of definitionIds) for (const version of rules.get(definitionId)?.versions || []) shapes.set(shapeOf(version.definition), { rule: rules.get(definitionId)!, version });
    const planned: (Planned & { record: JsonObject })[] = [];
    for (const [shape, sample] of shapes) {
      const definition = sample.version.definition;
      const primary = definition.grain === "record" ? Object.entries(definition.inputs).find(([, input]) => input.primary) : undefined;
      if (!primary || !projectsRows(primary[1].source)) continue;
      let ctx = options.context;
      if (!ctx) try { ctx = userPublicationContext(await backgroundAuthContext(orgId, sample.version.entered_by)); }
      catch { unresolved.push({ rule_id: ruleId, reason: "The person who last saved this rule can no longer read its inputs. Save the rule again." }); break; }
      const read = await readInputs(ctx, orgId, definition, payee, new Set([primary[0]]));
      if (!read.rows) { unresolved.push({ rule_id: ruleId, reason: read.failure! }); break; }
      const rows = read.rows;
      const schedule = definition.timezone ? null : await resolvePaySchedule(orgId, payee, definition.kind, day, layers).catch(() => null);
      const timezone = definition.timezone || text((schedule?.schedule as JsonObject | undefined)?.timezone) || "UTC";
      const shared: JsonObject = Object.fromEntries(Object.keys(definition.inputs).filter((name) => name !== primary[0]).map((name) => [name, rows[name]!.map((row) => row.value)]));
      for (const row of rows[primary[0]]!) {
        if (earned.has(`${ruleId}\u0000${row.key}`) || planned.some((entry) => entry.key === row.key)) continue;
        const expected = rowDate(row.value, definition.earned_at!, timezone);
        // The rule in effect on the day it is expected to be earned; with no date yet, the one in effect today.
        const ruleDay = expected?.date || localDay(Date.parse(asOf), timezone);
        const slot = effectiveRuleSlots(layers, plans, ruleDay).get(ruleId);
        const rule = slot && rules.get(slot.definition_rule_id);
        const version = rule && versionOn(rule.versions, ruleDay);
        if (!slot || !rule || !version || shapeOf(version.definition) !== shape) continue;
        const record = row.value as JsonObject;
        planned.push({ key: row.key, date: expected?.date || "", earned_at: expected?.instant || "", payload: { record, earned_at: expected?.instant || "" }, evidence: [],
          project_id: definition.project ? text(readField(record, definition.project)) : "", rule, version, params: resolvedParams(version.definition, slot.params), digest: "", shared, timezone, split: null, record });
      }
    }
    const groups = new Map<string, typeof planned>();
    for (const unit of planned) { const key = contentHash({ version: unit.version.version, rule: unit.rule.id, params: unit.params }); groups.set(key, [...(groups.get(key) || []), unit]); }
    for (const group of groups.values()) {
      const outcomes = await evaluate(group, payee, asOf);
      for (const unit of group) {
        const outcome = outcomes.get(unit.key)!;
        const project_title = await projectTitle(unit.project_id, text(unit.record.project_title));
        if (!outcome.lines) { unresolved.push({ rule_id: ruleId, unit: unit.key, reason: outcome.error || "The rule could not be run.", expected_on: unit.date, project_id: unit.project_id, project_title }); continue; }
        for (const line of outcome.lines) {
          const split = await splitOf(unit.date || day, line.amount_cents);
          earnings.push({
            id: `${owner}:${ruleId}:${unit.key}:${line.key}`, projected: true, payee: owner, rule_id: ruleId, rule_name: unit.rule.name, kind: unit.version.definition.kind, unit: unit.key, line: line.key,
            amount_cents: line.amount_cents, description: line.description, expected_on: unit.date, expected_at: unit.earned_at, expected_from: text(unit.record.expected_from),
            project_id: unit.project_id, project_title, record_title: text(unit.record.title), projected_from: text(unit.record.projected_from),
            ...(line.details ? { details: line.details } : {}), ...(split ? { split } : {})
          });
        }
      }
    }
  }
  return summarizeProjection(payee, ref.name || "", asOf, earnings, unresolved);
}

/**
 * A user's own projected earnings: what their own rules project, and their share of what each group they are an
 * active member of projects when that group's pay is split. A group paid as one is paid to the group, so it adds
 * nothing here; a group whose split rule decides the division when an earning is worked out is listed as unresolved
 * with the reason, never as a guessed share.
 */
export async function projectUserEarnings(orgId: string, userId: string, options: PayProjectionOptions = {}): Promise<PayProjection> {
  const me: Assignee = { type: "organization_user", id: userId };
  const own = await projectPayeeEarnings(orgId, me, options);
  const earnings = [...own.earnings], unresolved = [...own.unresolved];
  const groups = (await (await import("../workforce/storage.js")).listAssignmentGroups(orgId, true)).map((group) => group as JsonObject)
    .filter((group) => (Array.isArray(group.members) ? group.members as JsonObject[] : []).some((member) => text(member.user_id) === userId && text(member.status || "active") === "active"));
  for (const group of groups) {
    const payee: Assignee = { type: "resource_group", id: text(group.id) };
    const projection = await projectPayeeEarnings(orgId, payee, options);
    const of = { payee: payeeKey(payee), payee_name: projection.payee_name || text(group.name) };
    const day = projection.as_of.slice(0, 10);
    // Only a group whose pay reaches its members matters here; one paid as one keeps its earnings, and its gaps, to itself.
    const splits = distributionOn(await payLayersFor(orgId, payee, undefined, { day }), day)?.mode === "split" || projection.earnings.some((earning) => earning.split);
    if (!splits) continue;
    for (const earning of projection.earnings) {
      if (!earning.split) continue;
      if (earning.split.decided_when_earned) {
        unresolved.push({ rule_id: earning.rule_id, unit: earning.unit, reason: `${of.payee_name} divides this by a split rule when it is earned, so your share is not known yet.`, expected_on: earning.expected_on, project_id: earning.project_id, project_title: earning.project_title, share_of: of });
        continue;
      }
      const share = earning.split.members?.find((member) => member.id === userId);
      if (!share || !share.cents) continue;
      const { split: _split, ...line } = earning;
      earnings.push({ ...line, id: `${payeeKey(me)}:${earning.id}`, payee: payeeKey(me), amount_cents: share.cents, share_of: { ...of, line_cents: earning.amount_cents, method: earning.split.method } });
    }
    for (const entry of projection.unresolved) unresolved.push({ ...entry, share_of: of });
  }
  return summarizeProjection(me, own.payee_name, own.as_of, earnings, unresolved);
}

/** The most payees one organization-wide projection works through; beyond it the answer says it is partial. */
export const PAY_PROJECTION_PAYEE_LIMIT = 200;
/** Projected totals for everyone whose pay comes from rules, for payroll managers. Reads only. */
export async function projectOrganizationEarnings(orgId: string, options: PayProjectionOptions = {}) {
  const payees = await payeesWithPay(orgId);
  const rows = [];
  for (const payee of payees.slice(0, PAY_PROJECTION_PAYEE_LIMIT)) {
    try {
      const projection = await projectPayeeEarnings(orgId, payee, options);
      rows.push({ id: payeeKey(payee), payee, payee_name: projection.payee_name, total_cents: projection.total_cents, count: projection.earnings.length, unresolved_count: projection.unresolved.length,
        next_expected_on: projection.earnings.find((earning) => earning.expected_on)?.expected_on || "" });
    } catch (error) {
      rows.push({ id: payeeKey(payee), payee, payee_name: "", total_cents: 0, count: 0, unresolved_count: 1, next_expected_on: "", error: text((error as Error).message) || "The projection could not be worked out." });
    }
  }
  return { projected: true as const, as_of: options.asOf || nowIso(), payees: rows, payee_count: payees.length, total_cents: rows.reduce((sum, row) => sum + row.total_cents, 0), truncated: payees.length > PAY_PROJECTION_PAYEE_LIMIT };
}
