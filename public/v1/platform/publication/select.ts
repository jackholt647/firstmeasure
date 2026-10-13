import { z } from "zod";
import { badRequest, PlatformError } from "../errors.js";
import { evaluateConditions, validateConditions } from "../../work/conditions.js";
import { authorizeSource, resolveDataExport } from "./providers.js";
import { contentHash, jsonClone, validateJson } from "./validation.js";
import type { DataResult, JsonSchema, PublicationContext, SourceIdentity, SourceRef } from "./contracts.js";

/**
 * A declared selection over a published collection: which rows, in which
 * period, in what order. Consumers state it as data and never filter in their
 * own code, so a provider can later answer it from an index without any
 * consumer changing. Until a provider implements `select`, the host answers it
 * by reading the collection and filtering here.
 *
 * `where` is the group form of the one condition contract (work/conditions.ts),
 * with fields as dot paths into the published row. Operators may be added;
 * the meaning of an existing operator never changes.
 */
const field = z.string().max(300).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, "Use a dot path into the published row.");
const instant = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), "Use an ISO date or date-time.");
type Where = { match?: "all" | "any"; rules: Array<Where | { field: string; operator: string; value?: unknown }> };
const where: z.ZodType<Where> = z.lazy(() => z.object({
  match: z.enum(["all", "any"]).optional(),
  rules: z.array(z.union([where, z.object({ field, operator: z.string().max(40), value: z.unknown().optional() }).strict()])).max(32)
}).strict());

export const selectionSchema = z.object({
  where: where.optional(),
  /** Rows whose date field falls in the period, both ends inclusive. A date without a time covers that whole UTC day. */
  period: z.object({ field, from: instant.optional(), through: instant.optional() }).strict()
    .refine((value) => value.from || value.through, "A period needs a start or an end.").optional(),
  orderBy: z.object({ field, direction: z.enum(["asc", "desc"]).default("asc") }).strict().optional(),
  /** More matches than this is an error, never a silently shortened result. */
  limit: z.number().int().min(1).max(5000).default(1000),
  /** The instant relative times such as `now-3d` are measured from. Pass it to make a selection repeatable. */
  asOf: instant.optional()
}).strict();
export type Selection = z.infer<typeof selectionSchema>;

/** `key` and `revision` are what a consumer records to know later whether a row it depended on has changed. */
export type SelectedRow = { key: string; revision: string; value: Record<string, unknown> };
export type SelectionResult = {
  status: "ready";
  rows: SelectedRow[];
  source: SourceIdentity;
  schemaVersion: string;
  capturedAt: string;
  provenance: Record<string, unknown>;
} | Exclude<DataResult, { status: "ready" }>;

const SCAN_PAGE = 200;
const SCAN_PAGES = 250;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function depth(group: Where, level = 1): number {
  return Math.max(level, ...group.rules.map((rule) => "rules" in rule ? depth(rule, level + 1) : level));
}

export function normalizeSelection(input: unknown): Selection {
  const parsed = selectionSchema.safeParse(input ?? {});
  if (!parsed.success) throw badRequest("selection_invalid", `Invalid selection: ${parsed.error.issues[0]?.message || "check its shape"}`);
  const selection = parsed.data;
  if (selection.where) {
    if (depth(selection.where) > 4) throw badRequest("selection_invalid", "A selection's conditions nest at most four levels.");
    const issues = validateConditions(selection.where, "where");
    if (issues.length) throw badRequest("selection_invalid", issues[0]!);
  }
  return selection;
}

function readField(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (
    value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
  ), row);
}

function inPeriod(row: Record<string, unknown>, period: NonNullable<Selection["period"]>) {
  const raw = readField(row, period.field);
  const at = typeof raw === "number" ? raw : typeof raw === "string" && raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(at)) return false;
  if (period.from && at < Date.parse(period.from)) return false;
  if (period.through && at > (DATE_ONLY.test(period.through) ? Date.parse(`${period.through}T23:59:59.999Z`) : Date.parse(period.through))) return false;
  return true;
}

function compare(left: unknown, right: unknown) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = left === undefined || left === null ? "" : String(left), b = right === undefined || right === null ? "" : String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function selected(value: Record<string, unknown>): SelectedRow {
  if (typeof value.id !== "string" || !value.id || value.id.length > 300) throw badRequest("selection_identity", "Selected exports must publish a stable id on every row.");
  const revision = typeof value.revision === "number" || typeof value.revision === "string" && value.revision ? String(value.revision) : `sha256:${contentHash(value)}`;
  return { key: value.id, revision, value };
}

function failure(error: unknown): Exclude<DataResult, { status: "ready" }> {
  if (error instanceof PlatformError) return { status: error.statusCode === 401 || error.statusCode === 403 ? "denied" : error.statusCode === 404 ? "missing" : "error", code: error.code, message: error.message };
  return { status: "error", code: "source_failed", message: "The published source could not be read." };
}

/** Whether a published export can answer a selection at all, and whether it does so from its own index. */
export function selectionSupport(ref: Pick<SourceRef, "provider" | "export" | "version">) {
  const { exported } = resolveDataExport(ref as SourceRef);
  return { selectable: !!(exported.select || exported.list || exported.schema.type === "array"), indexed: !!exported.select };
}

export async function selectPublishedData(ctx: PublicationContext, ref: SourceRef, input: unknown): Promise<SelectionResult> {
  try {
    const selection = normalizeSelection(input);
    if (ref.provider.startsWith("external.")) await (await import("../../integrations/publication.js")).loadConnectionPublications(ctx.organizationId);
    const { provider, exported } = resolveDataExport(ref);
    await authorizeSource(ctx, ref);
    if (ref.path || ref.revision) throw badRequest("source_list_selector", "A selection cannot name a value path or revision.");
    validateJson(exported.argsSchema || { type: "object", additionalProperties: false }, ref.args || {}, "source arguments");
    const itemSchema = exported.listItemSchema || (exported.schema.type === "array" ? exported.schema.items as JsonSchema : exported.schema);
    const asRow = (item: unknown) => {
      validateJson(itemSchema, item, "selected source item");
      if (!item || typeof item !== "object" || Array.isArray(item)) throw badRequest("selection_identity", "Selected exports must publish object rows.");
      return item as Record<string, unknown>;
    };

    let rows: SelectedRow[];
    let scanned = 0;
    let sourceRevision = "";
    if (exported.select) {
      const result = await exported.select(ctx, ref, selection);
      rows = result.items.map(asRow).map(selected);
      sourceRevision = result.revision || "";
    } else {
      const items: unknown[] = [];
      if (exported.list) {
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await exported.list(ctx, ref, { limit: SCAN_PAGE, cursor });
          if (page.items.length > SCAN_PAGE) throw badRequest("source_page_overflow", "Provider exceeded its page limit.");
          items.push(...page.items);
          cursor = page.nextCursor;
          if (cursor && ++pages >= SCAN_PAGES) throw badRequest("selection_scan_limit", `This source has more than ${SCAN_PAGE * SCAN_PAGES} rows and no index for selections yet. Narrow the source arguments.`);
        } while (cursor);
      } else {
        const whole = await exported.read(ctx, ref);
        if ("status" in whole) return whole;
        if (exported.schema.type !== "array" || !Array.isArray(whole.value)) throw badRequest("source_not_selectable", "This export does not publish a collection.");
        items.push(...whole.value);
      }
      scanned = items.length;
      const now = selection.asOf || new Date().toISOString();
      rows = items.map(asRow)
        .filter((row) => !selection.period || inPeriod(row, selection.period))
        .filter((row) => !selection.where || evaluateConditions(selection.where, row, { now, payloadFallback: false }))
        .map(selected);
    }
    if (rows.length > selection.limit) throw badRequest("selection_too_large", `The selection matches more than ${selection.limit} rows. Narrow it or raise its limit.`);
    const order = selection.orderBy;
    rows.sort((a, b) => (order ? compare(readField(a.value, order.field), readField(b.value, order.field)) * (order.direction === "desc" ? -1 : 1) : 0) || compare(a.key, b.key));
    return {
      status: "ready",
      rows: jsonClone(rows, 128_000_000),
      source: { ...jsonClone(ref), version: provider.version, revision: sourceRevision || `selection:${contentHash(rows.map((row) => [row.key, row.revision]))}` },
      schemaVersion: exported.schemaVersion,
      capturedAt: new Date().toISOString(),
      provenance: exported.select ? { selection: "indexed" } : { selection: "scan", scanned }
    };
  } catch (error) { return failure(error); }
}
