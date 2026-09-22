import { z } from "zod";

import type { JsonObject } from "../../platform/storage.js";
import { readBranchModule } from "../../platform/storage.js";
import { moneyCents } from "../../proposals/scope.js";
import { registerDocumentSource, type DocumentSourceContext } from "./registry.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function roundCents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function prettifyKey(key: string) {
  return cleanText(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// measurements.project — the project's measurement fields as label/value rows.
// ---------------------------------------------------------------------------

registerDocumentSource("measurements.project", {
  shape: { rows: ["key", "label", "value"] },
  resolve: async (ctx) => {
    const fromProject = asObject(asObject(ctx.project).measurements);
    const measurements = Object.keys(fromProject).length ? fromProject : asObject(ctx.params.measurements);
    return Object.entries(measurements)
      .filter(([, value]) => typeof value === "number" || (typeof value === "string" && cleanText(value)))
      .map(([key, value]) => ({
        key,
        label: prettifyKey(key),
        value: typeof value === "number" ? value : cleanText(value)
      }));
  }
});

// ---------------------------------------------------------------------------
// pricebook.category — items of a category, read from the v1 pricebook (the
// org's default manifest catalog) with the branch `pricebook` module as the
// fallback. Rows are normalized to the pricebook_line-ish shape templates use.
// ---------------------------------------------------------------------------

function normalizePricebookRow(value: unknown): JsonObject {
  const item = asObject(value);
  const unitPrice = Number(item.unitPrice ?? item.unit_price ?? item.basePrice ?? item.base_price ?? 0) || 0;
  return {
    id: cleanText(item.id),
    name: cleanText(item.name || item.label || "Item"),
    description: cleanText(item.description),
    category: cleanText(item.category),
    manufacturer: cleanText(item.manufacturer),
    unit: cleanText(item.unit || "ea") || "ea",
    quantity: 1,
    unit_price: unitPrice,
    unit_price_cents: moneyCents(unitPrice),
    images: asArray(item.images).map(asObject)
  };
}

registerDocumentSource("pricebook.category", {
  params_schema: z.object({
    category: z.string().trim().optional(),
    pricebook_id: z.string().trim().optional()
  }).passthrough(),
  shape: { rows: ["id", "name", "description", "category", "unit", "unit_price_cents"] },
  resolve: async (ctx, args) => {
    const category = cleanText(args.category).toLowerCase();
    const matches = (rows: JsonObject[]) => (
      category ? rows.filter((row) => cleanText(row.category).toLowerCase() === category) : rows
    );
    // Primary: the standalone v1 pricebook module (org's default manifest).
    try {
      const { listPricebookManifests, readCatalog } = await import("../../pricebook/storage.js");
      const manifests = (await listPricebookManifests().catch(() => []))
        .map(asObject)
        .filter((manifest) => cleanText(asObject(manifest.organization_ref).id) === ctx.organizationId);
      const manifest = cleanText(args.pricebook_id)
        ? manifests.find((entry) => cleanText(entry.id) === cleanText(args.pricebook_id))
        : manifests.find((entry) => entry.is_default === true) || manifests[0];
      if (manifest && cleanText(manifest.id)) {
        const catalog = await readCatalog(cleanText(manifest.id)).catch(() => null);
        const rows = matches(asArray(asObject(catalog).items).map(normalizePricebookRow));
        if (rows.length) return rows;
      }
    } catch {
      // fall through to the branch module
    }
    // Fallback: the branch `pricebook` config module.
    const branchId = cleanText(ctx.document.branch_id || "default") || "default";
    const module = await readBranchModule(ctx.organizationId, branchId, "pricebook").catch(() => null);
    return matches(asArray(asObject(asObject(module).data).items).map(normalizePricebookRow));
  }
});

// ---------------------------------------------------------------------------
// materials.order_lines — line rows from material orders (a specific order or
// every order on the document's project). Reads the collection directly so a
// disabled materials capability flag never breaks a document render.
// ---------------------------------------------------------------------------

function materialOrderLineRows(order: JsonObject): JsonObject[] {
  return asArray(order.items).map(asObject).map((item) => ({
    id: cleanText(item.id),
    order_id: cleanText(order.id),
    name: cleanText(item.name || "Material item"),
    description: cleanText(item.description),
    category: cleanText(item.category || item.section),
    quantity: Number(item.quantity ?? 1) || 0,
    unit: cleanText(item.unit || "ea") || "ea",
    unit_price_cents: moneyCents(item.projected_unit_price ?? item.unit_price ?? 0),
    total_cents: item.projected_total !== undefined && item.projected_total !== null
      ? moneyCents(item.projected_total)
      : roundCents((Number(item.quantity ?? 1) || 0) * moneyCents(item.projected_unit_price ?? item.unit_price ?? 0))
  }));
}

registerDocumentSource("materials.order_lines", {
  params_schema: z.object({
    order_id: z.string().trim().optional()
  }).passthrough(),
  shape: { rows: ["id", "order_id", "name", "quantity", "unit", "unit_price_cents", "total_cents"] },
  resolve: async (ctx: DocumentSourceContext, args) => {
    const docs = await ctx.services.platform.listDocuments(ctx.organizationId, "material_orders").catch(() => [] as JsonObject[]);
    const orders = docs.map((doc): JsonObject => {
      const data = asObject(doc.data);
      return { ...data, id: cleanText(data.id || doc.id) };
    });
    const orderId = cleanText(args.order_id);
    const projectId = cleanText(ctx.document.project_id || asObject(ctx.project).id);
    const selected = orderId
      ? orders.filter((order) => cleanText(order.id) === orderId)
      : orders.filter((order) => projectId && cleanText(order.project_id) === projectId);
    selected.sort((a, b) => cleanText(a.ordered_at || a.created_at).localeCompare(cleanText(b.ordered_at || b.created_at)));
    return selected.flatMap(materialOrderLineRows);
  }
});

// ---------------------------------------------------------------------------
// payments.obligations — the project's existing payment obligations.
// ---------------------------------------------------------------------------

registerDocumentSource("payments.obligations", {
  shape: { rows: ["id", "label", "amount_cents", "allocated_cents", "balance_due_cents", "due_at", "status"] },
  resolve: async (ctx) => {
    const projectId = cleanText(ctx.document.project_id || asObject(ctx.project).id);
    if (!projectId) return [];
    const obligations = await ctx.services.payments.listProjectObligations(ctx.organizationId, projectId).catch(() => [] as JsonObject[]);
    return obligations.map((item, index) => ({
      id: cleanText(item.id) || `obligation_${index + 1}`,
      label: cleanText(item.label || "Payment"),
      direction: cleanText(item.direction || "inbound") || "inbound",
      amount_cents: roundCents(item.amount_cents),
      allocated_cents: roundCents(item.allocated_cents),
      balance_due_cents: Math.max(0, roundCents(item.amount_cents) - roundCents(item.allocated_cents)),
      due_rule: cleanText(item.due_rule),
      due_at: cleanText(item.due_at),
      status: cleanText(item.status || "open") || "open"
    }));
  }
});

/** Importing this module registers every built-in source. */
export function registerBuiltinDocumentSources() {
  // Registration happens at module load; this export makes the dependency
  // explicit instead of relying on import order.
}
