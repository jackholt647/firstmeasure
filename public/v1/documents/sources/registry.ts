import type { z } from "zod";

import type { JsonObject } from "../../platform/storage.js";
import type { WidgetResolveContext } from "../widgets/registry.js";

/**
 * Named data source registry (contract §8 "Sources"). A source turns platform
 * data (pricebook, materials, payments, measurements...) into normalized rows
 * usable anywhere an expression is: repeater `props.source`, param defaults,
 * workflow `options_from` — via the sugar string "source:<id>".
 *
 * Sources resolve SERVER-SIDE during resolveDocumentInstance and are frozen
 * into snapshots like widget data; documents never call the network.
 *
 * Injection mechanism: resolved rows are placed under the reserved param key
 * `params.__sources["<id>"]` and every literal "source:<id>" string in the
 * working definition/workflow is rewritten to the expression
 * "{{params.__sources['<id>']}}". This is the cleanest mechanism the shared
 * FMDocModel supports without library changes: resolveBindings builds its
 * scope from a fixed key set (params/outputs/computed/...) and does not thread
 * arbitrary extra scope keys through, so params carries the source payload.
 */

export type DocumentSourceContext = WidgetResolveContext;

export type DocumentSourceDefinition = {
  id: string;
  /** Optional zod schema for args; failing args resolve to []. */
  params_schema?: z.ZodTypeAny;
  /** Row-shape descriptor for editor/palette display (data only). */
  shape?: JsonObject;
  resolve: (ctx: DocumentSourceContext, args: JsonObject) => Promise<unknown>;
};

const registry = new Map<string, DocumentSourceDefinition>();

export function registerDocumentSource(id: string, definition: Omit<DocumentSourceDefinition, "id">) {
  const cleaned = String(id || "").trim().toLowerCase();
  if (!cleaned) throw new Error("registerDocumentSource requires an id.");
  registry.set(cleaned, { ...definition, id: cleaned });
}

export function documentSource(id: string): DocumentSourceDefinition | null {
  return registry.get(String(id || "").trim().toLowerCase()) || null;
}

export function listDocumentSources(): Array<{ id: string; shape: JsonObject }> {
  return [...registry.values()].map((source) => ({ id: source.id, shape: source.shape || {} }));
}

/**
 * Resolve a source to an array of rows. Unknown ids, arg validation failures
 * and resolver errors all degrade to [] — a missing source must never break a
 * document render.
 */
export async function resolveDocumentSource(id: string, ctx: DocumentSourceContext, args: JsonObject = {}): Promise<unknown[]> {
  const source = documentSource(id);
  if (!source) return [];
  let parsedArgs: JsonObject = args;
  if (source.params_schema) {
    const parsed = source.params_schema.safeParse(args);
    if (!parsed.success) return [];
    parsedArgs = (parsed.data && typeof parsed.data === "object" ? parsed.data : {}) as JsonObject;
  }
  try {
    const rows = await source.resolve(ctx, parsedArgs);
    return Array.isArray(rows) ? rows : rows === null || rows === undefined ? [] : [rows];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// "source:<id>" sugar scanning + rewriting
// ---------------------------------------------------------------------------

/** Reserved params key that carries resolved source rows into the scope. */
export const DOCUMENT_SOURCES_PARAM_KEY = "__sources";

const SOURCE_STRING_PATTERN = /^source:([a-z0-9_][a-z0-9_.:-]*)$/i;

/** The source id when a value is exactly a "source:<id>" sugar string. */
export function sourceIdFromString(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = SOURCE_STRING_PATTERN.exec(value.trim());
  return match?.[1] ? match[1].toLowerCase() : "";
}

/** Deep-scan arbitrary JSON values for unique "source:<id>" references. */
export function collectSourceIds(values: unknown[]): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      const id = sourceIdFromString(value);
      if (id) ids.add(id);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value as JsonObject)) visit(entry);
    }
  };
  for (const value of values) visit(value);
  return [...ids];
}

/** Expression a rewritten "source:<id>" string resolves through. */
export function sourceExpression(id: string) {
  return `{{params.${DOCUMENT_SOURCES_PARAM_KEY}['${String(id).replace(/'/g, "")}']}}`;
}

/**
 * Deep-rewrite "source:<id>" strings to their scope expressions. Returns a
 * new value; the input is not mutated.
 */
export function rewriteSourceStrings<T>(value: T): T {
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      const id = sourceIdFromString(entry);
      return id ? sourceExpression(id) : entry;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === "object") {
      const out: JsonObject = {};
      for (const [key, child] of Object.entries(entry as JsonObject)) out[key] = visit(child);
      return out;
    }
    return entry;
  };
  return visit(value) as T;
}
