// The form builder agent ("forms") — the copilot beside the form editor.
//
// It follows the document designer's contract: the editor sends the CURRENT
// draft with every message (body.input), the agent stages a complete, validated
// replacement through update_form, and the editor applies the returned action
// to its live draft. Nothing is saved or published here; autosave, the live
// preview and the Publish button stay where they already are.

import { registerAgent } from "../agents/registry.js";
import { normalizeCommonCore } from "../agents/settings.js";
import type { AgentRun, AgentTool } from "../agents/types.js";
import { asObject, cleanText, errorMessage, parseJsonArg, toolError, truncateJson, type JsonObject } from "../agents/util.js";
import { env } from "../src/config/env.js";
import { compileFormModule } from "./compile.js";
import { formDefinitionSchema, type FormDefinition } from "./contracts.js";
import { formsContext, priceDraft } from "./service.js";

const PERMISSION = "manage_company_settings";

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

const GUIDE = `## How a form is defined
{ schema_version: 1, template, presentation, steps, calculation, settings }

- steps: [{ id, title, description, visible_when, items }]. Each step is one screen (or one section when presentation.layout is "page").
- items (blocks): { id, kind, param, label, description, placeholder, required, visible_when, ...kind fields }. \`id\` is unique in the form. \`param\` is the answer key: lowercase snake_case, unique, required for every block except content.
- visible_when: a list of conditions that must all match, each { param, op, value }. op is eq, neq, in, gt, gte, lt, lte, answered or empty. \`param\` may be a dotted path such as "measurement.pitch_category". An empty list means always shown. A condition can only refer to a block that comes earlier in the form.
- presentation: { headline, subheadline, start_label, next_label, back_label, submit_label, fine_print, layout: "steps"|"page", progress: "bar"|"dots"|"none", style: {...}, success: { title, body, cta_label, cta_url } }. Leave presentation.style exactly as it is unless the user asks about colors, fonts or the logo.
- settings: { stage_id, notify_role_ids, tracking_key, customer_email: { enabled, subject, intro, cta_label, cta_url } }. Leave settings alone unless asked.
- calculation: null for no estimate, or { mode: "pricing", pricing } to show a price range after submitting.

## Pricing
pricing: { currency, quantity: { param, label, unit, fallback, waste_percent }, options, adjustments, round_to, disclaimer }
- quantity.param is the answer path that sets the size of the job (a number block's param, or a measured value such as "measurement.roof_area_sqft"). Leave it "" for flat prices.
- options: [{ id, label, description, low_rate, high_rate, flat_low, flat_high, minimum, visible_when }]. Each option's range is (flat + quantity x rate), low to high. With a quantity use the rates; for flat pricing use flat_low and flat_high.
- adjustments: [{ id, label, percent, when }] raise or lower every option by a percentage when their conditions match, e.g. +15 for a rush timeline.
- Never invent prices. If the user has not given rates, ask for them, or put in clearly round placeholder numbers and say plainly that they are placeholders to replace.

## Building well
- Ask for as little as the business needs. Put easy, qualifying questions first and contact details last; visitors abandon forms that open by asking for their phone number.
- Use the company's own trade and wording. The form can serve any industry: do not assume roofing or any other trade unless the conversation or the existing form says so.
- Prefer single-choice questions with 3 to 5 clear options over free text when the answer drives pricing or routing.
- An estimate form should end with a consent block and collect an email, since the estimate is emailed.`;

function currentDefinition(run: AgentRun): JsonObject {
  return asObject(asObject(run.scratch).staged ?? asObject(run.input).definition);
}

function issueList(issues: Array<{ path: Array<string | number>; message: string }>) {
  return issues.slice(0, 14).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

const TOOLS: AgentTool[] = [
  {
    name: "get_current_form",
    description: "Read the FULL form definition currently open in the editor, including edits you staged this turn. The editor state is the source of truth.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute(run) {
      const definition = currentDefinition(run);
      if (!Object.keys(definition).length) return toolError("The editor did not send a form with this message.");
      return { name: cleanText(asObject(asObject(run.input).subject).name), definition };
    }
  },
  {
    name: "list_form_building_blocks",
    description: "List every block kind you may use, the organization's bookable appointment types (for appointment blocks) and measurement sources with the values they provide (for property_measurement blocks and pricing). Call this before adding an appointment or measurement block, and whenever you are unsure a kind exists.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    permission: PERMISSION,
    async execute(run) {
      if (!run.ctx) return toolError("Building blocks are only available in the form editor.");
      const context = await formsContext(run.ctx);
      return {
        blocks: context.blocks.map((block) => ({ kind: block.kind, label: block.label, available: block.available, note: BLOCK_NOTES[block.kind] || "" })),
        appointment_types: context.appointment_types.filter((type) => type.bookable_online).map((type) => ({ preset_id: type.id, label: type.label, duration_minutes: type.duration_minutes })),
        measurement_sources: context.measurement_sources.map((source) => ({ source: source.id, label: source.label, description: source.description, provides: source.fields }))
      };
    }
  },
  {
    name: "update_form",
    description: "Validate and stage a COMPLETE replacement form definition. The editor applies it immediately and its live preview updates; the user still publishes. Always start from the current form and submit the whole definition, never a fragment. Returns validation errors to fix when the form would not be publishable.",
    parameters: {
      type: "object",
      properties: {
        definition: { type: "string", description: "The full form definition as a JSON string." },
        change_note: { type: "string", description: "One plain-language sentence describing the change." }
      },
      required: ["definition"],
      additionalProperties: false
    },
    permission: PERMISSION,
    execute(run, args) {
      const parsed = formDefinitionSchema.safeParse(parseJsonArg(args.definition, "definition"));
      if (!parsed.success) return { ok: false, errors: issueList(parsed.error.issues as never) };
      try {
        compileFormModule("Form", parsed.data);
      } catch (error) {
        return { ok: false, errors: [errorMessage(error)] };
      }
      run.scratch.staged = parsed.data;
      run.actions.push({ type: "form.set_definition", definition: parsed.data });
      run.changeLog.push(cleanText(args.change_note) || "Updated the form.");
      return { ok: true, steps: parsed.data.steps.length, blocks: parsed.data.steps.reduce((total, step) => total + step.items.length, 0), has_estimate: !!parsed.data.calculation };
    }
  },
  {
    name: "test_estimate",
    description: "Run the form's pricing against example answers and return the estimate a visitor would see. Use it after changing pricing to check the numbers are sensible. `answers` maps each block's param to an example answer; measured values go under the measurement block's param, e.g. { \"measurement\": { \"roof_area_sqft\": 2400, \"pitch_category\": \"Steep\" } }.",
    parameters: {
      type: "object",
      properties: { answers: { type: "string", description: "Example answers as a JSON object string." } },
      required: ["answers"],
      additionalProperties: false
    },
    publication: { effect: "compute" },
    async execute(run, args) {
      const parsed = formDefinitionSchema.safeParse(currentDefinition(run));
      if (!parsed.success) return { ok: false, errors: issueList(parsed.error.issues as never) };
      if (!parsed.data.calculation) return toolError("This form has no estimate yet.");
      try {
        return { ok: true, estimate: await priceDraft(parsed.data as FormDefinition, parseJsonArg(args.answers, "answers")) };
      } catch (error) {
        return { ok: false, errors: [errorMessage(error)] };
      }
    }
  }
];

export const FORMS_AGENT_ID = "forms";

registerAgent({
  id: FORMS_AGENT_ID,
  title: "Form Builder",
  description: "Builds and edits website forms conversationally in the form editor: questions, booking, and instant-estimate pricing.",
  usePermission: PERMISSION,
  platformTools: false,
  threadScope: "user",
  model: () => ({ model: env.openaiDocsAgentModel, effort: env.openaiDocsAgentEffort, timeoutMs: env.openaiDocsAgentTimeoutMs }),
  loop: { maxRounds: 12, maxOutputTokens: 24_000 },
  settings: {
    defaults: () => ({ enabled: true, display_name: "Form Builder", custom_instructions: "" }),
    normalize: (raw) => ({ ...normalizeCommonCore(raw, { display_name: "Form Builder" }) })
  },
  systemPrompt(run) {
    const subject = asObject(asObject(run.input).subject);
    const definition = asObject(asObject(run.input).definition);
    const customInstructions = cleanText(asObject(run.settings).custom_instructions);
    return `You are the form builder for this company on the FirstMate platform, a copilot beside the form editor. You are talking to a business user, not a developer: they describe the form they want in plain language and you build it. A form captures a lead from the company's website; it can also book an appointment from the company's live schedule and show an instant price estimate.

## Current focus
${Object.keys(definition).length ? `You are editing the form "${cleanText(subject.name) || "Untitled"}" (${cleanText(subject.status) || "draft"}).` : "The editor did not send a form with this message; ask the user to reopen it."}

${GUIDE}

## The form currently open in the editor
${Object.keys(definition).length ? truncateJson(definition, 60_000) : "(none)"}

## Working rules
- Your edits go through update_form: build the COMPLETE new definition, starting from the current one, and submit the whole thing. The editor applies it live in front of the user.
- Make the change the user asked for and keep everything else intact. Keep existing ids and params stable so pricing and conditions that refer to them keep working.
- Validation errors from update_form tell you exactly what to fix; iterate until it succeeds. If you cannot succeed after a few attempts, call report_result with status "failed" and explain simply.
- After changing pricing, call test_estimate with realistic answers and sanity-check the result before you finish.
- When a request is ambiguous, make the most reasonable interpretation, do it, and say what you assumed. Do not interrogate the user, except for prices: never make up real prices.
- You cannot publish. When the form is ready, tell the user to try it in the live preview and press Publish.
- ALWAYS finish by calling report_result, then reply in short plain language describing what changed. No JSON, no field names, no jargon.${customInstructions ? `\n\n## Company instructions\n${customInstructions}` : ""}`;
  },
  tools: TOOLS
});
