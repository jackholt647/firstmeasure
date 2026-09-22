/* Configure the test branch to route new projects into the scope-defined
 * roofing sales pipeline and attach two current appointments to that flow. */
import { ensureDefaultDocumentAssets } from "../documents/seeds.js";
import { listProjectDocuments } from "../documents/service.js";
import { readDocumentWorkflow, saveDocumentInstance } from "../documents/storage.js";
import { readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { readIntakeRouting, saveIntakeRouting } from "../scopes/router.js";
import { instantiateScopeTemplateWorkPlan } from "../scopes/service.js";
import { ensureDefaultScopeTemplates, readScopeTemplate } from "../scopes/storage.js";

const orgId = String(process.argv[2] || "").trim();
if (!orgId) throw new Error("Usage: seed-roofing-sales-demo.ts <orgId>");

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

async function main() {
  ensureDefaultScopeTemplates(orgId, "default");
  await ensureDefaultDocumentAssets(orgId);

  const routing = await readIntakeRouting(orgId, "default");
  await saveIntakeRouting(orgId, "default", {
    expected_revision: routing.revision,
    default_template_id: "roofing_sales_appointment",
    rules: routing.rules
  });

  const template = readScopeTemplate(orgId, "default", "roofing_sales_appointment");
  const demos = [
    { projectId: "routing_demo_19", eventId: "routing_demo_19_appt" },
    { projectId: "routing_demo_26", eventId: "routing_demo_26_appt" }
  ];

  for (const demo of demos) {
    const document = await readDocument(orgId, "projects", demo.projectId);
    const project = asObject(document.data);
    const events = (Array.isArray(project.events) ? project.events : []).map((value) => {
      const event = asObject(value);
      return String(event.id || "") === demo.eventId
        ? { ...event, scope_template_id: "roofing_sales_appointment", visit_state: {} }
        : event;
    });
    await upsertDocument(orgId, "projects", {
      id: demo.projectId,
      data: { ...project, sales_scope_template_id: "roofing_sales_appointment", events },
      metadata: document.metadata
    }, { replace: true });
    await instantiateScopeTemplateWorkPlan(orgId, {
      project_id: demo.projectId,
      branch_id: "default",
      template,
      source_type: "pipeline",
      source_id: "roofing_sales_appointment",
      source_key: `pipeline:${demo.projectId}:roofing_sales_appointment`,
      title: "Standard Roofing Sales",
      context: { demo: true, default_sales_pipeline: true }
    });
  }

  const documents = (await Promise.all(demos.map((demo) => listProjectDocuments(orgId, demo.projectId)))).flat();
  const workflow = await readDocumentWorkflow(orgId, "wfl_roofing_customer_workflow");
  for (const document of documents) {
    if (String(asObject(document.template_ref).template_id || "") !== "tpl_roofing_good_better_best_workflow") continue;
    await saveDocumentInstance(orgId, String(document.id), {
      ...document,
      workflow_ref: { workflow_id:"wfl_roofing_customer_workflow", version:Number(workflow.current_version || 0) }
    }, { expectedRevision:Number(document.revision || 0) });
  }
  console.log(JSON.stringify({
    ok: true,
    organization_id: orgId,
    branch_default_pipeline: "roofing_sales_appointment",
    appointments: demos,
    roofing_workflows: documents.filter((document) => String(asObject(document.template_ref).template_id || "") === "tpl_roofing_good_better_best_workflow")
      .map((document) => ({ id:document.id, project_id:document.project_id, status:document.status, workflow_version:workflow.current_version }))
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
