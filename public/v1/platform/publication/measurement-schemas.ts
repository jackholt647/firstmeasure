import { libraryEntries, libraryVersion } from "../../config-library/library.js";
import { badRequest } from "../errors.js";
import type { JsonSchema } from "./contracts.js";
import { registerDataProvider } from "./providers.js";
import { contentHash, jsonClone } from "./validation.js";

/**
 * One shared dictionary of what can be measured, and per kind of work a schema that selects from it.
 *
 * A definition is the meaning of a measurement: "roof area in square feet". It is defined once. A schema
 * ("roofing", "siding") lists the definitions that kind of work speaks in and which of them it cannot do
 * without. Two schemas share a measurement by naming the same definition, so nothing has to be reconciled when
 * an organization does both kinds of work. Producers (FirstMeasure, manual entry, another tool) fill the keys;
 * documents, material calculations and pay sheets bind to them. The producer does not own the names.
 */
export type MeasurementLevel = "project" | "structure";
export type MeasurementDefinition = {
  /** Stable meaning, e.g. `roof.ridge_length`. */
  id: string;
  /** The key a measurement dataset stores it under. A family of keys uses `keyPattern` instead. */
  key?: string;
  keyPattern?: string;
  label: string;
  unit: string;
  /** Where it can be measured. A per-structure value also rolls up into the project total. */
  levels: MeasurementLevel[];
  /**
   * A banded measurement that can be worked out when its own key is absent: the sum of another definition's keys
   * whose number falls in the band. Producers differ in whether they write the band or the exact pitches.
   */
  derive?: { from: string; above: number; upTo: number | null };
  /**
   * This measurement is a part of another one: the same thing measured, narrowed by one attribute. Squares over 8/12
   * are roof squares narrowed by pitch. Naming the partition is what lets a consumer know that two measurements
   * overlap, or that a set of them adds up to the whole, without being told case by case.
   */
  slice?: { partition: string };
  description: string;
};
/**
 * One way of cutting a base measurement into parts by an attribute of the building: roof squares by pitch band, by
 * exact pitch, by how the material reaches the roof. Parts of one partition never overlap each other. Parts of two
 * different partitions of the same base always may: ten hand-carried squares are ten of the same squares the pitch
 * bands already count, not ten more. A complete partition's parts add up to the base.
 */
export type MeasurementPartition = { id: string; of: string; dimension: string; label: string; complete: boolean; description: string };
export type MeasurementSchema = {
  id: string;
  version: string;
  title: string;
  description: string;
  measurements: { definition: string; required: boolean }[];
};

/**
 * Two or more definitions that are the same quantity of the same thing, stated in different units (roof squares and
 * roof area). Declaring this is an addition to the dictionary: neither definition changes. The first listed is the one a
 * person enters; the others follow from it. Parts of a partition are never equivalent to anything (they are parts).
 * `id` names it in the config library; it defaults to the first member's id.
 */
export type MeasurementEquivalence = { id?: string; measurements: string[]; description: string };

/**
 * The dictionary is data: config library entries of the kinds measurement_definition, measurement_partition,
 * measurement_equivalence and measurement_schema (config-library/kinds/), edited on dev and checked in as the
 * snapshot. It is rebuilt from them whenever the library changes (`libraryVersion`), so every read below is
 * synchronous and current. The register* functions add to it in this process only (tests use them to check the
 * dictionary's rules); what they add is kept across rebuilds.
 */
type Dictionary = {
  definitions: Map<string, MeasurementDefinition>;
  partitions: Map<string, MeasurementPartition>;
  schemas: Map<string, MeasurementSchema>;
  equivalences: (MeasurementEquivalence & { id: string })[];
  /** Exact dataset keys, then key families. One key has one meaning. */
  keys: Map<string, MeasurementDefinition>;
  patterns: { definition: MeasurementDefinition; pattern: RegExp }[];
};
const emptyDictionary = (): Dictionary => ({ definitions: new Map(), partitions: new Map(), schemas: new Map(), equivalences: [], keys: new Map(), patterns: [] });
const ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ID_ORDER = new Intl.Collator("en", { numeric: true });
export const MEASUREMENT_LIBRARY_KINDS = { definition: "measurement_definition", partition: "measurement_partition", equivalence: "measurement_equivalence", schema: "measurement_schema" } as const;

let dictionary = emptyDictionary();
let builtAt = -1;
const localAdditions: Array<(target: Dictionary) => void> = [];
function dict(): Dictionary {
  const version = libraryVersion();
  if (version !== builtAt) {
    builtAt = version;
    dictionary = buildDictionary();
    for (const add of localAdditions) { try { add(dictionary); } catch { /* no longer fits the library's dictionary */ } }
  }
  return dictionary;
}
/** The dictionary from the library: whole measurements, then partitions, then their parts, then equivalences and schemas. */
function buildDictionary() {
  const target = emptyDictionary();
  const problems: string[] = [];
  const attempt = (what: string, add: () => void) => { try { add(); } catch (error) { problems.push(`${what}: ${(error as Error).message}`); } };
  const definitions = libraryEntries<Omit<MeasurementDefinition, "id">>(MEASUREMENT_LIBRARY_KINDS.definition).map((entry) => ({ ...entry.data, id: entry.id }) as MeasurementDefinition);
  for (const definition of definitions.filter((entry) => !entry.slice)) attempt(definition.id, () => addDefinition(target, definition));
  for (const entry of libraryEntries<Omit<MeasurementPartition, "id">>(MEASUREMENT_LIBRARY_KINDS.partition)) attempt(entry.id, () => addPartition(target, { ...entry.data, id: entry.id } as MeasurementPartition));
  for (const definition of definitions.filter((entry) => entry.slice)) attempt(definition.id, () => addDefinition(target, definition));
  // Listed by id with numbers compared as numbers, so parts read in order (squares over 2/12 before over 12/12).
  target.definitions = new Map([...target.definitions].sort(([a], [b]) => ID_ORDER.compare(a, b)));
  for (const entry of libraryEntries<MeasurementEquivalence>(MEASUREMENT_LIBRARY_KINDS.equivalence)) attempt(entry.id, () => addEquivalence(target, { ...entry.data, id: entry.id }));
  for (const entry of libraryEntries<Omit<MeasurementSchema, "id">>(MEASUREMENT_LIBRARY_KINDS.schema)) attempt(entry.id, () => addSchema(target, { ...entry.data, id: entry.id } as MeasurementSchema));
  // Entries are checked when they are saved, so this only happens to a snapshot or store written some other way.
  if (problems.length) console.error(`Measurement dictionary: ${problems.length} library entries were left out. ${problems.join(" ")}`);
  return target;
}

function addPartition(target: Dictionary, partition: MeasurementPartition) {
  if (!ID.test(partition.id) || !ID.test(partition.dimension) || !partition.label.trim()) throw badRequest("measurement_partition_invalid", "A partition needs a stable id, the attribute it cuts by and a label.");
  if (target.partitions.has(partition.id)) throw badRequest("measurement_partition_duplicate", `Partition ${partition.id} is already defined.`);
  const base = target.definitions.get(partition.of);
  if (!base) throw badRequest("measurement_partition_unknown_base", `Partition ${partition.id} cuts ${partition.of}, which is not in the dictionary.`);
  // A part of a part would need the overlap of two attributes, which is only known where someone measured it.
  if (base.slice) throw badRequest("measurement_partition_invalid", `Partition ${partition.id} must cut a whole measurement, and ${partition.of} is itself a part.`);
  target.partitions.set(partition.id, Object.freeze(jsonClone(partition)));
}
function keyOwner(target: Dictionary, key: string) {
  return target.keys.get(key) || target.patterns.find((entry) => entry.pattern.test(key))?.definition || null;
}
function addDefinition(target: Dictionary, definition: MeasurementDefinition) {
  if (!ID.test(definition.id) || !definition.label.trim() || !definition.unit.trim() || !definition.levels.length) throw badRequest("measurement_definition_invalid", "A measurement needs a stable id, a label, a unit and a level.");
  if (!definition.key === !definition.keyPattern) throw badRequest("measurement_definition_invalid", "A measurement has either one key or one key pattern.");
  const pattern = definition.keyPattern ? new RegExp(definition.keyPattern) : null;
  if (definition.slice) {
    const partition = target.partitions.get(definition.slice.partition);
    if (!partition) throw badRequest("measurement_definition_invalid", `Measurement ${definition.id} names partition ${definition.slice.partition}, which is not defined.`);
    if (target.definitions.get(partition.of)!.unit !== definition.unit) throw badRequest("measurement_definition_invalid", `Measurement ${definition.id} is a part of ${partition.of} and must be in its unit.`);
  }
  if (target.definitions.has(definition.id)) throw badRequest("measurement_definition_duplicate", `Measurement ${definition.id} is already defined.`);
  // One key, one meaning: two definitions may not claim the same dataset key.
  if (definition.key && keyOwner(target, definition.key)) throw badRequest("measurement_key_claimed", `Key ${definition.key} already belongs to ${keyOwner(target, definition.key)!.id}.`);
  const frozen = Object.freeze(jsonClone(definition));
  target.definitions.set(definition.id, frozen);
  if (frozen.key) target.keys.set(frozen.key, frozen);
  else target.patterns.push({ definition: frozen, pattern: pattern! });
}
function addSchema(target: Dictionary, schema: MeasurementSchema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema.id) || !schema.version || !schema.title.trim() || !schema.measurements.length) throw badRequest("measurement_schema_invalid", "A measurement schema needs an id, a version, a title and at least one measurement.");
  if (target.schemas.has(schema.id)) throw badRequest("measurement_schema_duplicate", `Measurement schema ${schema.id} is already registered.`);
  const seen = new Set<string>();
  for (const entry of schema.measurements) {
    if (!target.definitions.has(entry.definition)) throw badRequest("measurement_schema_unknown_definition", `Schema ${schema.id} names ${entry.definition}, which is not in the dictionary.`);
    if (seen.has(entry.definition)) throw badRequest("measurement_schema_invalid", `Schema ${schema.id} lists ${entry.definition} twice.`);
    seen.add(entry.definition);
  }
  target.schemas.set(schema.id, Object.freeze(jsonClone(schema)));
}
function addEquivalence(target: Dictionary, equivalence: MeasurementEquivalence) {
  const members = equivalence.measurements.map((id) => target.definitions.get(id));
  if (members.length < 2 || members.some((definition) => !definition)) throw badRequest("measurement_equivalence_invalid", "An equivalence names two or more defined measurements.");
  const quantity = UNIT_SCALES[members[0]!.unit]?.quantity;
  for (const definition of members) {
    if (!definition!.key || definition!.slice || !quantity || UNIT_SCALES[definition!.unit]?.quantity !== quantity) throw badRequest("measurement_equivalence_invalid", `${definition!.id} cannot be equivalent: it needs its own key, no partition, and a unit of the same kind.`);
    if (target.equivalences.some((existing) => existing.measurements.includes(definition!.id))) throw badRequest("measurement_equivalence_duplicate", `${definition!.id} is already in an equivalence.`);
  }
  target.equivalences.push(Object.freeze(jsonClone({ ...equivalence, id: equivalence.id || equivalence.measurements[0]! })));
}
/** Adds to the dictionary in this process only, with the dictionary's rules. Library entries are the dictionary. */
function addLocally(add: (target: Dictionary) => void) { add(dict()); localAdditions.push(add); }
export function registerMeasurementPartition(partition: MeasurementPartition) { addLocally((target) => addPartition(target, partition)); }
export function registerMeasurementDefinition(definition: MeasurementDefinition) { addLocally((target) => addDefinition(target, definition)); }
export function registerMeasurementSchema(schema: MeasurementSchema) { addLocally((target) => addSchema(target, schema)); }
export function registerMeasurementEquivalence(equivalence: MeasurementEquivalence) { addLocally((target) => addEquivalence(target, equivalence)); }

export function listMeasurementPartitions() { return [...dict().partitions.values()].map((partition) => jsonClone(partition)); }
/** The whole measurement a definition is a part of, or the definition itself when it is not a part of anything. */
export function measurementBase(definitionId: string): string {
  const { definitions, partitions } = dict();
  const slice = definitions.get(definitionId)?.slice;
  return slice ? partitions.get(slice.partition)!.of : definitionId;
}
/**
 * How the first measurement stands to the second. `part`: it is cut from it. `whole`: the second is cut from it.
 * `disjoint`: two parts of one partition, which never share anything. `overlap`: two parts of different partitions of
 * the same base, which may count the same thing. `unrelated`: different things measured.
 */
export function measurementRelation(first: string, second: string): "same" | "part" | "whole" | "disjoint" | "overlap" | "unrelated" {
  if (first === second) return "same";
  const { definitions } = dict();
  const a = definitions.get(first), b = definitions.get(second);
  if (!a || !b || measurementBase(first) !== measurementBase(second)) return "unrelated";
  if (!b.slice) return "part";
  if (!a.slice) return "whole";
  return a.slice.partition === b.slice.partition ? "disjoint" : "overlap";
}
/**
 * Whether a set of measurements accounts for all of a base measurement, part of it, or none of it. All of it means
 * the base itself is in the set, or every part of one complete partition is. Parts of different partitions are never
 * added together, because they may count the same thing.
 */
export function measurementCover(baseId: string, definitionIds: string[]): "whole" | "part" | "none" {
  if (measurementWhole(baseId, definitionIds).length) return "whole";
  const { definitions } = dict();
  return definitionIds.some((id) => definitions.has(id) && measurementBase(id) === baseId) ? "part" : "none";
}
/**
 * The measurements in a set that between them are all of a base measurement: the base itself, or else every part of
 * one complete partition. Empty when the set does not add up to the whole. Anything else in the set that is a part of
 * the same base counts some of the same thing again.
 */
export function measurementWhole(baseId: string, definitionIds: string[]): string[] {
  const { definitions, partitions } = dict();
  const set = new Set(definitionIds.filter((id) => definitions.has(id) && measurementBase(id) === baseId));
  if (set.has(baseId)) return [baseId];
  for (const partition of partitions.values()) {
    if (partition.of !== baseId || !partition.complete) continue;
    const parts = [...definitions.values()].filter((definition) => definition.slice?.partition === partition.id);
    if (parts.length && parts.every((definition) => set.has(definition.id))) return parts.map((definition) => definition.id);
  }
  return [];
}
/**
 * Units of the same kind of quantity, as a multiple of that kind's base unit. Only units listed here convert, and only
 * between definitions declared equivalent; a value is never converted because its unit merely looks similar.
 */
const UNIT_SCALES: Record<string, { quantity: string; factor: number }> = {
  ft: { quantity: "length", factor: 1 },
  ft2: { quantity: "area", factor: 1 },
  roofing_square: { quantity: "area", factor: 100 }
};
/** Every declared equivalence, ordered by id. */
export function listMeasurementEquivalences() { return dict().equivalences.map((equivalence) => jsonClone(equivalence)); }
/** The kind of quantity a unit measures (length, area), or null for a unit that never converts. */
export function unitQuantity(unit: string) { return UNIT_SCALES[unit]?.quantity ?? null; }
/** The definitions equivalent to this one, each with the factor that turns a value of this one into a value of that one. */
export function measurementEquivalents(definitionId: string): { definition: string; key: string; unit: string; factor: number }[] {
  const { definitions, equivalences } = dict();
  const group = equivalences.find((equivalence) => equivalence.measurements.includes(definitionId));
  const own = definitions.get(definitionId);
  if (!group || !own) return [];
  return group.measurements.filter((id) => id !== definitionId).map((id) => {
    const other = definitions.get(id)!;
    return { definition: id, key: other.key!, unit: other.unit, factor: UNIT_SCALES[own.unit]!.factor / UNIT_SCALES[other.unit]!.factor };
  });
}
/** The member of an equivalence a person enters (the first listed), or the definition itself when it has none. */
export function preferredEquivalent(definitionId: string) {
  return dict().equivalences.find((equivalence) => equivalence.measurements.includes(definitionId))?.measurements[0] || definitionId;
}
export function listMeasurementDefinitions() { return [...dict().definitions.values()].map((definition) => jsonClone(definition)); }
export function listMeasurementSchemas() { return [...dict().schemas.values()].map((schema) => jsonClone(schema)); }
export function measurementSchema(id: string) {
  const schema = dict().schemas.get(id);
  if (!schema) throw badRequest("measurement_schema_unknown", `There is no measurement schema called ${id}.`);
  return jsonClone(schema);
}
export function definitionForKey(key: string) { return keyOwner(dict(), key); }
/** The schemas a scope template works in. Templates carry `measurement_schema_ids`; one without them is unscoped. */
export function measurementSchemaIdsForScope(template: unknown): string[] {
  const ids = template && typeof template === "object" ? (template as Record<string, unknown>).measurement_schema_ids : null;
  const { schemas } = dict();
  return Array.isArray(ids) ? [...new Set(ids.map(String).filter((id) => schemas.has(id)))] : [];
}

type Value = { value: number | null; unit: string; status?: string; source?: string };
const numberIn = (key: string) => { const match = key.match(/\d+(?:\.\d+)?/); return match ? Number(match[0]) : null; };
/**
 * The amount recorded for one definition in one set of measurements (a project's totals, or one structure's), or null
 * when nothing usable is there. A value in another unit is not this measurement. A band with no key of its own is
 * summed from the exact values that fall inside it. This is the only place a measurement is read as a number.
 */
export function measurementAmount(source: unknown, definitionId: string): number | null {
  const { definitions } = dict();
  const definition = definitions.get(definitionId);
  if (!definition) return null;
  const entries = Object.entries(obj(source));
  const read = (target: MeasurementDefinition, accept: (key: string) => boolean = () => true) => {
    let total: number | null = null;
    for (const [key, entry] of entries) {
      if (!(target.key ? target.key === key : new RegExp(target.keyPattern!).test(key)) || !accept(key) || !usable(entry, target.unit)) continue;
      total = (total || 0) + (obj(entry).value as number);
    }
    return total;
  };
  const own = read(definition);
  if (own !== null || !definition.derive) return own;
  const family = definitions.get(definition.derive.from);
  if (!family || family.unit !== definition.unit) return null;
  const { above, upTo } = definition.derive;
  return read(family, (key) => { const n = numberIn(key); return n !== null && n > above && (upTo === null || n <= upTo); });
}
/**
 * One definition across a whole dataset value: the project total, and each structure's own amount. With no total
 * recorded, the structures' sum stands in for it.
 */
export function measurementAmounts(datasetValue: unknown, definitionId: string) {
  const structures = (Array.isArray(obj(datasetValue).structures) ? obj(datasetValue).structures as unknown[] : []).map(obj)
    .map((structure) => ({ id: String(structure.id || ""), name: String(structure.name || ""), value: measurementAmount(structure.measurements, definitionId) }));
  const measured = structures.filter((structure): structure is { id: string; name: string; value: number } => structure.value !== null);
  const recorded = measurementAmount(obj(datasetValue).measurements, definitionId);
  const total = recorded ?? (measured.length ? measured.reduce((sum, structure) => sum + structure.value, 0) : null);
  return { total, recorded_total: recorded, structures: measured, structure_count: structures.length };
}
type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});
const usable = (entry: unknown, unit: string) => { const value = obj(entry); return typeof value.value === "number" && Number.isFinite(value.value) && value.unit === unit && value.status !== "missing" && value.status !== "pending"; };

export type MeasurementAssessment = {
  schema: { id: string; version: string; title: string };
  measurements: {
    definition: string; label: string; unit: string; required: boolean;
    /** ready: a usable value. missing: nothing recorded. unit_mismatch: recorded in another unit, which is never converted by guesswork. */
    status: "ready" | "missing" | "unit_mismatch";
    values: Record<string, Value>;
    structures: { id: string; name: string; values: Record<string, Value> }[];
  }[];
  missing_required: string[];
  /** Keys the dataset holds that no definition claims: a producer inventing a name, or a definition still to be written. */
  unrecognized: string[];
};
/** Compares one measurement dataset value with what a schema asks for. Reads nothing and changes nothing. */
export function assessMeasurements(schemaId: string, datasetValue: unknown): MeasurementAssessment {
  const schema = measurementSchema(schemaId);
  const totals = obj(obj(datasetValue).measurements);
  const structures = (Array.isArray(obj(datasetValue).structures) ? obj(datasetValue).structures as unknown[] : []).map(obj);
  const matching = (source: Obj, definition: MeasurementDefinition) => Object.fromEntries(Object.entries(source).filter(([key]) => (definition.key ? definition.key === key : new RegExp(definition.keyPattern!).test(key)))) as Record<string, Value>;
  const measurements = schema.measurements.map((entry) => {
    const definition = dict().definitions.get(entry.definition)!;
    const values = matching(totals, definition);
    const perStructure = definition.levels.includes("structure") ? structures.map((structure) => ({ id: String(structure.id || ""), name: String(structure.name || ""), values: matching(obj(structure.measurements), definition) })).filter((structure) => Object.keys(structure.values).length) : [];
    const recorded = [...Object.values(values), ...perStructure.flatMap((structure) => Object.values(structure.values))];
    const status = measurementAmounts(datasetValue, definition.id).total !== null ? "ready" as const : recorded.some((value) => typeof obj(value).value === "number") ? "unit_mismatch" as const : "missing" as const;
    return { definition: definition.id, label: definition.label, unit: definition.unit, required: entry.required, status, values, structures: perStructure };
  });
  const keys = new Set([...Object.keys(totals), ...structures.flatMap((structure) => Object.keys(obj(structure.measurements)))]);
  return {
    schema: { id: schema.id, version: schema.version, title: schema.title },
    measurements,
    missing_required: measurements.filter((entry) => entry.required && entry.status !== "ready").map((entry) => entry.definition),
    unrecognized: [...keys].filter((key) => !definitionForKey(key)).sort()
  };
}

// ---- Publication ----
const definitionSchema: JsonSchema = { type: "object", required: ["id", "label", "unit", "levels", "description"], properties: { id: { type: "string" }, key: { type: "string" }, keyPattern: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, levels: { type: "array", items: { enum: ["project", "structure"] } }, description: { type: "string" }, derive: { type: "object" }, slice: { type: "object", required: ["partition"], properties: { partition: { type: "string" } }, additionalProperties: false } }, additionalProperties: false };
const partitionSchema: JsonSchema = { type: "object", required: ["id", "of", "dimension", "label", "complete", "description"], properties: { id: { type: "string" }, of: { type: "string" }, dimension: { type: "string" }, label: { type: "string" }, complete: { type: "boolean" }, description: { type: "string" } }, additionalProperties: false };
const schemaSchema: JsonSchema = { type: "object", required: ["id", "version", "title", "description", "measurements"], properties: { id: { type: "string" }, version: { type: "string" }, title: { type: "string" }, description: { type: "string" }, measurements: { type: "array", items: { type: "object", required: ["definition", "required"], properties: { definition: { type: "string" }, required: { type: "boolean" } }, additionalProperties: false } } }, additionalProperties: false };
const valueMap: JsonSchema = { type: "object", additionalProperties: { type: "object" } };
const assessmentSchema: JsonSchema = { type: "object", required: ["schema", "measurements", "missing_required", "unrecognized"], properties: { status: { type: "string" }, dataset_id: { type: "string" }, schema: { type: "object" }, measurements: { type: "array", items: { type: "object", required: ["definition", "label", "unit", "required", "status", "values", "structures"], properties: { definition: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, required: { type: "boolean" }, status: { enum: ["ready", "missing", "unit_mismatch"] }, values: valueMap, structures: { type: "array", items: { type: "object", required: ["id", "name", "values"], properties: { id: { type: "string" }, name: { type: "string" }, values: valueMap }, additionalProperties: false } } }, additionalProperties: false } }, missing_required: { type: "array", items: { type: "string" } }, unrecognized: { type: "array", items: { type: "string" } } }, additionalProperties: false };
const manualSchema: JsonSchema = { type: "object", required: ["available", "schemas", "fields", "manual", "in_use", "report_linked"], properties: { available: { type: "boolean" }, schemas: { type: "array", items: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } }, additionalProperties: false } }, fields: { type: "array", items: { type: "object", required: ["definition", "key", "label", "unit", "required", "schemas", "group"], properties: { definition: { type: "string" }, key: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, required: { type: "boolean" }, schemas: { type: "array", items: { type: "string" } }, group: { type: "string" }, group_label: { type: "string" }, derives: { type: "array", items: { type: "object", required: ["definition", "key", "label", "unit", "factor"], properties: { definition: { type: "string" }, key: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, factor: { type: "number" } }, additionalProperties: false } } }, additionalProperties: false } }, manual: { type: ["object", "null"] }, in_use: { type: "object", required: ["source", "dataset_id", "values"], properties: { source: { enum: ["manual", "report", "other", "none"] }, dataset_id: { type: "string" }, values: { type: "object" } }, additionalProperties: false }, report_linked: { type: "boolean" } }, additionalProperties: false };
let registered = false;
export function registerMeasurementSchemaProvider() {
  if (registered) return;
  registered = true;
  const anyone = { scopes: ["organization", "project"] as const, permissions: ["view_project_data"], systemKinds: ["work", "module", "agent"] as const };
  registerDataProvider({ id: "measurement-schemas", version: "1", apps: ["measurements", "documents", "materials", "crew"], exports: {
    dictionary: { description: "Every measurement the platform has a shared meaning for: its id, dataset key, unit and whether it can be recorded per structure. Bind to these rather than to a producer's names.", schema: { type: "array", items: definitionSchema }, schemaVersion: "1", access: anyone,
      read: async () => { const value = listMeasurementDefinitions(); return { value, revision: `sha256:${contentHash(value)}` }; } },
    partitions: { description: "How base measurements are cut into parts: which measurement each partition cuts, by which attribute of the building, and whether its parts add up to the whole. Parts of one partition never overlap; parts of different partitions of the same measurement may count the same thing and are never added together.", schema: { type: "array", items: partitionSchema }, schemaVersion: "1", access: anyone,
      read: async () => { const value = listMeasurementPartitions(); return { value, revision: `sha256:${contentHash(value)}` }; } },
    catalog: { description: "Measurement schemas by kind of work (roofing, gutters, siding): which dictionary measurements each uses and which it requires.", schema: { type: "array", items: schemaSchema }, schemaVersion: "1", access: anyone,
      read: async () => { const value = listMeasurementSchemas(); return { value, revision: `sha256:${contentHash(value)}` }; } },
    assessment: { description: "What one schema asks for against this project's selected measurements: each measurement's status and values in total and per structure, the required ones still missing, and dataset keys no definition recognizes. Missing is never reported as zero.", schema: assessmentSchema, schemaVersion: "1", argsSchema: { type: "object", required: ["schema"], properties: { schema: { type: "string" } }, additionalProperties: false }, access: { scopes: ["project"] as const, permissions: ["view_project_data"], systemKinds: ["work", "module", "agent"] as const },
      read: async (ctx, ref) => {
        const schemaId = String(ref.args?.schema || "");
        measurementSchema(schemaId);
        const { effectiveProjectMeasurements } = await import("./firstmeasure-datasets.js");
        const effective = await effectiveProjectMeasurements(ctx, ref.target.projectId!);
        if (effective.status !== "ready") { const empty = assessMeasurements(schemaId, {}); return { value: { status: "unselected", ...empty }, revision: `sha256:${contentHash(empty)}` }; }
        const value = { status: "ready", dataset_id: String(effective.datasetId), ...assessMeasurements(schemaId, effective.value) };
        return { value, revision: `sha256:${contentHash(value)}`, provenance: { datasetId: effective.datasetId, datasetRevision: effective.revision } };
      } },
    manual: { description: "Measurements entered by hand for this project: the dictionary measurements its scope templates' schemas ask for (key, label, unit, required), the values entered, and which dataset the project reads now (manual entries, a report, another dataset or none) with its values. A completed report replaces entries made by hand; they stay listed until cleared. Write with measurements.manual.save.", schema: manualSchema, schemaVersion: "1", access: { scopes: ["project"] as const, permissions: ["view_project_data"], systemKinds: ["work", "module", "agent"] as const },
      read: async (ctx, ref) => {
        const { readManualMeasurements } = await import("./manual-measurements.js");
        const value = await readManualMeasurements(ctx, ref.target.projectId!);
        return { value, revision: `sha256:${contentHash(value)}` };
      } }
  } });
}
