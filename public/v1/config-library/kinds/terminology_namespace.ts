import { z } from "zod";
import type { LibraryKind } from "../contracts.js";

/**
 * Terminology defaults (docs/architecture/terminology.md): one entry per terminology namespace (`projects`, `money`,
 * `scheduling`), holding its section title and note and its terms, each a key, its default English label and its
 * kind. A term is read as `<namespace>.<key>` (`projects.project`); an organization's own wording is an override in
 * its `variable_mappings` module, never a copy of these entries, so no organization copy is kept.
 *
 * Pages read the entries directly (`browser: true`), and the server's terminology contract is built from them
 * (`platform/localization/terminology-defaults.ts`). Code reads term keys, so a namespace or a term key is never
 * removed and a term's kind never changes; labels, titles, notes and order may be edited, and terms added.
 */
export const TERMINOLOGY_NAMESPACE_KIND = "terminology_namespace";

/** entity: a noun that composes into related phrases; navigation/view/status/action: whole labels, never composed. */
export const TERMINOLOGY_TERM_KINDS = ["entity", "navigation", "view", "status", "action"] as const;

const term = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_]{0,79}$/, "A term key is lower case letters, digits and underscores."),
  label: z.string().trim().min(1, "A term needs a label.").max(160),
  kind: z.enum(TERMINOLOGY_TERM_KINDS)
}).strict();

export const terminologyNamespaceSchema = z.object({
  title: z.string().trim().min(1).max(160),
  note: z.string().trim().max(600),
  /** Where the namespace sits in the terminology editor and in the contract (lower first, then by id). */
  position: z.number().int().min(0).max(100000),
  terms: z.array(term).min(1).max(1000)
}).strict();

export type TerminologyNamespace = z.infer<typeof terminologyNamespaceSchema>;
export type TerminologyTermKind = (typeof TERMINOLOGY_TERM_KINDS)[number];

export const terminologyNamespaceKind: LibraryKind<TerminologyNamespace> = {
  kind: TERMINOLOGY_NAMESPACE_KIND,
  title: "Terminology namespace",
  description: "The default English wording of one terminology namespace: its terms (key, label, kind), read as <namespace>.<key>. Organizations override labels; keys are never removed.",
  idPattern: /^[a-z][a-z0-9_]{0,59}$/,
  schema: terminologyNamespaceSchema,
  validate(data) {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const item of data.terms) {
      if (seen.has(item.key)) errors.push(`The term ${item.key} is listed twice.`);
      seen.add(item.key);
    }
    return errors;
  },
  // Pages and server code read term keys: a namespace is never deleted, and an edit keeps every key with its kind.
  appendOnly: true,
  compatible(previous, next, id) {
    const errors: string[] = [];
    const now = new Map(next.terms.map((item) => [item.key, item]));
    for (const before of previous.terms) {
      const after = now.get(before.key);
      if (!after) errors.push(`${id}.${before.key} cannot be removed: code reads term keys. Change its label instead.`);
      else if (after.kind !== before.kind) errors.push(`${id}.${before.key} is a ${before.kind} term and stays one (it was changed to ${after.kind}).`);
    }
    return errors;
  },
  titleOf: (data) => data.title,
  browser: true
};
