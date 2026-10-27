import { z } from "zod";
import type { LibraryKind } from "../contracts.js";

export const MATERIAL_LIBRARY_KIND = "material_library";

const cents = z.number().int().min(0).max(100_000_000);
/**
 * A library of materials a development test organization starts with (materials/roofing-library.ts): estimating
 * items with manufacturer codes and costs, and the suppliers whose catalogues point at them. Research data: a SKU or
 * price appears only where it was seen on a public listing, and suppliers carry no order email.
 */
export const materialLibraryData = z.object({
  title: z.string().trim().min(1).max(200),
  /** Where the data came from and what it may be used for. */
  notes: z.array(z.string().max(1000)).max(20),
  items: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,119}$/),
    name: z.string().trim().min(1).max(200),
    /** The manufacturer's product code, or "". */
    code: z.string().max(80),
    type: z.string().trim().min(1).max(80),
    manufacturer: z.string().max(120),
    unit: z.string().trim().min(1).max(40),
    /** Base cost and sell price, in dollars. */
    cost: z.number().finite().min(0).max(1_000_000),
    price: z.number().finite().min(0).max(1_000_000),
    note: z.string().max(1000)
  }).strict()).min(1).max(2000),
  suppliers: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    delivery_fee_cents: cents.nullable(),
    /** What the supplier carries: a library item, its SKU there ("" when not seen) and a price seen there, or null. */
    offerings: z.array(z.object({ item_id: z.string().min(1).max(120), sku: z.string().max(80), price_cents: cents.nullable() }).strict()).max(2000),
    locations: z.array(z.object({ name: z.string().trim().min(1).max(200), address: z.string().max(400), phone: z.string().max(60) }).strict()).max(100)
  }).strict()).max(100)
}).strict();
export type MaterialLibraryData = z.infer<typeof materialLibraryData>;

export const materialLibraryKind: LibraryKind<MaterialLibraryData> = {
  kind: MATERIAL_LIBRARY_KIND,
  title: "Material libraries",
  description: "Estimating items and suppliers a development test organization's price book starts with (the roofing library), and the products the roofing setup falls back to for rules it does not cover.",
  schema: materialLibraryData,
  titleOf: (data) => data.title,
  validate(data) {
    const errors: string[] = [];
    const ids = new Set<string>();
    for (const entry of data.items) { if (ids.has(entry.id)) errors.push(`Item ${entry.id} is listed twice.`); ids.add(entry.id); }
    const names = new Set<string>();
    for (const supplier of data.suppliers) {
      if (names.has(supplier.name)) errors.push(`Supplier ${supplier.name} is listed twice.`);
      names.add(supplier.name);
      const offered = new Set<string>();
      for (const offering of supplier.offerings) {
        if (!ids.has(offering.item_id)) errors.push(`${supplier.name} offers ${offering.item_id}, which is not a library item.`);
        if (offered.has(offering.item_id)) errors.push(`${supplier.name} offers ${offering.item_id} twice.`);
        offered.add(offering.item_id);
      }
    }
    return errors;
  }
};
