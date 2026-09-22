import assert from "node:assert/strict";
import test from "node:test";

import { resolveIntakeTemplateId } from "../scopes/router.js";

test("fixed intake routing always uses the configured fallback scope", () => {
  assert.equal(resolveIntakeTemplateId({
    routing_mode: "default",
    default_template_id: "sales_pipeline",
    rules: [{ template_id: "roofing_sales", formula: { conditions: [{ field: "lead.interest", operator: "equals", value: "roofing" }] } }]
  }, { lead: { interest: "roofing" } }), "sales_pipeline");
});

test("field formulas route in order and fall back when initial fields are missing", () => {
  const routing = {
    routing_mode: "formula",
    default_template_id: "sales_pipeline",
    rules: [
      { template_id: "roofing_sales", formula: { match: "all", conditions: [{ field: "lead.interest", operator: "equals", value: "roofing" }, { field: "lead.source", operator: "in", value: "web, referral" }] } },
      { template_id: "commercial_sales", formula: { match: "any", conditions: [{ field: "lead.kind", operator: "equals", value: "commercial" }] } }
    ]
  };
  assert.equal(resolveIntakeTemplateId(routing, { lead: { interest: "Roofing", source: "web" } }), "roofing_sales");
  assert.equal(resolveIntakeTemplateId(routing, { lead: {} }), "sales_pipeline");
});

test("legacy dot-path condition rules remain compatible", () => {
  assert.equal(resolveIntakeTemplateId({
    default_template_id: "sales_pipeline",
    rules: [{ template_id: "canvassing_sales", conditions: { "lead_source.kind": ["canvassing", "door"] } }]
  }, { lead_source: { kind: "door" } }), "canvassing_sales");
});
