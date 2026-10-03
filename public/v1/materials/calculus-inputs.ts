import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { readOrganizationPricebook } from "../pricebook/storage.js";
import { effectiveProjectMeasurements } from "../platform/publication/firstmeasure-datasets.js";
import { measurementDatasetSchema } from "../platform/publication/datasets.js";
import type { JsonObject } from "../platform/storage.js";
const obj = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
const text = { type: "string" };
export function registerMaterialsInputs() {
  registerDataProvider({ id: "materials-inputs", version: "1", apps: ["materials", "pricebook", "measurements"], exports: {
    products: { description: "Organization products with explicit physical units and package coverage; catalog prices are selling references, not supplier quotes.", schemaVersion: "1", schema: { type: "array", items: { type: "object", required: ["id", "name", "unit", "variant", "category"], properties: { id: text, name: text, unit: text, variant: text, category: text, packaging: { type: "object", required: ["unit", "coverage"], properties: { unit: text, coverage: { type: "number", exclusiveMinimum: 0 } }, additionalProperties: false } }, additionalProperties: false } }, access: { scopes: ["organization"], permissions: ["view_pricebook"], capabilities: ["platform.pricebook"] },
      read: async ctx => {
        const catalog = await readOrganizationPricebook(ctx.organizationId);
        const value = catalog.catalog.items.map(raw => {
          const item = obj(raw), packaging = obj(item.order_packaging || item.orderPackaging);
          const coverage = Number(packaging.units_per_package) > 0 ? Number(packaging.units_per_package) : Number(packaging.packages_per_unit) > 0 ? 1 / Number(packaging.packages_per_unit) : 0;
          const unit = String(packaging.order_unit || "");
          return { id: String(item.id), name: String(item.name || item.id), unit: String(item.unit || "each"), variant: String(item.variantId || item.variant_id || ""), category: String(item.category || ""), ...(unit && Number.isFinite(coverage) && coverage > 0 ? { packaging: { unit, coverage } } : {}) };
        });
        return { value, revision: contentHash(value), provenance: { pricebook_id: catalog.manifest.id, catalog_revision: catalog.manifest.revision } };
      }
    },
    measurements: { description: "The project's explicitly selected measurement dataset, including units and provenance. Missing measurements never become zero.", schema: measurementDatasetSchema, schemaVersion: "1", access: { scopes: ["project"], permissions: ["view_projects"] },
      read: async (ctx, ref) => {
        const result = await effectiveProjectMeasurements(ctx, ref.target.projectId!);
        if (result.status !== "ready") return { status: "missing", code: "measurement_dataset_unselected", message: "Select a project measurement dataset before calculating materials." };
        return { value: result.value, revision: String(result.revision), provenance: { dataset_id: result.datasetId, ...obj(result.provenance) } };
      },
      authorizeSnapshot: async (ctx, ref, result) => {
        const datasetId = String(result.provenance.dataset_id || "");
        if (datasetId) await (await import("../platform/publication/datasets.js")).readProjectDataset(ctx, { ...ref.target, id: datasetId });
      }
    }
  } });
}
