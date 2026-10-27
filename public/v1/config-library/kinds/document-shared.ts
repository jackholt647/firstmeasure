import { z } from "zod";
import type { ValidationContext } from "../contracts.js";
import { libraryEntries } from "../library.js";

/**
 * What the document kinds (`document_theme`, `document_template`, `document_workflow`, `presentation_deck`) share:
 * the names they use for each other and the check that one entry names another that exists.
 */
export const DOCUMENT_THEME_KIND = "document_theme";
export const DOCUMENT_TEMPLATE_KIND = "document_template";
export const DOCUMENT_WORKFLOW_KIND = "document_workflow";
export const PRESENTATION_DECK_KIND = "presentation_deck";

/** The module id an organization's copy of a presentation deck is published at (documents/modules/presentation-service.ts). */
export const PRESENTATION_PRESET_PREFIX = "preset_presentation_";

export const assetId = z.string().trim().regex(/^[a-z0-9][a-z0-9_.:-]{0,159}$/);
export const plainText = (max: number) => z.string().trim().max(max);
/** Any JSON object whose structure an existing validator owns (the document model, the workflow schema). */
export const jsonObject = z.record(z.unknown());

/**
 * A default that is adapted to an organization's price book when its copy is made: the parameter's default becomes
 * that item's unit price, in cents. The rate itself is never stored in the library.
 */
export const pricebookDefaultSchema = z.object({
  param: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
  item_id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/)
}).strict();

/**
 * An entry this one names, missing from the library. A kind with no entries at all is not yet loaded (the one
 * generation run checks every kind before any is written), so a name is only refused once its kind has entries.
 */
export function missingEntry(ctx: ValidationContext, kind: string, id: string) {
  if (ctx.registries.entry(kind, id)) return false;
  return libraryEntries(kind).length > 0;
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Errors for every data binding (`{ source: { provider, export } }`) under `value` that names nothing registered. */
export function bindingErrors(value: unknown, ctx: ValidationContext, at: string): string[] {
  const errors: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const source = asRecord(record.source);
    if (record.kind === "data" && typeof source.provider === "string" && typeof source.export === "string") {
      if (!ctx.registries.provider(source.provider)) errors.push(`${path}: no data provider ${source.provider}.`);
      else if (!ctx.registries.providerExport(source.provider, source.export)) errors.push(`${path}: ${source.provider} has no export ${source.export}.`);
      return;
    }
    for (const [key, child] of Object.entries(record)) if (child && typeof child === "object") walk(child, `${path}.${key}`);
  };
  walk(value, at);
  return errors;
}

/** A kind's schema as `LibraryKind.schema` takes it: parsing fills defaults, so its input type is wider than its output. */
export const entrySchema = <S extends z.ZodTypeAny>(schema: S) => schema as unknown as z.ZodType<z.output<S>>;
