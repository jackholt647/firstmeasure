import type { PlatformAuthContext } from "../platform/auth.js";
import { experienceSchema, faqSchema, type ExperienceDefinition, type ExperienceInput, type TabFaqs } from "./contracts.js";
import type { ChooserContext } from "./chooser.js";

/**
 * Where guided experiences, tab FAQs and option sources are registered. Definitions are data checked when they are
 * registered, so a malformed one stops the server rather than failing for a customer. Domains register their own
 * (definitions/*.ts); this module knows none of them.
 */
const experiences = new Map<string, ExperienceDefinition>();
const faqs = new Map<string, TabFaqs>();
/** Questions other files add to a tab (`addTabFaqs`), merged when read. */
const faqExtras = new Map<string, TabFaqs["questions"]>();
export type GuidedSource = (ctx: PlatformAuthContext, chooser: ChooserContext, options: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
const sources = new Map<string, GuidedSource>();

export function registerExperience(input: ExperienceInput) {
  const parsed = experienceSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Guided experience ${String((input as { id?: unknown }).id)} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  if (experiences.has(parsed.data.id)) throw new Error(`Guided experience ${parsed.data.id} is registered twice.`);
  experiences.set(parsed.data.id, parsed.data);
  return parsed.data;
}
export function registerTabFaqs(input: unknown) {
  const parsed = faqSchema.parse(input);
  if (faqs.has(parsed.tab)) throw new Error(`Assistant questions for ${parsed.tab} are registered twice.`);
  faqSchema.parse({ tab: parsed.tab, questions: [...parsed.questions, ...(faqExtras.get(parsed.tab) || [])] });
  faqs.set(parsed.tab, parsed);
  return parsed;
}
/**
 * Adds questions to a tab another definition file owns (a tab's tour adds its own "Show me the tutorial again"), so
 * neither file edits the other. Kept apart and merged when read, whichever registers first; the tab's limit still holds.
 */
export function addTabFaqs(input: unknown) {
  const parsed = faqSchema.parse(input);
  const merged = [...(faqs.get(parsed.tab)?.questions || []), ...(faqExtras.get(parsed.tab) || []), ...parsed.questions];
  if (new Set(merged.map((question) => question.id)).size !== merged.length) throw new Error(`Assistant questions for ${parsed.tab} repeat an id.`);
  faqSchema.parse({ tab: parsed.tab, questions: merged });
  faqExtras.set(parsed.tab, [...(faqExtras.get(parsed.tab) || []), ...parsed.questions]);
  return parsed;
}
const withExtras = (entry: TabFaqs | undefined, tab: string): TabFaqs | null => {
  const extras = faqExtras.get(tab) || [];
  if (!entry) return extras.length ? { tab, questions: extras } : null;
  return extras.length ? { ...entry, questions: [...entry.questions, ...extras] } : entry;
};
/** Fills a step's options on the server (product catalogs, prices for a region) when the experience is read. */
export function registerGuidedSource(id: string, source: GuidedSource) {
  if (sources.has(id)) throw new Error(`Guided source ${id} is registered twice.`);
  sources.set(id, source);
}
export function experience(id: string) { return experiences.get(id) || null; }
export function listExperiences() { return [...experiences.values()]; }
export function tabFaqs(tab: string) { return withExtras(faqs.get(tab), tab); }
export function listTabFaqs() { return [...new Set([...faqs.keys(), ...faqExtras.keys()])].map((tab) => withExtras(faqs.get(tab), tab)!); }
export function guidedSource(id: string) { return sources.get(id) || null; }
