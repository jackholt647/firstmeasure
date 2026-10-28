import { libraryData } from "../config-library/library.js";
import { notFound } from "../platform/errors.js";

/**
 * Material libraries are config library entries of the kind `material_library` (config-library/kinds/material_library.ts):
 * estimating items with manufacturer codes and costs, and the suppliers whose catalogues point at them. `roofing` is
 * the supplier research a development test organization's price book starts with (roofing-library.ts) and the
 * products the roofing setup falls back to. Values are frozen.
 */
export const MATERIAL_LIBRARY_KIND = "material_library";
export type MaterialLibraryItem = { id: string; name: string; code: string; type: string; manufacturer: string; unit: string; cost: number; price: number; note: string };
export type MaterialLibrarySupplier = {
  name: string; delivery_fee_cents: number | null;
  offerings: { item_id: string; sku: string; price_cents: number | null }[];
  locations: { name: string; address: string; phone: string }[];
};
export type MaterialLibrary = { title: string; notes: string[]; items: MaterialLibraryItem[]; suppliers: MaterialLibrarySupplier[] };

export function materialLibrary(id: string): MaterialLibrary {
  const data = libraryData<MaterialLibrary>(MATERIAL_LIBRARY_KIND, id);
  if (!data) throw notFound("material_library_missing", `There is no material library called ${id} in the config library.`);
  return data;
}
