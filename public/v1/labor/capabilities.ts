import { z } from "zod";
import { listDocuments, upsertDocument, type JsonObject } from "../platform/storage.js";
import { listMeasurementSchemas, measurementSchemaIdsForScope } from "../platform/publication/measurement-schemas.js";
import { workItem, workItemsForSchemas } from "../platform/publication/work-items.js";
import { assigneeSchema, readAssignee, requireActor, requireAssignee, type Actor, type Assignee } from "./assignees.js";

/**
 * What an assignee is able to do, as work items, kept apart from how they are paid: a salaried employee has
 * capabilities and no pay sheet. Capabilities are granted the way permissions are. A kind of work grants every item
 * it requires; a scope the assignee is marked as doing grants the kinds of work that scope works in; single items can
 * be added or taken away on top. An assignee nobody has said anything about is unknown, which is not the same as
 * unable: nothing is reported against them.
 */
export const CAPABILITY_COLLECTION = "assignee_capabilities";
const item = z.string().trim().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(120);
export const capabilityInputSchema = z.object({
  assignee: assigneeSchema,
  /** Kinds of work the assignee does in full. */
  schema_ids: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  /** Single items on top of those. */
  item_ids: z.array(item).max(300).default([]),
  /** Items they do not do, even though a kind of work or a scope would grant them. */
  excluded_item_ids: z.array(item).max(300).default([]),
  expected_revision: z.number().int().nonnegative().optional()
}).strict().superRefine((value, context) => {
  const known = new Set(listMeasurementSchemas().map((schema) => schema.id));
  for (const schema of value.schema_ids) if (!known.has(schema)) context.addIssue({ code: z.ZodIssueCode.custom, message: `There is no kind of work called ${schema}.` });
  for (const id of [...value.item_ids, ...value.excluded_item_ids]) if (!workItem(id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `${id} is not in the work item dictionary.` });
});
export type Capabilities = {
  assignee: Assignee;
  schema_ids: string[]; item_ids: string[]; excluded_item_ids: string[]; revision: number;
  /** Kinds of work granted by the scopes the assignee is marked as doing. */
  scope_schema_ids: string[];
  /** Every item the assignee can do, once grants and exclusions are applied. */
  items: string[];
  /** False when nothing has been said about this assignee, so nothing can be concluded. */
  known: boolean;
};

const text = (value: unknown) => String(value ?? "").trim();
const key = (assignee: Assignee) => `${assignee.type}:${assignee.id}`;
type Declared = Pick<Capabilities, "assignee" | "schema_ids" | "item_ids" | "excluded_item_ids" | "revision">;
export async function listDeclaredCapabilities(orgId: string): Promise<Declared[]> {
  return (await listDocuments(orgId, CAPABILITY_COLLECTION)).map((document) => {
    const data = document.data as unknown as Omit<Declared, "revision">;
    return { assignee: data.assignee, schema_ids: data.schema_ids || [], item_ids: data.item_ids || [], excluded_item_ids: data.excluded_item_ids || [], revision: Number(document.revision || 0) };
  });
}
/** The kinds of work a set of scope templates works in. A scope that cannot be read grants nothing. */
async function scopeSchemas(orgId: string, branchId: string, scopeIds: string[], cache: Map<string, string[]>) {
  const { readScopeTemplateVersion } = await import("../scopes/storage.js");
  const found: string[] = [];
  for (const scopeId of scopeIds) {
    const cached = `${branchId}:${scopeId}`;
    if (!cache.has(cached)) cache.set(cached, measurementSchemaIdsForScope((await readScopeTemplateVersion(orgId, branchId || "default", scopeId).catch(() => null))?.definition));
    found.push(...cache.get(cached)!);
  }
  return [...new Set(found)];
}
function resolve(assignee: Assignee, declared: Declared | undefined, scopeSchemaIds: string[]): Capabilities {
  const granted = new Set([...workItemsForSchemas([...(declared?.schema_ids || []), ...scopeSchemaIds]), ...(declared?.item_ids || [])]);
  for (const excluded of declared?.excluded_item_ids || []) granted.delete(excluded);
  return {
    assignee, schema_ids: declared?.schema_ids || [], item_ids: declared?.item_ids || [], excluded_item_ids: declared?.excluded_item_ids || [], revision: declared?.revision || 0,
    scope_schema_ids: scopeSchemaIds, items: [...granted].sort(), known: !!declared || scopeSchemaIds.length > 0
  };
}
/** What several assignees can do, read together. Reads only. */
export async function capabilitiesFor(orgId: string, assignees: Assignee[]): Promise<Map<string, Capabilities>> {
  const declared = new Map((await listDeclaredCapabilities(orgId)).map((row) => [key(row.assignee), row]));
  const cache = new Map<string, string[]>(), out = new Map<string, Capabilities>();
  for (const assignee of assignees) {
    if (out.has(key(assignee))) continue;
    const record = (await readAssignee(orgId, assignee))?.record as JsonObject | undefined;
    const scopeIds = Array.isArray(record?.capability_scope_ids) ? (record!.capability_scope_ids as unknown[]).map(text).filter(Boolean) : [];
    out.set(key(assignee), resolve(assignee, declared.get(key(assignee)), scopeIds.length ? await scopeSchemas(orgId, text(record?.branch_id) || "default", scopeIds, cache) : []));
  }
  return out;
}
export async function assigneeCapabilities(orgId: string, assignee: Assignee): Promise<Capabilities> {
  await requireAssignee(orgId, assignee);
  return (await capabilitiesFor(orgId, [assignee])).get(key(assignee))!;
}
export async function saveCapabilities(orgId: string, input: unknown, actor: Actor): Promise<Capabilities> {
  requireActor(orgId, actor, "manage_company_settings", "capabilities_write_denied", "Changing what an assignee can do requires company settings access.");
  const parsed = capabilityInputSchema.parse(input);
  await requireAssignee(orgId, parsed.assignee);
  const { expected_revision, ...data } = parsed;
  await upsertDocument(orgId, CAPABILITY_COLLECTION, { id: key(parsed.assignee), ...(expected_revision !== undefined ? { expected_revision } : {}), data: { ...data, updated_by_user_id: text(actor.userId) } as unknown as JsonObject, metadata: { kind: "assignee_capabilities", subject_type: parsed.assignee.type, subject_id: parsed.assignee.id } }, { replace: true });
  return assigneeCapabilities(orgId, parsed.assignee);
}
