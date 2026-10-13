import { z } from "zod";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { ASSIGNEE_TYPES, requireAssignee, type Assignee } from "../labor/assignees.js";
import { normalizeSelection } from "../platform/publication/select.js";
import { contentHash as hashJson } from "../platform/publication/validation.js";
import { getPayrollDatabase, nowIso, type JsonObject } from "./storage.js";

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
  /** Named numbers and switches a plan or a payee can set without changing the rule. */
  parameters: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), z.object({ label: z.string().max(200).optional(), default: paramValue.optional() }).strict()).default({}),
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
export const paySetupSaveSchema = z.object({
  payee: payeeSchema,
  entries: z.array(paySetupEntrySchema).max(200),
  expected_revision: z.number().int().nonnegative().optional()
}).strict();

type Stamp = { entered_at: string; entered_by: string };
export type PayRuleVersion = Stamp & { version: string; effective_from: string; definition: PayRuleDefinition };
export type PayRule = { id: string; name: string; description: string; status: "active" | "archived"; versions: PayRuleVersion[]; revision: number };
export type PayPlanVersion = Stamp & { effective_from: string; rules: z.infer<typeof ruleRef>[] };
export type PayPlan = { id: string; name: string; description: string; status: "active" | "archived"; versions: PayPlanVersion[]; revision: number };
export type PaySetupEntry = z.infer<typeof paySetupEntrySchema> & Stamp & { id: string };
export type PaySetup = { payee: Assignee; entries: PaySetupEntry[]; revision: number };
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
      `);
    })();
    ensured.set(db, ready);
    ready.catch(() => ensured.delete(db));
  }
  return ready;
}

type Kind = "rule" | "plan" | "setup";
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

export async function savePayRule(orgId: string, input: unknown, actor: Actor): Promise<PayRule> {
  const parsed = payRuleSaveSchema.parse(input);
  const ruleId = parsed.id || slug(parsed.name, "rule");
  const current = await readRow<Omit<PayRule, "revision">>(orgId, "rule", ruleId) as PayRule | null;
  const version: PayRuleVersion = {
    version: contentHash(parsed.definition), effective_from: parsed.effective_from || today(),
    definition: parsed.definition, entered_at: nowIso(), entered_by: actor.userId
  };
  const data = { id: ruleId, name: parsed.name, description: parsed.description || "", status: "active" as const, versions: withVersion(current?.versions || [], version) };
  return { ...data, revision: await writeRow(orgId, "rule", ruleId, data, parsed.expected_revision, current?.revision ?? null) };
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
export async function savePayPlan(orgId: string, input: unknown, actor: Actor): Promise<PayPlan> {
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
  return { ...data, revision: await writeRow(orgId, "plan", planId, data, parsed.expected_revision, current?.revision ?? null) };
}
export async function archivePayPlan(orgId: string, input: unknown) {
  const parsed = z.object({ id, expected_revision: z.number().int().nonnegative().optional() }).strict().parse(input);
  return archive(orgId, "plan", parsed.id, await readPayPlan(orgId, parsed.id), parsed.expected_revision);
}

/** Checks a setup against the rules and plans that exist and stamps who entered each new or changed entry, and when. */
export async function normalizePaySetup(orgId: string, input: unknown, actor: Actor, current: PaySetup): Promise<PaySetup> {
  const parsed = paySetupSaveSchema.parse(input);
  const rules = new Set((await listPayRules(orgId)).map((rule) => rule.id));
  const plans = new Set((await listPayPlans(orgId)).map((plan) => plan.id));
  const previous = new Map(current.entries.map((entry) => [entry.id, entry]));
  const entries = parsed.entries.map((entry) => {
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
  return { payee: parsed.payee, entries, revision: current.revision };
}
export async function savePaySetup(orgId: string, input: unknown, actor: Actor): Promise<PaySetup> {
  const parsed = paySetupSaveSchema.parse(input);
  await requireAssignee(orgId, parsed.payee);
  const current = await readPaySetup(orgId, parsed.payee);
  const next = await normalizePaySetup(orgId, parsed, actor, current);
  const data = { payee: next.payee, entries: next.entries };
  return { ...data, revision: await writeRow(orgId, "setup", payeeKey(parsed.payee), data, parsed.expected_revision, current.revision || null) };
}

export type RuleSlot = { rule_id: string; definition_rule_id: string; params: Record<string, number | boolean | string> };
const inSpan = (entry: { effective_from: string; effective_through?: string }, date: string) => entry.effective_from <= date && (!entry.effective_through || date <= entry.effective_through);
/**
 * The rules that apply to a payee on one day. Plans and added rules bring
 * rules in, removals take them out, and overrides change parameters or swap
 * the formula. A rule keeps its own id as its slot even when its formula is
 * swapped, so what it earned before and after the swap is compared, not
 * paid twice. Later entries win over earlier ones of the same kind.
 */
export function effectiveRuleSlots(setup: Pick<PaySetup, "entries">, plans: Map<string, PayPlan>, date: string): Map<string, RuleSlot> {
  const active = setup.entries.filter((entry) => inSpan(entry, date)).sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.entered_at.localeCompare(b.entered_at));
  const slots = new Map<string, RuleSlot>();
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
  return slots;
}
/** Every rule a setup could ever bring in, at any date: the slots a refresh has to look at. */
export function candidateRuleSlots(setup: Pick<PaySetup, "entries">, plans: Map<string, PayPlan>) {
  const slots = new Map<string, Set<string>>();
  const add = (slot: string, definition = slot) => slots.set(slot, (slots.get(slot) || new Set<string>()).add(definition));
  for (const entry of setup.entries) {
    if (entry.kind === "plan") for (const version of plans.get(entry.plan_id)?.versions || []) for (const ref of version.rules) add(ref.rule_id);
    if (entry.kind === "add") add(entry.rule_id);
  }
  for (const entry of setup.entries) if (entry.kind === "override" && entry.replacement_rule_id && slots.has(entry.rule_id)) add(entry.rule_id, entry.replacement_rule_id);
  return slots;
}
/** Parameters as the formula sees them: the rule's defaults under what the plan and the payee set. */
export function resolvedParams(definition: PayRuleDefinition, set: RuleSlot["params"]) {
  const values: RuleSlot["params"] = {};
  for (const [name, declared] of Object.entries(definition.parameters)) if (declared.default !== undefined) values[name] = declared.default;
  for (const [name, value] of Object.entries(set)) if (Object.hasOwn(definition.parameters, name)) values[name] = value;
  return values;
}
