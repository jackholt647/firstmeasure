import type { Generator } from "./index.js";
import { PRESENTATION_DECK_KIND } from "../kinds/presentation-deck.js";

/** The roofing sales decks seedInstantRoofingDocuments published (signup-sandbox/roofing-documents.ts). */
export const ROOFING_DECKS: Record<string, string> = { itemized: "Roof replacement presentation", options: "Good / Better / Best presentation", gutters: "Gutter replacement presentation" };

/** One-shot: each deck the roofing presentation library builds (doc-present/templates/roofing-presentation.js). */
export const presentationDeckGenerator: Generator = {
  kind: PRESENTATION_DECK_KIND,
  async run() {
    const { roofingPresentationLayout } = await import("../../documents/modules/presentation-presets.js");
    return Object.entries(ROOFING_DECKS).map(([deck, name]) => ({ id: `roofing_${deck}`, data: { name, layout: roofingPresentationLayout(deck) } }));
  }
};
