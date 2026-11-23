import { z } from "zod";
import { validateConditions } from "../work/conditions.js";

/**
 * Flows (docs/architecture/flows.md): one definition for call scripts, workflows and (phase 3) website forms.
 * A flow is steps of blocks; a run plays it one step at a time on the server. Capability is added as a block
 * kind (this file and engine.ts), never as a mode: `kind` only says whether the call surface wraps it.
 */
const id = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/, "Use letters, numbers, dots, dashes and underscores.");
const label = (max = 200) => z.string().trim().max(max).default("");
const conditions = z.unknown().superRefine((value, ctx) => {
  for (const issue of validateConditions(value, "when")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});

export const FLOW_KINDS = ["call", "workflow"] as const;
export const FLOW_AUDIENCES = ["staff", "public"] as const;
/** Input kinds match the form item kinds so website forms rebuild onto them (phase 3). */
export const ASK_INPUTS = ["text", "paragraph", "number", "money", "select", "multi", "yes_no", "date", "phone", "email", "address"] as const;
export const BUTTONS = ["open_project", "open_contact", "go_to", "restart", "start_flow", "close"] as const;
/** Where an answer is written when its step is left: a contact or project field, or a custom field (`cf.<path>`). */
export const SAVES_TO = /^(contact|project)\.(cf\.[A-Za-z0-9_.-]+|name|first_name|last_name|email|phone|address|title|summary|notes)$/;

const option = z.object({ id, label: label(120), to: id.optional(), outcome: id.optional() }).strict();
const automation = z.object({
  automation: z.string().trim().min(1).max(120),
  input: z.record(z.unknown()).default({}),
  when: conditions.optional(),
  explainer: label(300)
}).strict();

const base = { id, label: label(300) };
export const blockSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("say"), text: z.string().trim().max(4000) }).strict(),
  z.object({ ...base, kind: z.literal("note"), text: z.string().trim().max(4000) }).strict(),
  z.object({ ...base, kind: z.literal("ask"), key: id, input: z.enum(ASK_INPUTS).default("text"), options: z.array(option).max(60).default([]),
    required: z.boolean().default(false), placeholder: label(200), saves_to: z.string().trim().regex(SAVES_TO).optional() }).strict(),
  z.object({ ...base, kind: z.literal("choice"), key: id, options: z.array(option).min(1).max(20), required: z.boolean().default(true) }).strict(),
  z.object({ ...base, kind: z.literal("contact"), mode: z.enum(["find", "create", "find_or_create"]).default("find_or_create"),
    from: z.record(z.string().trim().max(200)).default({}) }).strict(),
  z.object({ ...base, kind: z.literal("project"), mode: z.enum(["find", "create_lead", "create_project", "find_or_create_lead"]).default("create_lead"),
    from: z.record(z.string().trim().max(200)).default({}), template_id: z.string().trim().max(120).optional() }).strict(),
  z.object({ ...base, kind: z.literal("action"), ...automation.shape, preview: label(2000) }).strict(),
  z.object({ ...base, kind: z.literal("outcome"), outcome: id }).strict(),
  z.object({ ...base, kind: z.literal("buttons"), buttons: z.array(z.object({ kind: z.enum(BUTTONS), label: label(80), target: z.string().trim().max(500).default("") }).strict()).min(1).max(6),
    auto: z.enum(BUTTONS).optional() }).strict()
]);
export type FlowBlock = z.infer<typeof blockSchema>;

const next = z.union([id, z.null(), z.object({ branches: z.array(z.object({ when: conditions, to: id }).strict()).max(20), otherwise: id.nullable().default(null) }).strict()]);
export const stepSchema = z.object({ id, title: label(200), blocks: z.array(blockSchema).max(40).default([]), next: next.default(null) }).strict();
export type FlowStep = z.infer<typeof stepSchema>;
/** A call's wrap-up results (comms/calls wrap-up). A `call` flow's outcome names the one it means; see `callResultForOutcome`. */
export const CALL_DISPOSITIONS = ["answered", "voicemail", "no_answer", "busy", "wrong_number", "callback", "do_not_call", "technical_failure"] as const;
export const CALL_NEXT_ACTIONS = ["none", "complete", "follow_up", "scheduled"] as const;
export const outcomeSchema = z.object({ id, label: label(120), color: z.string().trim().max(20).default("#667085"), effects: z.array(automation).max(12).default([]),
  /** On the call surface: the wrap-up this outcome pre-fills. Unset falls back to the outcome id's usual meaning. */
  call: z.object({ disposition: z.enum(CALL_DISPOSITIONS).optional(), next_action: z.enum(["none", "complete"]).optional() }).strict().optional() }).strict();
export type FlowOutcome = z.infer<typeof outcomeSchema>;

/** The industry-default reading of common outcome ids, used when an outcome does not say which call result it is. */
const DISPOSITION_BY_OUTCOME: Record<string, (typeof CALL_DISPOSITIONS)[number]> = {
  ready: "answered", booked: "answered", appointment: "answered", interested: "answered", answered: "answered", not_interested: "answered",
  call_back: "callback", callback: "callback", no_answer: "no_answer", voicemail: "voicemail", busy: "busy",
  not_a_lead: "wrong_number", wrong_number: "wrong_number", do_not_call: "do_not_call"
};
/** The call wrap-up an outcome pre-fills: its own `call` mapping, else the default for its id; no disposition when neither says. */
export function callResultForOutcome(outcome: Pick<FlowOutcome, "id"> & { call?: FlowOutcome["call"] }) {
  return { disposition: outcome.call?.disposition || DISPOSITION_BY_OUTCOME[outcome.id] || "", next_action: outcome.call?.next_action || "none" };
}

const entry = z.object({ enabled: z.boolean().default(false), label: label(60), icon: z.string().trim().max(60).default(""), role_ids: z.array(z.string().trim().max(120)).max(40).default([]), sort_order: z.number().int().default(0) }).strict();
export const flowDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: label(1000),
  icon: z.string().trim().max(60).default("fa-diagram-project"),
  color: z.string().trim().max(20).default("#2563eb"),
  kind: z.enum(FLOW_KINDS).default("workflow"),
  audience: z.enum(FLOW_AUDIENCES).default("staff"),
  start: id,
  steps: z.array(stepSchema).min(1).max(80),
  outcomes: z.array(outcomeSchema).max(30).default([]),
  entry: z.object({ new_menu: entry.optional(), project: entry.optional(), contact: entry.optional() }).strict().default({}),
  metadata: z.record(z.unknown()).default({})
}).strict().superRefine((flow, ctx) => {
  const steps = new Set<string>(), outcomes = new Set(flow.outcomes.map((outcome) => outcome.id));
  for (const step of flow.steps) {
    if (steps.has(step.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step "${step.id}" is used twice.` });
    steps.add(step.id);
  }
  if (!steps.has(flow.start)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `The flow starts at "${flow.start}", which is not a step.` });
  const step = (to: string | null | undefined, where: string) => { if (to && !steps.has(to)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where} goes to "${to}", which is not a step.` }); };
  const outcome = (to: string | undefined, where: string) => { if (to && !outcomes.has(to)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where} ends with "${to}", which is not an outcome.` }); };
  const keys = new Set<string>();
  for (const entry of flow.steps) {
    const next = entry.next;
    if (typeof next === "string") step(next, `Step "${entry.id}"`);
    else if (next) { next.branches.forEach((branch) => step(branch.to, `Step "${entry.id}"`)); step(next.otherwise, `Step "${entry.id}"`); }
    const blocks = new Set<string>();
    for (const block of entry.blocks) {
      if (blocks.has(block.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Step "${entry.id}" uses block id "${block.id}" twice.` });
      blocks.add(block.id);
      if (block.kind === "ask" || block.kind === "choice") {
        if (keys.has(block.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `The answer "${block.key}" is asked twice.` });
        keys.add(block.key);
        block.options.forEach((choice) => { step(choice.to, `"${block.label || block.key}"`); outcome(choice.outcome, `"${block.label || block.key}"`); });
      }
      if (block.kind === "outcome") outcome(block.outcome, `Step "${entry.id}"`);
    }
  }
  if (flow.audience === "public" && flow.steps.some((entry) => entry.blocks.some((block) => ["contact", "project", "action", "outcome"].includes(block.kind))))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A public flow cannot find, create or run actions yet (phase 3)." });
});
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

export const runSourceSchema = z.object({
  kind: z.enum(["new_menu", "project", "contact", "crm", "call", "call_list_entry", "automation", "setup_preview", "manual"]).default("manual"),
  project_id: z.string().trim().max(160).optional(),
  contact_id: z.string().trim().max(160).optional(),
  call_id: z.string().trim().max(160).optional(),
  entry_id: z.string().trim().max(160).optional()
}).strict();
