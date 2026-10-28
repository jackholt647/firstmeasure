import { libraryEntries, libraryEntry } from "../config-library/library.js";
import { DEFAULT_TEMPLATE_KEY } from "./constants.js";
import { notFound } from "./errors.js";

/**
 * The bundled price book templates are config library entries of the kind `pricebook_template`
 * (config-library/kinds/pricebook_template.ts), keyed by template key; `default` is the one every market book is made
 * from. Each carries its version and the item ids each version added, which drive the additive upgrade of existing
 * market books and organization overlays (storage.ts). Values are frozen: clone before changing anything.
 */
export const PRICEBOOK_TEMPLATE_KIND = "pricebook_template";
export type PricebookTemplate = {
  key: string; version: number; name: string; description: string;
  added_item_ids: Record<string, string[]>;
  catalog: { taxonomy: Record<string, unknown>; items: Record<string, unknown>[]; variation_sets: unknown[]; assets: unknown[]; settings: Record<string, unknown>; metadata: Record<string, unknown> };
};

export function pricebookTemplate(key: string): PricebookTemplate | null {
  const entry = libraryEntry<Omit<PricebookTemplate, "key">>(PRICEBOOK_TEMPLATE_KIND, key);
  return entry ? { key: entry.id, ...entry.data } : null;
}
export function defaultPricebookTemplate(): PricebookTemplate {
  const template = pricebookTemplate(DEFAULT_TEMPLATE_KEY);
  if (!template) throw notFound("template_not_found", `The price book template '${DEFAULT_TEMPLATE_KEY}' is not in the config library.`);
  return template;
}
export function listPricebookTemplates(): PricebookTemplate[] {
  return libraryEntries<Omit<PricebookTemplate, "key">>(PRICEBOOK_TEMPLATE_KIND).map((entry) => ({ key: entry.id, ...entry.data }));
}
/** Item ids a template added after `version`. */
export function templateItemsAddedAfter(version: number, template = defaultPricebookTemplate()) {
  return Object.entries(template.added_item_ids).filter(([added]) => Number(added) > version).sort(([a], [b]) => Number(a) - Number(b)).flatMap(([, ids]) => ids);
}
