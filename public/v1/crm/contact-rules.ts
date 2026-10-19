import { z } from "zod";
import { badRequest, PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { validateConditions } from "../work/conditions.js";

// Contact automations (docs/architecture/crm.md, "Contact automations"). CRM settings saves these as the
// crm_contact_rules module and turns each into one organization rule (id contact_rule_<id>) on a contact
// event or a contact date. Nothing here acts on a contact: the engine runs the generated rules like any other,
// with `contact` in their conditions and {{contact.*}} in their inputs (work/engine.ts).

export const CONTACT_RULES_MODULE = "crm_contact_rules";
export const CONTACT_RULE_PREFIX = "contact_rule_";
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const id = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const ids = z.array(z.string().trim().min(1).max(160)).max(100).default([]);
const words = (max: number) => z.string().trim().max(max).default("");

const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(1600) }).strict(),
  z.object({ kind: z.literal("email"), subject: z.string().trim().min(1).max(300), text: z.string().trim().min(1).max(20000) }).strict(),
  z.object({ kind: z.literal("todo"), title: z.string().trim().min(1).max(300), message: words(4000), role_ids: ids, user_ids: ids, due_minutes: z.number().int().min(0).max(525600).default(0) }).strict(),
  z.object({ kind: z.literal("lead"), summary: words(2000), source_kind: words(80), role: words(80) }).strict()
]);

const trigger = z.object({
  /** created, updated (optionally when one field changes), tagged (optionally one tag), merged, or a date on the contact. */
  kind: z.enum(["created", "updated", "tagged", "merged", "date"]),
  tag: words(120),
  field: words(160),
  /** For a date: birthday or cf.<field>; days from the date to act (-14: two weeks before); yearly or once; the time of day. */
  date_field: words(160),
  offset_days: z.number().int().min(-365).max(365).default(0),
  yearly: z.boolean().default(true),
  time: z.string().trim().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).default("09:00")
}).strict();

const ruleSchema = z.object({
  id,
  title: z.string().trim().min(1).max(160),
  enabled: z.boolean().default(true),
  trigger,
  /** The one condition contract over `contact.<field>` (and payload.* for the event). */
  conditions: z.object({}).passthrough().default({}),
  actions: z.array(action).min(1).max(10)
}).strict();

const settingsSchema = z.object({ version: z.literal(1).default(1), rules: z.array(ruleSchema).max(100).default([]) }).strict();
export type ContactRulesSettings = z.infer<typeof settingsSchema>;
type ContactRule = z.infer<typeof ruleSchema>;

export function normalizeContactRules(value: unknown) {
  const settings = settingsSchema.parse({ ...object(value), version: 1 });
  const seen = new Set<string>();
  for (const rule of settings.rules) {
    if (seen.has(rule.id)) throw badRequest("contact_rule_duplicate", `Two contact automations are called "${rule.id}".`);
    seen.add(rule.id);
    const issues = validateConditions(rule.conditions, `contact automation "${rule.title}"`);
    if (issues.length) throw badRequest("contact_rule_conditions_invalid", issues[0]!, { issues });
    if (rule.trigger.kind === "date" && rule.trigger.date_field !== "birthday" && !/^cf\.[A-Za-z0-9_.-]+$/.test(rule.trigger.date_field)) {
      throw badRequest("contact_rule_date_field", `Choose the date "${rule.title}" follows: the birthday or a date field.`);
    }
  }
  return settings;
}

export async function readContactRules(orgId: string) {
  try { return normalizeContactRules((await readBranchModule(orgId, "default", CONTACT_RULES_MODULE)).data); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return normalizeContactRules({}); throw error; }
}

const EVENTS: Record<ContactRule["trigger"]["kind"], string> = { created: "contact.created", updated: "contact.updated", tagged: "contact.tagged", merged: "contact.merged", date: "contact.date" };

function ruleAction(entry: z.infer<typeof action>, index: number): JsonObject {
  const key = `${entry.kind}_${index + 1}`;
  if (entry.kind === "text") return { id: key, automation: "communications.sendSms.v1", input: { to: "{{contact.phone}}", text: entry.text }, conditions: { match: "all", rules: [{ field: "contact.phone", operator: "is_present" }] } };
  if (entry.kind === "email") return { id: key, automation: "communications.sendEmail.v1", input: { to: "{{contact.email}}", subject: entry.subject, text: entry.text }, conditions: { match: "all", rules: [{ field: "contact.email", operator: "is_present" }] } };
  if (entry.kind === "todo") return { id: key, automation: "work.createTodo.v1", input: { title: entry.title, message: entry.message, assigned_role_ids: entry.role_ids, assigned_user_ids: entry.user_ids, ...(entry.due_minutes ? { due_offset_minutes: entry.due_minutes } : {}) } };
  return { id: key, automation: "contacts.startLead.v1", input: { summary: entry.summary, ...(entry.source_kind ? { source_kind: entry.source_kind } : {}), ...(entry.role ? { role: entry.role } : {}) } };
}

/** The organization rules the settings stand for; every id starts with contact_rule_. */
export function contactRulesAsRules(settings: ContactRulesSettings): JsonObject[] {
  return settings.rules.map((rule) => {
    const t = rule.trigger;
    const extra: JsonObject[] = [];
    if (t.kind === "tagged" && t.tag) extra.push({ field: "payload.tag", operator: "equals", value: t.tag });
    if (t.kind === "updated" && t.field) extra.push({ field: "payload.changed_fields", operator: "contains", value: t.field });
    const own = object(rule.conditions);
    const conditions = extra.length ? { match: "all", rules: [...extra, ...(Array.isArray(own.rules) && own.rules.length ? [own] : [])] } : own;
    const [hour, minute] = t.time.split(":").map(Number);
    return {
      id: `${CONTACT_RULE_PREFIX}${rule.id}`,
      enabled: rule.enabled,
      title: rule.title,
      explainer: `Contact automation in CRM settings: ${rule.title}.`,
      ...(t.kind === "date"
        ? { schedule: { cron: `${minute} ${hour} * * *`, contact_date: { field: t.date_field, offset_days: t.offset_days, yearly: t.yearly } } }
        : { event: EVENTS[t.kind] }),
      conditions,
      actions: rule.actions.map(ruleAction)
    };
  });
}

/** Saves the settings and replaces the generated rules (and only those) in the organization's rules. */
export async function saveContactRules(orgId: string, value: unknown, authorUserId: string) {
  const settings = normalizeContactRules(object(value).data ?? value);
  await saveBranchModule(orgId, "default", CONTACT_RULES_MODULE, { data: settings, metadata: { kind: "crm_contact_rules" } }, { replace: true });
  const { readAutomationRules, saveAutomationRules } = await import("../work/rules.js");
  const current = await readAutomationRules(orgId, "default");
  const kept = current.rules.filter((rule) => !text(rule.id).startsWith(CONTACT_RULE_PREFIX));
  await saveAutomationRules(orgId, "default", { expected_revision: current.revision, rules: [...kept, ...contactRulesAsRules(settings)] }, { authorUserId });
  return settings;
}
