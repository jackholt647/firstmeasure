import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { forbidden, notFound } from "../platform/errors.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { listSuppliers, saveSupplier } from "./suppliers.js";

/**
 * A supplier's prices from its price sheet, as an agent sets them: for one supplier, the cost of each price book item
 * it carries (cents, what the company pays; never marked up). Items it did not carry are added. Saved through the
 * supplier's own writer, so the same checks and revisions apply.
 */
const input = z.object({
  supplier_id: z.string().min(1).max(200),
  prices: z.array(z.object({ item_id: z.string().min(1).max(200), price_cents: z.number().int().min(0).max(1_000_000_000).nullable(), sku: z.string().max(120).optional(), source: z.string().max(200).optional() }).strict()).min(1).max(2000),
  expected_revision: z.number().int().nonnegative().optional()
}).strict();

export function registerSupplierPricesPublication() {
  registerAction({
    id: "suppliers.prices.update", version: "1", domain: "materials", implementation: backendImplementationDigest(),
    description: "Set one supplier's costs from its price sheet: for each price book item (item_id), the price in cents the company pays this supplier, optionally its SKU. Adds items the supplier did not list. Costs only, never a markup. Find the supplier and its current items with the suppliers.catalog data and the price book with pricebook.prices.list; confirm uncertain matches with the person first.",
    inputSchema: zodToJsonSchema(input, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    validateInput: (value) => { input.parse(value); },
    execute: async (ctx, _target, value) => {
      if (!ctx.auth) throw forbidden("supplier_prices_user", "Setting supplier prices needs a signed-in person.");
      const body = input.parse(value);
      const supplier = (await listSuppliers(ctx.organizationId)).find((row) => row.id === body.supplier_id);
      if (!supplier) throw notFound("supplier_unknown", "That supplier does not exist.");
      const offerings = new Map(supplier.offerings.map((row) => [row.item_id, row]));
      const changed = body.prices.map((entry) => {
        const before = offerings.get(entry.item_id);
        offerings.set(entry.item_id, { item_id: entry.item_id, sku: entry.sku ?? before?.sku ?? "", price_cents: entry.price_cents });
        return { item_id: entry.item_id, before: before?.price_cents ?? null, after: entry.price_cents, added: !before, ...(entry.source ? { source: entry.source } : {}) };
      });
      const saved = await saveSupplier(ctx.organizationId, { id: supplier.id, name: supplier.name, offerings: [...offerings.values()], ...(body.expected_revision !== undefined ? { expected_revision: body.expected_revision } : {}) }, ctx.auth);
      return { supplier_id: saved.id, name: saved.name, changed, revision: saved.revision };
    }
  });
}
