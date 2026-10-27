import { libraryEntries } from "../config-library/library.js";
import type { RegistryChecks } from "../config-library/contracts.js";

/**
 * Reference checks shared by the guided-experience kinds of the config library (guided_experience, guided_tab_faqs,
 * setup_step, guided_copy): what an entry names must be registered by the running code or held by the library.
 */

export const GUIDED_EXPERIENCE_KIND = "guided_experience";
export const GUIDED_TAB_FAQS_KIND = "guided_tab_faqs";
export const SETUP_STEP_KIND = "setup_step";
export const GUIDED_COPY_KIND = "guided_copy";
/** Every setup step is also played as an experience with this prefix; those are derived, never entries. */
export const SETUP_STEP_EXPERIENCE_PREFIX = "setup_step.";
/** The kinds whose entries carry `{ key, text }` copy that the development copy editor changes in place. */
export const GUIDED_COPY_KINDS = [GUIDED_EXPERIENCE_KIND, GUIDED_TAB_FAQS_KIND, SETUP_STEP_KIND] as const;

/** Each capability entry (an entry may be `a|b`) names a registered capability. */
export function capabilityErrors(list: readonly string[] | undefined, registries: RegistryChecks, at: string) {
  const errors: string[] = [];
  for (const entry of list || []) for (const key of entry.split("|").map((part) => part.trim()).filter(Boolean)) {
    if (!registries.capability(key)) errors.push(`${at}: ${key} is not a registered capability.`);
  }
  return errors;
}

/**
 * Whether a reference to another library entry is missing. It is checked once the library holds entries of that
 * kind, so the one-shot generation, which checks every entry before any is written, is not refused for its order.
 */
export function entryMissing(registries: RegistryChecks, kind: string, id: string) {
  return libraryEntries(kind).length > 0 && !registries.entry(kind, id);
}

/** An experience id: an entry, or the experience every setup step is also played as (`setup_step.<step id>`). */
export function experienceMissing(registries: RegistryChecks, id: string, self = "") {
  if (id === self) return false;
  if (id.startsWith(SETUP_STEP_EXPERIENCE_PREFIX)) return entryMissing(registries, SETUP_STEP_KIND, id.slice(SETUP_STEP_EXPERIENCE_PREFIX.length));
  return entryMissing(registries, GUIDED_EXPERIENCE_KIND, id);
}

/** Every `{ key, text }` copy object in a value, in document order. */
export function copyObjects(value: unknown, out: { key: string; text: string }[] = []) {
  if (Array.isArray(value)) { for (const item of value) copyObjects(item, out); return out; }
  if (!value || typeof value !== "object") return out;
  const entry = value as Record<string, unknown>;
  if (typeof entry.key === "string" && typeof entry.text === "string" && Object.keys(entry).length === 2) { out.push({ key: entry.key, text: entry.text }); return out; }
  for (const child of Object.values(entry)) copyObjects(child, out);
  return out;
}
