import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-proposals-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Proposal Test Org",
    organization_id: `org_proposal_${suffix}`,
    global: {
      app_flags: {
        platform: { proposals: true, project_photos: true, customer_portal: true, pricebook: true, materials: true, money: true }
      }
    }
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, proposals: true, project_photos: true, customer_portal: true, pricebook: true, materials: true, money: true }
      }
    }
  }, { replace: false });
  return { orgId };
}

test("proposal lifecycle creates snapshots, PDFs, public views, signatures, and events", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_proposal_test";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "100 Proposal Lane",
      title: "Jane Homeowner",
      project_type: "residential",
      contacts: [{ name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222" }],
      photos: [],
      workflow_state: "contact_only"
    },
    metadata: { kind: "platform_project" }
  });

  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Roof Replacement Proposal",
    contacts: [{ role: "customer", name: "Jane Homeowner", email: "jane@example.test" }],
    editable: {
      title: "Roof Replacement Proposal",
      measurements: { roofSquares: 32, eavesLf: 180, pitch6to8Squares: 32 },
      theme: { key: "margin" },
      pages: [
        { id: "cover", kind: "cover", heading: "Roof Replacement Proposal", preparedFor: "Jane Homeowner" },
        { id: "pricing", kind: "pricing", title: "Investment", lineItems: [{ label: "Roof replacement", quantity: "1", amount: 12500 }] },
        { id: "signature", kind: "signature", title: "Approval", depositAmount: 2500, completionAmount: 10000 }
      ],
      scope: {
        measurements: { roofSquares: 0, eavesLf: 0, pitch6to8Squares: 0 },
        pieces: [{
          id: "roof_piece_primary",
          templateId: "roof_replacement",
          sectionName: "Main House Roof Replacement",
          measurements: { roofSquares: 0, eavesLf: 0, pitch6to8Squares: 0 },
          structures: [{ id: "main_house", name: "Main House", replacementMode: "full" }]
        }],
        root_items: [{
          id: "roof_replacement_scope",
          name: "Roof Replacement",
          label: "Roof Replacement",
          children: [
            {
              id: "underlayment_standard",
              name: "Standard Underlayment",
              label: "Standard Underlayment",
              quantity: 1,
              unit_price: 10000,
              selection: {
                mode: "choice",
                group_id: "underlayment_profile",
                selected: true,
                customer_visible: true,
                selectable_by: ["internal", "customer"]
              }
            },
            {
              id: "underlayment_premium",
              name: "Premium Underlayment",
              label: "Premium Underlayment",
              quantity: 1,
              unit_price: 12000,
              selection: {
                mode: "choice",
                group_id: "underlayment_profile",
                selected: false,
                customer_visible: true,
                selectable_by: ["internal", "customer"]
              }
            }
          ]
        }]
      },
      resources: {
        project_photo_refs: [],
        proposal_image_refs: [],
        markup_refs: []
      }
    }
  });
  assert.equal(created.proposal.status, "draft");
  assert.equal(created.proposal.project_id, projectId);
  const activeProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(activeProject.document.data.workflow_state, "proposal_only");
  assert.equal(activeProject.document.data.has_meaningful_activity, true);
  assert.ok(activeProject.document.data.proposal_ids.includes(created.proposal.id));

  const listed = await client.request("GET", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`);
  assert.equal(listed.count, 1);

  const proposalId = created.proposal.id;
  const patched = await client.request("PATCH", `/v1/proposals/organizations/${orgId}/proposals/${proposalId}`, {
    expected_revision: created.proposal.revision,
    editable: {
      pricing: { total: 12500 },
      variables: { customer_name: "Jane Homeowner" }
    }
  });
  assert.equal(patched.proposal.editable.pricing.total, 12500);

  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${proposalId}/send`, {
    expected_revision: patched.proposal.revision,
    recipients: [{ role: "customer", name: "Jane Homeowner", email: "jane@example.test" }],
    include_pdf: true,
    include_portal: true
  });
  assert.equal(sent.proposal.status, "sent");
  assert.equal(sent.snapshot.reason, "send");
  assert.ok(sent.snapshot.delivery.public_token);
  assert.equal(sent.snapshot.contact_snapshot.contacts[0].email, "jane@example.test");
  assert.equal(sent.snapshot.contact_snapshot.recipients[0].email, "jane@example.test");
  assert.equal(sent.emailed[0].email, "jane@example.test");
  assert.equal(sent.emailed[0].ok, true);
  assert.ok(sent.proposal.pdf.latest_media_id);
  const { readDocumentInstance } = await import("../documents/storage.js");
  const proposalDocument = await readDocumentInstance(orgId, `doc_legacy_proposal_${sent.snapshot.id}`);
  assert.equal(proposalDocument.document_type, "proposal");
  assert.equal((proposalDocument.template_ref as any).template_id, "tpl_proposal_default");
  const sentProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const pipelineInstance = sentProject.document.data.work_projection.active_instances
    .find((instance: any) => instance.kind === "pipeline");
  assert.equal(pipelineInstance.template_id, "sales_pipeline");
  assert.equal(pipelineInstance.stage_id, "closing_stage");

  const pdf = await client.raw("GET", `/v1/proposals/organizations/${orgId}/proposals/${proposalId}/pdf`);
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.ok(pdf.body.length > 100);

  const publicToken = sent.snapshot.delivery.public_token;
  const publicView = await client.request("GET", `/v1/proposals/public/${publicToken}`);
  assert.equal(publicView.snapshot.title, "Roof Replacement Proposal");
  assert.equal(publicView.snapshot.pdf_url, `/v1/proposals/public/${publicToken}/pdf`);

  const publicPdf = await client.raw("GET", `/v1/proposals/public/${publicToken}/pdf`);
  assert.equal(publicPdf.statusCode, 200);
  assert.equal(publicPdf.headers["content-type"], "application/pdf");
  assert.ok(publicPdf.body.length > 100);

  const viewed = await client.request("POST", `/v1/proposals/public/${publicToken}/view`, {
    type: "proposal_opened",
    session_id: "session_test"
  });
  assert.equal(viewed.snapshot.status, "viewed");

  const choice = await client.request("POST", `/v1/proposals/public/${publicToken}/choices`, {
    group_id: "underlayment_profile",
    option_id: "underlayment_premium",
    visitor_session_id: "session_test"
  });
  const choiceItems = choice.snapshot.content.scope.root_items[0].children;
  assert.equal(choiceItems[0].selection.selected, false);
  assert.equal(choiceItems[1].selection.selected, true);
  assert.equal(choiceItems[1].selection.selected_by, "customer");
  assert.equal(choice.workflow.proposal.totals.total, "$12,000.00");

  const signed = await client.request("POST", `/v1/proposals/public/${publicToken}/sign`, {
    signer_name: "Jane Homeowner",
    signature: { type: "adopt", text: "Jane Homeowner" }
  });
  assert.equal(signed.snapshot.status, "signed");
  assert.equal(signed.snapshot.content.scope.pieces[0].measurements.roofSquares, 32);
  assert.equal(signed.snapshot.content.scope.pieces[0].measurements.eavesLf, 180);
  assert.equal(signed.snapshot.content.scope.pieces[0].measurements.pitch6to8Squares, 32);
  assert.equal(signed.snapshot.content.scope.pieces[0].root_items[0].id, "roof_replacement_scope");

  const workPlans = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/plans?include_tree=1`);
  assert.equal(workPlans.count, 2);
  const roofWorkPlan = workPlans.plans.find((plan: any) => plan.template_id === "roof_replacement");
  assert.ok(roofWorkPlan);
  assert.equal(roofWorkPlan.scope_piece_id, "roof_piece_primary");
  assert.equal(roofWorkPlan.metadata.board_color, "#dc2626");
  assert.deepEqual(roofWorkPlan.root_nodes[0].children.map((stage: any) => stage.title), ["Pending Deposit", "Newly Sold", "Scheduled", "Pre-Production", "Production Completed"]);
  const salesWorkPlan = workPlans.plans.find((plan: any) => plan.template_id === "sales_pipeline");
  assert.equal(salesWorkPlan.status, "active");
  const flattenNodes = (nodes: any[]): any[] => nodes.flatMap((node) => [node, ...flattenNodes(node.children || [])]);
  const salesTasks = flattenNodes(salesWorkPlan.root_nodes);
  assert.equal(salesTasks.find((node: any) => node.template_node_id === "contact_lead").status, "completed");
  assert.equal(salesTasks.some((node: any) => node.template_node_id === "schedule_sales_appointment"), false);
  assert.equal(salesTasks.find((node: any) => node.template_node_id === "complete_sales_appointment").status, "completed");
  assert.equal(salesTasks.find((node: any) => node.template_node_id === "sign_sales_proposal").status, "completed");
  assert.equal(salesTasks.find((node: any) => node.template_node_id === "collect_sales_deposit").status, "ready");
  const roofTasks = flattenNodes(roofWorkPlan.root_nodes);
  assert.equal(roofTasks.find((node: any) => node.template_node_id === "deposit_paid").title, "Collect deposit");
  const signedProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const signedRoofInstance = signedProject.document.data.work_projection.active_instances
    .find((instance: any) => instance.template_id === "roof_replacement");
  assert.equal(signedRoofInstance.stage_id, "signed_pending_payment_stage");
  // Schedule-group rollup containers (is_schedule_group) ride along with the
  // startup requirements; only the three real requirements are counted here.
  const signedStartupEvents = (signedProject.document.data.events || [])
    .filter((event: any) => event.status === "unscheduled" && event.is_schedule_group !== true);
  assert.equal(signedStartupEvents.length, 3);
  assert.ok(signedStartupEvents.every((event: any) => !event.start_at && !event.end_at), JSON.stringify(signedStartupEvents, null, 2));
  const beforeDepositResources = await client.request("GET", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`);
  assert.equal(beforeDepositResources.count, 4);
  const beforeDepositTodos = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?project_id=${projectId}`);
  assert.equal(beforeDepositTodos.action_items.some((item: any) => item.title === "Schedule crew arrival"), false);

  const paid = await client.request("POST", `/v1/proposals/public/${publicToken}/payments/mock-deposit`, {});
  assert.equal(paid.payment.kind, "customer_deposit");
  assert.equal(paid.payment.status, "settled");
  const soldProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const soldRoofInstance = soldProject.document.data.work_projection.active_instances
    .find((instance: any) => instance.template_id === "roof_replacement");
  assert.ok(["newly_sold_stage", "scheduled_stage"].includes(soldRoofInstance.stage_id));
  assert.ok(soldProject.document.data.lifecycle.sold_at);
  const startupEvents = (soldProject.document.data.events || []).filter((event: any) => event.status === "unscheduled");
  const dryIn = startupEvents.find((event: any) => event.event_type_default_id === "material_delivery_dry_in");
  const shingles = startupEvents.find((event: any) => event.event_type_default_id === "material_delivery_shingles");
  const projectWork = startupEvents.find((event: any) => event.event_type_default_id === "project_work");
  assert.ok(dryIn?.source_node_id, JSON.stringify(startupEvents, null, 2));
  assert.ok(shingles?.source_node_id, JSON.stringify(startupEvents, null, 2));
  assert.ok(projectWork?.source_node_id, JSON.stringify(startupEvents, null, 2));
  assert.equal(dryIn.title, "Dry-In");
  assert.equal(shingles.title, "Shingle");
  assert.equal(dryIn.work_plan_id, roofWorkPlan.id);
  assert.equal(shingles.work_plan_id, roofWorkPlan.id);
  assert.equal(projectWork.work_plan_id, roofWorkPlan.id);

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const signedNotification = notifications.notifications.find((notification: any) => notification.source === "scope.roof_replacement.proposal_signed");
  assert.ok(signedNotification);
  assert.equal(signedNotification.title, "Jane Homeowner proposal signed");
  assert.equal(signedNotification.body, "100 Proposal Lane");
  assert.equal(signedNotification.context.proposal_id, proposalId);
  assert.equal(signedNotification.frontend_action.kind, "open_project");
  assert.equal(signedNotification.frontend_action.project_id, projectId);
  const paidNotification = notifications.notifications.find((notification: any) => notification.source === "scope.roof_replacement.proposal_paid");
  assert.ok(paidNotification);
  assert.equal(paidNotification.title, "Jane Homeowner proposal payment received");
  assert.equal(paidNotification.body, "Deposit: $2,500.00 - 100 Proposal Lane");
  assert.equal(paidNotification.context.proposal_id, proposalId);
  assert.equal(paidNotification.context.payment_id, paid.payment.id);
  assert.equal(paidNotification.context.amount_cents, "250000");
  const paidCelebration = notifications.notifications.find((notification: any) => notification.source === "scope.roof_replacement.proposal_paid_celebration");
  assert.ok(paidCelebration);
  assert.equal(paidCelebration.kind, "celebration");
  assert.equal(paidCelebration.celebration.size, "large");
  assert.equal(paidCelebration.celebration.reason, "proposal_paid");
  assert.equal(paidCelebration.celebration.text, "Jane Homeowner paid $2,500.00.");

  const boards = await client.request("GET", `/v1/work/organizations/${orgId}/boards?include_completed=1`);
  const roofBoard = boards.boards.find((board: any) => board.id === "roof_replacement");
  assert.equal(roofBoard.color, "#dc2626");
  assert.deepEqual(roofBoard.columns.map((column: any) => column.title), ["Pending Deposit", "Newly Sold", "Scheduled", "Pre-Production", "Production Completed", "Cancelled"]);

  const generatedMaterials = await client.request("GET", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`);
  assert.equal(generatedMaterials.count, 4);
  const dryInList = generatedMaterials.material_lists.find((list: any) => list.title === "Dry-In");
  const shingleList = generatedMaterials.material_lists.find((list: any) => list.title === "Shingle");
  const laborList = generatedMaterials.material_lists.find((list: any) => list.resource_type === "labor");
  const equipmentList = generatedMaterials.material_lists.find((list: any) => list.resource_type === "equipment");
  assert.equal(dryInList.color, "#dc2626");
  assert.equal(shingleList.color, "#f97316");
  assert.equal(dryInList.schedule_event_id, dryIn.id);
  assert.equal(shingleList.schedule_event_id, shingles.id);
  assert.equal(dryIn.material_list_id, dryInList.id);
  assert.equal(shingles.material_list_id, shingleList.id);
  assert.equal(projectWork.scope_resource_list_id, laborList.id);
  // The roofing preset now ships equipment scheduling enabled (resource-lane
  // Gantt); event creation stays gated on the org's equipment.scheduling
  // capability, so no requirement event is minted for this org.
  assert.equal(equipmentList.schedule.enabled, true);
  assert.ok(!equipmentList.schedule_event_id);
  assert.deepEqual(dryInList.order_sources.map((source: any) => source.id), ["manual", "srs_distribution", "convoy_supply"]);

  const afterDepositTodos = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?project_id=${projectId}`);
  const afterDepositTitles = new Set(afterDepositTodos.action_items.map((item: any) => item.title));
  [
    "Schedule project with customer",
    "Finalize material lists",
    "Order materials",
    "Schedule dry-in delivery",
    "Schedule shingle delivery",
    "Schedule crew arrival"
  ].forEach((title) => assert.ok(afterDepositTitles.has(title), `Missing post-deposit to-do: ${title}`));

  const paymentSummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  const finalObligation = paymentSummary.obligations.find((obligation: any) => obligation.label === "Final Payment");
  assert.ok(finalObligation);
  const finalPaid = await client.request("POST", `/v1/proposals/public/${publicToken}/payments/mock-deposit`, {
    obligation_id: finalObligation.id,
    amount_cents: 1_000_000
  });
  assert.equal(finalPaid.payment.kind, "customer_final");
  const notificationsAfterFinal = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const finalPaymentNotification = notificationsAfterFinal.notifications.find((notification: any) => notification.context?.payment_id === finalPaid.payment.id);
  assert.ok(finalPaymentNotification);
  assert.equal(finalPaymentNotification.title, "Jane Homeowner proposal payment received");
  assert.equal(finalPaymentNotification.body, "Final Payment: $10,000.00 - 100 Proposal Lane");
  const proposalPaidCelebrations = notificationsAfterFinal.notifications.filter((notification: any) => notification.source === "scope.roof_replacement.proposal_paid_celebration");
  assert.equal(proposalPaidCelebrations.length, 1);
  assert.equal(proposalPaidCelebrations[0].context.payment_id, paid.payment.id);

  const events = await client.request("GET", `/v1/proposals/organizations/${orgId}/proposals/${proposalId}/events`);
  assert.ok(events.events.some((event: any) => event.type === "proposal.sent"));
  assert.ok(events.events.some((event: any) => event.type === "proposal.viewed"));
  assert.ok(events.events.some((event: any) => event.type === "proposal.choice.selected"));
  assert.ok(events.events.some((event: any) => event.type === "proposal.signed"));

  const duplicated = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${proposalId}/duplicate`, {
    title: "Roof Replacement Proposal Copy"
  });
  assert.equal(duplicated.proposal.status, "draft");
  assert.equal(duplicated.proposal.project_id, projectId);

  const archived = await client.request("DELETE", `/v1/proposals/organizations/${orgId}/proposals/${duplicated.proposal.id}`, {
    expected_revision: duplicated.proposal.revision,
    reason: "Test archive"
  });
  assert.equal(archived.proposal.status, "archived");
});
