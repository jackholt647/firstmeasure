/* Seed two same-day service visits for the field salesperson demo. */
import { listDocuments, upsertDocument } from "../platform/storage.js";
import { ensureDefaultDocumentAssets } from "../documents/seeds.js";
import { listProjectDocuments, patchDocumentInstance } from "../documents/service.js";
import { readDocumentWorkflow, saveDocumentInstance } from "../documents/storage.js";
import { instantiateScopeTemplateWorkPlan } from "../scopes/service.js";
import { ensureDefaultScopeTemplates, readScopeTemplate } from "../scopes/storage.js";
import { initializeAccessRoles } from "../workforce/access.js";
import { patchWorkforceUserProfile } from "../workforce/service.js";
import { effectiveCapabilities, saveCapabilityValues } from "../platform/capabilities.js";

const orgId = String(process.argv[2] || "").trim();
const email = String(process.argv[3] || "sales.demo@1m8.ai").trim().toLowerCase();
if (!orgId) throw new Error("Usage: seed-same-day-service-demo.ts <orgId> [email]");

function todayAt(hour: number, minute: number) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

async function main() {
  initializeAccessRoles(orgId);
  const effective = await effectiveCapabilities(orgId) as { values?: Record<string, unknown> };
  const values = effective.values || effective as Record<string, unknown>;
  const enable: Record<string, boolean> = {};
  for (const key of ["apps.crew", "platform.documents", "platform.money"]) {
    const entry = values[key];
    const enabled = entry === true || (entry && typeof entry === "object" && (entry as Record<string, unknown>).value === true);
    if (!enabled) enable[key] = true;
  }
  if (Object.keys(enable).length) await saveCapabilityValues(orgId, enable);
  ensureDefaultScopeTemplates(orgId, "default");
  await ensureDefaultDocumentAssets(orgId);

  const users = await listDocuments(orgId, "users");
  const userDoc = users.find((doc) => String((doc.data as Record<string, unknown>).email || "").toLowerCase() === email);
  if (!userDoc) throw new Error(`User ${email} was not found in ${orgId}`);
  const userId = String(userDoc.id);
  await patchWorkforceUserProfile(orgId, userId, {
    access_role_ids: ["salesperson"],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: "salesperson", permissions: {} }
    }
  });

  const visits = [
    {
      id: "same_day_demo_carter",
      title: "Carter Same-Day Water Heater Install",
      address: "1840 Meadow View Drive, Springfield",
      customer: { name: "Jordan Carter", phone: "555-0128", email: "jordan.carter@example.com" },
      appointment: { id: "same_day_demo_appt_carter", start_at: todayAt(9, 30), end_at: todayAt(10, 45), notes: "Assess replacement, enter the selected unit and estimated installation hours, then authorize on site." }
    },
    {
      id: "same_day_demo_nguyen",
      title: "Nguyen Same-Day Garage Opener Install",
      address: "626 Willow Bend, Springfield",
      customer: { name: "Avery Nguyen", phone: "555-0176", email: "avery.nguyen@example.com" },
      appointment: { id: "same_day_demo_appt_nguyen", start_at: todayAt(13, 30), end_at: todayAt(14, 45), notes: "Build a materials and labor quote on the phone, take payment, sign, and begin the install." }
    }
  ];

  const salesTemplate = readScopeTemplate(orgId, "default", "same_day_service_sales");
  for (const visit of visits) {
    await upsertDocument(orgId, "projects", {
      id: visit.id,
      data: {
        branch_id: "default",
        title: visit.title,
        address: visit.address,
        status: "sales",
        contacts: [{ id: `${visit.id}_customer`, ...visit.customer, primary: true }],
        events: [{
          ...visit.appointment,
          kind: "appointment",
          event_type_default_id: "sales_appointment",
          status: "scheduled",
          assigned_user_ids: [userId],
          all_day: false,
          schedule_granularity: "time",
          duration_minutes: 75
        }]
      },
      metadata: { kind: "platform_project", branch_id: "default", source: "seed_same_day_service_demo" }
    }, { replace: true });
    await instantiateScopeTemplateWorkPlan(orgId, {
      project_id: visit.id,
      branch_id: "default",
      template: salesTemplate,
      source_type: "demo_seed",
      source_id: visit.id,
      source_key: `same_day_service_sales:${visit.id}`,
      title: "Same-Day Service Sales",
      context: { demo: true, assigned_user_id: userId }
    });
  }

  const projects = await listDocuments(orgId, "projects");
  const documents = (await Promise.all(visits.map((visit) => listProjectDocuments(orgId, visit.id)))).flat();
  const systemCtx = { orgId, branchId: "default", userId: "system_demo_seed", identityId: "system_demo_seed", permissions: {}, role: "system" } as never;
  const fieldWorkflow = await readDocumentWorkflow(orgId, "wfl_same_day_service_field");
  const fieldWorkflowVersion = Number(fieldWorkflow.current_version || 0);
  for (const document of documents) {
    // Real issued documents remain pinned forever. These explicitly marked
    // demo documents are refreshed by the demo seeder so UI/template changes
    // can be exercised without creating duplicate pending authorizations.
    if (fieldWorkflowVersion && String((document.workflow_ref as Record<string, unknown> | undefined)?.workflow_id || "") === "wfl_same_day_service_field") {
      await saveDocumentInstance(orgId, String(document.id), {
        ...document,
        workflow_ref: { workflow_id: "wfl_same_day_service_field", version: fieldWorkflowVersion }
      }, { expectedRevision: Number(document.revision || 0) });
    }
    await patchDocumentInstance(orgId, String(document.id), { metadata: { demo: "same_day_service" } }, systemCtx);
  }
  console.log(JSON.stringify({
    ok: true,
    organization_id: orgId,
    user_id: userId,
    appointments: visits.map((visit) => ({ project_id: visit.id, title: visit.title, start_at: visit.appointment.start_at })),
    seeded_projects: projects.filter((doc) => visits.some((visit) => visit.id === doc.id)).length,
    workflow_documents: documents.map((doc) => ({ id: doc.id, project_id: doc.project_id, status: doc.status, workflow_version: fieldWorkflowVersion }))
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
