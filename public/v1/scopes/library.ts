import { libraryEntries, libraryEntry, libraryStamp, type LibraryStamp } from "../config-library/library.js";
import type { LibraryEntry } from "../config-library/contracts.js";
import type { JsonObject } from "../work/storage.js";
import type { ScopeTemplateDefinition } from "./schemas.js";

/**
 * The scope library: the scope templates the platform ships are entries of the config library kind
 * `scope_template` (config-library/kinds/scope_template.ts, docs/architecture/config-library.md). Each organization
 * gets a copy of every default; an industry scope (`metadata.industry_preset`) is copied only by its CRM pack. A
 * copy records the library stamp it was made from in `metadata.library_stamp` and keeps `metadata.preset: true`
 * until the organization edits it; an untouched copy follows the library, an edited one never does until reset.
 */
export const SCOPE_LIBRARY_KIND = "scope_template";

const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});

function order(entry: LibraryEntry) {
  const value = Number(obj(entry.data).sort_order);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Every library scope template, in library order (sort_order, then id). */
export function scopeLibraryEntries(): LibraryEntry[] {
  return libraryEntries(SCOPE_LIBRARY_KIND).sort((a, b) => order(a) - order(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function isIndustryScopeEntry(entry: LibraryEntry) {
  return !!String(obj(obj(entry.data).metadata).industry_preset || "").trim();
}
/** The scope templates every organization gets. */
export function defaultScopeLibraryEntries() {
  return scopeLibraryEntries().filter((entry) => !isIndustryScopeEntry(entry));
}
export function scopeLibraryEntry(templateId: string) {
  return libraryEntry(SCOPE_LIBRARY_KIND, templateId);
}

/** A fresh copy of a library entry for an organization, stamped with the entry it came from. */
export function scopeLibraryCopy(entry: LibraryEntry): ScopeTemplateDefinition {
  const data = structuredClone(entry.data) as JsonObject;
  return { ...data, metadata: { ...obj(data.metadata), library_stamp: libraryStamp(entry) } } as unknown as ScopeTemplateDefinition;
}

/** The stamp an organization's copy was made from, or null for a copy made before the library (or not from it). */
export function copyStamp(metadata: unknown): LibraryStamp | null {
  const stamp = obj(obj(metadata).library_stamp);
  return stamp.sha256 ? stamp as unknown as LibraryStamp : null;
}

/**
 * How an organization's copy stands: `changed` once someone edited it (`preset` is no longer true), `library` when
 * it was made from the current entry, `behind` when it is untouched but made from an older one (or before the
 * library, with no stamp): such a copy upgrades by itself.
 */
export function scopeCopyState(entry: LibraryEntry, metadata: unknown): "library" | "behind" | "changed" {
  if (obj(metadata).preset !== true) return "changed";
  return copyStamp(metadata)?.sha256 === entry.sha256 ? "library" : "behind";
}
