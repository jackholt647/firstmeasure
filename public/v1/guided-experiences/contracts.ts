import { z } from "zod";
import { validateConditions } from "../work/conditions.js";

/**
 * Guided experiences (docs/architecture/guided-experiences.md): in-app setups, tutorials and assistant help, each
 * defined as data and played by one runtime. A definition says what kind of experience it is, whose progress it
 * keeps, when it may start, which variants exist and how to choose between them, its steps, and what finishing it
 * does. Nothing here names an organization's configuration; who sees an experience is its eligibility and chooser.
 */

const id = z.string().trim().regex(/^[a-z][a-z0-9_.:-]{0,119}$/);
/** Copy is a PlatformLanguage key in the `guided-experiences` namespace plus its English text. A reworded text needs a new key. */
export const copySchema = z.object({ key: z.string().regex(/^gx_[a-z0-9_]{2,90}$/), text: z.string().min(1).max(2000) }).strict();
export type Copy = z.infer<typeof copySchema>;
const selector = z.string().trim().min(1).max(400);
const conditions = z.unknown().superRefine((value, context) => {
  for (const issue of validateConditions(value)) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});
/** A step's next step: one id, or the first branch whose conditions match the selections so far, then `otherwise`. */
const next = z.union([id, z.object({ branches: z.array(z.object({ when: conditions, to: id }).strict()).min(1).max(12), otherwise: id.optional() }).strict()]);

export const KINDS = ["overlay", "modal", "agentic"] as const;
export type ExperienceKind = (typeof KINDS)[number];

const overlayStep = z.object({
  id,
  title: copySchema,
  body: copySchema,
  /** Elements left undimmed. The first one found is highlighted and the popover sits beside it; none means a centred card. */
  targets: z.array(selector).max(6).default([]),
  placement: z.enum(["auto", "top", "bottom", "left", "right", "center"]).default("auto"),
  /** `click`: the step advances when the person presses the highlighted element. */
  advance: z.enum(["next", "click"]).default("next"),
  /** How long to wait for a target to appear before the step is skipped. */
  wait_ms: z.number().int().min(0).max(10000).default(1500),
  next: next.optional()
}).strict();

const setupStep = z.object({
  id,
  /** The browser renderer for the widget side of this step (guided-setup.js `registerWidget`). */
  widget: z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/),
  title: copySchema,
  subtitle: copySchema.optional(),
  /** What the agent says when the step opens. Programmatic, never a model call. */
  say: z.array(copySchema).max(6).default([]),
  /** Data for the widget: fixed here, or filled by a registered server source (`registerGuidedSource`). */
  options: z.record(z.unknown()).default({}),
  source: id.optional(),
  /** The selection keys this step's widget writes; branches and the completion action read them. */
  selects: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,59}$/)).max(12).default([]),
  required: z.boolean().default(true),
  next: next.optional()
}).strict();

const trigger = z.discriminatedUnion("kind", [
  /** Runs before a button's own action: the click is held, the experience plays, then the click is let through. */
  z.object({ kind: z.literal("before_action"), action: id, selector, once: z.boolean().default(true), when: conditions.optional() }).strict(),
  /** The person opens a project tab (an app id such as project.materials). */
  z.object({ kind: z.literal("tab_opened"), tab: id, once: z.boolean().default(true), delay_ms: z.number().int().min(0).max(10000).default(700), when: conditions.optional() }).strict(),
  /** Another experience finished (its `then` names this one) or code asked for it by name. */
  z.object({ kind: z.literal("after_experience"), experience: id, once: z.boolean().default(true), when: conditions.optional() }).strict(),
  z.object({ kind: z.literal("manual") }).strict()
]);

const variant = z.object({
  id,
  /** Relative weight among the variants whose `when` matches. 0 keeps a variant defined but never chosen. */
  weight: z.number().int().min(0).max(10000).default(1),
  /** Conditions over the chooser context (work/conditions.ts): organization, person, surface. */
  when: conditions.optional(),
  /** A variant may play as another kind, e.g. a modal where the assistant is off. */
  kind: z.enum(KINDS).optional(),
  /** Step ids in the order this variant plays them; defaults to every step. */
  steps: z.array(id).max(40).optional(),
  /** Merged over each step's options (by step id) so content can differ without new steps. */
  content: z.record(z.record(z.unknown())).default({})
}).strict();

export const experienceSchema = z.object({
  id,
  version: z.number().int().positive(),
  kind: z.enum(KINDS),
  /** Whose progress it is: a setup is done once for the organization; a tutorial once per person. */
  scope: z.enum(["organization", "person"]),
  /** What the A/B bucket is keyed on. Defaults to the scope. */
  unit: z.enum(["organization", "person"]).optional(),
  /** The bucketing salt. Change it to reshuffle buckets for a new experiment. */
  salt: z.string().max(60).default("v1"),
  title: copySchema,
  description: copySchema.optional(),
  /** The project tab this belongs to, for "show me again" and FAQs. */
  tab: id.optional(),
  eligibility: z.object({
    capabilities: z.array(z.string().max(120)).max(12).default([]),
    /** Each entry is required; an entry may be a|b. */
    permissions: z.array(z.string().max(200)).max(8).default([]),
    when: conditions.optional()
  }).strict().default({}),
  triggers: z.array(trigger).max(8).default([]),
  variants: z.array(variant).min(1).max(12),
  steps: z.array(z.union([overlayStep, setupStep])).min(1).max(40),
  completion: z.object({
    /** A published action (platform/publication/actions.ts) run as the person with the selections as input. */
    action: z.object({ id: z.string().max(160), target: z.enum(["organization", "project"]), input: z.record(z.unknown()).default({}) }).strict().optional(),
    /** What the agent says once it is done. */
    say: z.array(copySchema).max(4).default([]),
    /** What happens next, in order: hand the conversation to the project's agent tray, let a held click through, play another experience. */
    then: z.array(z.union([
      z.object({ handoff: z.literal("assistant_tray") }).strict(),
      z.object({ resume: z.literal(true) }).strict(),
      z.object({ play: id }).strict()
    ])).max(6).default([])
  }).strict().default({}),
  /** Whether "show me again" may play it after it was completed. */
  replayable: z.boolean().default(false),
  /**
   * Onboarding sequencing, never access: until this person has finished the experience (`until`), the named project
   * tab shows only on projects matching `when`. Conditions are map-form equality over project facts
   * (`{ "project.has_report": true }`), the part of the condition contract the browser evaluates.
   */
  reveal: z.array(z.object({
    tab: id,
    until: z.enum(["finished", "completed"]).default("finished"),
    when: z.record(z.union([z.boolean(), z.string(), z.number()])).superRefine((value, context) => {
      for (const key of Object.keys(value)) if (!/^project\.[a-z][a-z0-9_]{0,59}$/.test(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: `${key} is not a project fact.` });
      if (!Object.keys(value).length) context.addIssue({ code: z.ZodIssueCode.custom, message: "A reveal needs a condition." });
    })
  }).strict()).max(4).default([])
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (ids.has(step.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Two steps are called ${step.id}.` });
    ids.add(step.id);
    const overlay = "targets" in step;
    if ((value.kind === "overlay") !== overlay) context.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${step.id} does not suit a ${value.kind} experience.` });
  }
  const refs = (step: { next?: unknown }) => {
    const n = step.next as string | { branches: { to: string }[]; otherwise?: string } | undefined;
    if (!n) return [];
    return typeof n === "string" ? [n] : [...n.branches.map((entry) => entry.to), ...(n.otherwise ? [n.otherwise] : [])];
  };
  for (const step of value.steps) for (const to of refs(step)) if (!ids.has(to)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Step ${step.id} goes to ${to}, which is not a step.` });
  const variants = new Set<string>();
  for (const entry of value.variants) {
    if (variants.has(entry.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Two variants are called ${entry.id}.` });
    variants.add(entry.id);
    for (const stepId of entry.steps || []) if (!ids.has(stepId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Variant ${entry.id} names step ${stepId}, which is not a step.` });
    for (const stepId of Object.keys(entry.content)) if (!ids.has(stepId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Variant ${entry.id} has content for ${stepId}, which is not a step.` });
    const kind = entry.kind || value.kind;
    if ((kind === "overlay") !== (value.kind === "overlay")) context.addIssue({ code: z.ZodIssueCode.custom, message: `Variant ${entry.id} cannot turn a ${value.kind} into a ${kind}.` });
  }
  if (!value.variants.some((entry) => entry.weight > 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one variant needs a weight above 0." });
});
export type ExperienceDefinition = z.infer<typeof experienceSchema>;
export type ExperienceInput = z.input<typeof experienceSchema>;
export type ExperienceStep = ExperienceDefinition["steps"][number];

/** Suggested questions for the assistant on a project tab. `ask` sends the question; `play` replays an experience. */
export const faqSchema = z.object({
  tab: id,
  questions: z.array(z.object({
    id,
    text: copySchema,
    action: z.enum(["ask", "play"]).default("ask"),
    /** For `play`: the experience to replay. Shown only where it exists and the person may see it. */
    experience: id.optional(),
    /** For `ask`: what is sent, when it differs from what is shown. */
    prompt: copySchema.optional()
  }).strict().superRefine((value, context) => {
    if (value.action === "play" && !value.experience) context.addIssue({ code: z.ZodIssueCode.custom, message: `${value.id} plays nothing.` });
  })).min(1).max(8)
}).strict();
export type TabFaqs = z.infer<typeof faqSchema>;

export const EVENT_TYPES = ["exposure", "start", "step_view", "step_done", "step_skip", "back", "dismiss", "complete", "replay", "question", "faq"] as const;
export type GuidedEventType = (typeof EVENT_TYPES)[number];
export const STATUSES = ["started", "completed", "dismissed"] as const;
export type GuidedStatus = (typeof STATUSES)[number];

/** Bounded, plain selections: what a person picked in a setup. Never markup, files or credentials. */
export const selectionsSchema = z.record(z.unknown()).superRefine((value, context) => {
  const text = JSON.stringify(value);
  if (text.length > 16384) context.addIssue({ code: z.ZodIssueCode.custom, message: "Selections are limited to 16 KB." });
  if (/[<>]|data:/i.test(text)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Selections are plain values." });
});
