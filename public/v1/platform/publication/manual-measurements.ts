/**
 * Measurements entered by hand, for a project that has no completed measurement report.
 *
 * They are an ordinary measurement dataset (role `manual`, producer `manual`) holding dictionary keys, so everything
 * that reads the project's selected measurement dataset (material calculations, measurement defaults, pay sheets,
 * requirements, the schema assessment) reads them exactly as it reads a report. Which keys can be entered comes from
 * the measurement schemas the project's scope templates name; a project whose scopes name none has nothing to enter.
 *
 * Precedence (see `docs/architecture/measurement-schemas.md`): the project reads one selected dataset, never a mix.
 * Entries made by hand are selected only while no report is. A completed report replaces them on arrival
 * (`publishCompletedFirstMeasureDataset`); the entries stay stored and shown as the person's own until cleared, but are
 * never read again while the report is selected. Adjusting a report's numbers is the separate override mechanism.
 */
import { readDocument, upsertDocument } from "../storage.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import type { PublicationContext, TargetRef } from "./contracts.js";
import { authorizePublication } from "./context.js";
import { contentHash } from "./validation.js";
import { listProjectDatasets, readProjectDataset, saveProjectDataset, selectProjectDataset } from "./datasets.js";
import { listMeasurementDefinitions, listMeasurementPartitions, measurementEquivalents, measurementSchema, measurementSchemaIdsForScope, preferredEquivalent } from "./measurement-schemas.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});
const text = (value: unknown) => String(value ?? "").trim();
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export const MANUAL_MEASUREMENT_ROLE = "manual";
export const MANUAL_MEASUREMENT_SOURCE = "manual";
const writeAccess = { scopes: ["project"] as const, permissions: ["manage_project_data"], systemKinds: ["work", "module"] as const };

/** One dataset per project, so a retried or concurrent first save cannot create two. */
export function manualMeasurementDatasetId(organizationId: string, projectId: string) {
  return `dataset_manual_${contentHash({ organizationId, projectId }).slice(0, 32)}`;
}

export type ManualMeasurementField = {
  definition: string; key: string; label: string; unit: string; required: boolean; schemas: string[];
  /** `area`, `length`, or `part:<partition id>` for a part of a measurement (squares by pitch band). */
  group: string; group_label?: string;
  /** Equivalent measurements in other units (roof area for roof squares): not entered, stored from this one's value. */
  derives?: { definition: string; key: string; label: string; unit: string; factor: number }[];
};

/** What can be entered for these schemas: their project-level dictionary measurements with a key of their own, in schema order. */
export function manualMeasurementFields(schemaIds: string[]): ManualMeasurementField[] {
  const definitions = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition]));
  const partitions = new Map(listMeasurementPartitions().map((partition) => [partition.id, partition]));
  const fields = new Map<string, ManualMeasurementField>();
  for (const schemaId of schemaIds) {
    for (const entry of measurementSchema(schemaId).measurements) {
      // A measurement the dictionary declares equivalent to another (roof area and roof squares) is entered once, as the
      // equivalence's preferred member; the others are stored from it.
      const definition = definitions.get(preferredEquivalent(entry.definition));
      // A family of keys (squares at each exact pitch) has no single key to type into; its bands do.
      if (!definition?.key || !definition.levels.includes("project")) continue;
      const known = fields.get(definition.id);
      if (known) { known.required ||= entry.required; if (!known.schemas.includes(schemaId)) known.schemas.push(schemaId); continue; }
      const derives = measurementEquivalents(definition.id).map((other) => ({ ...other, label: definitions.get(other.definition)!.label }));
      const partition = definition.slice ? partitions.get(definition.slice.partition) : undefined;
      fields.set(definition.id, {
        definition: definition.id, key: definition.key, label: definition.label, unit: definition.unit, required: entry.required, schemas: [schemaId],
        group: partition ? `part:${partition.id}` : definition.unit === "ft" ? "length" : "area",
        ...(partition ? { group_label: partition.label } : {}),
        ...(derives.length ? { derives } : {})
      });
    }
  }
  return [...fields.values()];
}

/** The schemas this project's work is in: the scope templates its running work plans and its lists came from. */
export async function projectMeasurementSchemaIds(organizationId: string, projectId: string) {
  const [{ listPlanRecords }, { readScopeTemplateVersion }, { listProjectMaterialLists }] = await Promise.all([
    import("../../work/storage.js"), import("../../scopes/storage.js"), import("../../materials/storage.js")
  ]);
  const refs: [string, string, number | undefined][] = [];
  for (const plan of await listPlanRecords(organizationId, { project_id: projectId })) {
    if (text(plan.status) === "canceled" || !text(plan.template_id)) continue;
    refs.push([text(plan.branch_id) || "default", text(plan.template_id), Number(plan.template_version) || undefined]);
  }
  for (const list of await listProjectMaterialLists(organizationId, projectId)) {
    if (text(list.status) === "archived" || !text(list.scope_template_id) || text(list.scope_template_id) === "manual") continue;
    refs.push([text(list.branch_id) || "default", text(list.scope_template_id), undefined]);
  }
  const found: string[] = [], seen = new Set<string>();
  for (const [branchId, templateId, version] of refs) {
    const key = `${branchId}:${templateId}:${version || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const template = await readScopeTemplateVersion(organizationId, branchId, templateId, version).catch(() => null)
      || (version ? await readScopeTemplateVersion(organizationId, branchId, templateId).catch(() => null) : null);
    for (const id of measurementSchemaIdsForScope(obj(template).definition)) if (!found.includes(id)) found.push(id);
  }
  return found;
}

const numbers = (measurements: unknown) => Object.fromEntries(Object.entries(obj(measurements))
  .filter(([, entry]) => typeof obj(entry).value === "number" && Number.isFinite(obj(entry).value as number))
  .map(([key, entry]) => [key, obj(entry).value as number]));

function linkedReport(project: Obj) {
  const measurement = obj(project.measurement_project || project.measurement), raw = obj(measurement.raw);
  return text(measurement.id || measurement.project_id || raw.id || raw.project_id || project.measurement_project_id || project.folder);
}

/**
 * Everything the manual measurements editor shows: the fields the project's schemas ask for, the person's entries, and
 * which dataset the project reads now (`in_use.source`: `manual`, `report`, `other` or `none`) with its values.
 */
export async function readManualMeasurements(ctx: PublicationContext, projectId: string) {
  const target: TargetRef = { scope: "project", organizationId: ctx.organizationId, projectId };
  const datasets = await listProjectDatasets(ctx, target);
  const project = await readDocument(ctx.organizationId, "projects", projectId);
  const schemaIds = await projectMeasurementSchemaIds(ctx.organizationId, projectId);
  const fields = manualMeasurementFields(schemaIds);
  const manualId = manualMeasurementDatasetId(ctx.organizationId, projectId);
  const manualRow = datasets.find((row) => row.id === manualId);
  const manualRecord = manualRow ? await readProjectDataset(ctx, { ...target, id: manualId }) : null;
  const selectedId = text(obj(obj(project.data).dataset_defaults).measurements);
  const selectedRow = datasets.find((row) => row.id === selectedId);
  const source = !selectedRow ? "none" : selectedRow.role === MANUAL_MEASUREMENT_ROLE ? "manual" : selectedRow.role.startsWith("firstmeasure:") ? "report" : "other";
  const selected = selectedRow ? (selectedRow.id === manualId && manualRecord ? manualRecord : await readProjectDataset(ctx, { ...target, id: selectedRow.id })) : null;
  return {
    available: fields.length > 0,
    schemas: schemaIds.map((id) => { const schema = measurementSchema(id); return { id: schema.id, title: schema.title }; }),
    fields,
    manual: manualRecord ? {
      dataset_id: manualRecord.id, store_revision: Number(manualRecord.storeRevision), revision: manualRecord.revision,
      values: numbers(obj(manualRecord.value).measurements),
      updated_at: manualRecord.createdAt, updated_by: text(obj(manualRecord.provenance).entered_by)
    } : null,
    in_use: { source, dataset_id: selectedRow?.id || "", values: selected ? numbers(obj(selected.value).measurements) : {} },
    report_linked: !!linkedReport(obj(project.data))
  };
}

export type ManualMeasurementInput = { values: Record<string, number | null>; expectedRevision?: number };

/**
 * The one writer of measurements entered by hand. A number sets a key, null clears it; only keys the project's schemas
 * ask for are accepted, in the dictionary's unit. The entries are selected as the project's measurements only while no
 * other dataset is selected, and unselected when the last one is cleared, so a report is never displaced by them.
 */
export async function saveManualMeasurements(ctx: PublicationContext, projectId: string, input: ManualMeasurementInput) {
  const target: TargetRef = { scope: "project", organizationId: ctx.organizationId, projectId };
  await authorizePublication(ctx, target, writeAccess, "measurements.manual.save");
  if (ctx.mode !== "command") throw forbidden("manual_measurements_mode", "Saving measurements requires command execution.");
  const fields = new Map(manualMeasurementFields(await projectMeasurementSchemaIds(ctx.organizationId, projectId)).map((field) => [field.key, field]));
  if (!fields.size) throw badRequest("manual_measurements_unavailable", "This project's scopes name no measurement schema, so there is nothing to enter.");
  // A value given for an equivalent of an entered measurement (roof area for roof squares) is taken as that measurement.
  const aliases = new Map<string, { key: string; factor: number }>();
  for (const field of fields.values()) for (const other of field.derives || []) aliases.set(other.key, { key: field.key, factor: 1 / other.factor });
  const changes = Object.entries(obj(input.values)).map(([key, value]): [string, unknown] => {
    const alias = aliases.get(key);
    return alias ? [alias.key, typeof value === "number" ? round(value * alias.factor) : value] : [key, value];
  });
  if (!changes.length) throw badRequest("manual_measurements_empty", "Give at least one measurement to set or clear.");
  for (const [key, value] of changes) {
    if (!fields.has(key)) throw badRequest("manual_measurement_unknown", `${key} is not a measurement this project's scopes ask for.`);
    if (value !== null && !(typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e9)) throw badRequest("manual_measurement_invalid", `${fields.get(key)!.label} must be a number of zero or more.`);
  }
  const id = manualMeasurementDatasetId(ctx.organizationId, projectId);
  const existing = (await listProjectDatasets(ctx, target)).find((row) => row.id === id);
  if (input.expectedRevision && Number(existing?.storeRevision || 0) !== input.expectedRevision) throw conflict("revision_conflict", "These measurements were changed by someone else. Reload them and try again.");
  const previous = existing ? await readProjectDataset(ctx, { ...target, id }) : null;
  const before = obj(obj(previous?.value).measurements);
  const after: Obj = { ...before };
  for (const [key, value] of changes) {
    const field = fields.get(key)!;
    // Equivalents are stored beside the entered value, so every reader finds whichever unit it reads.
    for (const other of field.derives || []) {
      if (value === null) delete after[other.key];
      else after[other.key] = { value: round((value as number) * other.factor), unit: other.unit, source: MANUAL_MEASUREMENT_SOURCE };
    }
    if (value === null) delete after[key];
    else after[key] = { value, unit: field.unit, source: MANUAL_MEASUREMENT_SOURCE };
  }
  const beforeValues = numbers(before), afterValues = numbers(after);
  const changed = [...new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)])].filter((key) => beforeValues[key] !== afterValues[key]).sort();
  let saved: { revision: string; storeRevision: number } | null = previous ? { revision: previous.revision, storeRevision: Number(previous.storeRevision) } : null;
  if (changed.length) {
    saved = await saveProjectDataset(ctx, { ...target, id }, {
      id, name: "Entered by hand", type: "measurements", schemaVersion: "1", role: MANUAL_MEASUREMENT_ROLE, value: { measurements: after },
      provenance: { producer: MANUAL_MEASUREMENT_SOURCE, entered_by: text(ctx.auth?.userId), entered_at: new Date().toISOString() },
      ...(existing ? { expectedRevision: Number(existing.storeRevision) } : {})
    });
  }
  // Selection follows the precedence rule: entries made by hand never replace another selected dataset.
  const project = await readDocument(ctx.organizationId, "projects", projectId);
  const defaults = obj(obj(project.data).dataset_defaults), selected = text(defaults.measurements);
  const hasValues = Object.keys(afterValues).length > 0;
  let inUse: "manual" | "other" | "none" = selected === id ? "manual" : selected ? "other" : "none";
  if (hasValues && !selected) { await selectProjectDataset(ctx, target, "measurements", id, Number(project.revision)); inUse = "manual"; }
  else if (!hasValues && selected === id) {
    const { measurements: _cleared, ...rest } = defaults;
    await upsertDocument(ctx.organizationId, "projects", { id: projectId, expected_revision: Number(project.revision), data: { dataset_defaults: rest } });
    inUse = "none";
  }
  if (changed.length) {
    const { recordProjectChange } = await import("../../history/storage.js");
    await recordProjectChange(ctx.organizationId, {
      project_id: projectId, domain: "measurements", subject_type: "measurement_dataset", subject_id: id, op: "values",
      summary: "Measurements entered by hand", before: { values: beforeValues }, after: { values: afterValues, in_use: inUse }, diff: { changed }
    });
  }
  return { datasetId: id, revision: saved?.revision || "", storeRevision: saved?.storeRevision || 0, values: afterValues, inUse, changed };
}
