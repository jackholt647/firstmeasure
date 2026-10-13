import { runModuleCode } from "../documents/modules/runtime.js";
import { readAssignee, type Assignee } from "../labor/assignees.js";
import { backgroundAuthContext } from "../platform/auth.js";
import { userPublicationContext } from "../platform/publication/context.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { selectPublishedData, type SelectedRow } from "../platform/publication/select.js";
import { contentHash as hashJson } from "../platform/publication/validation.js";
import {
  candidateRuleSlots, distributionOn, effectiveRuleSlots, ensurePayRuleSchema, listPayDefaults, listPayPlans, listPayRules, listPaySetups, payeeKey, payLayersFor, resolvedParams, versionOn,
  type PayPlan, type PayRule, type PayRuleDefinition, type PayRuleVersion, type PaySetup
} from "./pay-rules.js";
import type { PayrollLedgerEntryInput, PayrollPayeeRef } from "./schemas.js";
import { badRequest } from "../platform/errors.js";
import { findPayrollLedgerSourceEntries, getPayrollDatabase, nowIso, readPayrollLedgerEntry, resolvePayrollPolicy, voidPayrollLedgerEntry, type JsonObject } from "./storage.js";

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
  setup?: Pick<PaySetup, "entries" | "distribution">;
  /** The instant "now" is. Periods that end after it are not earned yet. */
  asOf?: string;
  /** Reads run as each rule's author unless a trusted caller supplies the context. */
  context?: PublicationContext;
};

type Row = SelectedRow;
type Unit = { key: string; date: string; earned_at: string; payload: JsonObject; evidence: [string, string, string][]; project_id: string };
type Planned = Unit & { version: PayRuleVersion; rule: PayRule; params: Record<string, number | boolean | string>; digest: string; shared: JsonObject; timezone: string };
/** Who shares a group's earning, fixed when it is first worked out. `basis` identifies the distribution setting it came from. */
export type PayAllocation = { basis: string; members: { id: string; weight: number }[] };
type StoredUnit = { rule_id: string; unit_key: string; digest: string; status: string; earned_at: string; lines: PayLine[]; allocation: PayAllocation | null };

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

function withTokens<T>(value: T, payee: Assignee): T {
  const tokens: Record<string, string> = { "$payee.key": payeeKey(payee), "$payee.type": payee.type, "$payee.id": payee.id };
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

async function readInputs(ctx: PublicationContext, orgId: string, definition: PayRuleDefinition, payee: Assignee) {
  const rows: Record<string, Row[]> = {};
  for (const [name, input] of Object.entries(definition.inputs)) {
    const result = await selectPublishedData(ctx, withTokens({
      provider: input.source.provider, export: input.source.export, target: { scope: "organization" as const, organizationId: orgId }, ...(input.source.args ? { args: input.source.args } : {})
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
  return rows.map((row) => ({ id: `${row.rule_id}:${row.unit_key}`, rule_id: String(row.rule_id), unit: String(row.unit_key), status: String(row.status), earned_at: String(row.earned_at),
    rule_version: String(row.rule_version), lines: JSON.parse(String(row.lines_json || "[]")) as PayLine[], error: String(row.error), evaluated_at: String(row.evaluated_at),
    split_among: String(row.allocation_json || "") ? (JSON.parse(String(row.allocation_json)) as PayAllocation).members : null }));
}

export async function refreshPayeeEarnings(orgId: string, payee: Assignee, options: PayRefreshOptions = {}): Promise<PayRefreshResult> {
  const result: PayRefreshResult = { payee, evaluated: 0, unchanged: 0, differences: [], unresolved: [], posted: [] };
  const dryRun = !!options.dryRun;
  const asOf = options.asOf || nowIso();
  const layers = await payLayersFor(orgId, payee, dryRun && options.setup ? options.setup : undefined);
  const rules = new Map((await listPayRules(orgId)).map((rule) => [rule.id, rule]));
  const plans = new Map<string, PayPlan>((await listPayPlans(orgId)).map((plan) => [plan.id, plan]));
  const stored = await storedUnits(orgId, payee);
  const owner = payeeKey(payee);
  const ref = await payeeRef(orgId, payee);
  if (!ref) { result.unresolved.push({ rule_id: "", reason: "This payee is no longer available in the organization." }); return result; }
  result.payee_name = ref.name || "";
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
  let members: string[] | null = null;
  /** Who shares this earning. Kept from the first time it was worked out unless the distribution setting itself has changed. */
  const allocationFor = async (date: string, prior: PayAllocation | null | undefined): Promise<PayAllocation | null | { error: string }> => {
    const setting = payee.type === "resource_group" ? distributionOn(layers, date) : null;
    if (!setting || setting.mode === "as_one") return null;
    const basis = contentHash(setting);
    if (prior && prior.basis === basis) return prior;
    if (setting.method === "shares") return { basis, members: Object.entries(setting.shares || {}).map(([id, weight]) => ({ id, weight })).sort((a, b) => a.id.localeCompare(b.id)) };
    if (!members) {
      const group = (await (await import("../workforce/storage.js")).listAssignmentGroups(orgId, true)).find((entry) => text((entry as JsonObject).id) === payee.id) as JsonObject | undefined;
      members = (Array.isArray(group?.members) ? group!.members as JsonObject[] : []).filter((member) => text(member.status || "active") === "active").map((member) => text(member.user_id)).filter(Boolean).sort();
    }
    return members.length ? { basis, members: members.map((id) => ({ id, weight: 1 })) } : { error: "This group has no active members to split its pay among." };
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
      const want = new Map<string, number>(allocation ? [...splitCentsByWeight(amount, allocation.members)].map(([id, cents]) => [`organization_user:${id}`, cents]) : [[owner, amount]]);
      for (const paid of [...new Set([...want.keys(), ...all.map((entry) => `${entry.payee.type}:${entry.payee.id}`)])].sort()) {
        const entries = all.filter((entry) => `${entry.payee.type}:${entry.payee.id}` === paid);
        const counted = entries.filter((entry) => entry.state !== "void" || entry.metadata.pay_rule_declined === true);
        const posted = counted.reduce((sum, entry) => sum + entry.amount_cents, 0);
        const target = want.get(paid) || 0;
        const delta = target - posted;
        if (!delta) continue;
        const paidRef = await refFor(paid);
        if (!paidRef) throw new Error(`${paid} is no longer available in the organization, so their share cannot be posted.`);
        const policy = await resolvePayrollPolicy(orgId, paidRef, kind).catch(() => null);
        const settled = entries.some((entry) => entry.state !== "void" && entry.applied_cents !== 0);
        const handling: Handling = settled ? correctionPolicy(policy?.schedule as JsonObject | undefined, delta > 0) : "normal";
        result.differences.push({ rule_id: ruleId, unit: unit.key, line: key, earned_on: unit.date, posted_cents: posted, target_cents: target, delta_cents: delta, handling, ...(paid === owner ? {} : { payee: paid }) });
        if (dryRun) continue;
        const label = line?.description || previous.find((entry) => entry.key === key)?.description || rule?.name || "Pay rule";
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
            ...(paid === owner ? {} : { split: { of: owner, line_cents: amount, members: allocation?.members.length || 0 } }),
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
      const schedule = definition.timezone ? null : await resolvePayrollPolicy(orgId, ref, definition.kind).catch(() => null);
      const timezone = definition.timezone || text((schedule?.schedule as JsonObject | undefined)?.timezone) || "UTC";
      const built = unitsFor(definition, read.rows, timezone, localDay(Date.parse(asOf), timezone), firstDay);
      const sharedDigest = contentHash(built.sharedEvidence);
      for (const unit of built.units) {
        const slot = effectiveRuleSlots(layers, plans, unit.date).get(ruleId);
        const rule = slot && rules.get(slot.definition_rule_id);
        const version = rule && versionOn(rule.versions, unit.date);
        // A record or period belongs to the shape of the rule that applied on its day, and to no other.
        if (!slot || !rule || !version || shapeOf(version.definition) !== shape || planned.some((entry) => entry.key === unit.key)) continue;
        const params = resolvedParams(version.definition, slot.params);
        planned.push({ ...unit, rule, version, params, shared: built.shared, timezone, evidence: [...unit.evidence, ...built.sharedEvidence],
          digest: contentHash({ rule: version.version, params, payee: owner, unit: unit.key, date: unit.date, earned_at: unit.earned_at, evidence: unit.evidence, shared: sharedDigest,
            distribution: payee.type === "resource_group" ? distributionOn(layers, unit.date) : null }) });
      }
    }
    if (unreadable.has(ruleId)) continue;
    if (!dryRun && stored.some((entry) => entry.rule_id === ruleId && entry.unit_key === WHOLE_RULE)) {
      await getPayrollDatabase().prepare("DELETE FROM pay_rule_units WHERE organization_id=? AND payee_type=? AND payee_id=? AND rule_id=? AND unit_key=?").run(orgId, payee.type, payee.id, ruleId, WHOLE_RULE);
    }
    const before = new Map(stored.filter((entry) => entry.rule_id === ruleId).map((entry) => [entry.unit_key, entry]));
    const changed = planned.filter((unit) => { desired.add(`${ruleId}\u0000${unit.key}`); const prior = before.get(unit.key); return !(prior && prior.status === "ok" && prior.digest === unit.digest); });
    result.unchanged += planned.length - changed.length;
    const groups = new Map<string, Planned[]>();
    for (const unit of changed) { const key = contentHash({ version: unit.version.version, params: unit.params }); groups.set(key, [...(groups.get(key) || []), unit]); }
    for (const group of groups.values()) {
      const outcomes = await evaluate(group, payee, asOf);
      for (const unit of group) {
        result.evaluated += 1;
        const outcome = outcomes.get(unit.key)!;
        const prior = before.get(unit.key);
        if (!outcome.lines) {
          // Could not be worked out is not zero: what was posted before stays, and the reason is reported.
          result.unresolved.push({ rule_id: ruleId, unit: unit.key, reason: outcome.error || "The rule could not be run." });
          if (!dryRun) await saveUnit(orgId, payee, ruleId, { key: unit.key, digest: unit.digest, status: "error", earned_at: unit.earned_at, version: unit.version.version, lines: prior?.lines || [], error: outcome.error || "", evidence: unit.evidence });
          continue;
        }
        try {
          const allocation = await allocationFor(unit.date, prior?.allocation);
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
export async function previewPaySetup(orgId: string, payee: Assignee, setup: Pick<PaySetup, "entries" | "distribution">, options: Pick<PayRefreshOptions, "asOf" | "context"> = {}) {
  const preview = await refreshPayeeEarnings(orgId, payee, { ...options, dryRun: true, setup });
  return { ...preview, total_delta_cents: preview.differences.reduce((sum, difference) => sum + difference.delta_cents, 0) };
}

/** Everyone whose pay comes from rules: payees with their own setup, and, when any default exists, every assignee a default covers. */
export async function payeesWithPay(orgId: string): Promise<Assignee[]> {
  const found = new Map<string, Assignee>((await listPaySetups(orgId)).filter((setup) => setup.entries.length).map((setup) => [payeeKey(setup.payee), setup.payee]));
  if ((await listPayDefaults(orgId)).some((entry) => entry.entries.length)) {
    const { listDocuments } = await import("../platform/storage.js");
    const everyone: Assignee[] = [
      ...(await listDocuments(orgId, "users")).filter((row) => !["disabled", "deleted", "archived", "removed"].includes(text((row.data as JsonObject).status))).map((row) => ({ type: "organization_user" as const, id: row.id })),
      ...(await (await import("../workforce/storage.js")).listAssignmentGroups(orgId, false)).map((group) => ({ type: "resource_group" as const, id: text((group as JsonObject).id) })),
      ...(await (await import("../connections/storage.js")).listOrganizationConnections(orgId)).map((connection) => ({ type: "organization_connection" as const, id: text((connection as JsonObject).id) }))
    ];
    for (const payee of everyone) if (payee.id && !found.has(payeeKey(payee)) && (await payLayersFor(orgId, payee)).some((layer) => layer.entries.length)) found.set(payeeKey(payee), payee);
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
