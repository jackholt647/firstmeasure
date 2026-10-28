import type { PlatformAuthContext } from "../platform/auth.js";
import { libraryEntries } from "../config-library/library.js";
import { experienceSchema, faqSchema, type ExperienceDefinition, type ExperienceInput, type TabFaqs } from "./contracts.js";
import type { ChooserContext } from "./chooser.js";
import { listSetupSteps, setupStepsVersion } from "./setup-steps.js";
import { GUIDED_EXPERIENCE_KIND, GUIDED_TAB_FAQS_KIND, SETUP_STEP_EXPERIENCE_PREFIX } from "./library-checks.js";

/**
 * Where the runtime reads guided experiences and tab FAQs, and where guided sources are registered. Experiences and
 * tab questions are config library entries (kinds guided_experience and guided_tab_faqs, checked when they are saved),
 * read live: an edit on dev is played on the next read, everywhere. Every setup step is also an experience,
 * `setup_step.<id>`, derived here from its setup_step entry. Sources (code that fills a step's options) are registered
 * by id in sources.ts.
 */
export type GuidedSource = (ctx: PlatformAuthContext, chooser: ChooserContext, options: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
const sources = new Map<string, GuidedSource>();

/** Definitions added in this process only (tests), beside the library's. */
const testExperiences = new Map<string, ExperienceDefinition>();
let testVersion = 0;

type Derived = { key: string; experiences: Map<string, ExperienceDefinition>; faqs: Map<string, TabFaqs> };
let derived: Derived | null = null;
const warned = new Set<string>();
function warnOnce(id: string, message: string) {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`[guided-experiences] ${message}`);
}

/** The setup step played on its own: no steps, the step as its requirement, so it asks only what is still missing. */
function setupStepExperience(step: ReturnType<typeof listSetupSteps>[number]): ExperienceInput {
  return {
    id: `${SETUP_STEP_EXPERIENCE_PREFIX}${step.id}`, version: step.version, kind: "modal", scope: step.scope, salt: "v1", replayable: true,
    title: step.title, description: step.description,
    eligibility: { capabilities: step.eligibility.capabilities, permissions: step.eligibility.permissions },
    triggers: [{ kind: "manual" }], variants: [{ id: "default", weight: 1 }],
    requires: [step.id], steps: [], completion: { screen: "none" }
  };
}

/** Parsed once per library change: an entry the running code no longer accepts is left out (and logged), never thrown. */
function current(): Derived {
  const key = `${setupStepsVersion()}:${testVersion}`;
  if (derived?.key === key) return derived;
  const experiences = new Map<string, ExperienceDefinition>();
  for (const entry of libraryEntries(GUIDED_EXPERIENCE_KIND)) {
    const parsed = experienceSchema.safeParse(entry.data);
    if (parsed.success) experiences.set(parsed.data.id, parsed.data);
    else warnOnce(`${entry.id}@${entry.revision}`, `guided_experience/${entry.id} r${entry.revision} is not a valid experience and is not played: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  }
  for (const step of listSetupSteps()) {
    const parsed = experienceSchema.safeParse(setupStepExperience(step));
    if (parsed.success) experiences.set(parsed.data.id, parsed.data);
  }
  for (const [id, definition] of testExperiences) experiences.set(id, definition);
  const faqs = new Map<string, TabFaqs>();
  for (const entry of libraryEntries(GUIDED_TAB_FAQS_KIND)) {
    const parsed = faqSchema.safeParse(entry.data);
    if (parsed.success) faqs.set(parsed.data.tab, parsed.data);
    else warnOnce(`${entry.id}@${entry.revision}`, `guided_tab_faqs/${entry.id} r${entry.revision} is not valid and is not shown.`);
  }
  return derived = { key, experiences, faqs };
}

/** Tests: an experience played in this process only. Refused when the library or an earlier call has the id. */
export function registerExperienceForTests(input: ExperienceInput) {
  const parsed = experienceSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Guided experience ${String((input as { id?: unknown }).id)} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  if (current().experiences.has(parsed.data.id)) throw new Error(`Guided experience ${parsed.data.id} is registered twice.`);
  testExperiences.set(parsed.data.id, parsed.data);
  testVersion += 1;
  return parsed.data;
}

/** Fills a step's options on the server (product catalogs, prices for a region) when the experience is read. */
export function registerGuidedSource(id: string, source: GuidedSource) {
  if (sources.has(id)) throw new Error(`Guided source ${id} is registered twice.`);
  sources.set(id, source);
}
export function experience(id: string) { return current().experiences.get(id) || null; }
export function listExperiences() { return [...current().experiences.values()]; }
export function tabFaqs(tab: string) { return current().faqs.get(tab) || null; }
export function listTabFaqs() { return [...current().faqs.values()]; }
export function guidedSource(id: string) { return sources.get(id) || null; }
