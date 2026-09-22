import assert from "node:assert/strict";
import test from "node:test";

import { resolveCatalogItemToScopeItem } from "../pricebook/resolver.js";

const record = (value: unknown) => value as Record<string, unknown>;

const catalog = {
  items: [{
    id: "gaf_hdz",
    code: "HDZ",
    name: "GAF Timberline HDZ",
    unit: "sq",
    unit_price: 100,
    internal_cost: 60,
    external_description: "Customer description",
    internal_description: "Crew description",
    default_variant_selection: { color: "charcoal", texture: "smooth", pricing_policy: "fixed_forever" },
    default_pricing_update_rule: { id: "fixed_forever", label: "Fixed forever", mode: "fixed" },
    variant_dimensions: [
      {
        id: "color",
        label: "Color",
        kind: "color",
        affects_sku: true,
        values: [
          { id: "charcoal", label: "Charcoal", hex: "#374151" },
          { id: "red", label: "Red", hex: "#b42318", adjustment: { operation: "add", value: 20, target: "sell_price" } }
        ]
      },
      {
        id: "texture",
        label: "Texture",
        kind: "option",
        affects_sku: true,
        values: [
          { id: "smooth", label: "Smooth" },
          { id: "rough", label: "Rough", adjustment: { operation: "multiply", value: 2, target: "sell_price" } }
        ]
      },
      {
        id: "pricing_policy",
        label: "Price behavior",
        kind: "pricing_policy",
        affects_sku: false,
        values: [
          { id: "fixed_forever", label: "Fixed forever", pricing_update_rule: { id: "fixed_forever", mode: "fixed" } },
          { id: "good_for_30_days", label: "Good for 30 days", pricing_update_rule: { id: "good_for_30_days", mode: "conditional", lock_on: ["signature"], expires_after: { amount: 30, unit: "days" } } }
        ]
      }
    ],
    variant_overrides: {
      "color=red|texture=rough|pricing_policy=good_for_30_days": { unit_price: 230 }
    }
  }],
  variation_sets: []
};

test("artifact lines snapshot the selected combination and keep commercial policies out of the SKU", () => {
  const line = resolveCatalogItemToScopeItem(catalog, "gaf_hdz", {
    selected_variants: { color: "red", texture: "rough", pricing_policy: "good_for_30_days" }
  });
  const snapshot = record(line.pricebook_snapshot);
  const updateRule = record(line.pricing_update_rule);

  assert.equal(line.unit_price, 230);
  assert.equal(snapshot.unit_price, 230);
  assert.equal(snapshot.internal_cost, 60);
  assert.equal(updateRule.mode, "conditional");
  assert.deepEqual(updateRule.lock_on, ["signature"]);
  assert.equal(line.sku_key, "HDZ/color:red/texture:rough");
  assert.doesNotMatch(String(line.sku_key), /pricing_policy/);
  assert.deepEqual(line.selected_variants, {
    color: "red",
    texture: "rough",
    pricing_policy: "good_for_30_days"
  });
});

test("fixed forever is the default artifact-line behavior", () => {
  const line = resolveCatalogItemToScopeItem(catalog, "gaf_hdz");
  assert.equal(line.unit_price, 100);
  assert.equal(record(line.pricing_update_rule).mode, "fixed");
  assert.equal(record(line.pricebook_snapshot).unit_price, 100);
});

test("an artifact line can carry a custom rule without changing the price book item", () => {
  const line = resolveCatalogItemToScopeItem(catalog, "gaf_hdz", {
    pricing_update_rule: {
      id: "custom_90_day_rule",
      label: "Good for 90 days",
      mode: "conditional",
      formula: "days_since(doc.sent_at) >= 90 && !doc.signed"
    }
  });
  assert.equal(record(line.pricing_update_rule).id, "custom_90_day_rule");
  assert.equal(record(line.pricebook_snapshot).unit_price, 100);
  assert.equal(record(record(line.pricebook_snapshot).pricing_update_rule).id, "custom_90_day_rule");
  assert.equal(record(catalog.items[0]!.default_pricing_update_rule).id, "fixed_forever");
});

test("variant price formulas use the safe arithmetic subset", () => {
  const formulaCatalog: any = structuredClone(catalog);
  const color = formulaCatalog.items[0]!.variant_dimensions[0]!.values[1]!;
  color.adjustment = { operation: "formula", formula: "base * 1.2 + 5", target: "sell_price" };
  formulaCatalog.items[0]!.variant_overrides = {};
  const line = resolveCatalogItemToScopeItem(formulaCatalog, "gaf_hdz", {
    selected_variants: { color: "red", texture: "smooth", pricing_policy: "fixed_forever" }
  });
  assert.equal(line.unit_price, 125);
});
