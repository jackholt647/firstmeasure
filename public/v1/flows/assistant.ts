// Flows in the shared FirstMate assistant (docs/architecture/flows.md, docs/architecture/global-assistant.md).
//
// There is no flows agent. The global assistant gets these tools, so "add a question about the roof's age to my new
// lead script" works from the dock, a side chat or a flow editor. An editor's chat column is the same assistant in a
// private conversation whose subject is the flow (`flow:<id>`), which adds the flow as context and says the editor is
// already showing it.

import { createAgentThread, getAgentsDatabase } from "../agents/storage.js";
import type { AgentRun, AgentTool } from "../agents/types.js";
import { cleanText, errorMessage, parseJsonArg, toolError, type JsonObject } from "../agents/util.js";
import { requireCapability, type PlatformAuthContext } from "../platform/auth.js";
import { forbidden } from "../platform/errors.js";
import { ASK_INPUTS, BUTTONS, flowDefinitionSchema } from "./contracts.js";
import { canEditFlows, flowActions, listFlows, readFlow, saveFlow } from "./service.js";

const SUBJECT = "flow:";

const GUIDE = `A flow is a call script or a workflow: steps a person goes through to say things, ask things and do things, with branches.
Definition: { name, description, icon, color, kind: "call"|"workflow", audience: "staff", start: <step id>, steps, outcomes, entry: { new_menu?: { enabled, label, icon, role_ids, sort_order } }, metadata }.
- steps: [{ id, title, blocks, next }]. next is a step id, null (the flow ends there), or { branches: [{ when, to }], otherwise }.
- blocks (each has a unique id within its step):
  - { kind: "say", text }: words to read out (a call) or show (a workflow). Templates: {{contact.first_name}}, {{contact.name}}, {{user.first_name}}, {{organization.name}}, {{answers.<key>}}.
  - { kind: "note", text }: guidance for the person, never said to the customer.
  - { kind: "ask", key, label, input: ${ASK_INPUTS.join("|")}, options: [{ id, label }], required, placeholder, saves_to?, min?, max? }: an input. key is the variable the answer is stored as (lowercase snake_case, unique in the flow). saves_to writes it to a field: contact.<name|first_name|last_name|email|phone|address|cf.path> or project.<title|summary|notes|address|cf.path>.
  - { kind: "choice", key, label, options: [{ id, label, to?: <step id>, outcome?: <outcome id> }] }: the buttons that decide where the flow goes. At most one per step. A step with no choice uses its next.
  - { kind: "contact", mode: find|create|find_or_create, from: { name: "answers.name", phone: "answers.phone", email: "answers.email" } }
  - { kind: "project", mode: find|create_lead|create_project, from: { address: "answers.address" } }
  - { kind: "action", label, automation, input, preview, explainer, when? }: runs when the step is left. preview is what the person sees (a text message's words).
  - { kind: "outcome", outcome }: ends the flow with that outcome.
  - { kind: "buttons", buttons: [{ kind: ${BUTTONS.join("|")}, label, target }] }: the end screen.
- outcomes: [{ id, label, color, effects: [{ automation, input }] }]. scopes.activateTemplate.v1 { template_id } starts a board; sales.markLost.v1 { reason } marks the lead lost.
Keep step ids, block ids and answer keys stable when editing; add new ones for new things. Prefer short steps: a few lines and one or two inputs each.`;

export const flowsInstructions = `## Flows (call scripts and workflows)
A flow is a call script or a step-by-step workflow (the new lead call, New > Lead, any custom one). Use flows_list to find one and flows_get to read it; call flows_guide before your first edit. Change a flow with flows_save, always submitting the COMPLETE definition built from the current one, keeping existing ids and answer keys. Saving publishes it: new runs use it at once; runs already started keep their version. Describe changes in plain language, never as JSON or ids.`;

function auth(run: AgentRun): PlatformAuthContext {
  if (!run.ctx) throw forbidden("flows_user", "A signed-in user is required to work with flows.");
  return run.ctx;
}

function tool(name: string, description: string, properties: JsonObject, required: string[], write: boolean, execute: AgentTool["execute"]): AgentTool {
  return {
    name, description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    permission: "manage_company_settings|manage_communications",
    ...(write ? { gate: (run: AgentRun) => run.settings.allow_actions === false || run.scratch.actionsAllowed === false ? "Assistant actions are disabled." : true as const } : { publication: { effect: "read" as const } }),
    async execute(run, args, key) {
      try { return await execute(run, args, key); } catch (error) { return toolError(errorMessage(error)); }
    }
  };
}
const string = { type: "string" };

export const flowsTools: AgentTool[] = [
  tool("flows_list", "List this company's flows (call scripts and workflows) with their kind and whether they are in the New menu.", {}, [], false, async (run) => ({
    flows: (await listFlows(auth(run))).map((flow) => ({ flow_id: flow.id, name: flow.name, kind: flow.kind, description: flow.description, version: flow.latest_version, in_new_menu: (flow.entry as JsonObject)?.new_menu ? ((flow.entry as JsonObject).new_menu as JsonObject).enabled === true : false }))
  })),
  tool("flows_guide", "The flow definition format, every block kind, and the automations an action block or outcome may run. Call before building or editing a flow.", {}, [], false, async () => ({
    guide: GUIDE, automations: flowActions().map((action) => ({ automation: action.id, title: action.title, description: action.description }))
  })),
  tool("flows_get", "Read one flow: its newest definition and version.", { flow_id: string }, ["flow_id"], false, async (run, args) => {
    const flow = await readFlow(auth(run).orgId, cleanText(args.flow_id), { latest: true });
    return { flow_id: flow.id, name: flow.name, kind: flow.kind, version: flow.version, definition: flow.definition };
  }),
  tool("flows_save", "Validate and save a COMPLETE replacement definition for a flow (new id to create one). Start from flows_get and submit the whole definition, never a fragment. Returns validation errors to fix.", { flow_id: string, definition: { type: "string", description: "The full flow definition as a JSON string." }, change_note: { type: "string", description: "One plain-language sentence describing the change." } }, ["flow_id", "definition"], true, async (run, args) => {
    const ctx = auth(run);
    if (!canEditFlows(ctx)) return toolError("Editing flows needs company settings or communications access.");
    const parsed = flowDefinitionSchema.safeParse(parseJsonArg(args.definition, "definition"));
    if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 14).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
    const id = cleanText(args.flow_id);
    const current = await readFlow(ctx.orgId, id, { latest: true }).catch(() => null);
    const saved = await saveFlow(ctx, { id, definition: parsed.data, ...(current ? { expected_version: current.version } : {}) });
    run.changeLog.push(cleanText(args.change_note) || `Updated the flow "${saved.name}".`);
    return { ok: true, flow_id: saved.id, version: saved.version };
  })
];

/** One private assistant conversation per user and flow, like the form editor's. */
export async function ensureFlowConversation(ctx: PlatformAuthContext, flowId: string) {
  if (!canEditFlows(ctx)) throw forbidden("flows_edit_denied", "Editing flows needs company settings or communications access.");
  await requireCapability(ctx, "apps.assistant");
  const flow = await readFlow(ctx.orgId, flowId, { latest: true });
  const subject = `${SUBJECT}${flow.id}`;
  return getAgentsDatabase().transaction(async (database) => {
    const existing = await database.prepare("SELECT * FROM agent_threads WHERE agent_id=? AND organization_id=? AND created_by_user_id=? AND subject_id=? ORDER BY created_at LIMIT 1")
      .get("assistant", ctx.orgId, ctx.userId, subject);
    return existing || createAgentThread({ agent_id: "assistant", organization_id: ctx.orgId, branch_id: ctx.branchId || "default", subject_id: subject, title: `Flow: ${flow.name}`.slice(0, 80), created_by_user_id: ctx.userId });
  }, `flow-thread:${ctx.orgId}:${ctx.userId}:${flow.id}`);
}

/** Prompt context for a flow conversation. Also the access check for its thread. */
export async function flowConversationContext(ctx: PlatformAuthContext | null, subject: string) {
  if (!subject.startsWith(SUBJECT)) return "";
  if (!ctx) throw forbidden("flows_user", "Sign in to work on this flow.");
  if (!canEditFlows(ctx)) throw forbidden("flows_edit_denied", "Editing flows needs company settings or communications access.");
  const flow = await readFlow(ctx.orgId, subject.slice(SUBJECT.length), { latest: true });
  return `## Flow editor
You are beside the flow editor, in a private conversation about the ${flow.kind === "call" ? "call script" : "workflow"} "${flow.name}" (flow_id ${flow.id}, version ${flow.version}). Requests here are about this flow unless the user says otherwise. The editor shows it beside this conversation and reloads it after you save. Read it with flows_get before editing; the user may have edited it by hand since your last turn.`;
}
