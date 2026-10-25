import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { badRequest } from "../../platform/errors.js";
import { registerAction } from "../../platform/publication/actions.js";
import { backendImplementationDigest } from "../../platform/publication/implementation.js";
import { roofingTradeSetup } from "./roofing.js";

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
  apply: (orgId: string, selections: unknown) => Promise<Record<string, unknown>>;
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
  const input = z.object({ trade: z.string().max(40) }).passthrough();
  registerAction({
    id: "pricebook.setup.apply", version: "1", domain: "pricebook", implementation: backendImplementationDigest(),
    description: "Set up the organization's price book for a trade from what it uses: for roofing, the shingle manufacturers and lines (brands, lines, default_line), which measurement rules are on and their waste (rules), typed prices (prices) and the price region. Writes price book items whose quantity formulas use the measurement dictionary, and the measurement defaults that generate a project's materials. Items with the same ids are replaced; other items are kept.",
    inputSchema: { ...(zodToJsonSchema(input, { $refStrategy: "none" }) as Record<string, unknown>), description: "trade plus that trade's selections. Roofing: { trade:'roofing', brands:['gaf'], lines:['lib-shingle-gaf-hdz'], default_line?, rules?:{ <rule key>:{ enabled?, waste?: number|'roof' } }, prices?:{ <item id>: number }, region?:'national'|'northeast'|'midwest'|'south'|'west' }" },
    outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    validateInput: (value) => { const { trade, ...rest } = input.parse(value); tradeSetup(trade).schema.parse(rest); },
    execute: async (ctx, _target, value) => {
      const { trade, ...rest } = input.parse(value);
      return tradeSetup(trade).apply(ctx.organizationId, rest);
    }
  });
}
