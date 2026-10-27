import type { Generator } from "./index.js";
import { DEFAULT_PRICEBOOK_TEMPLATE, TEMPLATE_ADDED_ITEM_IDS } from "../../pricebook/default_template.js";

/** The bundled price book template and the item ids each version added (pricebook/default_template.ts). */
export const pricebookTemplateGenerator: Generator = {
  kind: "pricebook_template",
  run: () => {
    const { key, version, name, description, catalog } = JSON.parse(JSON.stringify(DEFAULT_PRICEBOOK_TEMPLATE));
    const added = Object.fromEntries(Object.entries(TEMPLATE_ADDED_ITEM_IDS).map(([at, ids]) => [String(at), [...ids]]));
    return [{ id: key, data: { version, name, description, added_item_ids: added, catalog } }];
  }
};
