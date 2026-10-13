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
  description: string;
};
export type MeasurementSchema = {
  id: string;
  version: string;
  title: string;
  description: string;
  measurements: { definition: string; required: boolean }[];
};

const definitions = new Map<string, MeasurementDefinition>();
const schemas = new Map<string, MeasurementSchema>();
const ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function registerMeasurementDefinition(definition: MeasurementDefinition) {
  if (!ID.test(definition.id) || !definition.label.trim() || !definition.unit.trim() || !definition.levels.length) throw badRequest("measurement_definition_invalid", "A measurement needs a stable id, a label, a unit and a level.");
  if (!definition.key === !definition.keyPattern) throw badRequest("measurement_definition_invalid", "A measurement has either one key or one key pattern.");
  if (definition.keyPattern) new RegExp(definition.keyPattern);
  if (definitions.has(definition.id)) throw badRequest("measurement_definition_duplicate", `Measurement ${definition.id} is already defined.`);
  // One key, one meaning: two definitions may not claim the same dataset key.
  if (definition.key && definitionForKey(definition.key)) throw badRequest("measurement_key_claimed", `Key ${definition.key} already belongs to ${definitionForKey(definition.key)!.id}.`);
  definitions.set(definition.id, Object.freeze(jsonClone(definition)));
}
export function registerMeasurementSchema(schema: MeasurementSchema) {
  if (!/^[a-z][a-z0-9_]*$/.test(schema.id) || !schema.version || !schema.title.trim() || !schema.measurements.length) throw badRequest("measurement_schema_invalid", "A measurement schema needs an id, a version, a title and at least one measurement.");
  if (schemas.has(schema.id)) throw badRequest("measurement_schema_duplicate", `Measurement schema ${schema.id} is already registered.`);
  const seen = new Set<string>();
  for (const entry of schema.measurements) {
    if (!definitions.has(entry.definition)) throw badRequest("measurement_schema_unknown_definition", `Schema ${schema.id} names ${entry.definition}, which is not in the dictionary.`);
    if (seen.has(entry.definition)) throw badRequest("measurement_schema_invalid", `Schema ${schema.id} lists ${entry.definition} twice.`);
    seen.add(entry.definition);
  }
  schemas.set(schema.id, Object.freeze(jsonClone(schema)));
}
export function listMeasurementDefinitions() { return [...definitions.values()].map((definition) => jsonClone(definition)); }
export function listMeasurementSchemas() { return [...schemas.values()].map((schema) => jsonClone(schema)); }
export function measurementSchema(id: string) {
  const schema = schemas.get(id);
  if (!schema) throw badRequest("measurement_schema_unknown", `There is no measurement schema called ${id}.`);
  return jsonClone(schema);
}
export function definitionForKey(key: string) {
  for (const definition of definitions.values()) {
    if (definition.key ? definition.key === key : new RegExp(definition.keyPattern!).test(key)) return definition;
  }
  return null;
}
/** The schemas a scope template works in. Templates carry `measurement_schema_ids`; one without them is unscoped. */
export function measurementSchemaIdsForScope(template: unknown): string[] {
  const ids = template && typeof template === "object" ? (template as Record<string, unknown>).measurement_schema_ids : null;
  return Array.isArray(ids) ? [...new Set(ids.map(String).filter((id) => schemas.has(id)))] : [];
}

type Value = { value: number | null; unit: string; status?: string; source?: string };
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
    const definition = definitions.get(entry.definition)!;
    const values = matching(totals, definition);
    const perStructure = definition.levels.includes("structure") ? structures.map((structure) => ({ id: String(structure.id || ""), name: String(structure.name || ""), values: matching(obj(structure.measurements), definition) })).filter((structure) => Object.keys(structure.values).length) : [];
    const recorded = [...Object.values(values), ...perStructure.flatMap((structure) => Object.values(structure.values))];
    const status = recorded.some((value) => usable(value, definition.unit)) ? "ready" as const : recorded.some((value) => typeof obj(value).value === "number") ? "unit_mismatch" as const : "missing" as const;
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

// ---- The dictionary. Keys are the ones measurement datasets already use, so existing calculations keep working. ----
const both: MeasurementLevel[] = ["project", "structure"];
const define = (id: string, key: string, label: string, unit: string, description: string) => registerMeasurementDefinition({ id, key, label, unit, levels: both, description });
define("roof.area", "roofArea", "Roof area", "ft2", "Sloped surface area of every roof face.");
define("roof.squares", "roofSquares", "Roof squares", "roofing_square", "Roof area in roofing squares of 100 square feet.");
define("roof.ventilation_squares", "ventilationSquares", "Ventilated squares", "roofing_square", "Roof squares counted toward ventilation.");
define("roof.flat_squares", "flatRoofSquares", "Flat roof squares", "roofing_square", "Squares pitched 2/12 or lower.");
define("roof.squares_2_to_4", "pitch2to4Squares", "Squares over 2/12 up to 4/12", "roofing_square", "Squares pitched over 2/12 and up to 4/12.");
define("roof.squares_4_to_6", "pitch4to6Squares", "Squares over 4/12 up to 6/12", "roofing_square", "Squares pitched over 4/12 and up to 6/12.");
define("roof.squares_6_to_8", "pitch6to8Squares", "Squares over 6/12 up to 8/12", "roofing_square", "Squares pitched over 6/12 and up to 8/12.");
define("roof.squares_9_to_12", "pitch9to12Squares", "Squares over 8/12 up to 12/12", "roofing_square", "Squares pitched over 8/12 and up to 12/12.");
define("roof.squares_13_plus", "pitch13PlusSquares", "Squares over 12/12", "roofing_square", "Squares pitched steeper than 12/12.");
registerMeasurementDefinition({ id: "roof.squares_at_pitch", keyPattern: "^pitch\\d+(?:\\.\\d+)?Squares$", label: "Squares at each pitch", unit: "roofing_square", levels: both, description: "Squares at one exact pitch, one key per pitch such as pitch6Squares for 6/12." });
define("roof.ridge_length", "ridgesLf", "Ridges", "ft", "Total ridge length.");
define("roof.hip_length", "hipsLf", "Hips", "ft", "Total hip length.");
define("roof.valley_length", "valleyLf", "Valleys", "ft", "Total valley length.");
define("roof.rake_length", "rakesLf", "Rakes", "ft", "Total rake length.");
define("roof.eave_length", "eavesLf", "Eaves", "ft", "Total eave length.");
define("roof.head_wall_length", "headWallLf", "Head walls", "ft", "Length of roof meeting a wall across its top.");
define("roof.side_wall_length", "sideWallLf", "Side walls", "ft", "Length of roof meeting a wall along its slope, where step flashing goes.");
define("roof.transition_length", "transitionsLf", "Transitions", "ft", "Length of pitch transitions.");
define("roof.parapet_length", "parapetLf", "Parapets", "ft", "Parapet wall length.");
define("roof.protrusion_length", "protrusionLf", "Protrusions", "ft", "Perimeter of roof protrusions.");
define("roof.chimney_back_length", "chimneyBackLf", "Chimney backs", "ft", "Length across the high side of chimneys.");
define("roof.chimney_step_length", "chimneyStepLf", "Chimney sides", "ft", "Length along the sloped sides of chimneys.");
define("roof.chimney_apron_length", "chimneyApronLf", "Chimney aprons", "ft", "Length across the low side of chimneys.");
define("roof.skylight_length", "skylightLf", "Skylight perimeter", "ft", "Perimeter of skylights.");
define("roof.unclassified_length", "unknownLf", "Unclassified lines", "ft", "Roof lines that were measured but not classified.");
define("exterior_wall.gross_area", "wallGrossArea", "Gross exterior wall area", "ft2", "Exterior wall area including openings.");
define("exterior_wall.net_area", "wallNetArea", "Net exterior wall area", "ft2", "Exterior wall area with openings taken out.");
define("exterior_wall.opening_area", "wallOpeningArea", "Opening area", "ft2", "Area of windows, doors and other openings.");
define("exterior_wall.opening_perimeter", "wallOpeningPerimeter", "Opening perimeter", "ft", "Perimeter of windows, doors and other openings.");
define("exterior_wall.top_length", "wallTopLf", "Wall tops", "ft", "Length along the top of walls.");
define("exterior_wall.bottom_length", "wallBottomLf", "Wall bottoms", "ft", "Length along the bottom of walls.");
define("exterior_wall.transition_length", "wallTransitionsLf", "Wall transitions", "ft", "Length of transitions between wall materials.");
define("exterior_wall.termination_length", "wallTerminationsLf", "Wall terminations", "ft", "Length where wall cladding terminates.");
define("exterior_wall.inside_corner_length", "insideCornersLf", "Inside corners", "ft", "Total inside corner length.");
define("exterior_wall.outside_corner_length", "outsideCornersLf", "Outside corners", "ft", "Total outside corner length.");
define("exterior_wall.return_area", "wallReturnsArea", "Returns", "ft2", "Area of wall returns.");

// ---- Schemas. A new kind of work is mostly a new selection from the dictionary. ----
const select = (required: string[], optional: string[]) => [...required.map((definition) => ({ definition, required: true })), ...optional.map((definition) => ({ definition, required: false }))];
const roofLines = ["roof.ridge_length", "roof.hip_length", "roof.valley_length", "roof.rake_length", "roof.eave_length", "roof.head_wall_length", "roof.side_wall_length", "roof.transition_length", "roof.parapet_length", "roof.protrusion_length", "roof.chimney_back_length", "roof.chimney_step_length", "roof.chimney_apron_length", "roof.skylight_length", "roof.unclassified_length"];
registerMeasurementSchema({ id: "roofing", version: "1", title: "Roofing", description: "Sloped and flat roof replacement, repair and maintenance.", measurements: select(["roof.area", "roof.squares"], ["roof.ventilation_squares", "roof.flat_squares", "roof.squares_2_to_4", "roof.squares_4_to_6", "roof.squares_6_to_8", "roof.squares_9_to_12", "roof.squares_13_plus", "roof.squares_at_pitch", ...roofLines]) });
// Gutters run along the eaves, so this schema shares the roofing schema's eave length rather than defining its own.
registerMeasurementSchema({ id: "gutters", version: "1", title: "Gutters", description: "Gutter and downspout replacement.", measurements: select(["roof.eave_length"], ["roof.rake_length"]) });
registerMeasurementSchema({ id: "siding", version: "1", title: "Siding", description: "Wall cladding replacement.", measurements: select(["exterior_wall.net_area"], ["exterior_wall.gross_area", "exterior_wall.opening_area", "exterior_wall.opening_perimeter", "exterior_wall.top_length", "exterior_wall.bottom_length", "exterior_wall.transition_length", "exterior_wall.termination_length", "exterior_wall.inside_corner_length", "exterior_wall.outside_corner_length", "exterior_wall.return_area"]) });

// ---- Publication ----
const definitionSchema: JsonSchema = { type: "object", required: ["id", "label", "unit", "levels", "description"], properties: { id: { type: "string" }, key: { type: "string" }, keyPattern: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, levels: { type: "array", items: { enum: ["project", "structure"] } }, description: { type: "string" } }, additionalProperties: false };
const schemaSchema: JsonSchema = { type: "object", required: ["id", "version", "title", "description", "measurements"], properties: { id: { type: "string" }, version: { type: "string" }, title: { type: "string" }, description: { type: "string" }, measurements: { type: "array", items: { type: "object", required: ["definition", "required"], properties: { definition: { type: "string" }, required: { type: "boolean" } }, additionalProperties: false } } }, additionalProperties: false };
const valueMap: JsonSchema = { type: "object", additionalProperties: { type: "object" } };
const assessmentSchema: JsonSchema = { type: "object", required: ["schema", "measurements", "missing_required", "unrecognized"], properties: { status: { type: "string" }, dataset_id: { type: "string" }, schema: { type: "object" }, measurements: { type: "array", items: { type: "object", required: ["definition", "label", "unit", "required", "status", "values", "structures"], properties: { definition: { type: "string" }, label: { type: "string" }, unit: { type: "string" }, required: { type: "boolean" }, status: { enum: ["ready", "missing", "unit_mismatch"] }, values: valueMap, structures: { type: "array", items: { type: "object", required: ["id", "name", "values"], properties: { id: { type: "string" }, name: { type: "string" }, values: valueMap }, additionalProperties: false } } }, additionalProperties: false } }, missing_required: { type: "array", items: { type: "string" } }, unrecognized: { type: "array", items: { type: "string" } } }, additionalProperties: false };
let registered = false;
export function registerMeasurementSchemaProvider() {
  if (registered) return;
  registered = true;
  const anyone = { scopes: ["organization", "project"] as const, permissions: ["view_project_data"], systemKinds: ["work", "module", "agent"] as const };
  registerDataProvider({ id: "measurement-schemas", version: "1", apps: ["measurements", "documents", "materials", "crew"], exports: {
    dictionary: { description: "Every measurement the platform has a shared meaning for: its id, dataset key, unit and whether it can be recorded per structure. Bind to these rather than to a producer's names.", schema: { type: "array", items: definitionSchema }, schemaVersion: "1", access: anyone,
      read: async () => { const value = listMeasurementDefinitions(); return { value, revision: `sha256:${contentHash(value)}` }; } },
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
      } }
  } });
}
