// Forms in the shared FirstMate assistant.
//
// There is no separate forms agent. The global assistant gets these tools, so
// "edit my estimate form" works the same from the dock, a side chat or the form
// editor's AI tab. The editor's tab is the same assistant in a private
// conversation whose subject is the form (`form:<id>`), which adds the form as
// context and tells the assistant the preview is already on screen.

import { panelEnvelope } from "../agents/panels.js";
import { authorizePanelWidget } from "../agents/platform_tools.js";
import { createAgentThread, getAgentsDatabase } from "../agents/storage.js";
import type { AgentRun, AgentTool } from "../agents/types.js";
import { asObject, cleanText, errorMessage, parseJsonArg, toolError, type JsonObject } from "../agents/util.js";
import { hasPermission, requireCapability, type PlatformAuthContext } from "../platform/auth.js";
import { forbidden } from "../platform/errors.js";
import { compileFormModule } from "./compile.js";
import { formDefinitionSchema } from "./contracts.js";
import { createForm, formInsights, formsContext, getForm, listForms, priceDraft, publishForm, updateForm } from "./service.js";

const PERMISSION = "manage_company_settings";
const SUBJECT = "form:";

const BLOCK_NOTES: Record<string, string> = {
  contact: "Name, email and phone in one block. `fields.<name|email|phone>` each take { enabled, required }. At most one per form; every form that should create a reachable lead needs one.",
  address: "A single address line. Needed before a property_measurement block and used to plan appointment travel.",
  text: "Short free-text answer.",
  paragraph: "Long free-text answer. Paragraph answers become the lead's summary.",
  number: "Numeric answer with optional min, max and unit. The usual quantity for pricing.",
  select: "Single choice. `options` are { value, label, description? }; `style` is cards, list or dropdown.",
  multi_select: "Multiple choice with the same options shape.",
  boolean: "Yes / no.",
  date: "A calendar date.",
  appointment: "Lets the visitor book an open time. `preset_id` must be one of the organization's bookable appointment types; duration, staffing and arrival windows come from that type. At most one per form.",
  property_measurement: "Measures the property at an address. `source` names a measurement source and `address_param` the answer key of an earlier address block. Its values are available to pricing and conditions as `<param>.<field>`.",
  consent: "A checkbox the visitor must tick; `label` is the sentence shown.",
  content: "Static heading, text and image. Collects nothing, so it has no `param`."
};

const GUIDE = `A form definition is { schema_version: 1, template, presentation, steps, calculation, settings }.

- steps: [{ id, title, description, visible_when, items }]. Each step is one screen (or one section when presentation.layout is "page").
- items (blocks): { id, kind, param, label, description, placeholder, required, visible_when, ...kind fields }. \`id\` is unique in the form. \`param\` is the answer key: lowercase snake_case, unique, required for every block except content.
- visible_when: a list of conditions that must all match, each { param, op, value }. op is eq, neq, in, gt, gte, lt, lte, answered or empty. \`param\` may be a dotted path such as "measurement.pitch_category". An empty list means always shown. A condition can only refer to a block that comes earlier in the form.
- presentation: { headline, subheadline, start_label, next_label, back_label, submit_label, fine_print, layout: "steps"|"page", progress: "bar"|"dots"|"none", style, success: { title, body, cta_label, cta_url } }. Leave presentation.style exactly as it is unless the user asks about colors, fonts, corners, the header or the logo.
- settings: { stage_id, notify_role_ids, tracking_key, customer_email: { enabled, subject, intro, cta_label, cta_url } }. Leave settings alone unless asked.
- calculation: null for no estimate, or { mode: "pricing", pricing } to show a price range after submitting.

Pricing: { currency, quantity: { param, label, unit, fallback, waste_percent }, options, adjustments, round_to, disclaimer }
- quantity.param is the answer path that sets the size of the job (a number block's param, or a measured value such as "measurement.roof_area_sqft"). Leave it "" for flat prices.
- options: [{ id, label, description, low_rate, high_rate, flat_low, flat_high, minimum, visible_when }]. Each option's range is (flat + quantity x rate), low to high. With a quantity use the rates; for flat pricing use flat_low and flat_high.
- adjustments: [{ id, label, percent, when }] raise or lower every option by a percentage when their conditions match, e.g. +15 for a rush timeline.
- Never invent prices. If the user has not given rates, ask for them, or use clearly round placeholder numbers and say plainly that they are placeholders to replace.

Building well:
- Ask for as little as the business needs. Put easy, qualifying questions first and contact details last.
- Use the company's own trade and wording. Forms serve any industry; do not assume one.
- Prefer single-choice questions with 3 to 5 clear options over free text when the answer drives pricing or routing.
- An estimate form should end with a consent block and collect an email, since the estimate is emailed.`;

export const formsInstructions = `## Website forms
Companies build website forms (lead capture, appointment booking, instant estimates) in Settings → Forms and Leads, and you can build and edit them from any conversation. Use forms_list to find a form and forms_get to read it. Before your first edit in a conversation call forms_building_blocks for the definition format and the blocks, appointment types and measurements this company can use. Change a form with forms_save, always submitting the COMPLETE definition built from the current one and keeping existing ids and answer keys stable. forms_save changes the draft only; visitors see it after forms_publish, which you call only when the user asks to publish. After changing pricing, check it with forms_test_estimate. Use forms_show to put the live preview or the submissions view beside the conversation. Describe changes in plain language, never as JSON or field names.`;

function auth(run: AgentRun): PlatformAuthContext {
  if (!run.ctx) throw forbidden("forms_user", "A signed-in user is required to work with forms.");
  return run.ctx;
}

const inEditor = (run: AgentRun) => cleanText(run.scratch.threadSubjectId || run.subjectId).startsWith(SUBJECT);

/** Puts a form widget beside the conversation. The editor already shows the preview, so it is skipped there. */
async function present(run: AgentRun, formId: string, title: string, view: "preview" | "submissions") {
  if (inEditor(run) && view === "preview") return false;
  const key = `form-${view}-${formId}`;
  if (run.renders.some((render) => asObject(render).key === key)) return true;
  const widget = await authorizePanelWidget(run, { id: view === "preview" ? "forms.preview" : "forms.submissions", version: "1", target: { scope: "organization", organizationId: run.orgId }, config: { form_id: formId } });
  run.renders.push(panelEnvelope({ title: view === "preview" ? title : `${title} submissions`, key }, [widget]));
  return true;
}

function tool(name: string, description: string, properties: JsonObject, required: string[], write: boolean, execute: AgentTool["execute"]): AgentTool {
  return {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
    permission: PERMISSION,
    ...(write ? { gate: (run: AgentRun) => run.settings.allow_actions === false || run.scratch.actionsAllowed === false ? "Assistant actions are disabled." : true as const } : { publication: { effect: "read" as const } }),
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
const summary = (form: Awaited<ReturnType<typeof getForm>>) => ({ form_id: form.id, name: form.name, status: form.status, has_unpublished_changes: form.has_unpublished_changes, features: form.features, submissions: form.submissions.count });

export const formsTools: AgentTool[] = [
  tool("forms_list", "List this company's website forms with their status, what they do and how many submissions they have.", {}, [], false, async (run) => ({ forms: (await listForms(auth(run))).map(summary) })),
  tool("forms_building_blocks", "The form definition format, every block kind, and this company's bookable appointment types, measurement sources and starting templates. Call before building or editing a form.", {}, [], false, async (run) => {
    const context = await formsContext(auth(run));
    return {
      guide: GUIDE,
      blocks: context.blocks.map((block) => ({ kind: block.kind, label: block.label, available: block.available, note: BLOCK_NOTES[block.kind] || "" })),
      appointment_types: context.appointment_types.filter((type) => type.bookable_online).map((type) => ({ preset_id: type.id, label: type.label, duration_minutes: type.duration_minutes })),
      measurement_sources: context.measurement_sources.map((source) => ({ source: source.id, label: source.label, description: source.description, provides: source.fields })),
      templates: context.templates.filter((template) => template.available).map((template) => ({ template: template.id, name: template.name, description: template.description }))
    };
  }),
  tool("forms_get", "Read one form: its full draft definition, status and whether the draft differs from what visitors see.", { form_id: string }, ["form_id"], false, async (run, args) => {
    const form = await getForm(auth(run), cleanText(args.form_id));
    return { ...summary(form), definition: form.definition };
  }),
  tool("forms_create", "Create a new draft form from a starting template (see forms_building_blocks; use \"blank\" to start empty). Returns its id and definition to edit with forms_save.", { name: string, template: string }, ["name"], true, async (run, args) => {
    const form = await createForm(auth(run), { name: cleanText(args.name), template: cleanText(args.template) || "blank" });
    run.changeLog.push(`Created the form "${form.name}".`);
    await present(run, form.id, form.name, "preview");
    return { ...summary(form), definition: form.definition };
  }),
  tool("forms_save", "Validate and save a COMPLETE replacement definition as the form's draft. Start from forms_get and submit the whole definition, never a fragment. Returns validation errors to fix when the form would not be publishable. Visitors are unaffected until the form is published.", { form_id: string, definition: { type: "string", description: "The full form definition as a JSON string." }, name: { type: "string", description: "Optional new name for the form." }, change_note: { type: "string", description: "One plain-language sentence describing the change." } }, ["form_id", "definition"], true, async (run, args) => {
    const parsed = formDefinitionSchema.safeParse(parseJsonArg(args.definition, "definition"));
    if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 14).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
    compileFormModule("Form", parsed.data);
    const form = await updateForm(auth(run), cleanText(args.form_id), { definition: parsed.data, ...(cleanText(args.name) ? { name: cleanText(args.name) } : {}) });
    run.changeLog.push(cleanText(args.change_note) || `Updated the form "${form.name}".`);
    await present(run, form.id, form.name, "preview");
    return { ok: true, ...summary(form) };
  }),
  tool("forms_test_estimate", "Run a form's draft pricing against example answers and return the estimate a visitor would see. `answers` maps each block's param to an example answer; measured values go under the measurement block's param.", { form_id: string, answers: { type: "string", description: "Example answers as a JSON object string." } }, ["form_id", "answers"], false, async (run, args) => {
    const form = await getForm(auth(run), cleanText(args.form_id));
    const parsed = formDefinitionSchema.safeParse(form.definition);
    if (!parsed.success || !parsed.data.calculation) return toolError(parsed.success ? "This form has no estimate yet." : "Finish the form before testing its estimate.");
    return { ok: true, estimate: await priceDraft(parsed.data, parseJsonArg(args.answers, "answers")) };
  }),
  tool("forms_publish", "Publish the form's draft so visitors see it. Only when the user asks to publish or go live.", { form_id: string }, ["form_id"], true, async (run, args) => {
    const form = await publishForm(auth(run), cleanText(args.form_id));
    run.changeLog.push(`Published the form "${form.name}".`);
    return { ok: true, ...summary(form) };
  }),
  tool("forms_insights", "How a form is performing: views, starts, submissions and completion rate, how far visitors get step by step, how each question is answered, average estimates, bookings and the most recent submissions.", { form_id: string }, ["form_id"], false, async (run, args) => {
    const insights = await formInsights(auth(run), cleanText(args.form_id));
    return { ...insights, daily: insights.daily.slice(-14), recent: insights.recent.slice(0, 10) };
  }),
  tool("forms_show", "Show a form beside the conversation: its live, clickable preview, or its submissions and performance view.", { form_id: string, view: { type: "string", enum: ["preview", "submissions"] } }, ["form_id"], false, async (run, args) => {
    const form = await getForm(auth(run), cleanText(args.form_id));
    const shown = await present(run, form.id, form.name, cleanText(args.view) === "submissions" ? "submissions" : "preview");
    return shown ? { ok: true, status: "presentation_requested" } : { ok: true, status: "already_visible", note: "The preview is already on screen beside this conversation." };
  })
];

/** One private assistant conversation per user and form, like the other focused surfaces. */
export async function ensureFormConversation(ctx: PlatformAuthContext, formId: string) {
  if (!hasPermission(ctx, PERMISSION)) throw forbidden("forms_permission", "Company settings permission is required.");
  await requireCapability(ctx, "apps.assistant");
  const form = await getForm(ctx, formId);
  const subject = `${SUBJECT}${form.id}`;
  return getAgentsDatabase().transaction(async (database) => {
    const existing = await database
      .prepare("SELECT * FROM agent_threads WHERE agent_id=? AND organization_id=? AND created_by_user_id=? AND subject_id=? ORDER BY created_at LIMIT 1")
      .get("assistant", ctx.orgId, ctx.userId, subject);
    return existing || createAgentThread({ agent_id: "assistant", organization_id: ctx.orgId, branch_id: ctx.branchId || "default", subject_id: subject, title: `Form: ${form.name}`.slice(0, 80), created_by_user_id: ctx.userId });
  }, `form-thread:${ctx.orgId}:${ctx.userId}:${form.id}`);
}

/** Prompt context for a form conversation. Also the access check for its thread. */
export async function formConversationContext(ctx: PlatformAuthContext | null, subject: string) {
  if (!subject.startsWith(SUBJECT)) return "";
  if (!ctx) throw forbidden("forms_user", "Sign in to work on this form.");
  if (!hasPermission(ctx, PERMISSION)) throw forbidden("forms_permission", "Company settings permission is required.");
  const form = await getForm(ctx, subject.slice(SUBJECT.length));
  return `## Form editor
You are in Settings → Forms and Leads, in the form editor, in a private conversation about the form "${form.name}" (form_id ${form.id}, ${form.status}${form.has_unpublished_changes ? ", with unpublished changes" : ""}). Requests here are about this form unless the user says otherwise. Its live preview is already displayed beside this conversation and refreshes each time you save, so do not show it again. Read the current draft with forms_get before editing; the user may also have edited it by hand since your last turn. You cannot see what the user typed into the preview.`;
}
