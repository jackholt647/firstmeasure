import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { badRequest, conflict } from "../platform/errors.js";
import { systemPublicationContext } from "../platform/publication/context.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { listMeasurementDefinitions, measurementAmounts, measurementSchema } from "../platform/publication/measurement-schemas.js";
import { listWorkSchemas, workItem, workRequirements } from "../platform/publication/work-items.js";
import { readOrganizationPricebook } from "../pricebook/storage.js";
import { legacyMeasurements } from "../labor/pay-sheet-publication.js";
import { materialsCommand, publishDefaultsMaterialArtifact, readMaterialsLedger } from "./calculus.js";

/**
 * An organization's measurement defaults: what a roof needs, worked out from its measurements alone, for a project no
 * document has defined yet. "I just got a roof report and want the materials now."
 *
 * The defaults are data the organization edits (Settings > Reports > Default materials and labor). Each material rule
 * adds dictionary measurements together, adds a waste allowance and names a price book product and its package. Labor
 * is the work items the job includes; how anyone is paid for them stays on their pay sheet.
 *
 * They reach a project as a published artifact: one set in its materials ledger, origin `defaults`, whose calculation
 * interprets the rules. Generating evaluates and applies it through the ledger's own commands, so it has the same
 * history, revision checks and orders as any other set. A document that has published a scope overrides them
 * completely: nothing is published once one has, and the requirements ignore a defaults set beside one
 * (`projectScopeSets`).
 */
export const MEASUREMENT_DEFAULTS_MODULE = "measurement_defaults";
export const MEASUREMENT_DEFAULTS_KEY = "measurement_defaults";
const SCHEMA_ID = "roofing";

const key = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/);
const definitionId = z.string().trim().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(120);
const percent = z.number().finite().min(0).max(100);
const ruleSchema = z.object({
  key, enabled: z.boolean().default(true),
  label: z.string().trim().min(1).max(120), group: z.string().trim().max(80).default("Materials"),
  /** Measurements added together, each times its factor. A negative factor takes a part away (flat squares from all squares). */
  terms: z.array(z.object({ measurement: definitionId, factor: z.number().finite().min(-10).max(10) }).strict()).min(1).max(8),
  /** `roof` is the roof's own waste, from its hips, valleys and pitch; a number is a fixed allowance. */
  waste: z.union([z.literal("roof"), percent]).default(0),
  /** How it is bought: one package covers this much of the line's unit. */
  package: z.object({ unit: z.string().trim().min(1).max(40), coverage: z.number().finite().positive().max(1e6) }).strict().optional(),
  /** The price book product, by id; else the first product of this item type. */
  product_id: z.string().trim().max(120).default(""), product_type: z.string().trim().max(120).default("")
}).strict();
const wasteSchema = z.object({
  base_percent: percent, per_cut_foot_percent: z.number().finite().min(0).max(10), steep_percent: percent,
  min_percent: percent, max_percent: percent
}).strict();
export const measurementDefaultsSchema = z.object({
  version: z.literal(1).default(1),
  materials: z.object({ enabled: z.boolean(), waste: wasteSchema, rules: z.array(ruleSchema).max(60) }).strict(),
  labor: z.object({ enabled: z.boolean(), items: z.array(z.object({ item: definitionId, enabled: z.boolean().default(true) }).strict()).max(60) }).strict()
}).strict();
export type MeasurementDefaults = z.infer<typeof measurementDefaultsSchema>;
type Rule = z.infer<typeof ruleSchema>;

const UNIT_WORDS: Record<string, string> = { roofing_square: "sq", ft: "lf", ft2: "sq ft" };
const definitions = () => new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition]));
const roofingMeasurements = () => new Set(measurementSchema(SCHEMA_ID).measurements.map((entry) => entry.definition));
const roofingWork = () => listWorkSchemas().find((schema) => schema.id === SCHEMA_ID)?.items || [];

function check(settings: MeasurementDefaults) {
  const known = definitions(), allowed = roofingMeasurements(), keys = new Set<string>();
  settings.materials.rules.forEach((rule, index) => {
    const at = `materials.rules.${index}`;
    if (keys.has(rule.key)) throw badRequest("measurement_defaults_invalid", `Two material rules use the key ${rule.key}.`, { path: `${at}.key` });
    keys.add(rule.key);
    const units = new Set<string>();
    rule.terms.forEach((term, termIndex) => {
      const definition = known.get(term.measurement);
      if (!definition || !allowed.has(term.measurement)) throw badRequest("measurement_defaults_invalid", `${rule.label} reads ${term.measurement}, which is not a roofing measurement.`, { path: `${at}.terms.${termIndex}.measurement` });
      units.add(definition.unit);
    });
    // Feet and squares are never added together.
    if (units.size > 1) throw badRequest("measurement_defaults_invalid", `${rule.label} adds measurements in different units.`, { path: `${at}.terms` });
  });
  if (settings.materials.waste.min_percent > settings.materials.waste.max_percent) throw badRequest("measurement_defaults_invalid", "The lowest waste is above the highest.", { path: "materials.waste.min_percent" });
  const offered = new Set(roofingWork().map((entry) => entry.item)), items = new Set<string>();
  settings.labor.items.forEach((entry, index) => {
    if (!offered.has(entry.item) || !workItem(entry.item)) throw badRequest("measurement_defaults_invalid", `${entry.item} is not roofing work.`, { path: `labor.items.${index}.item` });
    if (items.has(entry.item)) throw badRequest("measurement_defaults_invalid", `${entry.item} is listed twice.`, { path: `labor.items.${index}.item` });
    items.add(entry.item);
  });
  return settings;
}
export function parseMeasurementDefaults(value: unknown): MeasurementDefaults { return check(measurementDefaultsSchema.parse(value)); }

const term = (measurement: string, factor = 1) => ({ measurement, factor });
const shingled = [term("roof.squares"), term("roof.flat_squares", -1)];
const rule = (key: string, label: string, group: string, terms: Rule["terms"], waste: Rule["waste"], pack: Rule["package"], product_id: string, product_type = ""): Rule => ({ key, enabled: true, label, group, terms, waste, package: pack, product_id, product_type });
/**
 * Industry defaults for a shingle roof replacement. Every number is a starting point an organization changes in
 * Settings; the product ids are the roofing library's, and a price book without them falls back to the item type, or
 * to the rule's own name with no product.
 */
export function industryMeasurementDefaults(): MeasurementDefaults {
  return {
    version: 1,
    materials: {
      enabled: true,
      // 10% on a plain gable, more for every foot of hip and valley cut per square, more again for steep squares.
      waste: { base_percent: 10, per_cut_foot_percent: 0.8, steep_percent: 3, min_percent: 8, max_percent: 25 },
      rules: [
        rule("shingles", "Architectural shingles", "Roof covering", shingled, "roof", { unit: "bundle", coverage: 1 / 3 }, "lib-shingle-gaf-hdz", "Shingles"),
        rule("starter", "Starter strip", "Edges and ridges", [term("roof.eave_length"), term("roof.rake_length")], 5, { unit: "bundle", coverage: 120 }, "lib-starter-gaf-prostart", "Starter"),
        rule("hip_ridge", "Hip and ridge cap", "Edges and ridges", [term("roof.hip_length"), term("roof.ridge_length")], 5, { unit: "bundle", coverage: 25 }, "lib-ridge-gaf-seal-a-ridge", "Hip & Ridge"),
        rule("drip_edge", "Drip edge", "Edges and ridges", [term("roof.eave_length"), term("roof.rake_length")], 5, { unit: "pc", coverage: 10 }, "lib-drip-edge-alum-white"),
        // One 36 in course along the eaves and one down each valley; colder climates double the eave course.
        rule("ice_water", "Ice and water shield", "Underlayment", [term("roof.eave_length"), term("roof.valley_length")], 10, { unit: "roll", coverage: 66.7 }, "lib-iws-gaf-weatherwatch", "Ice & Water"),
        rule("underlayment", "Synthetic underlayment", "Underlayment", shingled, 10, { unit: "roll", coverage: 10 }, "lib-underlay-gaf-feltbuster", "Underlayment"),
        rule("valley_metal", "Valley metal", "Flashing", [term("roof.valley_length")], 5, { unit: "pc", coverage: 10 }, "lib-valley-w-galv"),
        // A 5 x 7 in piece at every course: a bundle of 100 runs about 46 ft of wall.
        rule("step_flashing", "Step flashing", "Flashing", [term("roof.side_wall_length"), term("roof.chimney_step_length")], 10, { unit: "bundle", coverage: 46 }, "lib-step-flashing"),
        rule("headwall_flashing", "Headwall and counter flashing", "Flashing", [term("roof.head_wall_length"), term("roof.chimney_apron_length")], 5, { unit: "pc", coverage: 10 }, "lib-counter-flashing"),
        rule("ridge_vent", "Ridge vent", "Ventilation", [term("roof.ridge_length")], 0, { unit: "pc", coverage: 4 }, "lib-ridge-vent-cobra-rigid"),
        rule("coil_nails", "Coil roofing nails", "Fasteners", shingled, "roof", { unit: "box", coverage: 20 }, "lib-coil-nails-1.25"),
        rule("cap_nails", "Plastic cap nails", "Fasteners", shingled, 0, { unit: "pail", coverage: 10 }, "lib-cap-nails-1"),
        rule("low_slope_base", "Low-slope base sheet", "Low slope", [term("roof.flat_squares")], 10, { unit: "roll", coverage: 2 }, "lib-modbit-base-sheet"),
        rule("low_slope_cap", "Low-slope cap sheet", "Low slope", [term("roof.flat_squares")], 10, { unit: "roll", coverage: 1 }, "lib-modbit-cap-sheet")
      ]
    },
    labor: { enabled: true, items: roofingWork().map((entry) => ({ item: entry.item, enabled: true })) }
  };
}

/** The organization's defaults, or the industry defaults when it has never saved its own. */
export async function readMeasurementDefaults(orgId: string) {
  let stored: Awaited<ReturnType<typeof readBranchModule>> | null = null;
  try { stored = await readBranchModule(orgId, "default", MEASUREMENT_DEFAULTS_MODULE); }
  catch (error) { const code = (error as { statusCode?: number; code?: string }); if (code.statusCode !== 404 && code.code !== "ENOENT") throw error; }
  const data = stored?.data as JsonObject | undefined;
  if (!stored || !data || !Object.keys(data).length) return { settings: industryMeasurementDefaults(), stored: false, revision: 0 };
  return { settings: parseMeasurementDefaults(data), stored: true, revision: Number(stored.revision || 0) };
}
export async function saveMeasurementDefaults(orgId: string, input: unknown) {
  const body = z.object({ settings: z.unknown(), expected_revision: z.number().int().nonnegative().optional() }).strict().parse(input);
  const settings = parseMeasurementDefaults(body.settings);
  const current = await readMeasurementDefaults(orgId);
  if (body.expected_revision !== undefined && body.expected_revision !== current.revision) throw conflict("measurement_defaults_revision", "Someone else changed these defaults. Reload them before saving.");
  const saved = await saveBranchModule(orgId, "default", MEASUREMENT_DEFAULTS_MODULE, { data: settings as unknown as JsonObject }, { replace: true });
  return { settings, stored: true, revision: Number(saved.revision || 0) };
}
/** What the editor offers: the roofing measurements a rule can read and the roofing work labor can include. */
export function measurementDefaultsCatalog() {
  const known = definitions(), optional = new Map(roofingWork().map((entry) => [entry.item, !!entry.optional]));
  return {
    measurements: [...roofingMeasurements()].map((id) => known.get(id)!).filter((definition) => !!definition.key).map((definition) => ({ id: definition.id, label: definition.label, unit: UNIT_WORDS[definition.unit] || definition.unit })),
    work_items: roofingWork().map((entry) => { const item = workItem(entry.item)!; return { id: item.id, label: item.label, unit: item.unit, kind: item.kind, description: item.description, optional: optional.get(item.id) || false, under: entry.under || "" }; })
  };
}

/**
 * The calculation the artifact carries. It only interprets what it is given: the rules and waste (its defaults, taken
 * from the organization's settings when published) and the project's measured amounts and work (its values, read on
 * the server when generated). It reads nothing itself.
 */
const SOURCE = `const v = inputs.values, m = v.measures || {}, w = v.waste || {}, lines = [], warnings = (v.notes || []).slice();
const amount = (id) => { const x = m[id]; return x && typeof x.amount === 'number' && Number.isFinite(x.amount) ? x.amount : null; };
const fmt = (n) => String(Math.round(n * 100) / 100);
const squares = amount('roof.squares');
if (!(squares > 0)) throw new Error('This project has no roof squares measured yet. Finish its measurement report, then generate again.');
const cut = (amount('roof.hip_length') || 0) + (amount('roof.valley_length') || 0);
const steep = (amount('roof.squares_9_to_12') || 0) + (amount('roof.squares_13_plus') || 0);
let roofWaste = Number(w.base_percent || 0) + Number(w.per_cut_foot_percent || 0) * cut / squares + Number(w.steep_percent || 0) * steep / squares;
roofWaste = Math.min(Number(w.max_percent ?? 100), Math.max(Number(w.min_percent ?? 0), Math.round(roofWaste * 2) / 2));
for (const rule of v.rules || []) {
  if (rule.enabled === false) continue;
  let total = 0; const parts = [];
  for (const term of rule.terms) {
    const x = amount(term.measurement);
    if (x === null || x === 0) continue;
    total += term.factor * x;
    parts.push((term.factor < 0 ? '- ' : parts.length ? '+ ' : '') + (Math.abs(term.factor) !== 1 ? fmt(Math.abs(term.factor)) + ' x ' : '') + (m[term.measurement].label || term.measurement) + ' ' + fmt(x));
  }
  if (!(total > 0)) continue;
  const pct = rule.waste === 'roof' ? roofWaste : Number(rule.waste || 0);
  const quantity = Math.round(total * (1 + pct / 100) * 100) / 100;
  lines.push({ key: rule.key, product_id: (rule.product && rule.product.id) || ('default:' + rule.key), name: (rule.product && rule.product.name) || rule.label, quantity, unit: rule.unit, group: rule.group || 'Materials',
    explanation: parts.join(' ') + ' ' + rule.unit + (pct ? ' + ' + fmt(pct) + '% waste' + (rule.waste === 'roof' ? ' (roof waste from hips, valleys and pitch)' : '') : ''),
    ...(rule.package ? { packaging: rule.package } : {}), ...(rule.product && typeof rule.product.unit_cost === 'number' ? { unit_cost: rule.product.unit_cost } : {}) });
}
return { outputs: { lines, warnings, work: v.work || [] } };`;

type PricebookItem = { id: string; name: string; type: string; unit: string; cost: number };
const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
/** The price book product a rule names, its cost per unit of the line where its own unit is the package's. */
function product(rule: Rule, items: PricebookItem[]) {
  const found = (rule.product_id && items.find((item) => item.id === rule.product_id))
    || (rule.product_type && (items.find((item) => lower(item.type) === lower(rule.product_type) && (!rule.package || lower(item.unit) === lower(rule.package.unit))) || items.find((item) => lower(item.type) === lower(rule.product_type))));
  if (!found) return null;
  const perPackage = rule.package && lower(found.unit) === lower(rule.package.unit) && found.cost > 0 ? found.cost / rule.package.coverage : null;
  return { id: found.id, name: found.name, ...(perPackage !== null ? { unit_cost: Math.round(perPackage * 100) / 100 } : {}) };
}
/** The artifact's definition for these settings, with each rule's product looked up in the price book now. */
export function measurementDefaultsCalculus(settings: MeasurementDefaults, items: PricebookItem[]) {
  const known = definitions(), missing: string[] = [];
  const rules = (settings.materials.enabled ? settings.materials.rules : []).filter((entry) => entry.enabled).map((entry) => {
    const found = product(entry, items);
    if (!found && (entry.product_id || entry.product_type)) missing.push(entry.label);
    return { key: entry.key, label: entry.label, group: entry.group, terms: entry.terms, waste: entry.waste, unit: UNIT_WORDS[known.get(entry.terms[0]!.measurement)?.unit || ""] || "ea", ...(entry.package ? { package: entry.package } : {}), ...(found ? { product: found } : {}) };
  });
  const notes = [
    ...(rules.length ? ["Pipe boots, vents and other penetrations are not in the measurement report. Add them by hand."] : []),
    ...(missing.length ? [`Not in the price book, so named from the defaults: ${missing.join(", ")}.`] : [])
  ];
  return {
    type: "materials_calculus" as const, key: MEASUREMENT_DEFAULTS_KEY, title: "Materials from measurements", source: SOURCE, bindings: {},
    inputSchema: { type: "object", properties: { rules: { type: "array" }, waste: { type: "object" }, notes: { type: "array" }, measures: { type: "object" }, work: { type: "array" }, measurement_source: { type: "string" } }, required: ["rules", "waste"], additionalProperties: false },
    defaults: { rules, waste: settings.materials.waste, notes, measures: {}, work: [] }
  };
}

async function pricebookItems(orgId: string): Promise<PricebookItem[]> {
  try {
    return (await readOrganizationPricebook(orgId)).catalog.items.map((raw) => {
      const item = raw as Record<string, unknown>, cost = Number(item.internal_cost ?? item.base_cost);
      return { id: String(item.id || ""), name: String(item.name || item.id || ""), type: String(item.type || item.category || ""), unit: String(item.unit || ""), cost: Number.isFinite(cost) && cost > 0 ? cost : Number(item.unit_price) || 0 };
    });
  } catch { return []; } // An organization without a price book still gets its lines, by the defaults' own names.
}

/** The measured amounts every rule, the waste and the work read, from the project's dataset or, with none selected, what the Project tab holds. */
async function projectMeasures(orgId: string, projectId: string, rules: { terms: { measurement: string }[] }[], legacy: unknown) {
  const { effectiveProjectMeasurements } = await import("../platform/publication/firstmeasure-datasets.js");
  const measured = await effectiveProjectMeasurements(systemPublicationContext({ kind: "work", organizationId: orgId, projectId, operations: ["datasets.value"] }), projectId);
  const value: unknown = measured.status === "ready" ? measured.value : { measurements: legacyMeasurements(legacy) };
  const source = measured.status === "ready" ? "dataset" : Object.keys(legacyMeasurements(legacy)).length ? "project" : "none";
  const known = definitions();
  const ids = new Set(["roof.squares", "roof.hip_length", "roof.valley_length", "roof.squares_9_to_12", "roof.squares_13_plus", ...rules.flatMap((entry) => entry.terms.map((t) => t.measurement))]);
  const measures = Object.fromEntries([...ids].map((id) => [id, { amount: measurementAmounts(value, id).total, label: known.get(id)?.label || id, unit: known.get(id)?.unit || "" }]));
  return { value, source, measures };
}

/**
 * Publishes the organization's defaults as this project's artifact and generates it: evaluate, then apply, as the
 * `materials.calculus` generator. Nothing happens when both halves are switched off, or when a document has published
 * a scope, which overrides the defaults. Generating again re-applies the calculation to the defaults as they stand.
 */
export async function generateFromMeasurementDefaults(ctx: PublicationContext, projectId: string, input: unknown = {}) {
  const parsed = z.object({ legacy_measurements: z.record(z.unknown()).optional() }).strict().parse(input || {});
  const orgId = ctx.organizationId;
  const { settings } = await readMeasurementDefaults(orgId);
  if (!settings.materials.enabled && !settings.labor.enabled) return { status: "off" as const };
  const before = await readMaterialsLedger(ctx, projectId);
  if ((before.sets as unknown as { origin?: { type?: string } }[]).some((set) => set.origin?.type === "document")) return { status: "document" as const };
  const definition = measurementDefaultsCalculus(settings, settings.materials.enabled ? await pricebookItems(orgId) : []);
  const measured = await projectMeasures(orgId, projectId, definition.defaults.rules, parsed.legacy_measurements);
  if (measured.measures["roof.squares"]?.amount == null) throw badRequest("measurement_defaults_unmeasured", "This project has no roof measurements yet. Finish its measurement report, then generate again.");
  // Work the job includes, left unsized so the scope set sizes it from the measurements. An item only some roofs have
  // (valleys, wall flashing) is included where this one has some.
  const sized = new Map(workRequirements([SCHEMA_ID], { measurements: measured.value }, { includeEmpty: true }).map((row) => [row.item, row.quantity]));
  const optional = new Map(roofingWork().map((entry) => [entry.item, !!entry.optional]));
  const work = settings.labor.enabled ? settings.labor.items.filter((entry) => entry.enabled && (!optional.get(entry.item) || Number(sized.get(entry.item)) > 0)).map((entry) => ({ item: entry.item })) : [];
  const published = await publishDefaultsMaterialArtifact(orgId, projectId, definition, { title: "Measurement defaults", branch_id: ctx.branchId || "default" });
  const command = async (revision: number, operation: string, payload: Record<string, unknown>) => materialsCommand(ctx, projectId, { key: `defaults_${operation}_${randomUUID()}`, expected_revision: revision, operation, input: payload });
  const current = await readMaterialsLedger(ctx, projectId);
  const evaluated = await command(current.revision, "evaluate", { set_id: published.set_id, values: { measures: measured.measures, work, measurement_source: measured.source } });
  const evaluationId = String((evaluated.result as { evaluation_id?: string }).evaluation_id);
  const applied = await command(evaluated.ledger.revision, "apply", { set_id: published.set_id, evaluation_id: evaluationId, reason: "Generate from measurement defaults" });
  const set = (applied.ledger.sets as unknown as { id: string; lines: unknown[]; work?: unknown[]; evaluations: { id: string; warnings: string[] }[] }[]).find((entry) => entry.id === published.set_id);
  return { status: "generated" as const, set_id: published.set_id, lines: set?.lines.length || 0, work: (set?.work || []).length, warnings: set?.evaluations.find((entry) => entry.id === evaluationId)?.warnings || [], measurement_source: measured.source, ledger: applied.ledger };
}
