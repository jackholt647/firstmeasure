import assert from "node:assert/strict";
import test from "node:test";

import { workflowDefinitionSchema } from "../documents/workflows/schemas.js";
import { filterDocumentDefinitionByCapabilities, filterWorkflowByCapabilities, requireDefinitionCapabilities } from "../documents/capability_policy.js";

test("workflow sections validate nested fields and presentation metadata", () => {
  const parsed = workflowDefinitionSchema.safeParse({
    schema_version: 1,
    name: "Conditional intake",
    contract: { params: { project_type: { type: "string" } }, outputs: {} },
    steps: [{
      id: "st_page_1",
      title: "Project",
      sections: [{
        id: "sec_project",
        title: "Project details",
        when: "{{params.project_type != 'skip'}}",
        transition: { type: "grow", duration_ms: 220 },
        items: [{
          kind: "select",
          writes: "params.project_type",
          label: "Project type",
          options: [{ value: "roof", label: "Roof" }],
          presentation: { style: "tiles", frame: { x: 24, y: 24, w: 420, h: 150 } }
        }]
      }]
    }]
  });
  assert.equal(parsed.success, true);
});

test("workflow sections apply kind validation to nested fields", () => {
  const parsed = workflowDefinitionSchema.safeParse({
    name: "Bad nested field",
    steps: [{ id: "st_page_1", sections: [{ id: "sec_1", items: [{ kind: "made_up", writes: "params.x" }] }] }]
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.issues.map((issue) => issue.message).join(" "), /Unknown workflow item kind/);
});

test("disabled template capabilities preserve and annotate document and workflow elements", () => {
  const state = { effectiveByKey: { "documents.payments": false, "documents.esign": true }, enabledTypes: null };
  assert.doesNotThrow(() => requireDefinitionCapabilities(state, { pages: [{ children: [{ type: "widget", props: { widget: "doc.pay_now" } }] }] }));
  const document = filterDocumentDefinitionByCapabilities({
    pages: [{ id: "pg_1", children: [{ id: "nd_pay", type: "widget", props: { widget: "doc.pay_now" } }] }],
    outputs: { payment: { type: "payment" } }
  }, state);
  const payNode = (document.pages as any[])[0].children[0];
  assert.equal(payNode.props.widget, "doc.pay_now");
  assert.equal(payNode.props.disabled, true);
  assert.equal((document.outputs as any).payment.disabled, true);
  const web = filterDocumentDefinitionByCapabilities({
    kind: "view",
    root: { id: "view_root", type: "frame", props: {}, children: [{ id: "web_pay", type: "widget", props: { widget: "doc.pay_now@1" } }] }
  }, state);
  assert.equal((web.root as any).children[0].props.disabled, true);

  const workflow = filterWorkflowByCapabilities({
    name: "Pay",
    steps: [{ id: "st_1", sections: [{ id: "sec_1", items: [{ kind: "payment", writes: "outputs.payment" }] }] }]
  }, state);
  const payment = ((workflow.steps as any[])[0].sections[0].items[0]);
  assert.equal(payment.kind, "payment");
  assert.equal(payment.disabled, true);
});
