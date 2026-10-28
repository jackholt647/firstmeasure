import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Generator } from "./index.js";
import { ROOFING_LIBRARY_ITEMS, ROOFING_LIBRARY_SUPPLIERS } from "../../materials/roofing-library-data.js";

/** The roofing material library (materials/roofing-library-data.ts), with the provenance its header records. */
export const materialLibraryGenerator: Generator = {
  kind: "material_library",
  run: () => {
    const source = readFileSync(fileURLToPath(new URL("../../materials/roofing-library-data.ts", import.meta.url)), "utf8");
    const header = source.split(/\r?\n/).filter((line) => line.startsWith("// ")).slice(0, 4).map((line) => line.slice(3));
    // The first header line names the script that wrote the file, which goes with it; the rest is about the data.
    const notes = [header.slice(1, 3).join(" "), header[3] || ""].filter(Boolean);
    return [{
      id: "roofing",
      data: {
        title: "Roofing library (supplier research, 2026-10-12)",
        notes,
        items: ROOFING_LIBRARY_ITEMS.map(([id, name, code, type, manufacturer, unit, cost, price, note]) => ({ id, name, code, type, manufacturer, unit, cost, price, note })),
        suppliers: ROOFING_LIBRARY_SUPPLIERS.map((supplier) => ({
          name: supplier.name, delivery_fee_cents: supplier.delivery_fee_cents,
          offerings: supplier.offerings.map(([item_id, sku, price_cents]) => ({ item_id, sku, price_cents })),
          locations: supplier.locations.map(([name, address, phone]) => ({ name, address, phone }))
        }))
      }
    }];
  }
};
