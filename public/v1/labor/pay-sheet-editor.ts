import { z } from "zod";
import { badRequest } from "../platform/errors.js";
import { readDocument } from "../platform/storage.js";
import { listMeasurementDefinitions, listMeasurementPartitions, listMeasurementSchemas } from "../platform/publication/measurement-schemas.js";
import { listWorkSchemas, workItem, workItemMeasure, workItemsForSchemas } from "../platform/publication/work-items.js";
import type { Assignee } from "./assignees.js";
import { capabilitiesFor, listDeclaredCapabilities } from "./capabilities.js";
import { evaluatePaySheet, listPaySheets, paySheetInputSchema, resolvePaySheetInputs, type PaySheet } from "./pay-sheets.js";
import { projectPayContext } from "./pay-sheet-publication.js";
import { projectScope, requiredWork } from "./scope-artifacts.js";

/**
 * What the pay sheet editor reads that is not a sheet: the words each kind of work speaks in, which assignees could
 * use a sheet they do not have, and a sheet that has not been saved priced against a real project. Everything here
 * reads only; saving and archiving stay with pay-sheets.ts.
 */

/**
 * Each kind of work as a pay sheet sees it: the measurements it selects (which part of which whole each one is, so
 * counting can be told from adjusting) and the work items and functions its jobs require. The same dictionary the
 * data layer publishes as measurement-schemas and work-items, put together for one screen. Reads nothing stored.
 */
export function paySheetKindsOfWork() {
  const definitions = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition]));
  const partitions = listMeasurementPartitions();
  const works = new Map(listWorkSchemas().map((schema) => [schema.id, schema]));
  const label = (id: string) => definitions.get(id)?.label || id;
  return {
    kinds: listMeasurementSchemas().map((schema) => ({
      id: schema.id, title: schema.title, description: schema.description,
      measurements: schema.measurements.map((entry) => {
        const definition = definitions.get(entry.definition)!;
        const partition = definition.slice ? partitions.find((candidate) => candidate.id === definition.slice!.partition) : undefined;
        return {
          definition: definition.id, label: definition.label, unit: definition.unit, description: definition.description, required: entry.required,
          // A family of keys (one per exact pitch) cannot be typed as one number.
          key: definition.key || "", per_structure: definition.levels.includes("structure"),
          ...(partition ? { part_of: { base: partition.of, base_label: label(partition.of), partition: partition.id, partition_label: partition.label, complete: partition.complete } } : {})
        };
      }),
      work: (works.get(schema.id)?.items || []).map((entry) => {
        const item = workItem(entry.item)!;
        const sizedBy = "fixed" in entry.quantity ? [] : entry.quantity.measurements;
        return {
          item: item.id, label: item.label, kind: item.kind, unit: item.unit, description: item.description, under: entry.under || "", optional: !!entry.optional,
          // The whole measurement this item's amount is, when it is exactly one: a pay line reading a part of it adjusts.
          measure: workItemMeasure([schema.id], item.id), sized_by: sizedBy.map((id) => ({ definition: id, label: label(id) })),
          ...(item.per_load_default !== undefined ? { per_load_default: item.per_load_default } : {})
        };
      })
    })),
    partitions: partitions.map((partition) => ({ ...partition, parts: [...definitions.values()].filter((definition) => definition.slice?.partition === partition.id).map((definition) => definition.id) }))
  };
}

const text = (value: unknown) => String(value ?? "").trim();
const key = (assignee: Assignee) => `${assignee.type}:${assignee.id}`;
/**
 * Every pay sheet, and for each assignee that has one or could have one, the kinds of work it is able to do, so a
 * list can show who has no sheet for work they do. Being able to do some of a kind of work's items is enough.
 * Assignees nobody has said anything about are left out: unknown is not the same as unable.
 */
export async function paySheetOverview(orgId: string) {
  const sheets = await listPaySheets(orgId);
  const candidates = new Map<string, Assignee>();
  for (const sheet of sheets) candidates.set(key(sheet.subject), sheet.subject);
  try {
    const { listResourceGroups } = await import("../workforce/storage.js"), { listOrganizationConnections } = await import("../connections/storage.js");
    for (const group of await listResourceGroups(orgId, {})) if (!group.archived_at && text(group.status) !== "archived") candidates.set(`resource_group:${text(group.id)}`, { type: "resource_group", id: text(group.id) });
    for (const connection of await listOrganizationConnections(orgId, {})) if (!connection.archived_at && text(connection.status) !== "archived") candidates.set(`organization_connection:${text(connection.id)}`, { type: "organization_connection", id: text(connection.id) });
  } catch { /* an organization without groups or companies has only the assignees its sheets name */ }
  // A person is only someone who could have a sheet once something has been said about what they can do.
  for (const declared of await listDeclaredCapabilities(orgId)) candidates.set(key(declared.assignee), declared.assignee);
  const capabilities = await capabilitiesFor(orgId, [...candidates.values()]);
  const kinds = listMeasurementSchemas().map((schema) => ({ id: schema.id, items: workItemsForSchemas([schema.id]) }));
  const assignees = [...candidates.values()].map((assignee) => {
    const able = capabilities.get(key(assignee));
    const granted = new Set([...(able?.schema_ids || []), ...(able?.scope_schema_ids || [])]);
    const capable = kinds.filter((kind) => granted.has(kind.id) || kind.items.some((item) => able?.items.includes(item))).map((kind) => kind.id);
    return { assignee, known: !!able?.known, capable_schema_ids: able?.known ? capable : [], sheet_ids: sheets.filter((sheet) => key(sheet.subject) === key(assignee)).map((sheet) => sheet.id) };
  });
  return { sheets, assignees };
}

const numbers = z.record(z.string().max(200), z.number().finite());
const legacy = z.record(z.string().max(120), z.object({ value: z.number().finite().nonnegative(), unit: z.string().max(40) }).strict());
export const paySheetTrialSchema = z.object({ sheet: z.unknown(), manual: numbers.optional(), fields: numbers.optional(), legacy_measurements: legacy.optional() }).strict();
/**
 * A sheet that may not be saved yet, priced against one project exactly as a saved one would be: the project's
 * measurements, the material on its lists, its fields and the work it requires, with numbers typed for the trial on
 * top. Says what each input read and which of the project's requirements the sheet pays for, includes or leaves open.
 * An unresolved line stays unresolved; nothing is priced at zero. Reads only.
 */
export async function tryPaySheet(orgId: string, projectId: string, input: unknown) {
  const parsed = paySheetTrialSchema.parse(input);
  const { expected_revision: _revision, ...draft } = paySheetInputSchema.parse(parsed.sheet);
  try { await readDocument(orgId, "projects", projectId); } catch { throw badRequest("project_unknown", "This project is unavailable."); }
  const saved = draft.id ? (await listPaySheets(orgId)).find((sheet) => sheet.id === draft.id) : undefined;
  const sheet: PaySheet = { ...draft, id: draft.id || "draft", revision: saved?.revision || 0 };
  const base = await projectPayContext(orgId, projectId, { fields: parsed.fields, manual: parsed.manual, legacy_measurements: parsed.legacy_measurements });
  const required = requiredWork((await projectScope(orgId, projectId)).sets, base);
  const context = { ...base, work: required.map((row) => ({ item: row.item, quantity: row.quantity })) };
  const evaluation = evaluatePaySheet(sheet, context);
  const states = new Map(evaluation.work.items.map((entry) => [entry.item, entry.state]));
  return {
    project_id: projectId,
    measurement_source: base.measurement_source,
    evaluation,
    inputs: resolvePaySheetInputs(sheet, context),
    // What this project requires and how this sheet stands to each: paid, included, provided, only adjusted, or open.
    required_work: required.map((row) => ({ item: row.item, label: row.label, kind: row.kind, unit: row.unit, quantity: row.quantity, state: states.get(row.item) || "open", in_kind: row.schemas.some((schema) => sheet.schema_ids.includes(schema)) }))
  };
}
