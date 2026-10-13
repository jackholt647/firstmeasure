import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { listWorkSchemas, workItem, workRequirements, type WorkRequirement } from "../platform/publication/work-items.js";
import { materialsCommand, projectScopeSets, readMaterialsLedger } from "../materials/calculus.js";

/**
 * A project's scope is what its artifacts say it is, and nothing else.
 *
 * The scope set for a kind of work says what such a job could require and how each thing is sized. It does not say
 * what this job requires. That comes from the project's scope artifacts: the sets in its materials ledger, each
 * published by an accepted document's calculation, made by hand, or built by an agent. A set lists material lines
 * and, in `work`, the work items and functions this job includes. The project's scope is all of them added together.
 * A project with no artifact that names work has no work to do, however many roofs its measurements describe.
 */
export type ScopeSet = Awaited<ReturnType<typeof projectScopeSets>>[number];
export async function projectScope(orgId: string, projectId: string): Promise<{ sets: ScopeSet[] }> {
  return { sets: await projectScopeSets(orgId, projectId) };
}

export type RequiredWork = WorkRequirement & { sources: { set_id: string; title: string; origin: string }[] };
const placement = (item: string) => {
  const schemas = listWorkSchemas().filter((schema) => schema.items.some((entry) => entry.item === item));
  return { schemas: schemas.map((schema) => schema.id), under: schemas.flatMap((schema) => schema.items).find((entry) => entry.item === item)?.under || "", order: Math.min(...schemas.map((schema) => schema.items.findIndex((entry) => entry.item === item)), 9999) };
};
/**
 * The work and functions the artifacts add up to. An amount an artifact states is taken as stated, and stated amounts
 * add. An artifact that names an item without an amount means all of it, as the scope set sizes it from the project's
 * measurements; that is counted once however many artifacts say it, and stands over any stated amounts beside it.
 */
export function requiredWork(sets: ScopeSet[], context: { measurements?: unknown; fields?: Record<string, number> }): RequiredWork[] {
  const byItem = new Map<string, { stated: number; measured: boolean; sources: RequiredWork["sources"] }>();
  for (const set of sets) for (const entry of set.work) {
    if (!workItem(entry.item)) continue;
    const row = byItem.get(entry.item) || { stated: 0, measured: false, sources: [] };
    if (typeof entry.quantity === "number") row.stated += entry.quantity; else row.measured = true;
    if (!row.sources.some((source) => source.set_id === set.id)) row.sources.push({ set_id: set.id, title: set.title, origin: set.origin });
    byItem.set(entry.item, row);
  }
  return [...byItem.entries()].map(([item, row]) => {
    const definition = workItem(item)!, where = placement(item);
    // Sized with every item of its kind of work present, so an item that is only required where there is some of it
    // still reports its amount, or that the amount is unknown.
    const sized = row.measured ? workRequirements(where.schemas, context, { includeEmpty: true }).find((entry) => entry.item === item) : undefined;
    const quantity = row.measured ? sized?.quantity ?? null : row.stated;
    return {
      item, label: definition.label, kind: definition.kind, unit: definition.unit, description: definition.description, schemas: where.schemas, under: where.under,
      quantity, measure: row.measured ? sized?.measure || "" : "", sources: row.sources, order: where.order,
      reason: quantity === null ? `${definition.label} cannot be sized until this project has the measurements it is worked out from.` : ""
    };
  }).sort((a, b) => a.order - b.order).map(({ order: _order, ...row }) => row);
}

const item = z.string().trim().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(120);
export const manualScopeSchema = z.object({ work: z.array(z.object({ item, quantity: z.number().finite().nonnegative().max(1e9).optional() }).strict()).max(300) }).strict();
export const MANUAL_SCOPE_KEY = "manual_scope";
/**
 * Sets the work a person has added to this project by hand. It is an artifact like any other: one manual set in the
 * project's ledger whose calculation returns exactly what it was given, evaluated and applied through the ledger's
 * own commands, so it has the same history and the same revision checks as a set a document published.
 */
export async function saveManualScope(ctx: PublicationContext, projectId: string, input: unknown) {
  const parsed = manualScopeSchema.parse(input);
  const command = async (revision: number, operation: string, payload: Record<string, unknown>) => materialsCommand(ctx, projectId, { key: `scope_${operation}_${randomUUID()}`, expected_revision: revision, operation, input: payload });
  const view = await readMaterialsLedger(ctx, projectId);
  let revision = view.revision;
  let setId = (view.sets as unknown as { id: string; origin?: { type?: string }; definition?: { key?: string } }[]).find((set) => set.origin?.type === "manual" && set.definition?.key === MANUAL_SCOPE_KEY)?.id || "";
  if (!setId) {
    const created = await command(revision, "create", { definition: { type: "materials_calculus", key: MANUAL_SCOPE_KEY, title: "Added by hand", source: "return {outputs:{lines:[],warnings:[],work:inputs.values.work}};", defaults: { work: [] }, inputSchema: { type: "object", properties: { work: { type: "array" } }, required: ["work"], additionalProperties: false } } });
    revision = created.ledger.revision; setId = String((created.result as { set_id?: string }).set_id);
  }
  const evaluated = await command(revision, "evaluate", { set_id: setId, values: { work: parsed.work } });
  await command(evaluated.ledger.revision, "apply", { set_id: setId, evaluation_id: (evaluated.result as { evaluation_id?: string }).evaluation_id, reason: "Scope changed by hand" });
  return { set_id: setId, work: parsed.work };
}
