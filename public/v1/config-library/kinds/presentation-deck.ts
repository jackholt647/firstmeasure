import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { FMDocModel } from "../../documents/schemas.js";
import { PRESENTATION_DECK_KIND, entrySchema, jsonObject, plainText } from "./document-shared.js";

export { PRESENTATION_DECK_KIND };

/**
 * A sales presentation organizations start with (docs/architecture/config-library.md): a paged DocModel whose
 * slides are pages, played by the presentation player and edited in the presentation editor. An organization's
 * copy is published as the presentation module `preset_presentation_<id>` (documents/modules/presentation-service.ts
 * `ensurePresentationPreset`); once the organization publishes its own version, library changes no longer reach it.
 */
export const presentationDeckEntrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: plainText(2000).default(""),
  /** The slides: a document-model document (paged, or a fluid view). */
  layout: z.object({ schema_version: z.number().int().positive(), kind: z.enum(["document", "view"]) }).passthrough(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /** Whether the customer's choices come back for review or become the contract directly. */
  customer_contract: z.enum(["review", "direct"]).optional(),
  contract: jsonObject.optional()
}).strict();
export type PresentationDeckEntry = z.infer<typeof presentationDeckEntrySchema>;

export const presentationDeckKind: LibraryKind<PresentationDeckEntry> = {
  kind: PRESENTATION_DECK_KIND,
  title: "Presentation decks",
  description: "Sales presentations organizations start with. Each organization's copy is a presentation module; an untouched copy follows the library.",
  schema: entrySchema(presentationDeckEntrySchema),
  validate(data) {
    const checked = FMDocModel.validateDocument(data.layout);
    return checked.ok ? [] : checked.errors.slice(0, 20).map((error) => `layout.${error.path}: ${error.message}`);
  },
  titleOf: (data) => data.name,
  /** The dev player and editor harnesses (doc-present/dev-present*.html) load the decks directly. */
  browser: true,
  orgCopies: {
    status: async (orgId, ids) => (await import("../../documents/library-copies.js")).deckCopyStatus(orgId, ids),
    reset: async (ctx, id) => {
      const { ensureLibraryDeck } = await import("../../documents/library-copies.js");
      return await ensureLibraryDeck(ctx.orgId, id, { reset: true });
    }
  }
};
