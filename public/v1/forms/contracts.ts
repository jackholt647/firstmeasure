import { z } from "zod";

import { registerWorkflowItemKind } from "../documents/workflows/kinds.js";

/**
 * Form definitions. A form is authored as steps of typed blocks and published
 * as a content-addressed workflow document module (see compile.ts). Blocks are
 * workflow item kinds; adding a block means registering a kind here and a
 * renderer in libraries/forms-embed — never a new form "mode".
 */

export const FORM_FONTS = ["Montserrat", "Inter", "Roboto", "Open Sans", "Lato", "Poppins", "Source Sans 3"] as const;
export const PARAM_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

const text = (max: number) => z.string().trim().max(max);
const id = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/);

/** `param` is a dotted path into the collected answers, e.g. `roof_age` or `measurement.pitch_category`. */
export const conditionSchema = z.object({
  param: z.string().trim().min(1).max(160).regex(/^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/),
  op: z.enum(["eq", "neq", "in", "gt", "gte", "lt", "lte", "answered", "empty"]).default("eq"),
  value: z.unknown().optional()
}).strict();
export type FormCondition = z.infer<typeof conditionSchema>;
/** A list is a conjunction; an empty list always matches. */
const conditionsSchema = z.array(conditionSchema).max(8).default([]);

const optionSchema = z.object({
  value: text(80).min(1),
  label: text(160).min(1),
  description: text(300).default(""),
  image_url: text(2000).default("")
}).strict();

const contactFieldSchema = z.object({ enabled: z.boolean().default(true), required: z.boolean().default(false) }).strict();

export const FORM_BLOCKS = {
  contact: { label: "Contact details", icon: "fa-address-card", writes: true, group: "Lead" },
  address: { label: "Address", icon: "fa-location-dot", writes: true, group: "Lead" },
  text: { label: "Short answer", icon: "fa-font", writes: true, group: "Questions" },
  paragraph: { label: "Long answer", icon: "fa-align-left", writes: true, group: "Questions" },
  number: { label: "Number", icon: "fa-hashtag", writes: true, group: "Questions" },
  select: { label: "Single choice", icon: "fa-circle-dot", writes: true, group: "Questions" },
  multi_select: { label: "Multiple choice", icon: "fa-square-check", writes: true, group: "Questions" },
  boolean: { label: "Yes / no", icon: "fa-toggle-on", writes: true, group: "Questions" },
  date: { label: "Date", icon: "fa-calendar-day", writes: true, group: "Questions" },
  appointment: { label: "Appointment picker", icon: "fa-calendar-check", writes: true, group: "Smart blocks", capability: "appointment_form" },
  property_measurement: { label: "Property measurement", icon: "fa-ruler-combined", writes: true, group: "Smart blocks", capability: "instant_estimate" },
  consent: { label: "Consent checkbox", icon: "fa-shield-halved", writes: true, group: "Lead" },
  content: { label: "Text / image", icon: "fa-paragraph", writes: false, group: "Layout" }
} as const;
export type FormBlockKind = keyof typeof FORM_BLOCKS;
const blockKinds = Object.keys(FORM_BLOCKS) as [FormBlockKind, ...FormBlockKind[]];

export const formItemSchema = z.object({
  id,
  kind: z.enum(blockKinds),
  /** Answer key; required for every block that collects a value. */
  param: z.string().trim().regex(PARAM_PATTERN).optional(),
  label: text(300).default(""),
  description: text(1200).default(""),
  placeholder: text(200).default(""),
  required: z.boolean().default(false),
  visible_when: conditionsSchema,
  /** Project custom-field path that receives this answer on submission. */
  maps_to: text(200).default(""),
  // select / multi_select
  options: z.array(optionSchema).max(40).default([]),
  style: z.enum(["cards", "list", "dropdown"]).default("cards"),
  // number
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  unit: text(40).default(""),
  // contact
  fields: z.object({ name: contactFieldSchema, email: contactFieldSchema, phone: contactFieldSchema }).strict()
    .default({ name: { enabled: true, required: true }, email: { enabled: true, required: false }, phone: { enabled: true, required: true } }),
  // appointment
  preset_id: text(120).default(""),
  min_notice_hours: z.number().int().min(0).max(720).default(2),
  horizon_days: z.number().int().min(1).max(365).default(45),
  // property_measurement
  source: text(80).default(""),
  address_param: z.string().trim().regex(PARAM_PATTERN).optional(),
  // content
  heading: text(300).default(""),
  body: text(4000).default(""),
  image_url: text(2000).default("")
}).strict();
export type FormItem = z.infer<typeof formItemSchema>;

export const formStepSchema = z.object({
  id,
  title: text(300).default(""),
  description: text(1200).default(""),
  visible_when: conditionsSchema,
  items: z.array(formItemSchema).max(24).default([])
}).strict();
export type FormStep = z.infer<typeof formStepSchema>;

export const presentationSchema = z.object({
  headline: text(200).default(""),
  subheadline: text(600).default(""),
  start_label: text(60).default(""),
  next_label: text(60).default("Next"),
  back_label: text(60).default("Back"),
  submit_label: text(60).default("Submit"),
  fine_print: text(1200).default(""),
  /** `steps` shows one step at a time; `page` stacks every step on one page. */
  layout: z.enum(["steps", "page"]).default("steps"),
  progress: z.enum(["bar", "dots", "none"]).default("bar"),
  style: z.object({
    use_company_colors: z.boolean().default(true),
    primary_color: hex.default("#2563eb"),
    text_color: hex.default("#111827"),
    background_color: hex.default("#ffffff"),
    font_family: z.enum(FORM_FONTS).default("Inter"),
    corners: z.enum(["soft", "round", "square"]).default("soft"),
    logo_enabled: z.boolean().default(true),
    logo_url: text(2000).default("")
  }).strict().default({}),
  success: z.object({
    title: text(200).default("Thanks — we got it"),
    body: text(1200).default("We will be in touch shortly."),
    cta_label: text(80).default(""),
    cta_url: text(2000).default("")
  }).strict().default({})
}).strict();

const pricingOptionSchema = z.object({
  id,
  label: text(160).min(1),
  description: text(300).default(""),
  /** Price per quantity unit; a flat option uses flat_low/flat_high and zero rates. */
  low_rate: z.number().finite().min(0).default(0),
  high_rate: z.number().finite().min(0).default(0),
  flat_low: z.number().finite().min(0).default(0),
  flat_high: z.number().finite().min(0).default(0),
  minimum: z.number().finite().min(0).default(0),
  visible_when: conditionsSchema
}).strict();

export const pricingSchema = z.object({
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default("USD"),
  quantity: z.object({
    /** Dotted answer path supplying the quantity, e.g. `measurement.roof_area_sqft`. Empty means flat pricing. */
    param: z.string().trim().max(160).default(""),
    label: text(80).default("Quantity"),
    unit: text(40).default(""),
    /** Used when the answer or measurement is unavailable. Zero disables the fallback. */
    fallback: z.number().finite().min(0).default(0),
    waste_percent: z.number().finite().min(0).max(100).default(0)
  }).strict().default({}),
  options: z.array(pricingOptionSchema).min(1).max(24),
  /** Percentage modifiers applied to every option when their conditions match. */
  adjustments: z.array(z.object({ id, label: text(160).min(1), percent: z.number().finite().min(-90).max(500), when: conditionsSchema }).strict()).max(24).default([]),
  round_to: z.number().finite().min(1).max(10_000).default(50),
  disclaimer: text(1200).default("This is a preliminary estimate. Final pricing is confirmed after we review the details with you.")
}).strict();
export type FormPricing = z.infer<typeof pricingSchema>;

/**
 * `pricing` runs the standard estimator over a declarative price table.
 * `code` runs author-supplied JavaScript with `parameters` in scope. Both are
 * published as the module source and execute in the document-module sandbox.
 */
export const calculationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pricing"), pricing: pricingSchema }).strict(),
  z.object({ mode: z.literal("code"), source: z.string().min(1).max(100_000), parameters: z.record(z.unknown()).default({}) }).strict()
]);
export type FormCalculation = z.infer<typeof calculationSchema>;

export const settingsSchema = z.object({
  stage_id: text(120).default("new_lead"),
  notify_role_ids: z.array(text(120).min(1)).max(40).default(["inside_sales", "sales_appointments"]),
  tracking_key: text(120).default(""),
  customer_email: z.object({
    enabled: z.boolean().default(false),
    subject: text(200).default(""),
    intro: text(1200).default(""),
    cta_label: text(80).default(""),
    cta_url: text(2000).default("")
  }).strict().default({})
}).strict();

/** Structural shape only, so a half-built draft can be saved. Publishing uses formDefinitionSchema. */
export const formDraftSchema = z.object({
  schema_version: z.literal(1).default(1),
  template: text(80).default("blank"),
  presentation: presentationSchema.default({}),
  steps: z.array(formStepSchema).min(1).max(20),
  calculation: calculationSchema.nullable().default(null),
  settings: settingsSchema.default({})
}).strict();

export const formDefinitionSchema = formDraftSchema.superRefine((definition, ctx) => {
  const stepIds = new Set<string>();
  const itemIds = new Set<string>();
  const params = new Map<string, FormBlockKind>();
  // Conditions may only look backwards, so the visitor's browser and the server always agree on what is shown.
  const earlier = (conditions: FormCondition[], path: Array<string | number>) => {
    for (const condition of conditions) {
      if (!params.has(condition.param.split(".")[0]!)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Its "show when" rule depends on '${condition.param}', which is not asked earlier in the form.` });
    }
  };
  definition.steps.forEach((step, stepIndex) => {
    earlier(step.visible_when, ["steps", stepIndex, "visible_when"]);
    if (stepIds.has(step.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "id"], message: `Duplicate step id '${step.id}'.` });
    stepIds.add(step.id);
    step.items.forEach((item, itemIndex) => {
      const path = ["steps", stepIndex, "items", itemIndex];
      const issue = (field: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, field], message });
      if (itemIds.has(item.id)) issue("id", `Duplicate block id '${item.id}'.`);
      itemIds.add(item.id);
      earlier(item.visible_when, [...path, "visible_when"]);
      if (FORM_BLOCKS[item.kind].writes) {
        if (!item.param) issue("param", "This block needs an answer key.");
        else if (params.has(item.param)) issue("param", `Answer key '${item.param}' is used by more than one block.`);
        else params.set(item.param, item.kind);
      }
      if ((item.kind === "select" || item.kind === "multi_select") && !item.options.length) issue("options", "Add at least one choice.");
      if ((item.kind === "select" || item.kind === "multi_select") && new Set(item.options.map((option) => option.value)).size !== item.options.length) issue("options", "Choices must be unique.");
      if (item.kind === "contact" && !Object.values(item.fields).some((field) => field.enabled)) issue("fields", "Turn on at least one contact field.");
      if (item.kind === "property_measurement" && !item.source) issue("source", "Choose what to measure.");
    });
  });
  for (const [stepIndex, step] of definition.steps.entries()) for (const [itemIndex, item] of step.items.entries()) {
    if (item.kind === "property_measurement" && params.get(item.address_param || "") !== "address") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", stepIndex, "items", itemIndex, "address_param"], message: "A property measurement needs an address block earlier in the form." });
    }
  }
  if ([...params.values()].filter((kind) => kind === "appointment").length > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "A form can book one appointment." });
  if ([...params.values()].filter((kind) => kind === "contact").length > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "A form can have one contact details block." });
});
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

/** What a calculation must return as `outputs.estimate`; the embed and emails render this shape for every industry. */
export const estimateOutputSchema = {
  type: "object",
  required: ["estimate"],
  additionalProperties: false,
  properties: {
    estimate: {
      type: "object",
      required: ["currency", "low", "high"],
      additionalProperties: false,
      properties: {
        currency: { type: "string", minLength: 3, maxLength: 3 },
        low: { type: "number", minimum: 0 },
        high: { type: "number", minimum: 0 },
        summary: { type: "string", maxLength: 600 },
        disclaimer: { type: "string", maxLength: 1200 },
        quantity: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "number", minimum: 0 }, unit: { type: "string", maxLength: 40 }, label: { type: "string", maxLength: 80 }, source: { type: "string", maxLength: 40 } }
        },
        options: {
          type: "array",
          maxItems: 24,
          items: {
            type: "object",
            required: ["id", "label", "low", "high"],
            additionalProperties: false,
            properties: { id: { type: "string", maxLength: 80 }, label: { type: "string", maxLength: 160 }, description: { type: "string", maxLength: 300 }, low: { type: "number", minimum: 0 }, high: { type: "number", minimum: 0 } }
          }
        },
        adjustments: {
          type: "array",
          maxItems: 24,
          items: { type: "object", required: ["label", "percent"], additionalProperties: false, properties: { label: { type: "string", maxLength: 160 }, percent: { type: "number" } } }
        }
      }
    }
  }
} as const;

// Workflow item kinds contributed by forms. The pre-existing text/number/select/
// multi_select/boolean/date kinds are reused as-is. Form kinds are registered on
// their own surface so the document workflow editor does not offer them.
const formKindSchema = z.object({ kind: z.string(), writes: z.string().optional() }).passthrough();
for (const kind of ["contact", "address", "paragraph", "appointment", "property_measurement", "consent"]) {
  registerWorkflowItemKind(kind, { schema: formKindSchema, writes: "params", surface: "forms" });
}
registerWorkflowItemKind("content", { schema: formKindSchema, writes: "none", surface: "forms" });

/** Importing this module registers the form block kinds. */
export function registerFormBlockKinds() {
  // Registration happens at module load, mirroring registerBuiltinWorkflowItemKinds.
}

export function formItems(definition: Pick<FormDefinition, "steps">): FormItem[] {
  return definition.steps.flatMap((step) => step.items);
}

function answerAt(answers: Record<string, unknown>, path: string): unknown {
  let value: unknown = answers;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && !value.length);

export function conditionMatches(condition: FormCondition, answers: Record<string, unknown>): boolean {
  const actual = answerAt(answers, condition.param);
  const expected = condition.value;
  switch (condition.op) {
    case "answered": return !isEmpty(actual);
    case "empty": return isEmpty(actual);
    case "in": return Array.isArray(expected) && (Array.isArray(actual) ? actual.some((entry) => expected.includes(entry)) : expected.includes(actual));
    case "neq": return Array.isArray(actual) ? !actual.includes(expected) : String(actual ?? "") !== String(expected ?? "");
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    default: return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "") === String(expected ?? "");
  }
}

export function conditionsMatch(conditions: FormCondition[] | undefined, answers: Record<string, unknown>) {
  return (conditions || []).every((condition) => conditionMatches(condition, answers));
}
