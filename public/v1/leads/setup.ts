import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema, PublicationContext } from "../platform/publication/contracts.js";
import { forbidden } from "../platform/errors.js";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { isCapabilityEnabled, rawCapabilityValues, saveCapabilityValues } from "../platform/capabilities.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { readIntakeRouting, saveIntakeRouting } from "../scopes/router.js";
import { readAutomationRules, saveAutomationRules } from "../work/rules.js";
import { CONTACT_METHODS, NO_ANSWER_ACTIONS, SUGGESTED_QUESTIONS, manualLeadFlow, newLeadFlow, type NewLeadAnswers } from "../flows/new-lead.js";

/**
 * The leads setup (docs/architecture/flows.md, "The leads setup"): setup steps asked once, the first time someone opens
 * the CRM or the Automations Hub. It asks how the company handles a new lead, never how to configure anything, and
 * makes what that needs: the lead sources turned on, new leads arriving as new leads (intake routing's default
 * `unscoped`), the new-lead flow (a call script, or a first text or email) that the New Leads call list plays, and the
 * New menu with New › Lead. Each part is saved by `leads.setup.save` as the person; the answers are kept in the default
 * branch's `lead_setup` module and read through the `lead-setup` provider (`status`).
 */
export const LEAD_SETUP_MODULE = "lead_setup";
export const NEW_LEAD_FLOW_ID = "new_lead_call";
export const MANUAL_LEAD_FLOW_ID = "new_lead";
const QUEUE_RULE = "platform_queue_new_lead_calls";
const SOURCES = ["website", "email", "services", "phone"] as const;
const MENU_ITEMS = /^(lead|project|contact|report|document|payment|appointment|doc:[a-z0-9_]+|form:[A-Za-z0-9_-]+|flow:[A-Za-z0-9_.-]+)$/;

const question = z.object({ key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(200), input: z.enum(["text", "paragraph", "number", "select", "multi", "yes_no", "date", "address", "phone", "email"]).default("text"),
  options: z.array(z.object({ id: z.string().trim().regex(/^[a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(120) }).strict()).max(20).default([]), saves_to: z.string().trim().max(120).optional() }).strict();
export const saveSchema = z.discriminatedUnion("part", [
  z.object({ part: z.literal("sources"), sources: z.array(z.enum(SOURCES)).max(SOURCES.length) }).strict(),
  z.object({ part: z.literal("contact"), method: z.enum([...CONTACT_METHODS, "none"]) }).strict(),
  z.object({ part: z.literal("no_answer"), actions: z.array(z.enum(NO_ANSWER_ACTIONS)).max(3) }).strict(),
  z.object({ part: z.literal("questions"), questions: z.array(question).max(20) }).strict(),
  z.object({ part: z.literal("script"), definition: z.record(z.unknown()).optional() }).strict(),
  z.object({ part: z.literal("new_menu"), items: z.array(z.string().trim().regex(MENU_ITEMS)).min(1).max(16) }).strict()
]);
type SaveInput = z.infer<typeof saveSchema>;
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;

async function readAnswers(orgId: string): Promise<JsonObject> {
  try { return object((await readBranchModule(orgId, "default", LEAD_SETUP_MODULE)).data); } catch { return {}; }
}
async function writeAnswers(orgId: string, patch: JsonObject, userId: string) {
  let revision: number | undefined;
  let data: JsonObject = {};
  try { const module = await readBranchModule(orgId, "default", LEAD_SETUP_MODULE); data = object(module.data); revision = Number(module.revision) || undefined; } catch { /* first answer */ }
  await saveBranchModule(orgId, "default", LEAD_SETUP_MODULE, { ...(revision ? { expected_revision: revision } : {}), data: { ...data, ...patch, updated_at: new Date().toISOString(), updated_by: userId },
    metadata: { kind: "lead_setup" } }, { replace: true });
}

/** The answers in the shape the new-lead flow builder takes; what is unanswered is the default (call, text on no answer). */
export function flowAnswers(answers: JsonObject, boardId: string): NewLeadAnswers {
  const method = text(answers.contact);
  return {
    contact: (CONTACT_METHODS as readonly string[]).includes(method) ? method as NewLeadAnswers["contact"] : "call",
    no_answer: Array.isArray(answers.no_answer) ? answers.no_answer.map(text).filter((entry) => (NO_ANSWER_ACTIONS as readonly string[]).includes(entry)) as NewLeadAnswers["no_answer"] : ["text", "retry"],
    questions: Array.isArray(answers.questions) ? answers.questions as NewLeadAnswers["questions"] : SUGGESTED_QUESTIONS,
    board_id: boardId
  };
}

/** Where the setup stands and what it would make: the answers, the lead sources, the flow the answers make, the New menu. */
export async function leadSetupStatus(ctx: PublicationContext) {
  const orgId = ctx.organizationId;
  const answers = await readAnswers(orgId);
  const routing = await readIntakeRouting(orgId, "default");
  const [lead_import, email, website, values] = await Promise.all([isCapabilityEnabled(orgId, "platform.lead_import"), isCapabilityEnabled(orgId, "email.inbound_lead_import"),
    isCapabilityEnabled(orgId, "platform.website_embed_import"), rawCapabilityValues(orgId)]);
  let inbox = "";
  if (lead_import && email) { try { inbox = text(object((await readBranchModule(orgId, "default", "lead_import")).data).inbound_email); } catch { /* none yet */ } }
  const contact = text(answers.contact);
  const { readHead } = await import("../flows/storage.js");
  const flowHead = await readHead(orgId, NEW_LEAD_FLOW_ID);
  return {
    answers,
    answered: {
      sources: Array.isArray(answers.sources),
      contact: !!contact,
      no_answer: !!contact && (contact !== "call" || Array.isArray(answers.no_answer)),
      questions: !!contact && (contact === "none" || Array.isArray(answers.questions)),
      script: !!contact && (contact === "none" || !!answers.script_saved_at),
      new_menu: Array.isArray(answers.new_menu)
    },
    sources: { lead_inbox: { on: lead_import && email, address: inbox }, website_forms: { on: lead_import && website } },
    routing: { default_entry: routing.default_entry, default_template_id: routing.default_template_id },
    suggested_questions: SUGGESTED_QUESTIONS,
    flow: contact === "none" ? null : newLeadFlow(flowAnswers(answers, routing.default_template_id)),
    flow_id: NEW_LEAD_FLOW_ID, flow_saved: !!flowHead,
    new_menu: { mode: text(values["platform.new_button_mode"]), items: text(values["platform.new_button_items"]).split(",").map(text).filter(Boolean) }
  };
}

function person(ctx: PublicationContext): PlatformAuthContext {
  if (!ctx.auth || ctx.auth.orgId !== ctx.organizationId || !hasPermission(ctx.auth, "manage_company_settings")) throw forbidden("lead_setup_denied", "Company settings access is required to set up leads.");
  return ctx.auth;
}

/** The New Leads call list plays the new-lead flow: the queue rule names it (list metadata `flow_id`). */
async function queueRule(orgId: string, flowId: string | null) {
  const { rules, revision } = await readAutomationRules(orgId, "default");
  const next = rules.map((rule) => {
    if (text(rule.id) !== QUEUE_RULE) return rule;
    const input = object(rule.input), list = object(input.list), metadata = { ...object(list.metadata) };
    if (flowId) metadata.flow_id = flowId; else delete metadata.flow_id;
    return { ...rule, input: { ...input, list: { ...list, metadata } } };
  });
  await saveAutomationRules(orgId, "default", { rules: next, expected_revision: revision });
}

export async function saveLeadSetup(ctx: PublicationContext, value: unknown) {
  const auth = person(ctx);
  const orgId = ctx.organizationId;
  const input: SaveInput = saveSchema.parse(value);
  const answers = await readAnswers(orgId);
  if (input.part === "sources") {
    // Turning a source on is what the answer means; the inbox address is made with it.
    const on: Record<string, boolean> = {};
    if (input.sources.includes("email")) Object.assign(on, { "platform.lead_import": true, "email.inbound_lead_import": true });
    if (input.sources.includes("website")) Object.assign(on, { "platform.lead_import": true, "platform.website_embed_import": true, "lead_forms.contact_form": true });
    if (Object.keys(on).length) await saveCapabilityValues(orgId, on);
    if (input.sources.includes("email")) await (await import("../email/api.js")).ensureLeadImportSettings(orgId, "default");
    await writeAnswers(orgId, { sources: input.sources }, auth.userId);
  } else if (input.part === "contact") {
    await writeAnswers(orgId, { contact: input.method }, auth.userId);
    // New leads arrive as new leads unless the company treats them like any project (the board's first step).
    const routing = await readIntakeRouting(orgId, "default");
    const { revision, updated_at: _updated, ...data } = routing;
    await saveIntakeRouting(orgId, "default", { expected_revision: revision, data: { ...data, default_entry: input.method === "none" ? "scope" : "unscoped" } });
    if (input.method === "none") await queueRule(orgId, null);
  } else if (input.part === "no_answer") {
    await writeAnswers(orgId, { no_answer: input.actions }, auth.userId);
  } else if (input.part === "questions") {
    await writeAnswers(orgId, { questions: input.questions }, auth.userId);
  } else if (input.part === "script") {
    // The script the answers made, as the person left it in the setup (edited or not), saved as the org's flow.
    const routing = await readIntakeRouting(orgId, "default");
    const definition = input.definition || newLeadFlow(flowAnswers(answers, routing.default_template_id));
    const { saveFlow, readFlow } = await import("../flows/service.js");
    const current = await readFlow(orgId, NEW_LEAD_FLOW_ID, { latest: true }).catch(() => null);
    await saveFlow(auth, { id: NEW_LEAD_FLOW_ID, definition, publish: true, ...(current ? { expected_version: current.version } : {}) });
    await queueRule(orgId, NEW_LEAD_FLOW_ID);
    await writeAnswers(orgId, { script_saved_at: new Date().toISOString() }, auth.userId);
  } else {
    // The New menu, in the order given. `lead` is New › Lead: the manual lead flow, made or switched on and off here.
    const { saveFlow, readFlow } = await import("../flows/service.js");
    const wantsLead = input.items.includes("lead");
    const manual = await readFlow(orgId, MANUAL_LEAD_FLOW_ID, { latest: true }).catch(() => null);
    const questions = flowAnswers(answers, "").questions;
    const definition = manual ? { ...manual.definition } : manualLeadFlow(questions);
    const entry = { ...object(object(definition.entry).new_menu), enabled: wantsLead, label: text(object(object(definition.entry).new_menu).label) || "Lead", icon: "fa-user-plus", role_ids: [], sort_order: 0 };
    if (manual || wantsLead) await saveFlow(auth, { id: MANUAL_LEAD_FLOW_ID, definition: { ...definition, entry: { ...object(definition.entry), new_menu: entry } }, publish: true, ...(manual ? { expected_version: manual.version } : {}) });
    const items = input.items.map((item) => item === "lead" ? `flow:${MANUAL_LEAD_FLOW_ID}` : item);
    await saveCapabilityValues(orgId, { "platform.new_button_mode": "selector", "platform.new_button_items": [...new Set(items)].join(",") });
    await writeAnswers(orgId, { new_menu: input.items }, auth.userId);
  }
  return leadSetupStatus(ctx);
}

const readAccess: AccessPolicy = { scopes: ["organization"], permissions: ["view_projects"], systemKinds: ["module", "agent"] };
let registered = false;
export function registerLeadSetupPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "lead-setup", version: "1", apps: ["crm"], exports: {
    status: { description: "How the company handles new leads, as the leads setup asked it (where leads come in, how they contact a new lead: call, text, email or none, what happens on no answer, what they ask), which parts are answered, the lead sources that are on (the lead inbox address), the new-lead flow those answers make, and the New menu.",
      schema: { type: "object" }, schemaVersion: "1", access: readAccess, read: async (ctx) => ({ value: await leadSetupStatus(ctx) }) }
  } });
  registerAction({ id: "leads.setup.save", version: "1", domain: "leads", implementation: backendImplementationDigest(),
    description: "Save one part of the leads setup and make what it needs: sources (turns on the lead inbox and website forms), contact (call, text, email, or none: none puts new leads straight onto the board, otherwise they arrive as new leads), no_answer (text, email, retry), questions (what to ask), script (saves the new-lead flow, as given or as the answers make it, and has the New Leads call list play it), new_menu (the New menu's items in order; `lead` is New › Lead).",
    inputSchema: json(saveSchema) as Record<string, unknown>, outputSchema: { type: "object" }, effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    validateInput: (value) => { saveSchema.parse(value); },
    execute: (ctx, _target, value) => saveLeadSetup(ctx, value) });
}
