import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { badRequest } from "../../platform/errors.js";
import { registerAction } from "../../platform/publication/actions.js";
import { backendImplementationDigest } from "../../platform/publication/implementation.js";
import { roofingTradeSetup } from "./roofing.js";
import type { PublicationContext } from "../../platform/publication/contracts.js";

/**
 * Price book setups by trade: what a new organization picks (manufacturers, product lines, how a job's materials are
 * worked out from its measurements) becomes its price book and measurement defaults. One published action applies any
 * trade's setup, so the guided setup, an agent and a module all write it the same way. A trade plugs in by adding a
 * TradeSetup here; roofing is the first.
 */
export type TradeSetup = {
  trade: string;
  title: string;
  schema: z.ZodTypeAny;
  /** What the setup shows for a price region. */
  options: (regionId: string) => Record<string, unknown>;
  /** Writes the setup through the price book's and defaults' own writers. */
  /** Runs as the person: writers that are published actions (suppliers) are invoked with this context. */
  apply: (ctx: PublicationContext, selections: unknown) => Promise<Record<string, unknown>>;
};

const setups = new Map<string, TradeSetup>();
export function registerTradeSetup(setup: TradeSetup) {
  if (setups.has(setup.trade)) throw new Error(`The ${setup.trade} price book setup is registered twice.`);
  setups.set(setup.trade, setup);
}
export function tradeSetup(trade: string) {
  const setup = setups.get(trade);
  if (!setup) throw badRequest("pricebook_setup_trade", `There is no price book setup for ${trade}.`);
  return setup;
}
export function listTradeSetups() { return [...setups.values()]; }

let registered = false;
export function registerPricebookSetupPublication() {
  if (registered) return;
  registered = true;
  if (!setups.has("roofing")) registerTradeSetup(roofingTradeSetup);
  registerPriceActions();
  const input = z.object({ trade: z.string().max(40) }).passthrough();
  registerAction({
    id: "pricebook.setup.apply", version: "1", domain: "pricebook", implementation: backendImplementationDigest(),
    description: "Set up the organization's price book for a trade from what it uses. Roofing: the kinds of roof it installs (roof_types), for shingle the manufacturers in the order picked (brands; every product they make is written) and the defaults generation uses (defaults), otherwise the default material (default_material, a roof-type component system), plus suppliers, typed costs (prices) and the price region. Writes price book items whose quantity formulas use the measurement dictionary, and the measurement defaults that generate a project's materials. Items with the same ids are replaced; other items are kept.",
    inputSchema: { ...(zodToJsonSchema(input, { $refStrategy: "none" }) as Record<string, unknown>), description: "trade plus that trade's selections. Roofing: { trade:'roofing', roof_types:['shingle','metal',...], brands:['gaf'], defaults?:{ shingle?, underlayment?, ice_water?, ice_coverage?:'perimeter_18_valleys'|'eaves_36_valleys'|'eaves_72_valleys'|'eaves_36'|'valleys'|'none', pipe_boot?, ridge_vent?, intake_vent?, box_vent?, low_slope_system?:'tpo'|'pvc'|'epdm'|'mod_bit'|'none', low_slope? } (product ids), default_material?: a system id such as 'metal_standing_seam' when shingle is not installed, rules?:{ <rule key>:{ source?, waste?: number|'roof', coverage? } }, prices?:{ <item id>: number }, region?:'national'|'northeast'|'midwest'|'south'|'west' }" },
    outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    validateInput: (value) => { const { trade, ...rest } = input.parse(value); tradeSetup(trade).schema.parse(rest); },
    execute: async (ctx, _target, value) => {
      const { trade, ...rest } = input.parse(value);
      return tradeSetup(trade).apply(ctx, rest);
    }
  });
}

/**
 * The organization's price book prices, for an agent matching a supplier price sheet: read them, then apply a checked
 * list of changes. Costs (`internal_cost`, what the company pays) and sell prices (`unit_price`) are separate fields;
 * nothing here derives one from the other.
 */
function registerPriceActions() {
  registerAction({
    id: "pricebook.prices.list", version: "1", domain: "pricebook", implementation: backendImplementationDigest(),
    description: "List the organization's price book items with their cost (internal_cost) and sell price (unit_price), to match a supplier price sheet against. Optional `query` filters by name, code or manufacturer.",
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 120 } }, additionalProperties: false },
    outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["view_pricebook|manage_company_settings"] },
    effect: "read", executionKinds: ["api", "agent", "module"], idempotency: "none",
    execute: async (ctx, _target, value) => {
      const { getOrganizationPricebook } = await import("../storage.js");
      const query = String((value as { query?: unknown }).query || "").trim().toLowerCase();
      const items = ((await getOrganizationPricebook(ctx.organizationId)).catalog.items as Record<string, unknown>[])
        .filter((item) => !query || [item.name, item.code, item.manufacturer, item.type].some((field) => String(field ?? "").toLowerCase().includes(query)))
        .slice(0, 400)
        .map((item) => ({ id: String(item.id), name: String(item.name || ""), code: String(item.code || ""), manufacturer: String(item.manufacturer || ""), type: String(item.type || ""), unit: String(item.unit || ""), internal_cost: Number(item.internal_cost || 0), unit_price: Number(item.unit_price || 0) }));
      return { items };
    }
  });
  // Items read from a supplier's price sheet that the price book does not have yet (the agent, after the setup's
  // suppliers step or any time). Merged by name with an item already there, whose cost it sets.
  const newItem = z.object({
    name: z.string().trim().min(1).max(200), unit: z.string().trim().min(1).max(40), internal_cost: z.number().finite().min(0).max(1e6),
    category: z.enum(["misc", "shingle_roofs", "leak_barriers", "underlayments", "flashing", "accessories", "gutters", "flat_roofs", "flat_roof_accessories"]).default("misc"),
    type: z.string().trim().max(120).default(""), manufacturer: z.string().trim().max(120).default(""), code: z.string().trim().max(120).default(""),
    description: z.string().trim().max(500).default(""), source: z.string().max(200).optional()
  }).strict();
  const addInput = z.object({ items: z.array(newItem).min(1).max(300), note: z.string().max(500).optional() }).strict();
  registerAction({
    id: "pricebook.items.add", version: "1", domain: "pricebook", implementation: backendImplementationDigest(),
    description: "Add items read from a supplier price sheet to the organization's price book: name, unit, cost (internal_cost, what the company pays; never a markup), and optionally category, type (such as 'Standing seam metal'), manufacturer, code and description. An item whose name matches one already in the price book is not added again; its cost is set. Quantities are entered on each job until a measurement rule is set up. Returns each item's id (added or matched), to set that supplier's costs with suppliers.prices.update. Show the person the list before adding.",
    inputSchema: zodToJsonSchema(addInput, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    validateInput: (value) => { addInput.parse(value); },
    execute: async (ctx, _target, value) => {
      const { getOrganizationPricebook, saveOrganizationCatalog } = await import("../storage.js");
      const { items: incoming } = addInput.parse(value);
      const book = await getOrganizationPricebook(ctx.organizationId);
      const items = [...(book.catalog.items as Record<string, unknown>[])];
      const byName = new Map(items.map((item, index) => [String(item.name || "").trim().toLowerCase(), index]));
      const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
      const added: { item_id: string; name: string }[] = [], matched: { item_id: string; name: string; before: number | null; after: number }[] = [];
      for (const entry of incoming) {
        const at = byName.get(entry.name.toLowerCase());
        if (at !== undefined) {
          const item = items[at]!;
          matched.push({ item_id: String(item.id), name: String(item.name), before: Number.isFinite(Number(item.internal_cost)) ? Number(item.internal_cost) : null, after: entry.internal_cost });
          items[at] = { ...item, internal_cost: entry.internal_cost, metadata: { ...((item.metadata || {}) as Record<string, unknown>), price_source: "price_sheet" } };
          continue;
        }
        let id = `ps-${slug(entry.name)}`;
        for (let n = 2; items.some((item) => String(item.id) === id); n += 1) id = `ps-${slug(entry.name)}-${n}`;
        items.push({ id, kind: "atomic", name: entry.name, code: entry.code, type: entry.type, category: entry.category, segment: ["flat_roofs", "flat_roof_accessories"].includes(entry.category) ? "flat" : "sloped",
          manufacturer: entry.manufacturer, unit: entry.unit, internal_cost: entry.internal_cost, unit_price: entry.internal_cost, unitPrice: entry.internal_cost, base_price: entry.internal_cost,
          description: entry.description, external_description: "", autoAdd: false,
          metadata: { source: "price_sheet", added_from: "price_sheet", price_source: "price_sheet", quantity: "entered_by_hand", ...(entry.source ? { price_sheet_line: entry.source } : {}) } });
        byName.set(entry.name.toLowerCase(), items.length - 1);
        added.push({ item_id: id, name: entry.name });
      }
      await saveOrganizationCatalog(ctx.organizationId, { ...book.catalog, items }, Number(book.manifest.revision));
      return { added, matched };
    }
  });
  const change = z.object({ item_id: z.string().min(1).max(160), internal_cost: z.number().finite().min(0).max(1e6).optional(), unit_price: z.number().finite().min(0).max(1e6).optional(), source: z.string().max(200).optional() }).strict()
    .refine((entry) => entry.internal_cost !== undefined || entry.unit_price !== undefined, "Give a cost or a price.");
  const changesInput = z.object({ changes: z.array(change).min(1).max(500), note: z.string().max(500).optional() }).strict();
  registerAction({
    id: "pricebook.prices.update", version: "1", domain: "pricebook", implementation: backendImplementationDigest(),
    description: "Apply a checked list of price changes to the organization's price book: for each item id, a new cost (internal_cost, what the company pays a supplier) and/or sell price (unit_price). Only the prices change. Confirm uncertain matches with the person first. Returns each change with its old and new values and any ids not found.",
    inputSchema: zodToJsonSchema(changesInput, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    validateInput: (value) => { changesInput.parse(value); },
    execute: async (ctx, _target, value) => {
      const { getOrganizationPricebook, saveOrganizationCatalog } = await import("../storage.js");
      const { changes } = changesInput.parse(value);
      const book = await getOrganizationPricebook(ctx.organizationId);
      const byId = new Map(changes.map((entry) => [entry.item_id, entry]));
      const applied: Record<string, unknown>[] = [];
      const items = (book.catalog.items as Record<string, unknown>[]).map((item) => {
        const entry = byId.get(String(item.id));
        if (!entry) return item;
        const next = { ...item, metadata: { ...((item.metadata || {}) as Record<string, unknown>), price_source: "price_sheet" }, ...(entry.internal_cost !== undefined ? { internal_cost: entry.internal_cost } : {}), ...(entry.unit_price !== undefined ? { unit_price: entry.unit_price, unitPrice: entry.unit_price, base_price: entry.unit_price } : {}) };
        applied.push({ item_id: item.id, name: item.name, before: { internal_cost: item.internal_cost ?? null, unit_price: item.unit_price ?? null }, after: { internal_cost: next.internal_cost ?? null, unit_price: next.unit_price ?? null }, ...(entry.source ? { source: entry.source } : {}) });
        return next;
      });
      const missing = changes.map((entry) => entry.item_id).filter((itemId) => !(book.catalog.items as Record<string, unknown>[]).some((item) => String(item.id) === itemId));
      if (applied.length) await saveOrganizationCatalog(ctx.organizationId, { ...book.catalog, items }, Number(book.manifest.revision));
      return { applied, missing };
    }
  });
}
