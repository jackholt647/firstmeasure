import type { Generator } from "./index.js";
import { DOCUMENT_THEME_KIND } from "../kinds/document-theme.js";

/** One-shot: the three seeded themes (documents/seeds.ts THEME_SEEDS), before organization branding. */
export const documentThemeGenerator: Generator = {
  kind: DOCUMENT_THEME_KIND,
  async run() {
    const { THEME_SEEDS } = await import("../../documents/seeds.js");
    return THEME_SEEDS.map((seed) => ({ id: seed.id, data: { name: seed.name, description: seed.description, definition: seed.definition() } }));
  }
};
