import assert from "node:assert/strict";
import test from "node:test";

import { resolveIntakeEntry } from "../scopes/router.js";

const resolveIntakeTemplateId = (routing: Record<string, unknown>, project: Record<string, unknown>) => {
  const entry = resolveIntakeEntry(routing, project);
  return entry.entry === "scope" ? entry.template_id : "";
};

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

test("routing can leave a lead unscoped, by rule or by default", () => {
  const routing = {
    routing_mode: "formula",
    default_entry: "scope",
    default_template_id: "sales_pipeline",
    rules: [{ entry: "unscoped", formula: { conditions: [{ field: "lead_source.kind", operator: "in", value: "missed_call, voicemail" }] } }]
  };
  assert.deepEqual(resolveIntakeEntry(routing, { lead_source: { kind: "missed_call" } }), { entry: "unscoped" });
  assert.deepEqual(resolveIntakeEntry(routing, { lead_source: { kind: "web_form" } }), { entry: "scope", template_id: "sales_pipeline" });
  assert.deepEqual(resolveIntakeEntry({ ...routing, default_entry: "unscoped" }, { lead_source: { kind: "web_form" } }), { entry: "unscoped" });
});
