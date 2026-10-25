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
  faqs.set(parsed.tab, parsed);
  return parsed;
}
/** Fills a step's options on the server (product catalogs, prices for a region) when the experience is read. */
export function registerGuidedSource(id: string, source: GuidedSource) {
  if (sources.has(id)) throw new Error(`Guided source ${id} is registered twice.`);
  sources.set(id, source);
}
export function experience(id: string) { return experiences.get(id) || null; }
export function listExperiences() { return [...experiences.values()]; }
export function tabFaqs(tab: string) { return faqs.get(tab) || null; }
export function listTabFaqs() { return [...faqs.values()]; }
export function guidedSource(id: string) { return sources.get(id) || null; }
