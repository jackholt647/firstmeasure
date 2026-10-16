import { z } from "zod";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { ASSIGNEE_TYPES, requireAssignee, type Assignee } from "../labor/assignees.js";
import { normalizeSelection } from "../platform/publication/select.js";
import { contentHash as hashJson } from "../platform/publication/validation.js";
import { ensureSqlColumn } from "../platform/sql_store.js";
import { getPayrollDatabase, nowIso, readPayrollSchedule, type JsonObject } from "./storage.js";

/**
 * Pay rules, pay plans and each payee's pay setup. See docs/architecture/pay-rules.md.
 *
 * A pay rule is one formula with declared inputs. A pay plan groups rules for
 * quick assignment. A payee's setup says which plans and rules apply to them
 * and how they differ. Everything is effective-dated: an earning is worked out
 * with whatever was in effect on the day it was earned.
 */
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/, "Use letters, digits, dots, dashes and underscores.");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");
const field = z.string().max(300).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, "Use a dot path into the published row.");
const paramValue = z.union([z.number().finite(), z.boolean(), z.string().max(500)]);
const params = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), paramValue);

/** Hashes plain data; keys left undefined are not part of it. */
const contentHash = (value: unknown) => hashJson(JSON.parse(JSON.stringify(value)));
export const PAY_PERIODS = ["day", "week", "month", "quarter", "year"] as const;
export const PAY_RULE_KINDS = ["hourly", "salary", "piece_rate", "commission", "reimbursement", "adjustment"] as const;
/**
 * What a parameter holds, so a form does not have to guess from its default: a plain `number`, a `boolean` switch,
 * `text`, whole `cents` of money, or `basis_points` (hundredths of a percent). Left out, a form falls back to the
 * default's own type.
 */
export const PAY_PARAMETER_TYPES = ["number", "boolean", "text", "cents", "basis_points"] as const;
export type PayParameterType = typeof PAY_PARAMETER_TYPES[number];
const fitsParameterType = (type: PayParameterType, value: unknown) => type === "boolean" ? typeof value === "boolean" : type === "text" ? typeof value === "string"
  : typeof value === "number" && (type === "number" || Number.isInteger(value));
const parameters = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), z.object({ label: z.string().max(200).optional(), type: z.enum(PAY_PARAMETER_TYPES).optional(), default: paramValue.optional() }).strict())
  .superRefine((value, context) => {
    for (const [name, declared] of Object.entries(value)) if (declared.type && declared.default !== undefined && !fitsParameterType(declared.type, declared.default)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name, "default"], message: `The default of ${name} is not ${declared.type === "boolean" ? "a yes or no" : declared.type === "text" ? "text" : declared.type === "number" ? "a number" : `a whole number of ${declared.type.replace("_", " ")}`}.` });
    }
  }).default({});

const inputSchema = z.object({
  /** A published collection. `args` and `where` values may use `$payee.key`, `$payee.type` and `$payee.id`. */
  source: z.object({ provider: z.string().min(1).max(200), export: z.string().min(1).max(200), args: z.record(z.unknown()).optional() }).strict(),
  where: z.unknown().optional(),
  /** The row's date. For a rule that pays by period, rows are grouped into periods by it. */
  date: field.optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  /** The one input a rule that pays by record produces an earning for. */
  primary: z.boolean().optional()
}).strict();

export const payRuleDefinitionSchema = z.object({
  /** `record`: one earning per row of the primary input. `period`: one per calendar period. */
  grain: z.enum(["record", "period"]),
  period: z.enum(PAY_PERIODS).optional(),
  /** 0 is Sunday. Only read when the period is a week. */
  week_starts: z.number().int().min(0).max(6).default(1),
  /** Pay every period even when no input has a row in it (a salary). Period rules only. */
  always: z.boolean().default(false),
  /** IANA timezone periods are cut in. Left out, the payee's pay schedule decides, then UTC. */
  timezone: z.string().max(120).optional(),
  kind: z.enum(PAY_RULE_KINDS).default("commission"),
  /** Record rules: the primary row's field holding the date the earning was earned. No date, not earned yet. */
  earned_at: field.optional(),
  /** Record rules: the primary row's field holding its project id, carried onto the earning. */
  project: field.optional(),
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), inputSchema).refine((value) => Object.keys(value).length <= 8, "A rule reads at most eight inputs."),
  /** Named numbers and switches a plan or a payee can set without changing the rule. Each may declare its `type` (see PAY_PARAMETER_TYPES). */
  parameters,
  /**
   * The body of a function run once per record or period in the sandbox. It
   * sees `unit`, `params`, `payee` and `shared`, and returns what was earned:
   * cents, `{ amount_cents, key?, description?, details? }`, a list of those,
   * or null for nothing. It cannot read the clock or anything undeclared.
   */
  code: z.string().min(1).max(64_000)
}).strict().superRefine((value, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  const primaries = Object.values(value.inputs).filter((input) => input.primary);
  if (value.grain === "record") {
    if (primaries.length !== 1) issue("inputs", "A rule that pays by record names exactly one primary input.");
    if (!value.earned_at) issue("earned_at", "A rule that pays by record names the field holding the earned date.");
    if (value.period || value.always) issue("period", "Periods belong to rules that pay by period.");
  } else {
    if (!value.period) issue("period", "A rule that pays by period names its period.");
    if (primaries.length) issue("inputs", "Only rules that pay by record have a primary input.");
    if (value.earned_at || value.project) issue("earned_at", "A period rule's earnings are earned on the period's last day.");
    if (!value.always && !Object.values(value.inputs).some((input) => input.date)) issue("inputs", "A period rule needs an input with a date, or `always`.");
  }
  for (const [name, input] of Object.entries(value.inputs)) {
    try { normalizeSelection({ ...(input.where === undefined ? {} : { where: input.where }), ...(input.limit ? { limit: input.limit } : {}) }); }
    catch (error) { issue("inputs", `${name}: ${(error as Error).message}`); }
  }
  if (value.timezone) try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }); } catch { issue("timezone", "Unknown timezone."); }
});
export type PayRuleDefinition = z.infer<typeof payRuleDefinitionSchema>;

export const payRuleSaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  /** The first day this version of the rule applies to. A past date backdates it. Defaults to today. */
  effective_from: day.optional(),
  definition: payRuleDefinitionSchema,
  expected_revision: z.number().int().nonnegative().optional()
}).strict();

const ruleRef = z.object({ rule_id: id, params: params.optional() }).strict();
export const payPlanSaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  effective_from: day.optional(),
  rules: z.array(ruleRef).max(64),
  expected_revision: z.number().int().nonnegative().optional()
}).strict();

const span = { effective_from: day, effective_through: day.optional(), note: z.string().trim().max(500).optional() };
/** `plan` and `add` bring rules in. `remove` takes one out. `override` changes one rule's parameters or swaps in another rule. */
export const paySetupEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan_id: id, ...span }).strict(),
  z.object({ kind: z.literal("add"), rule_id: id, params: params.optional(), ...span }).strict(),
  z.object({ kind: z.literal("remove"), rule_id: id, ...span }).strict(),
  z.object({ kind: z.literal("override"), rule_id: id, params: params.optional(), replacement_rule_id: id.optional(), ...span }).strict()
]);
const payeeSchema = z.object({ type: z.enum(ASSIGNEE_TYPES), id: z.string().trim().min(1).max(200) }).strict();

/** What a split input may compare a row's field with: something about the earning being divided. */
const earningToken = z.string().max(320).regex(/^\$earning\.(?:project_id|unit|rule_id|record\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/, "Use $earning.project_id, $earning.unit, $earning.rule_id or $earning.record.<field>.");
const splitInputSchema = z.object({
  /**
   * A published collection, selected once per refresh for the whole group. `args` and `where` values may use
   * `$payee.key`, `$payee.type` and `$payee.id` (the group) and `$members.keys` / `$members.ids` (lists, for `in`).
   */
  source: z.object({ provider: z.string().min(1).max(200), export: z.string().min(1).max(200), args: z.record(z.unknown()).optional() }).strict(),
  where: z.unknown().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  /** The row's field naming the member (`type:id`) it is about. Rows about anyone who is not one of the earning's members are not handed over. */
  member: field.optional(),
  /** Which rows belong to an earning: each named row field must equal that value of the earning. An earning with no such value gets no rows. */
  match: z.record(field, earningToken).refine((value) => Object.keys(value).length <= 4, "An input matches on at most four fields.").optional(),
  /**
   * Which rows belong to an earning by time, in exact instants. The window ends when the earned day (or period) ends
   * and starts when it starts, `days_before` days earlier, or never (`any_time_before`). A row is in when the span from
   * its `start` to its `end` touches the window; with `end` declared each row also carries the exact `seconds` inside it.
   */
  window: z.object({ start: field, end: field.optional(), days_before: z.number().int().min(0).max(3660).optional(), any_time_before: z.boolean().optional() }).strict().optional()
}).strict();
/**
 * A split rule: how one earning of a group is divided among its members. Same vocabulary as a pay rule (declared
 * inputs, parameters, a formula run evaluate-only in the sandbox), but it returns weights, not money.
 */
export const paySplitDefinitionSchema = z.object({
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), splitInputSchema).refine((value) => Object.keys(value).length <= 8, "A split rule reads at most eight inputs.").default({}),
  parameters,
  /**
   * The body of a function run once per earning line in the sandbox. It sees `earning`, `members`, `rows`, `params`
   * and `group`, and returns an object keyed by member key whose values are a weight or
   * `{ weight, reason?, details? }`. A member left out, or given 0, gets nothing.
   */
  code: z.string().min(1).max(64_000)
}).strict().superRefine((value, context) => {
  for (const [name, input] of Object.entries(value.inputs)) {
    try { normalizeSelection({ ...(input.where === undefined ? {} : { where: input.where }), ...(input.limit ? { limit: input.limit } : {}) }); }
    catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, path: ["inputs"], message: `${name}: ${(error as Error).message}` }); }
    if (input.window?.days_before !== undefined && input.window.any_time_before) context.addIssue({ code: z.ZodIssueCode.custom, path: ["inputs"], message: `${name}: a window starts a number of days before, or at any time before, not both.` });
  }
});
export type PaySplitDefinition = z.infer<typeof paySplitDefinitionSchema>;
export const paySplitRuleSaveSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  /** The first earned day this version divides. A past date backdates it. Defaults to today. */
  effective_from: day.optional(),
  definition: paySplitDefinitionSchema,
  expected_revision: z.number().int().nonnegative().optional()
}).strict();

/**
 * How a group's earnings reach people, from a date. `as_one` pays the group as
 * one payee. `split` pays its members instead: `equal` shares among the active
 * members, fixed `shares` by user id (any positive weights), or a split `rule`
 * (`split_rule_id`, with `params`) that works the weights out from data.
 * Who shared an earning is fixed when it is first worked out, so a later change
 * of members never moves pay that was already earned. With `equal` and `shares`
 * the weights are fixed then too; with a rule they follow the data it reads.
 */
export const payDistributionSchema = z.object({
  effective_from: day,
  mode: z.enum(["as_one", "split"]),
  method: z.enum(["equal", "shares", "rule"]).optional(),
  shares: z.record(z.string().min(1).max(200), z.number().positive().finite()).optional(),
  split_rule_id: id.optional(),
  params: params.optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "split" && value.method === "shares" && !Object.keys(value.shares || {}).length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["shares"], message: "Name each member's share." });
  if (value.mode === "as_one" && (value.method || value.shares)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["method"], message: "A group paid as one has nothing to split." });
  if (value.method === "rule" && !value.split_rule_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["split_rule_id"], message: "Name the split rule." });
  if (value.method !== "rule" && (value.split_rule_id || value.params)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["split_rule_id"], message: "Only a split by rule names a split rule and its parameters." });
});
export type PayDistribution = z.infer<typeof payDistributionSchema>;

/**
 * Which pay schedule pays a payee, from a date: the "when" beside the rules' "what". A choice names one kind of
 * earning or, as `*` (the default), every kind that has no choice of its own. It may also override the schedule's
 * `timing_basis` (whether an earning is recognized when the work was done or when the job was completed) and its
 * `clawback_cap_percent` (how much of one check a clawback may take). Choices sit on a payee's own setup and on
 * pay defaults and are resolved through the same layers as rules: the highest layer that says wins, and within a
 * layer a choice for the exact kind beats the catch-all.
 */
export const PAY_SCHEDULE_EARNING_KINDS = ["*", ...PAY_RULE_KINDS, "clawback"] as const;
/** What each fixed word is called on a screen, published with the vocabulary so no screen keeps its own copy. */
export const PAY_VOCABULARY_LABELS = {
  earning_kinds: { "*": "All earnings", hourly: "Hourly", salary: "Salary", piece_rate: "Piece rate", commission: "Commission", reimbursement: "Reimbursement", adjustment: "Adjustment", clawback: "Clawback" },
  parameter_types: { number: "Number", cents: "Money", basis_points: "Percentage", boolean: "Yes or no", text: "Text" },
  periods: { day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" }
} as const satisfies { earning_kinds: Record<typeof PAY_SCHEDULE_EARNING_KINDS[number], string>; parameter_types: Record<typeof PAY_PARAMETER_TYPES[number], string>; periods: Record<typeof PAY_PERIODS[number], string> };
export const payScheduleChoiceSchema = z.object({
  effective_from: day, effective_through: day.optional(),
  earning_kind: z.enum(PAY_SCHEDULE_EARNING_KINDS).default("*"),
  schedule_id: z.string().trim().min(1).max(180),
  timing_basis: z.enum(["worked", "completed"]).optional(),
  clawback_cap_percent: z.number().min(0).max(100).optional(),
  note: z.string().trim().max(500).optional()
}).strict();
const schedules = z.array(payScheduleChoiceSchema).max(100).optional();

export const paySetupSaveSchema = z.object({
  payee: payeeSchema,
  entries: z.array(paySetupEntrySchema).max(200),
  distribution: z.array(payDistributionSchema).max(50).optional(),
  /** Which schedule pays this payee, by date and kind of earning. Left out, the stored choices are kept; an empty list clears them. */
  schedules,
  expected_revision: z.number().int().nonnegative().optional()
}).strict();

/**
 * What a default is attached to. A default is a pay setup shared by every payee the subject covers, underneath each
 * payee's own setup, lowest first:
 *
 * 1. `organization` (everyone);
 * 2. `assignee_kind` (all users, all groups of users, or all outside companies);
 * 3. `worker_classification` (users who are employees or independent contractors);
 * 4. the payee's types: `role` for a user (every access role they hold; a user's roles are their types), `group_type`
 *    for a group of users (its one kind), `company_type` for an outside company (each type it has). Several of one
 *    kind apply together, in order of id.
 *
 * Later in that order wins over earlier, and a payee's own entries win over all.
 */
export const PAY_DEFAULT_SUBJECTS = ["organization", "assignee_kind", "worker_classification", "role", "group_type", "company_type"] as const;
export const payDefaultSaveSchema = z.object({
  subject: z.object({ type: z.enum(PAY_DEFAULT_SUBJECTS), id: z.string().trim().min(1).max(200) }).strict(),
  entries: z.array(paySetupEntrySchema).max(200),
  distribution: z.array(payDistributionSchema).max(50).optional(),
  /** Which schedule pays everyone this default covers. Left out, the stored choices are kept; an empty list clears them. */
  schedules,
  expected_revision: z.number().int().nonnegative().optional()
}).strict();

type Stamp = { entered_at: string; entered_by: string };
export type PayRuleVersion = Stamp & { version: string; effective_from: string; definition: PayRuleDefinition };
export type PayRule = { id: string; name: string; description: string; status: "active" | "archived"; versions: PayRuleVersion[]; revision: number };
export type PaySplitRuleVersion = Stamp & { version: string; effective_from: string; definition: PaySplitDefinition };
export type PaySplitRule = { id: string; name: string; description: string; status: "active" | "archived"; versions: PaySplitRuleVersion[]; revision: number };
export type PayPlanVersion = Stamp & { effective_from: string; rules: z.infer<typeof ruleRef>[] };
export type PayPlan = { id: string; name: string; description: string; status: "active" | "archived"; versions: PayPlanVersion[]; revision: number };
export type PaySetupEntry = z.infer<typeof paySetupEntrySchema> & Stamp & { id: string };
export type PayScheduleChoice = z.infer<typeof payScheduleChoiceSchema> & Stamp & { id: string };
/** `closed` is set when the payee was removed from the organization: everything is kept and nothing new is worked out. */
export type PaySetup = { payee: Assignee; entries: PaySetupEntry[]; distribution?: PayDistribution[]; schedules?: PayScheduleChoice[]; closed?: { at: string; by: string }; revision: number };
export type PayDefaultSubject = { type: typeof PAY_DEFAULT_SUBJECTS[number]; id: string };
export type PayDefault = { subject: PayDefaultSubject; entries: PaySetupEntry[]; distribution?: PayDistribution[]; schedules?: PayScheduleChoice[]; revision: number };
/**
 * One layer of a payee's pay: a default it inherits, or its own setup (`source` is null). Lower layers come first.
 * `covered_from` and `covered_through` bound the days a default covered the payee, when payroll saw that start or
 * stop (a role given or taken away); left out, the layer covers every day.
 */
export type PayLayer = { source: PayDefaultSubject | null; entries: PaySetupEntry[]; distribution?: PayDistribution[]; schedules?: PayScheduleChoice[]; covered_from?: string; covered_through?: string };
export type Actor = { userId: string };

const ensured = new WeakMap<object, Promise<void>>();
/** Created on first use of each database, so the tables arrive with the code on an existing one. */
export function ensurePayRuleSchema() {
  const db = getPayrollDatabase();
  let ready = ensured.get(db);
  if (!ready) {
    ready = (async () => {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS pay_definitions (
          organization_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (organization_id, kind, id)
        );
        CREATE TABLE IF NOT EXISTS pay_rule_units (
          organization_id TEXT NOT NULL, payee_type TEXT NOT NULL, payee_id TEXT NOT NULL, rule_id TEXT NOT NULL, unit_key TEXT NOT NULL,
          digest TEXT NOT NULL, status TEXT NOT NULL, earned_at TEXT NOT NULL DEFAULT '', rule_version TEXT NOT NULL DEFAULT '',
          lines_json TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', evaluated_at TEXT NOT NULL,
          PRIMARY KEY (organization_id, payee_type, payee_id, rule_id, unit_key)
        );
        CREATE TABLE IF NOT EXISTS pay_rule_evidence (
          organization_id TEXT NOT NULL, source TEXT NOT NULL, row_key TEXT NOT NULL,
          payee_type TEXT NOT NULL, payee_id TEXT NOT NULL, rule_id TEXT NOT NULL, unit_key TEXT NOT NULL, row_revision TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (organization_id, source, row_key, payee_type, payee_id, rule_id, unit_key)
        );
        CREATE INDEX IF NOT EXISTS pay_rule_evidence_unit_idx ON pay_rule_evidence (organization_id, payee_type, payee_id, rule_id, unit_key);
        CREATE TABLE IF NOT EXISTS pay_layer_spans (
          organization_id TEXT NOT NULL, payee_type TEXT NOT NULL, payee_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
          covered_from TEXT NOT NULL DEFAULT '', covered_through TEXT NOT NULL DEFAULT '', noted_at TEXT NOT NULL,
          PRIMARY KEY (organization_id, payee_type, payee_id, subject_type, subject_id, covered_from)
        );
      `);
      await ensureSqlColumn(db, "pay_rule_units", "allocation_json", "TEXT NOT NULL DEFAULT ''");
    })();
    ensured.set(db, ready);
    ready.catch(() => ensured.delete(db));
  }
  return ready;
}

type Kind = "rule" | "plan" | "setup" | "default" | "split";
async function readRow<T>(orgId: string, kind: Kind, key: string): Promise<(T & { revision: number }) | null> {
  await ensurePayRuleSchema();
  const row = await getPayrollDatabase().prepare("SELECT data_json, revision FROM pay_definitions WHERE organization_id=? AND kind=? AND id=?").get(orgId, kind, key);
  return row ? { ...(JSON.parse(String(row.data_json)) as T), revision: Number(row.revision) } : null;
}
async function listRows<T>(orgId: string, kind: Kind): Promise<(T & { revision: number })[]> {
  await ensurePayRuleSchema();
  const rows = await getPayrollDatabase().prepare("SELECT data_json, revision FROM pay_definitions WHERE organization_id=? AND kind=? ORDER BY id").all(orgId, kind);
  return rows.map((row) => ({ ...(JSON.parse(String(row.data_json)) as T), revision: Number(row.revision) }));
}
async function writeRow(orgId: string, kind: Kind, key: string, data: JsonObject, expected: number | undefined, current: number | null) {
  if (expected !== undefined && expected !== (current ?? 0)) throw conflict("pay_definition_changed", "This changed elsewhere. Reload and try again.", { current_revision: current ?? 0 });
  const now = nowIso();
  const db = getPayrollDatabase();
  if (current === null) {
    await db.prepare("INSERT INTO pay_definitions (organization_id, kind, id, data_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(orgId, kind, key, JSON.stringify(data), now, now);
    return 1;
  }
  const result = await db.prepare("UPDATE pay_definitions SET data_json=?, revision=revision+1, updated_at=? WHERE organization_id=? AND kind=? AND id=? AND revision=?").run(JSON.stringify(data), now, orgId, kind, key, current);
  if (!Number((result as { changes?: number }).changes ?? 1)) throw conflict("pay_definition_changed", "This changed elsewhere. Reload and try again.");
  return current + 1;
}
const strip = <T extends { revision: number }>({ revision: _revision, ...rest }: T) => rest as unknown as JsonObject;
const today = () => nowIso().slice(0, 10);
const slug = (name: string, prefix: string) => `${prefix}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "new"}_${contentHash({ name, at: nowIso() }).slice(0, 6)}`;
/** A version with the same effective date replaces the one before it; history keeps the rest. */
function withVersion<T extends { effective_from: string }>(versions: T[], next: T) {
  return [...versions.filter((version) => version.effective_from !== next.effective_from), next].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
}
/** The version in effect on a day: the latest that starts on or before it. */
export function versionOn<T extends { effective_from: string }>(versions: T[], date: string): T | null {
  let found: T | null = null;
  for (const version of versions) if (version.effective_from <= date && (!found || version.effective_from >= found.effective_from)) found = version;
  return found;
}

export const listPayRules = (orgId: string) => listRows<Omit<PayRule, "revision">>(orgId, "rule") as Promise<PayRule[]>;
export const listPayPlans = (orgId: string) => listRows<Omit<PayPlan, "revision">>(orgId, "plan") as Promise<PayPlan[]>;
export const listPaySetups = (orgId: string) => listRows<Omit<PaySetup, "revision">>(orgId, "setup") as Promise<PaySetup[]>;
export async function readPayRule(orgId: string, ruleId: string) {
  const rule = await readRow<Omit<PayRule, "revision">>(orgId, "rule", ruleId) as PayRule | null;
  if (!rule) throw notFound("pay_rule_unknown", "That pay rule does not exist.");
  return rule;
}
export async function readPayPlan(orgId: string, planId: string) {
  const plan = await readRow<Omit<PayPlan, "revision">>(orgId, "plan", planId) as PayPlan | null;
  if (!plan) throw notFound("pay_plan_unknown", "That pay plan does not exist.");
  return plan;
}
export const payeeKey = (payee: Assignee) => `${payee.type}:${payee.id}`;
export async function readPaySetup(orgId: string, payee: Assignee): Promise<PaySetup> {
  return (await readRow<Omit<PaySetup, "revision">>(orgId, "setup", payeeKey(payee)) as PaySetup | null) || { payee, entries: [], revision: 0 };
}

/** The rule as saving this input would leave it, without saving: what `savePayRule` writes and what a preview evaluates. */
export async function draftPayRule(orgId: string, input: unknown, actor: Actor) {
  const parsed = payRuleSaveSchema.parse(input);
  const ruleId = parsed.id || slug(parsed.name, "rule");
  const current = await readRow<Omit<PayRule, "revision">>(orgId, "rule", ruleId) as PayRule | null;
  const version: PayRuleVersion = {
    version: contentHash(parsed.definition), effective_from: parsed.effective_from || today(),
    definition: parsed.definition, entered_at: nowIso(), entered_by: actor.userId
  };
  const data = { id: ruleId, name: parsed.name, description: parsed.description || "", status: "active" as const, versions: withVersion(current?.versions || [], version) };
  return { data, current, expected: parsed.expected_revision };
}
export async function savePayRule(orgId: string, input: unknown, actor: Actor): Promise<PayRule> {
  const { data, current, expected } = await draftPayRule(orgId, input, actor);
  return { ...data, revision: await writeRow(orgId, "rule", data.id, data, expected, current?.revision ?? null) };
}
async function archive<T extends { status: string; revision: number }>(orgId: string, kind: Kind, key: string, current: T, expected?: number) {
  const data = { ...strip(current), status: "archived" };
  return { ...data, revision: await writeRow(orgId, kind, key, data, expected, current.revision) } as unknown as T;
}
/** An archived rule is no longer offered for new plans and setups. Setups that already use it keep working until it is removed from them. */
export async function archivePayRule(orgId: string, input: unknown) {
  const parsed = z.object({ id, expected_revision: z.number().int().nonnegative().optional() }).strict().parse(input);
  return archive(orgId, "rule", parsed.id, await readPayRule(orgId, parsed.id), parsed.expected_revision);
}
/** Split rules are kept beside pay rules, as their own kind of definition: they have versions and parameters like a rule but divide an earning instead of making one. */
export const listPaySplitRules = (orgId: string) => listRows<Omit<PaySplitRule, "revision">>(orgId, "split") as Promise<PaySplitRule[]>;
export async function readPaySplitRule(orgId: string, ruleId: string) {
  const rule = await readRow<Omit<PaySplitRule, "revision">>(orgId, "split", ruleId) as PaySplitRule | null;
  if (!rule) throw notFound("pay_split_rule_unknown", "That split rule does not exist.");
  return rule;
}
export async function savePaySplitRule(orgId: string, input: unknown, actor: Actor): Promise<PaySplitRule> {
  const parsed = paySplitRuleSaveSchema.parse(input);
  const ruleId = parsed.id || slug(parsed.name, "split");
  const current = await readRow<Omit<PaySplitRule, "revision">>(orgId, "split", ruleId) as PaySplitRule | null;
  const version: PaySplitRuleVersion = {
    version: contentHash(parsed.definition), effective_from: parsed.effective_from || today(),
    definition: parsed.definition, entered_at: nowIso(), entered_by: actor.userId
  };
  const data = { id: ruleId, name: parsed.name, description: parsed.description || "", status: "active" as const, versions: withVersion(current?.versions || [], version) };
  return { ...data, revision: await writeRow(orgId, "split", ruleId, data, parsed.expected_revision, current?.revision ?? null) };
}
/** An archived split rule is no longer offered. Groups whose pay already names it keep being divided by it until their setting changes. */
export async function archivePaySplitRule(orgId: string, input: unknown) {
  const parsed = z.object({ id, expected_revision: z.number().int().nonnegative().optional() }).strict().parse(input);
  return archive(orgId, "split", parsed.id, await readPaySplitRule(orgId, parsed.id), parsed.expected_revision);
}
/** The plan as saving this input would leave it, without saving. */
export async function draftPayPlan(orgId: string, input: unknown, actor: Actor) {
  const parsed = payPlanSaveSchema.parse(input);
  const planId = parsed.id || slug(parsed.name, "plan");
  const rules = new Map((await listPayRules(orgId)).map((rule) => [rule.id, rule]));
  const seen = new Set<string>();
  for (const ref of parsed.rules) {
    if (!rules.has(ref.rule_id)) throw badRequest("pay_rule_unknown", `Pay rule ${ref.rule_id} does not exist.`);
    if (seen.has(ref.rule_id)) throw badRequest("pay_plan_duplicate_rule", "A plan lists each rule once.");
    seen.add(ref.rule_id);
  }
  const current = await readRow<Omit<PayPlan, "revision">>(orgId, "plan", planId) as PayPlan | null;
  const version: PayPlanVersion = { effective_from: parsed.effective_from || today(), rules: parsed.rules, entered_at: nowIso(), entered_by: actor.userId };
  const data = { id: planId, name: parsed.name, description: parsed.description || "", status: "active" as const, versions: withVersion(current?.versions || [], version) };
  return { data, current, expected: parsed.expected_revision };
}
export async function savePayPlan(orgId: string, input: unknown, actor: Actor): Promise<PayPlan> {
  const { data, current, expected } = await draftPayPlan(orgId, input, actor);
  return { ...data, revision: await writeRow(orgId, "plan", data.id, data, expected, current?.revision ?? null) };
}
export async function archivePayPlan(orgId: string, input: unknown) {
  const parsed = z.object({ id, expected_revision: z.number().int().nonnegative().optional() }).strict().parse(input);
  return archive(orgId, "plan", parsed.id, await readPayPlan(orgId, parsed.id), parsed.expected_revision);
}

type EntryInput = z.infer<typeof paySetupEntrySchema>;
/** Checks entries against the rules and plans that exist and stamps who entered each new or changed one, and when. */
async function stampEntries(orgId: string, input: EntryInput[], actor: Actor, current: PaySetupEntry[]): Promise<PaySetupEntry[]> {
  const rules = new Set((await listPayRules(orgId)).map((rule) => rule.id));
  const plans = new Set((await listPayPlans(orgId)).map((plan) => plan.id));
  const previous = new Map(current.map((entry) => [entry.id, entry]));
  const entries = input.map((entry) => {
    if (entry.effective_through && entry.effective_through < entry.effective_from) throw badRequest("pay_setup_span", "An entry cannot end before it starts.");
    if (entry.kind === "plan" && !plans.has(entry.plan_id)) throw badRequest("pay_plan_unknown", `Pay plan ${entry.plan_id} does not exist.`);
    if (entry.kind !== "plan" && !rules.has(entry.rule_id)) throw badRequest("pay_rule_unknown", `Pay rule ${entry.rule_id} does not exist.`);
    if (entry.kind === "override" && entry.replacement_rule_id && !rules.has(entry.replacement_rule_id)) throw badRequest("pay_rule_unknown", `Pay rule ${entry.replacement_rule_id} does not exist.`);
    if (entry.kind === "override" && !entry.params && !entry.replacement_rule_id) throw badRequest("pay_setup_override_empty", "An override changes parameters or names a replacement rule.");
    const entryId = contentHash(entry).slice(0, 16);
    const kept = previous.get(entryId);
    return { ...entry, id: entryId, entered_at: kept?.entered_at || nowIso(), entered_by: kept?.entered_by || actor.userId } as PaySetupEntry;
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw badRequest("pay_setup_duplicate", "The same entry appears twice.");
  return entries;
}
async function checkDistribution(orgId: string, distribution: PayDistribution[] | undefined, groups: boolean) {
  if (!distribution?.length) return undefined;
  if (!groups) throw badRequest("pay_distribution_not_group", "Only a group of users can be paid as one or split among its members.");
  if (new Set(distribution.map((entry) => entry.effective_from)).size !== distribution.length) throw badRequest("pay_distribution_duplicate", "Two distribution settings start on the same day.");
  const named = distribution.filter((entry) => entry.split_rule_id);
  const known = named.length ? new Set((await listPaySplitRules(orgId)).map((rule) => rule.id)) : new Set<string>();
  for (const entry of named) if (!known.has(entry.split_rule_id!)) throw badRequest("pay_split_rule_unknown", `Split rule ${entry.split_rule_id} does not exist.`);
  return [...distribution].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
}
type ScheduleInput = z.infer<typeof payScheduleChoiceSchema>;
/**
 * Checks schedule choices against the pay schedules that exist and stamps who entered each new or changed one, and
 * when. Left out, what is stored is kept, so a caller that only edits rules never drops when someone is paid.
 */
async function stampSchedules(orgId: string, input: ScheduleInput[] | undefined, actor: Actor, current: PayScheduleChoice[] | undefined): Promise<PayScheduleChoice[] | undefined> {
  if (input === undefined) return current?.length ? current : undefined;
  const previous = new Map((current || []).map((choice) => [choice.id, choice]));
  const active = new Map<string, boolean>();
  const choices: PayScheduleChoice[] = [];
  for (const choice of input) {
    if (choice.effective_through && choice.effective_through < choice.effective_from) throw badRequest("pay_schedule_span", "A schedule choice cannot end before it starts.");
    const choiceId = contentHash(choice).slice(0, 16);
    const kept = previous.get(choiceId);
    if (!kept) {
      if (!active.has(choice.schedule_id)) {
        const schedule = await readPayrollSchedule(orgId, choice.schedule_id).catch(() => null);
        if (!schedule) throw badRequest("pay_schedule_unknown", `Pay schedule ${choice.schedule_id} does not exist.`);
        active.set(choice.schedule_id, schedule.status !== "archived");
      }
      // An ended choice may still name an archived schedule: it only says what was true.
      if (!active.get(choice.schedule_id) && !choice.effective_through) throw badRequest("pay_schedule_archived", "An archived pay schedule cannot be chosen for new earnings.");
    }
    choices.push({ ...choice, id: choiceId, entered_at: kept?.entered_at || nowIso(), entered_by: kept?.entered_by || actor.userId });
  }
  if (new Set(choices.map((choice) => `${choice.earning_kind}\u0000${choice.effective_from}`)).size !== choices.length) throw badRequest("pay_schedule_duplicate", "Two schedule choices for the same kind of earning start on the same day.");
  return choices.length ? choices.sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.earning_kind.localeCompare(b.earning_kind)) : undefined;
}
/** Checks a setup against the rules, plans and schedules that exist and stamps who entered each new or changed entry, and when. */
export async function normalizePaySetup(orgId: string, input: unknown, actor: Actor, current: PaySetup): Promise<PaySetup> {
  const parsed = paySetupSaveSchema.parse(input);
  const distribution = await checkDistribution(orgId, parsed.distribution, parsed.payee.type === "resource_group");
  const chosen = await stampSchedules(orgId, parsed.schedules, actor, current.schedules);
  return { payee: parsed.payee, entries: await stampEntries(orgId, parsed.entries, actor, current.entries), ...(distribution ? { distribution } : {}), ...(chosen ? { schedules: chosen } : {}), revision: current.revision };
}
export async function savePaySetup(orgId: string, input: unknown, actor: Actor): Promise<PaySetup> {
  const parsed = paySetupSaveSchema.parse(input);
  await requireAssignee(orgId, parsed.payee);
  const current = await readPaySetup(orgId, parsed.payee);
  const next = await normalizePaySetup(orgId, parsed, actor, current);
  const data = { payee: next.payee, entries: next.entries, ...(next.distribution ? { distribution: next.distribution } : {}), ...(next.schedules ? { schedules: next.schedules } : {}) };
  return { ...data, revision: await writeRow(orgId, "setup", payeeKey(parsed.payee), data, parsed.expected_revision, current.revision || null) };
}
/**
 * Marks a payee's setup as closed because the payee was removed. Nothing is deleted: the entries, schedule choices,
 * stored results and ledger stay as they are. A closed setup is no longer refreshed; saving it again reopens it.
 */
export async function closePaySetup(orgId: string, payee: Assignee, actor: Actor): Promise<PaySetup> {
  const current = await readPaySetup(orgId, payee);
  if (!current.revision || current.closed) return current;
  const data = { ...strip(current), closed: { at: nowIso(), by: actor.userId } };
  return { ...(data as unknown as Omit<PaySetup, "revision">), revision: await writeRow(orgId, "setup", payeeKey(payee), data, undefined, current.revision) };
}

const defaultKey = (subject: PayDefaultSubject) => `${subject.type}:${subject.id}`;
export const listPayDefaults = (orgId: string) => listRows<Omit<PayDefault, "revision">>(orgId, "default") as Promise<PayDefault[]>;
export async function readPayDefault(orgId: string, subject: PayDefaultSubject): Promise<PayDefault> {
  return (await readRow<Omit<PayDefault, "revision">>(orgId, "default", defaultKey(subject)) as PayDefault | null) || { subject, entries: [], revision: 0 };
}
const clean = (value: unknown) => String(value ?? "").trim();
const idList = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))].sort();

/**
 * A payee's types, from the one place that knows them (`assigneeTypeIds`): for a user the access roles they resolve to
 * today (the saved ones, or the role inferred for them when none are saved), for a group its one type, for an outside
 * company its zero or more types. Payroll asks only here and never reads the roles off a record itself.
 */
export async function payeeTypeIdsFor(orgId: string, payee: Assignee): Promise<string[]> {
  return idList(await (await import("../assignees/base.js")).assigneeTypeIds(orgId, payee));
}
/** Whether a default may be attached to this subject, and whether the subject can cover groups of users (so may say how a group's pay is distributed). */
async function checkDefaultSubject(orgId: string, subject: PayDefaultSubject, lookUpRoles: boolean): Promise<{ groups: boolean }> {
  const { type, id: subjectId } = subject;
  if (type === "organization") {
    if (subjectId !== orgId) throw badRequest("pay_default_subject", "The organization default belongs to this organization.");
    return { groups: true };
  }
  if (type === "assignee_kind") {
    if (!(ASSIGNEE_TYPES as readonly string[]).includes(subjectId)) throw badRequest("pay_default_subject", "Choose users, groups of users or outside companies.");
    return { groups: subjectId === "resource_group" };
  }
  if (type === "worker_classification") {
    if (!["employee", "independent_contractor"].includes(subjectId)) throw badRequest("pay_default_subject", "Choose employees or independent contractors.");
    return { groups: false };
  }
  if (type === "role") {
    // Listing roles puts the organization's standard roles in place first, which only a save may do; a preview trusts the id.
    if (lookUpRoles && !(await (await import("../workforce/access.js")).listAccessRoles(orgId, { include_archived: true })).some((role) => clean((role as JsonObject).id) === subjectId)) throw badRequest("pay_default_subject", "That role does not exist.");
    return { groups: false };
  }
  const base = await import("../assignees/base.js");
  if (type === "group_type") {
    if (!(await base.listGroupTypes(orgId)).some((entry) => entry.id === subjectId)) throw badRequest("pay_default_subject", "That type of group does not exist.");
    return { groups: true };
  }
  if (!(await base.listCompanyTypes(orgId)).some((entry) => entry.id === subjectId)) throw badRequest("pay_default_subject", "That type of outside company does not exist.");
  return { groups: false };
}
/** The default as saving this input would leave it, without saving. */
export async function draftPayDefault(orgId: string, input: unknown, actor: Actor, options: { lookUpRoles?: boolean } = {}) {
  const parsed = payDefaultSaveSchema.parse(input);
  const { groups } = await checkDefaultSubject(orgId, parsed.subject, options.lookUpRoles !== false);
  const distribution = await checkDistribution(orgId, parsed.distribution, groups);
  const current = await readPayDefault(orgId, parsed.subject);
  const chosen = await stampSchedules(orgId, parsed.schedules, actor, current.schedules);
  const data = { subject: parsed.subject, entries: await stampEntries(orgId, parsed.entries, actor, current.entries), ...(distribution ? { distribution } : {}), ...(chosen ? { schedules: chosen } : {}) };
  return { data, current, expected: parsed.expected_revision };
}
/** Saves the pay every payee a subject covers starts from. Saving no entries, no distribution and no schedules clears it. */
export async function savePayDefault(orgId: string, input: unknown, actor: Actor): Promise<PayDefault> {
  const { data, current, expected } = await draftPayDefault(orgId, input, actor);
  return { ...data, revision: await writeRow(orgId, "default", defaultKey(data.subject), data, expected, current.revision || null) };
}

/**
 * The default subjects that cover a payee today, lowest first. The payee's types come from `assigneeTypeIds`: the
 * roles a user resolves to today (saved, or inferred when none are saved), a group's one type, a company's types.
 * A payee that no longer exists is covered by nothing.
 */
export async function payDefaultSubjectsFor(orgId: string, payee: Assignee): Promise<PayDefaultSubject[]> {
  const { readAssignee } = await import("../labor/assignees.js");
  const found = await readAssignee(orgId, payee);
  if (!found) return [];
  const subjects: PayDefaultSubject[] = [{ type: "organization", id: orgId }, { type: "assignee_kind", id: payee.type }];
  if (payee.type === "organization_user") {
    subjects.push({ type: "worker_classification", id: clean(found.record.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee" });
  }
  const typed = payee.type === "organization_user" ? "role" : payee.type === "resource_group" ? "group_type" : "company_type";
  for (const typeId of await payeeTypeIdsFor(orgId, payee)) subjects.push({ type: typed, id: typeId });
  return subjects;
}

/**
 * When each default subject covered a payee. Roles, a group's type and a company's types have no history of their
 * own, so payroll keeps the days it saw them: the first time a payee's pay is worked out, everything that covers them
 * is taken to have always done so; after that, a subject that appears covers them from the day it was noticed, and
 * one that disappears stops covering them the day before. Earnings earned while a default covered someone therefore
 * stay theirs when the role is taken away, exactly as when a setup entry is ended rather than deleted.
 * Only a refresh records (`record`); every other reader sees the same answer without writing.
 */
export type CoverageSpan = { subject: PayDefaultSubject; from: string; through: string };
const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
async function coverageSpans(orgId: string, payee: Assignee, options: { day: string; record: boolean; unknownPayee?: "organization" }): Promise<CoverageSpan[]> {
  const current = await payDefaultSubjectsFor(orgId, payee);
  const spans = await notePayCoverage(orgId, payee, current, options);
  // Nothing is known about a payee with no record. A ledger entry posted by hand for one still follows the organization's schedule.
  if (!current.length && !spans.length && options.unknownPayee) return [{ subject: { type: "organization", id: orgId }, from: "", through: "" }, { subject: { type: "assignee_kind", id: payee.type }, from: "", through: "" }];
  return spans;
}
/**
 * Compares the subjects that cover a payee today (`current`) with the spans kept for them and returns every span,
 * lowest layer first. With `record` the comparison is remembered. An empty `current` means the payee has no record
 * (removed, or never one): nothing is concluded from that and the kept spans are returned as they are.
 */
export async function notePayCoverage(orgId: string, payee: Assignee, current: PayDefaultSubject[], options: { day: string; record: boolean }): Promise<CoverageSpan[]> {
  await ensurePayRuleSchema();
  const db = getPayrollDatabase();
  const key = [orgId, payee.type, payee.id];
  const spans: CoverageSpan[] = (await db.prepare("SELECT subject_type, subject_id, covered_from, covered_through FROM pay_layer_spans WHERE organization_id=? AND payee_type=? AND payee_id=?").all(...key))
    .map((row) => ({ subject: { type: String(row.subject_type), id: String(row.subject_id) } as PayDefaultSubject, from: String(row.covered_from || ""), through: String(row.covered_through || "") }));
  if (!current.length) return order(spans);
  const seenBefore = spans.length > 0;
  const now = nowIso();
  const open = new Map(spans.filter((span) => !span.through).map((span) => [defaultKey(span.subject), span]));
  for (const subject of current) {
    if (open.delete(defaultKey(subject))) continue;
    const span = { subject, from: seenBefore ? options.day : "", through: "" };
    // Taken away and given back on the same day: the span that ended yesterday simply continues.
    if (spans.some((entry) => defaultKey(entry.subject) === defaultKey(subject) && entry.from === span.from)) continue;
    spans.push(span);
    if (options.record) await db.prepare("INSERT INTO pay_layer_spans (organization_id, payee_type, payee_id, subject_type, subject_id, covered_from, covered_through, noted_at) VALUES (?, ?, ?, ?, ?, ?, '', ?)").run(...key, subject.type, subject.id, span.from, now);
  }
  for (const span of open.values()) {
    span.through = dayBefore(options.day);
    if (options.record) await db.prepare("UPDATE pay_layer_spans SET covered_through=?, noted_at=? WHERE organization_id=? AND payee_type=? AND payee_id=? AND subject_type=? AND subject_id=? AND covered_from=?").run(span.through, now, ...key, span.subject.type, span.subject.id, span.from);
  }
  // A span that ends before it starts (given and taken away between two refreshes on one day) never covered a day.
  return order(spans.filter((span) => !span.through || !span.from || span.from <= span.through));
}
const order = (spans: CoverageSpan[]) => [...spans].sort((a, b) => PAY_DEFAULT_SUBJECTS.indexOf(a.subject.type) - PAY_DEFAULT_SUBJECTS.indexOf(b.subject.type) || a.subject.id.localeCompare(b.subject.id) || a.from.localeCompare(b.from));

export type PayLayerOptions = {
  /** Replaces the payee's stored setup, for previews. */
  own?: Pick<PaySetup, "entries" | "distribution" | "schedules">;
  /** Defaults to use in place of the stored ones with the same subject, for previews. */
  defaults?: Pick<PayDefault, "subject" | "entries" | "distribution" | "schedules">[];
  /** The day "today" is when noticing that a subject started or stopped covering the payee. */
  day?: string;
  /** Remember what was noticed. Only a refresh that posts does. */
  record?: boolean;
  /** Give a payee with no record the organization and kind defaults. Only for choosing a schedule for an entry posted by hand. */
  unknownPayee?: "organization";
};
/**
 * A payee's pay, layer by layer: every default that covers or covered them, lowest first, then their own setup.
 * Several roles (or company types) are separate layers in order of id, so a later one can change what an earlier one
 * brought; rules that differ simply add up.
 */
export async function payLayersFor(orgId: string, payee: Assignee, own?: PayLayerOptions["own"], options: PayLayerOptions = {}): Promise<PayLayer[]> {
  const defaults = new Map<string, Pick<PayDefault, "subject" | "entries" | "distribution" | "schedules">>((await listPayDefaults(orgId)).map((entry) => [defaultKey(entry.subject), entry]));
  for (const entry of options.defaults || []) defaults.set(defaultKey(entry.subject), entry);
  const layers: PayLayer[] = [];
  for (const span of defaults.size ? await coverageSpans(orgId, payee, { day: options.day || today(), record: !!options.record, unknownPayee: options.unknownPayee }) : []) {
    const found = defaults.get(defaultKey(span.subject));
    if (found && (found.entries.length || found.distribution?.length || found.schedules?.length)) layers.push({
      source: span.subject, entries: found.entries as PaySetupEntry[], ...(found.distribution ? { distribution: found.distribution } : {}), ...(found.schedules ? { schedules: found.schedules } : {}),
      ...(span.from ? { covered_from: span.from } : {}), ...(span.through ? { covered_through: span.through } : {})
    });
  }
  const setup = own || options.own || await readPaySetup(orgId, payee);
  layers.push({ source: null, entries: setup.entries as PaySetupEntry[], ...(setup.distribution ? { distribution: setup.distribution } : {}), ...(setup.schedules ? { schedules: setup.schedules } : {}) });
  return layers;
}
type Covered = { covered_from?: string; covered_through?: string };
const covers = (layer: Covered, date: string) => (!layer.covered_from || layer.covered_from <= date) && (!layer.covered_through || date <= layer.covered_through);
/** How a group's earnings on one day reach people: the highest layer that says, else paid as one. */
export function distributionOn(layers: (Pick<PayLayer, "distribution"> & Covered)[], date: string): PayDistribution | null {
  for (let index = layers.length - 1; index >= 0; index--) {
    const found = covers(layers[index]!, date) ? versionOn(layers[index]!.distribution || [], date) : null;
    if (found) return found;
  }
  return null;
}

export type RuleSlot = { rule_id: string; definition_rule_id: string; params: Record<string, number | boolean | string> };
type Entries = Pick<PaySetup, "entries"> & Covered;
const asLayers = (value: Entries | Entries[]) => Array.isArray(value) ? value : [value];
const inSpan = (entry: { effective_from: string; effective_through?: string }, date: string) => entry.effective_from <= date && (!entry.effective_through || date <= entry.effective_through);

/**
 * Which schedule choice applies to one kind of earning on one day: the highest layer that says wins, and within a
 * layer a choice for the exact kind beats the catch-all. Among choices of the same kind in a layer the latest to
 * start wins. `source` is the default it came from, or null for the payee's own setup.
 */
export function scheduleChoiceOn(layers: (Pick<PayLayer, "schedules" | "source"> & Covered)[], date: string, earningKind = "*"): { choice: PayScheduleChoice; source: PayDefaultSubject | null } | null {
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index]!;
    if (!covers(layer, date)) continue;
    const active = (layer.schedules || []).filter((choice) => inSpan(choice, date));
    const latest = (kind: string) => active.filter((choice) => choice.earning_kind === kind).sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.entered_at.localeCompare(b.entered_at)).at(-1);
    const found = (earningKind !== "*" ? latest(earningKind) : undefined) || latest("*");
    if (found) return { choice: found, source: layer.source };
  }
  return null;
}
export type ResolvedPaySchedule = {
  schedule_id: string; earning_kind: string; timing_basis: string; clawback_cap_percent: number | null; effective_from: string; effective_through: string;
  /** The default the choice came from; null when it is the payee's own. */
  source: PayDefaultSubject | null;
  schedule: Awaited<ReturnType<typeof readPayrollSchedule>>;
};
/**
 * The pay schedule that pays one kind of a payee's earnings earned on a day (today when left out), with the
 * overrides the choice carries. An earning from a day before any choice had started is paid by today's choice, so
 * work done before a schedule was first chosen is not left without one. Null when no layer says. This is the one
 * answer to "when is this payee paid": the ledger, clawback caps, corrections and period timezones all ask here.
 * Reads only.
 */
export async function resolvePaySchedule(orgId: string, payee: Assignee, earningKind = "*", date = today(), layers?: PayLayer[]): Promise<ResolvedPaySchedule | null> {
  const from = layers || await payLayersFor(orgId, payee, undefined, { unknownPayee: "organization" });
  const found = scheduleChoiceOn(from, date, earningKind || "*") || (date < today() ? scheduleChoiceOn(from, today(), earningKind || "*") : null);
  if (!found) return null;
  const schedule = await readPayrollSchedule(orgId, found.choice.schedule_id).catch(() => null);
  if (!schedule) return null;
  return {
    schedule_id: schedule.id, earning_kind: found.choice.earning_kind, timing_basis: found.choice.timing_basis || "", clawback_cap_percent: found.choice.clawback_cap_percent ?? null,
    effective_from: found.choice.effective_from, effective_through: found.choice.effective_through || "", source: found.source, schedule
  };
}
/**
 * The rules that apply to a payee on one day. Plans and added rules bring
 * rules in, removals take them out, and overrides change parameters or swap
 * the formula. A rule keeps its own id as its slot even when its formula is
 * swapped, so what it earned before and after the swap is compared, not
 * paid twice. Layers are applied lowest first, so a payee's own entries can
 * add to, change or remove what a default brought; within a layer later
 * entries win over earlier ones of the same kind. A default counts only on
 * the days it covered the payee.
 */
export function effectiveRuleSlots(setup: Entries | Entries[], plans: Map<string, PayPlan>, date: string): Map<string, RuleSlot> {
  const slots = new Map<string, RuleSlot>();
  for (const layer of asLayers(setup)) {
    if (!covers(layer, date)) continue;
    const active = layer.entries.filter((entry) => inSpan(entry, date)).sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.entered_at.localeCompare(b.entered_at));
    for (const entry of active) if (entry.kind === "plan") {
      const version = versionOn(plans.get(entry.plan_id)?.versions || [], date);
      for (const ref of version?.rules || []) slots.set(ref.rule_id, { rule_id: ref.rule_id, definition_rule_id: ref.rule_id, params: { ...ref.params } });
    }
    for (const entry of active) if (entry.kind === "add") slots.set(entry.rule_id, { rule_id: entry.rule_id, definition_rule_id: entry.rule_id, params: { ...entry.params } });
    for (const entry of active) if (entry.kind === "override") {
      const slot = slots.get(entry.rule_id);
      if (slot) slots.set(entry.rule_id, { ...slot, definition_rule_id: entry.replacement_rule_id || slot.definition_rule_id, params: { ...slot.params, ...entry.params } });
    }
    for (const entry of active) if (entry.kind === "remove") slots.delete(entry.rule_id);
  }
  return slots;
}
/** Every rule a payee's layers could ever bring in, at any date: the slots a refresh has to look at. */
export function candidateRuleSlots(setup: Entries | Entries[], plans: Map<string, PayPlan>) {
  const entries = asLayers(setup).flatMap((layer) => layer.entries);
  const slots = new Map<string, Set<string>>();
  const add = (slot: string, definition = slot) => slots.set(slot, (slots.get(slot) || new Set<string>()).add(definition));
  for (const entry of entries) {
    if (entry.kind === "plan") for (const version of plans.get(entry.plan_id)?.versions || []) for (const ref of version.rules) add(ref.rule_id);
    if (entry.kind === "add") add(entry.rule_id);
  }
  for (const entry of entries) if (entry.kind === "override" && entry.replacement_rule_id && slots.has(entry.rule_id)) add(entry.rule_id, entry.replacement_rule_id);
  return slots;
}
/** Parameters as the formula sees them: the rule's defaults under what the plan and the payee set. */
export function resolvedParams(definition: Pick<PayRuleDefinition, "parameters">, set: RuleSlot["params"]) {
  const values: RuleSlot["params"] = {};
  for (const [name, declared] of Object.entries(definition.parameters)) if (declared.default !== undefined) values[name] = declared.default;
  for (const [name, value] of Object.entries(set)) if (Object.hasOwn(definition.parameters, name)) values[name] = value;
  return values;
}
