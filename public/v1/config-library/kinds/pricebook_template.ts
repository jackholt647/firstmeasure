import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { PRICEBOOK_FORMULA_TOKEN_TYPES, PRICEBOOK_OPERATORS, PRICEBOOK_PARENS } from "../../pricebook/constants.js";
import { validateCatalogGraph } from "../../pricebook/resolver.js";

export const PRICEBOOK_TEMPLATE_KIND = "pricebook_template";

const option = z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(120) }).strict();
const token = z.object({ type: z.enum(PRICEBOOK_FORMULA_TOKEN_TYPES), value: z.string().min(1).max(80) }).strict();
/** A price book item. Its deeper structure (components, variants, options) is owned by the price book's own resolver and checked with it. */
const item = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,119}$/),
  name: z.string().trim().min(1).max(200),
  category: z.string().min(1).max(80),
  unit: z.string().min(1).max(40),
  formulaConfig: z.object({ tokens: z.array(token).max(80), includeWaste: z.boolean() }).strict().optional(),
  description: z.string().max(2000).optional()
}).passthrough();
const catalog = z.object({
  taxonomy: z.object({
    categories: z.array(option).min(1),
    units: z.array(option).min(1),
    measurement_fields: z.array(z.object({ key: z.string().min(1).max(80), label: z.string().min(1).max(120) }).strict()).min(1),
    manufacturers: z.array(option),
    segments: z.array(option)
  }).strict(),
  variation_sets: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120), variable_key: z.string().min(1).max(80), values: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) }).passthrough()) }).strict()),
  items: z.array(item).min(1).max(2000),
  assets: z.array(z.unknown()),
  settings: z.record(z.unknown()),
  metadata: z.record(z.unknown())
}).strict();

/**
 * The bundled price book template (pricebook/storage.ts): the catalog the global market book is made from, its
 * version, and which item ids each version added. Market books and organization overlays record the version they
 * were brought up to; a newer version adds its items to them, additively, and nothing else.
 */
export const pricebookTemplateData = z.object({
  version: z.number().int().min(1).max(100000),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000),
  /** Item ids added after version 1, by the version that added them. Existing price books gain them on upgrade. */
  added_item_ids: z.record(z.string().regex(/^[1-9][0-9]{0,5}$/), z.array(z.string().min(1).max(120)).min(1)),
  catalog
}).strict();
export type PricebookTemplateData = z.infer<typeof pricebookTemplateData>;

export const pricebookTemplateKind: LibraryKind<PricebookTemplateData> = {
  kind: PRICEBOOK_TEMPLATE_KIND,
  title: "Price book templates",
  description: "The bundled price book template: the market catalog every organization's price book links to, versioned so a new version's items reach existing price books additively.",
  schema: pricebookTemplateData,
  titleOf: (data) => data.name,
  validate(data) {
    const errors: string[] = [];
    try { validateCatalogGraph(data.catalog); } catch (error) { errors.push((error as Error).message); }
    const ids = new Set(data.catalog.items.map((entry) => entry.id));
    const categories = new Set(data.catalog.taxonomy.categories.map((entry) => entry.value));
    const fields = new Set(data.catalog.taxonomy.measurement_fields.map((entry) => entry.key));
    for (const entry of data.catalog.items) {
      if (!categories.has(entry.category)) errors.push(`${entry.id}: category ${entry.category} is not in the taxonomy.`);
      for (const part of entry.formulaConfig?.tokens || []) {
        if (part.type === "measurement" && !fields.has(part.value)) errors.push(`${entry.id}: its formula reads ${part.value}, which is not a measurement field of the taxonomy.`);
        if (part.type === "operator" && !(PRICEBOOK_OPERATORS as readonly string[]).includes(part.value)) errors.push(`${entry.id}: ${part.value} is not an operator.`);
        if (part.type === "paren" && !(PRICEBOOK_PARENS as readonly string[]).includes(part.value)) errors.push(`${entry.id}: ${part.value} is not a parenthesis.`);
        if (part.type === "number" && !Number.isFinite(Number(part.value))) errors.push(`${entry.id}: ${part.value} is not a number.`);
      }
    }
    for (const [version, added] of Object.entries(data.added_item_ids)) {
      if (Number(version) < 2 || Number(version) > data.version) errors.push(`added_item_ids names version ${version}, which is not between 2 and ${data.version}.`);
      for (const id of added) if (!ids.has(id)) errors.push(`Version ${version} added ${id}, which is not a template item.`);
    }
    return errors;
  },
  compatible(previous, next) {
    const errors: string[] = [];
    if (next.version < previous.version) errors.push(`The template version never goes back (it is ${previous.version}).`);
    // What a version added is history: existing price books were upgraded by it.
    for (const [version, added] of Object.entries(previous.added_item_ids)) {
      if (JSON.stringify(next.added_item_ids[version] || []) !== JSON.stringify(added)) errors.push(`What version ${version} added never changes.`);
    }
    // A new item reaches existing price books only through a new version that lists it.
    const before = new Set(previous.catalog.items.map((entry) => entry.id));
    const listed = new Set(Object.entries(next.added_item_ids).filter(([version]) => Number(version) > previous.version).flatMap(([, ids]) => ids));
    for (const entry of next.catalog.items) {
      if (!before.has(entry.id) && !listed.has(entry.id)) errors.push(`${entry.id} is new: raise the version above ${previous.version} and list it in added_item_ids under the new version, so existing price books gain it.`);
    }
    return errors;
  }
};
