import { canonicalJson } from "../canonical.js";

/**
 * What the measurement and work dictionary kinds share (docs/architecture/measurement-schemas.md,
 * docs/architecture/requirements.md). Dictionary entries are only ever added: a definition's key, unit and meaning
 * never change, and a schema's selection only grows, under a new version.
 */

/** A dictionary id: dotted lower-case words (`roof.ridge_length`). */
export const DICTIONARY_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** A schema id, shared by the measurement and work schemas of one kind of work (`roofing`). */
export const SCHEMA_ID = /^[a-z][a-z0-9_]*$/;

export const sameJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Errors for every listed field whose value differs between two revisions. */
export function unchanged<T extends Record<string, unknown>>(previous: T, next: T, fields: (keyof T)[], what: string) {
  return fields.filter((field) => !sameJson(previous[field], next[field]))
    .map((field) => `${what}: ${String(field)} never changes (was ${canonicalJson(previous[field] ?? null)}). Add a new entry beside it instead.`);
}
