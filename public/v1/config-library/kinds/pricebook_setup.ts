import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { listMeasurementDefinitions } from "../../platform/publication/measurement-schemas.js";
import { PRICEBOOK_CATEGORIES } from "../../pricebook/constants.js";

export const PRICEBOOK_SETUP_KIND = "pricebook_setup";

/**
 * The data a trade's price book setup reads (pricebook/setups/<trade>.ts): for roofing, the research catalog of
 * manufacturers, generic items, labor, estimating rules and regions; the roof-type components; the supplier
 * research; and the setup's own default tables. Entry ids are `<trade>.<part>`. The research parts keep the
 * research's own schema (schema_version 1): the fields the setup reads are checked here, and everything else
 * (sources, notes, price ranges) is kept as it was researched.
 */
const id = z.string().trim().min(1).max(160);
const number = z.number().finite();
const product = z.object({ id, name: z.string().trim().min(1).max(200), default_price: number.nullable().optional(), unit: z.string().max(40).optional() }).passthrough();
const catalogContent = z.object({
  schema_version: z.literal(1),
  manufacturers: z.array(z.object({ id, name: z.string().trim().min(1).max(120), pricebook_manufacturer: z.string().max(60).optional(), product_lines: z.array(product).min(1), accessories: z.array(product.extend({ role: z.string().min(1).max(60) })).optional() }).passthrough()).min(1),
  generic_items: z.array(product.extend({ rule_id: z.string().max(60).optional(), category: z.string().max(60).optional() })),
  labor_items: z.array(product.extend({ rule_id: z.string().max(60).optional() })),
  estimating_rules: z.array(z.object({ id, label: z.string().max(200).optional(), pricebook_formula: z.string().max(400).nullable().optional(), unit: z.string().max(40).optional(), include_waste: z.boolean().optional(), show_in_setup: z.boolean().optional(), order: number.optional() }).passthrough()).min(1),
  regions: z.array(z.object({ id, label: z.string().max(120), states: z.array(z.string().length(2)), material_multiplier: number.positive().optional(), labor_multiplier: number.positive().optional(), price_multiplier: number.positive().optional() }).passthrough()).min(1),
  roof_types: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1).max(120), systems: z.array(z.string().max(60)), catalog: z.boolean().optional(), low_slope: z.object({ cap: z.string().min(1).max(60), base: z.string().min(1).max(60).optional() }).strict().optional() }).strict()).min(1)
}).passthrough();
const componentsContent = z.object({
  schema_version: z.literal(1),
  status: z.string().max(40),
  types: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    label: z.string().trim().min(1).max(120),
    components: z.array(z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), label: z.string().trim().min(1).max(200), group: z.string().max(80), standard: z.boolean(),
      terms: z.array(z.object({ measurement: z.string().max(160), factor: number }).strict()).max(8),
      entered_by_hand: z.boolean(), waste_percent: number.min(0).max(40), unit: z.string().min(1).max(40), coverage: number.positive().nullable().optional(),
      explain: z.string().max(2000), unit_cost_estimate: number.min(0).nullable().optional(), provisional: z.boolean().optional()
    }).passthrough()).min(1)
  }).passthrough()).min(1)
}).passthrough();
const suppliersContent = z.object({
  schema_version: z.literal(1),
  suppliers: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), name: z.string().trim().min(1).max(200), kind: z.string().max(40).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    manufacturers: z.array(z.string().max(60)), line_scope: z.enum(["full_range", "retail_core"]), regions: z.string().max(400).optional(),
    /** The material library supplier whose observed SKUs and prices are this supplier's starting costs. */
    library_supplier: z.string().max(200).optional()
  }).passthrough()).min(1)
}).passthrough();
const slot = z.object({ role: z.string().min(1).max(60), rule: z.string().min(1).max(60), generic_first: z.literal(true).optional() }).strict();
const width = number.min(0).max(20);
const settingsContent = z.object({
  /** The most installed brands, shown first in this order. */
  featured_brands: z.array(z.string().max(60)).max(20),
  /** Name, accent colour and tagline for brands the setup knows well. */
  brand_looks: z.record(z.string().max(60), z.object({ name: z.string().min(1).max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), tagline: z.string().max(200) }).strict()),
  /** Research rule ids beside the measurement-default rule keys they fill. */
  default_rules: z.record(z.string().max(60), z.string().min(1).max(60)),
  /** The accessory roles the setup reads from the catalog. */
  accessory_roles: z.array(z.string().min(1).max(60)).min(1),
  /** The research rule an accessory role is measured by, where it is not the role itself. */
  role_rules: z.record(z.string().max(60), z.string().min(1).max(60)),
  /** Price book category by product kind or role. */
  categories: z.record(z.string().max(60), z.enum(PRICEBOOK_CATEGORIES)),
  /** The slots of the defaults step: the accessory role that fills each and the rule generic items are measured by. */
  default_slots: z.object({ underlayment: slot, ice_water: slot, pipe_boot: slot, ridge_vent: slot, intake_vent: slot, box_vent: slot }).strict(),
  /** How far the ice and water barrier runs, in feet up from each edge (a valley gets a course centred in it); null for none. */
  ice_coverage: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), widths: z.object({ eaves: width, rakes: width, valleys: width }).strict().nullable() }).strict()).min(1).max(20),
  default_ice_coverage: z.string().max(40)
}).strict();

const trade = z.literal("roofing");
export const pricebookSetupData = z.discriminatedUnion("part", [
  z.object({ trade, part: z.literal("catalog"), content: catalogContent }).strict(),
  z.object({ trade, part: z.literal("components"), content: componentsContent }).strict(),
  z.object({ trade, part: z.literal("suppliers"), content: suppliersContent }).strict(),
  z.object({ trade, part: z.literal("settings"), content: settingsContent }).strict()
]);
export type PricebookSetupData = z.infer<typeof pricebookSetupData>;
export type RoofingSettingsContent = z.infer<typeof settingsContent>;

const TITLES = { catalog: "research catalog", components: "roof-type components", suppliers: "supplier research", settings: "setup defaults" } as const;
const identifiers = (formula: string) => formula.match(/[A-Za-z][A-Za-z0-9]*/g) || [];
const duplicates = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index);

export const pricebookSetupKind: LibraryKind<PricebookSetupData> = {
  kind: PRICEBOOK_SETUP_KIND,
  title: "Price book setups",
  description: "What a trade's price book setup reads: for roofing the research catalog, the roof-type components, the supplier research and the setup's default tables. The setup's logic is code; these are its data.",
  idPattern: /^[a-z][a-z0-9_]{0,39}\.(catalog|components|suppliers|settings)$/,
  schema: pricebookSetupData,
  titleOf: (data) => `${data.trade[0]!.toUpperCase()}${data.trade.slice(1)} ${TITLES[data.part]}`,
  validate(data, ctx) {
    const errors: string[] = [];
    if (ctx.id !== `${data.trade}.${data.part}`) errors.push(`The entry id must be ${data.trade}.${data.part}.`);
    const sibling = (part: string) => ctx.registries.entry(PRICEBOOK_SETUP_KIND, `${data.trade}.${part}`)?.data as { content?: Record<string, unknown> } | undefined;
    if (data.part === "catalog") {
      const content = data.content;
      const products = [...content.manufacturers.flatMap((maker) => [...maker.product_lines, ...(maker.accessories || [])]), ...content.generic_items, ...content.labor_items].map((entry) => entry.id);
      for (const repeated of new Set(duplicates(products))) errors.push(`Product ${repeated} is listed twice.`);
      const rules = content.estimating_rules.map((rule) => rule.id);
      for (const repeated of new Set(duplicates(rules))) errors.push(`Estimating rule ${repeated} is listed twice.`);
      for (const entry of [...content.generic_items, ...content.labor_items]) if (entry.rule_id && !rules.includes(entry.rule_id)) errors.push(`${entry.id} is measured by ${entry.rule_id}, which is not an estimating rule.`);
      // A formula that reads anything else is not a price book formula and would be dropped without a word.
      for (const rule of content.estimating_rules) for (const name of identifiers(rule.pricebook_formula || "")) if (!ctx.registries.measurementKey(name)) errors.push(`Rule ${rule.id}'s pricebook_formula reads ${name}, which is not a key of the measurement dictionary.`);
      for (const repeated of new Set(duplicates(content.roof_types.map((type) => type.id)))) errors.push(`Roof type ${repeated} is listed twice.`);
      const systems = (sibling("components")?.content?.types as { id: string }[] | undefined)?.map((type) => type.id);
      if (systems) for (const type of content.roof_types) for (const system of type.systems) if (!type.catalog && !systems.includes(system)) errors.push(`Roof type ${type.id} names system ${system}, which is not in ${data.trade}.components.`);
    }
    if (data.part === "components") {
      const definitions = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition]));
      for (const repeated of new Set(duplicates(data.content.types.map((type) => type.id)))) errors.push(`System ${repeated} is listed twice.`);
      for (const type of data.content.types) {
        for (const repeated of new Set(duplicates(type.components.map((entry) => entry.key)))) errors.push(`${type.id}: component ${repeated} is listed twice.`);
        for (const entry of type.components) {
          if (entry.entered_by_hand || !entry.terms.length) continue;
          const units = new Set(entry.terms.map((term) => definitions.get(term.measurement)?.unit));
          for (const term of entry.terms) if (!definitions.has(term.measurement)) errors.push(`${type.id}.${entry.key} reads ${term.measurement}, which is not in the measurement dictionary.`);
          if (units.size > 1) errors.push(`${type.id}.${entry.key} adds measurements in different units.`);
          for (const term of entry.terms) if (term.factor === 0 || Math.abs(term.factor) > 10) errors.push(`${type.id}.${entry.key}: a factor is between -10 and 10 and not zero.`);
        }
      }
    }
    if (data.part === "suppliers") {
      for (const repeated of new Set(duplicates(data.content.suppliers.map((supplier) => supplier.id)))) errors.push(`Supplier ${repeated} is listed twice.`);
      const library = ctx.registries.entry("material_library", data.trade)?.data as { suppliers?: { name: string }[] } | undefined;
      if (library) for (const supplier of data.content.suppliers) if (supplier.library_supplier && !library.suppliers?.some((entry) => entry.name === supplier.library_supplier)) errors.push(`${supplier.id} takes its prices from ${supplier.library_supplier}, which is not a supplier of material_library/${data.trade}.`);
    }
    if (data.part === "settings") {
      const ids = data.content.ice_coverage.map((entry) => entry.id);
      for (const repeated of new Set(duplicates(ids))) errors.push(`Ice coverage ${repeated} is listed twice.`);
      if (!ids.includes(data.content.default_ice_coverage)) errors.push(`The default ice coverage ${data.content.default_ice_coverage} is not one of the choices.`);
      if (!data.content.ice_coverage.some((entry) => entry.widths)) errors.push("At least one ice coverage choice covers something.");
    }
    return errors;
  }
};
