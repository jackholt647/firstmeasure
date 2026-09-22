import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
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
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-materials-test-"));
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
    email: `materials-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Materials Owner",
    company: "Materials Test Org",
    organization_id: `org_materials_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, pricebook: true, materials: true, proposals: true, project_photos: true }
      }
    }
  }, { replace: false });
  return { orgId, suffix };
}

async function seedPricebook(orgId: string, suffix: string) {
  const { createItem, getOrganizationPricebook, patchItem } = await import("../pricebook/storage.js");
  const created = await getOrganizationPricebook(orgId);
  const withShingle = await createItem(created.manifest.id, {
    id: "architectural_shingle",
    name: "Architectural Shingle",
    category: "shingle_roofs",
    manufacturer: "generic",
    segment: "sloped",
    unit: "sq",
    unitPrice: 120,
    formulaConfig: { tokens: [{ type: "number", value: "1" }] },
    description: "Snapshot this price into material lists."
  }, created.manifest.revision);
  const withUnderlayment = await createItem(withShingle.manifest.id, {
    id: "synthetic_underlayment",
    name: "Synthetic Underlayment",
    category: "leak_barriers",
    manufacturer: "generic",
    segment: "sloped",
    unit: "sq",
    unitPrice: 35,
    formulaConfig: { tokens: [{ type: "number", value: "1" }] }
  }, withShingle.manifest.revision);
  return {
    pricebookId: created.manifest.id,
    updateShinglePrice: async () => {
      await patchItem(created.manifest.id, "architectural_shingle", { unitPrice: 150 }, withUnderlayment.manifest.revision);
    }
  };
}

test("materials lifecycle snapshots pricebook items, locks orders, amends lists, and records delivery windows", async () => {
  const client = createSessionClient();
  const { orgId, suffix } = await register(client);
  const { pricebookId, updateShinglePrice } = await seedPricebook(orgId, suffix);
  const projectId = "project_materials_test";

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "200 Material Way",
      title: "Material Test Roof",
      project_type: "residential",
      contacts: [{ name: "Marta Materials", email: "marta@example.test" }]
    },
    metadata: { kind: "platform_project" }
  });

  const created = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, {
    title: "Roof Materials",
    sections: [
      { key: "shingles", title: "Shingles" },
      { key: "underlayments", title: "Underlayments" },
      { key: "accessories", title: "Accessories" }
    ],
    items: [
      {
        section: "shingles",
        structure_id: "main",
        quantity: 32,
        pricebook_ref: { pricebook_id: pricebookId, item_id: "architectural_shingle" }
      },
      {
        section: "underlayments",
        structure_id: "main",
        quantity: 34,
        pricebook_ref: { pricebook_id: pricebookId, item_id: "synthetic_underlayment" }
      },
      {
        section: "accessories",
        name: "Starter strip",
        quantity: 9,
        unit: "bundle"
      }
    ],
    resources: { proposal_ids: ["proposal_test"] }
  });

  const list = created.material_list;
  assert.equal(list.status, "planning");
  assert.equal(list.current_items.length, 3);
  assert.equal(list.current_items[0].projected_unit_price, 120);
  assert.equal(list.current_items[0].projected_total, 3840);
  assert.equal(list.current_items[0].pricebook_snapshot.item.unitPrice, 120);

  const recolored = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/versions`, {
    expected_revision: list.revision,
    reason: "revision",
    update_items: [{
      id: list.current_items[0].id,
      selected_options: { color: "brown" },
      pricebook_ref: {
        ...list.current_items[0].pricebook_ref,
        catalog_revision: 0,
        selected_options: { color: "brown" }
      }
    }]
  });
  assert.equal(recolored.material_list.current_items[0].selected_options.color, "brown");
  assert.equal(recolored.material_list.current_items[0].product_selection.selected_options.color, "brown");

  await updateShinglePrice();
  const afterPricebookChange = await client.request("GET", `/v1/materials/organizations/${orgId}/material-lists/${list.id}`);
  assert.equal(afterPricebookChange.material_list.current_items[0].pricebook_snapshot.item.unitPrice, 120);

  const scheduleRequirement = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/schedule-event`, {
    event: {
      title: "Roof Materials Delivery",
      kind: "material_delivery",
      icon: "fa-truck-ramp-box",
      color: "#7c3aed"
    }
  });
  assert.equal(scheduleRequirement.event.kind, "material_delivery");
  assert.equal(scheduleRequirement.event.order_status, "unordered");
  assert.equal(scheduleRequirement.event.locked, false);

  const scheduledBeforeOrder = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: scheduleRequirement.event.id,
      start_at: "2026-07-15T07:00:00.000Z",
      end_at: "2026-07-16T07:00:00.000Z",
      status: "scheduled"
    }
  });
  assert.equal(scheduledBeforeOrder.event.start_at, "2026-07-15T07:00:00.000Z");

  const ordered = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/orders`, {
    expected_revision: scheduledBeforeOrder.material_list.revision,
    title: "Initial roof order",
    vendor: { name: "Roof Supply Co." },
    scheduled_window: {
      start_date: "2026-07-15",
      end_date: "2026-07-15",
      precision: "day",
      timezone: "America/Los_Angeles"
    },
    quoted_price: { amount: 5600, currency: "USD", source: "supplier_quote" }
  });
  assert.equal(ordered.material_list.status, "ordered");
  assert.equal(ordered.material_list.delivery_status, "scheduled");
  assert.ok(ordered.order.items[0].locked_pricing.locked_at);
  assert.equal(ordered.order.items[0].locked_pricing.projected_unit_price, 120);
  assert.equal(ordered.version.reason, "order_lock");
  assert.equal(ordered.order.schedule_event_id, scheduleRequirement.event.id);
  assert.equal(ordered.order.order_source_id, "manual");

  const orderedProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const lockedDeliveryEvent = orderedProject.document.data.events.find((event: any) => event.id === scheduleRequirement.event.id);
  assert.equal(lockedDeliveryEvent.locked, true);
  assert.equal(lockedDeliveryEvent.schedule_lock.locked, true);
  assert.equal(lockedDeliveryEvent.order_status, "ordered");
  assert.equal(lockedDeliveryEvent.material_order_id, ordered.order.id);
  assert.equal(lockedDeliveryEvent.start_at, "2026-07-15T07:00:00.000Z");
  assert.equal(lockedDeliveryEvent.end_at, "2026-07-16T07:00:00.000Z");

  const rejectedReschedule = await client.raw("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: lockedDeliveryEvent.id,
      start_at: "2000-01-04T08:00:00.000Z",
      end_at: "2000-01-04T17:00:00.000Z"
    }
  });
  assert.equal(rejectedReschedule.statusCode, 409);
  assert.equal(JSON.parse(rejectedReschedule.body).error, "project_event_locked");

  const confirmedReschedule = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    unlock_confirmed: true,
    event: {
      id: lockedDeliveryEvent.id,
      start_at: "2000-01-04T08:00:00.000Z",
      end_at: "2000-01-04T17:00:00.000Z"
    }
  });
  assert.equal(confirmedReschedule.event.locked, false);
  assert.equal(confirmedReschedule.event.schedule_lock.locked, false);
  assert.equal(confirmedReschedule.material_list.schedule_status, "scheduled");
  const ensuredWhileUnlocked = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/schedule-event`, {});
  assert.equal(ensuredWhileUnlocked.event.locked, false);
  assert.equal(ensuredWhileUnlocked.event.schedule_lock.locked, false);
  const delayedList = await client.request("PATCH", `/v1/materials/organizations/${orgId}/material-lists/${list.id}`, {
    expected_revision: ensuredWhileUnlocked.material_list.revision,
    delivery_status: "delayed"
  });
  assert.equal(delayedList.material_list.delivery_status, "delayed");
  const scheduledEventsBeforeRelock = await client.request("GET", `/v1/work/organizations/${orgId}/events?project_id=${projectId}&limit=500`);
  const scheduledCountBeforeRelock = scheduledEventsBeforeRelock.events.filter((event: any) => event.type === "project.event_scheduled").length;

  const relocked = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: { id: lockedDeliveryEvent.id, locked: true }
  });
  assert.equal(relocked.event.locked, true);
  assert.equal(relocked.event.schedule_lock.locked, true);
  assert.equal(relocked.material_list.delivery_status, "delayed");
  const scheduledEventsAfterRelock = await client.request("GET", `/v1/work/organizations/${orgId}/events?project_id=${projectId}&limit=500`);
  assert.equal(scheduledEventsAfterRelock.events.filter((event: any) => event.type === "project.event_scheduled").length, scheduledCountBeforeRelock);
  const { processProjectEventLifecycleForOrg } = await import("../platform/api.js");
  await processProjectEventLifecycleForOrg(orgId);
  const lifecycleProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const fulfillmentControlledEvent = lifecycleProject.document.data.events.find((event: any) => event.id === lockedDeliveryEvent.id);
  assert.equal(fulfillmentControlledEvent.status, "scheduled");
  assert.equal(fulfillmentControlledEvent.completed_emitted_at, undefined);

  const supplement = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/versions`, {
    expected_revision: relocked.material_list.revision,
    reason: "supplement",
    bundled_with_order_id: ordered.order.id,
    add_items: [
      {
        section: "accessories",
        parent_item_id: ordered.order.items[2].id,
        name: "Extra starter strip",
        quantity: 2,
        unit: "bundle",
        projected_unit_price: 42,
        notes: "Added after initial order."
      }
    ],
    remove_item_ids: [ordered.order.items[1].id],
    notes: "Supplement and removal for changed field condition."
  });
  assert.equal(supplement.version.reason, "supplement");
  assert.equal(supplement.version.bundled_with_order_id, ordered.order.id);
  assert.ok(supplement.version.change_set.removed_item_ids.includes(ordered.order.items[1].id));
  assert.equal(supplement.material_list.current_items.some((item: any) => item.id === ordered.order.items[1].id), false);

  const delivery = await client.request("POST", `/v1/materials/organizations/${orgId}/material-orders/${ordered.order.id}/deliveries`, {
    status: "delivered",
    actual_delivered_at: "2026-07-02T15:30:00.000Z",
    quantities: [
      { item_id: ordered.order.items[0].id, quantity: 32, unit: "sq" }
    ],
    received_by: { name: "Site Lead" }
  });
  assert.equal(delivery.delivery.status, "delivered");
  assert.equal(delivery.delivery.estimated_window.precision, "day");

  const orders = await client.request("GET", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/orders`);
  assert.equal(orders.count, 1);

  const deliveries = await client.request("GET", `/v1/materials/organizations/${orgId}/material-orders/${ordered.order.id}/deliveries`);
  assert.equal(deliveries.count, 1);

  const versions = await client.request("GET", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/versions`);
  assert.ok(versions.versions.some((version: any) => version.reason === "order_lock"));
  assert.ok(versions.versions.some((version: any) => version.reason === "supplement"));

  const events = await client.request("GET", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/events`);
  assert.ok(events.events.some((event: any) => event.type === "material_order.created"));
  assert.ok(events.events.some((event: any) => event.type === "material_delivery.recorded"));

  const freshProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const freshDeliveryEvent = freshProject.document.data.events.find((event: any) => event.id === lockedDeliveryEvent.id);
  const staleAutosave = await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      ...freshProject.document.data,
      events: [{
        ...freshDeliveryEvent,
        status: "unscheduled",
        start_at: "",
        end_at: "",
        updated_at: "1999-01-01T00:00:00.000Z"
      }]
    },
    metadata: freshProject.document.metadata
  });
  const preservedNewerEvent = staleAutosave.document.data.events.find((event: any) => event.id === lockedDeliveryEvent.id);
  assert.equal(preservedNewerEvent.status, "scheduled");
  assert.equal(preservedNewerEvent.start_at, "2000-01-04T08:00:00.000Z");

  const missingEventsAutosave = await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { ...staleAutosave.document.data, events: [] },
    metadata: staleAutosave.document.metadata
  });
  assert.ok(missingEventsAutosave.document.data.events.some((event: any) => event.id === lockedDeliveryEvent.id));

  const { readDocument, upsertDocument } = await import("../platform/storage.js");
  const corruptedProject = await readDocument(orgId, "projects", projectId);
  const corruptedData: any = corruptedProject.data;
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      ...corruptedData,
      events: corruptedData.events.map((event: any) => event.id === lockedDeliveryEvent.id
        ? { ...event, title: "", kind: "", icon: "", color: "", status: "unscheduled", start_at: "", end_at: "", updated_at: new Date().toISOString() }
        : event)
    },
    metadata: corruptedProject.metadata
  }, { replace: true });
  const repairedSchedule = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${list.id}/schedule-event`, {});
  assert.equal(repairedSchedule.event.status, "scheduled");
  assert.equal(repairedSchedule.event.start_at, "2000-01-04T08:00:00.000Z");
  assert.equal(repairedSchedule.event.title, "Roof Materials Delivery");
  assert.equal(repairedSchedule.event.kind, "material_delivery");
  assert.equal(repairedSchedule.event.icon, "fa-truck-ramp-box");
  assert.equal(repairedSchedule.event.color, "#7c3aed");
});

test("scope-defined material lists split selected pricebook items and initialize idempotent delivery events", async () => {
  const client = createSessionClient();
  const { orgId, suffix } = await register(client);
  const { pricebookId } = await seedPricebook(orgId, suffix);
  const projectId = "project_scope_materials_test";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "300 Scope Way", title: "Scope Materials", events: [] },
    metadata: { kind: "platform_project" }
  });

  const initialization = {
    proposal_id: "proposal_scope_materials",
    scope_template_id: "roof_replacement",
    scope_template_version: 4,
    scope: {
      measurements: { roofSquares: 31, eavesLf: 190 },
      pieces: [{ id: "roof_piece", template_id: "roof_replacement", section_name: "Main Roof" }],
      root_items: [{
        id: "roof_scope",
        name: "Roof",
        selection: { mode: "fixed", selected: true },
        children: [
          {
            id: "scope_underlayment",
            name: "Synthetic Underlayment",
            quantity: 33,
            unit: "sq",
            pricebook_ref: { pricebook_id: pricebookId, item_id: "synthetic_underlayment" },
            selection: { mode: "fixed", selected: true }
          },
          {
            id: "scope_shingle",
            name: "Architectural Shingle",
            quantity: 31,
            unit: "sq",
            pricebook_ref: { pricebook_id: pricebookId, item_id: "architectural_shingle" },
            selection: { mode: "choice", group_id: "shingle", selected: true }
          },
          {
            id: "scope_unselected_shingle",
            name: "Unselected Shingle",
            quantity: 31,
            unit: "sq",
            pricebook_ref: { pricebook_id: pricebookId, item_id: "architectural_shingle" },
            selection: { mode: "choice", group_id: "shingle", selected: false }
          }
        ]
      }]
    },
    materials: {
      enabled: true,
      assignment: "first_match",
      order_sources: [
        { id: "manual", name: "Manual Order", kind: "manual", status: "active" },
        { id: "srs_distribution", name: "SRS Distribution", kind: "integration", status: "coming_soon" },
        { id: "convoy_supply", name: "Convoy Supply", kind: "integration", status: "coming_soon" }
      ],
      lists: [
        {
          id: "dry_in",
          title: "Dry-In",
          color: "#dc2626",
          selector: { pricebook_item_ids: ["synthetic_underlayment"] },
          schedule: { enabled: true, event_type_default_id: "material_delivery_dry_in", source_node_template_id: "schedule_dry_in_delivery", lock_on_order: true },
          order_source_ids: ["manual", "srs_distribution", "convoy_supply"]
        },
        {
          id: "shingle",
          title: "Shingle",
          color: "#f97316",
          selector: { pricebook_item_ids: ["architectural_shingle"] },
          schedule: { enabled: true, event_type_default_id: "material_delivery_shingles", source_node_template_id: "schedule_shingle_delivery", lock_on_order: true },
          order_source_ids: ["manual", "srs_distribution", "convoy_supply"]
        }
      ]
    },
    work_plan_id: "work_plan_scope_materials",
    source_nodes: {
      schedule_dry_in_delivery: "work_node_dry_in",
      schedule_shingle_delivery: "work_node_shingles"
    }
  };

  const first = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, initialization);
  assert.equal(first.count, 2);
  assert.equal(first.created_count, 2);
  assert.deepEqual(first.material_lists.map((list: any) => list.title), ["Dry-In", "Shingle"]);
  const dryIn = first.material_lists.find((list: any) => list.title === "Dry-In");
  const shingle = first.material_lists.find((list: any) => list.title === "Shingle");
  assert.equal(dryIn.current_items.length, 1);
  assert.equal(dryIn.current_items[0].source_item_id, "scope_underlayment");
  assert.equal(dryIn.current_items[0].metadata.material_list_color, "#dc2626");
  assert.equal(shingle.current_items.length, 1);
  assert.equal(shingle.current_items[0].source_item_id, "scope_shingle");
  assert.equal(shingle.measurements.roofSquares, 31);
  assert.equal(first.schedule_events.find((event: any) => event.material_list_id === dryIn.id).source_node_id, "work_node_dry_in");
  assert.equal(first.schedule_events.find((event: any) => event.material_list_id === dryIn.id).title, "Dry-In");
  assert.equal(first.schedule_events.find((event: any) => event.material_list_id === shingle.id).title, "Shingle");
  const comingSoonOrder = await client.raw("POST", `/v1/materials/organizations/${orgId}/material-lists/${dryIn.id}/orders`, {
    order_source_id: "srs_distribution"
  });
  assert.equal(comingSoonOrder.statusCode, 409);
  assert.equal(JSON.parse(comingSoonOrder.body).error, "material_order_source_unavailable");

  const { proposal_id: _signedProposalId, ...uiInitialization } = initialization;
  const second = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, uiInitialization);
  assert.equal(second.created_count, 0);
  assert.deepEqual(second.material_lists.map((list: any) => list.id).sort(), first.material_lists.map((list: any) => list.id).sort());
  for (const firstList of first.material_lists) {
    assert.equal(second.material_lists.find((list: any) => list.id === firstList.id).revision, firstList.revision);
  }
  for (const firstEvent of first.schedule_events) {
    assert.equal(second.schedule_events.find((event: any) => event.id === firstEvent.id).updated_at, firstEvent.updated_at);
  }
  const changedScopeInitialization: any = JSON.parse(JSON.stringify(uiInitialization));
  changedScopeInitialization.scope.root_items[0].children[1].quantity = 35;
  delete changedScopeInitialization.scope.measurements.eavesLf;
  const reconciled = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, changedScopeInitialization);
  const reconciledShingle = reconciled.material_lists.find((list: any) => list.title === "Shingle");
  assert.equal(reconciledShingle.id, shingle.id);
  assert.equal(reconciledShingle.current_items[0].quantity, 35);
  assert.equal(reconciledShingle.measurements.eavesLf, undefined);
  assert.ok(reconciledShingle.version_number > shingle.version_number);
  const reconciledAgain = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, changedScopeInitialization);
  const stableReconciledShingle = reconciledAgain.material_lists.find((list: any) => list.title === "Shingle");
  assert.equal(stableReconciledShingle.version_number, reconciledShingle.version_number);
  const deletedScopeItem = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${shingle.id}/versions`, {
    expected_revision: stableReconciledShingle.revision,
    reason: "removal",
    remove_item_ids: [stableReconciledShingle.current_items[0].id]
  });
  assert.equal(deletedScopeItem.material_list.current_items.some((item: any) => item.source_item_id === "scope_shingle"), false);
  const afterDeleteInit = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, changedScopeInitialization);
  const preservedDeleteShingle = afterDeleteInit.material_lists.find((list: any) => list.title === "Shingle");
  assert.equal(preservedDeleteShingle.current_items.some((item: any) => item.source_item_id === "scope_shingle"), false);
  const forceRegenerated = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    ...changedScopeInitialization,
    force_regenerate: true
  });
  const restoredShingle = forceRegenerated.material_lists.find((list: any) => list.title === "Shingle");
  assert.equal(restoredShingle.current_items.some((item: any) => item.source_item_id === "scope_shingle"), true);
  const manualAmendment = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${shingle.id}/versions`, {
    expected_revision: restoredShingle.revision,
    reason: "manual",
    add_items: [{ name: "Hand-added coil stock", quantity: 1, unit: "roll" }]
  });
  const afterManualInit = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, changedScopeInitialization);
  const preservedManualShingle = afterManualInit.material_lists.find((list: any) => list.title === "Shingle");
  assert.equal(preservedManualShingle.version_number, manualAmendment.material_list.version_number);
  assert.ok(preservedManualShingle.current_items.some((item: any) => item.name === "Hand-added coil stock"));
  await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, { title: "Manual Add-On" });
  const orderedLists = await client.request("GET", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`);
  assert.deepEqual(orderedLists.material_lists.map((list: any) => list.title), ["Dry-In", "Shingle", "Manual Add-On"]);
  const project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(project.document.data.events.filter((event: any) => event.kind === "material_delivery").length, 2);

  const noLockList = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, {
    title: "Pickup",
    schedule: { enabled: true, event_type_default_id: "material_pickup", lock_on_order: false }
  });
  const noLockSchedule = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${noLockList.material_list.id}/schedule-event`, {});
  const noLockOrder = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${noLockList.material_list.id}/orders`, {
    expected_revision: noLockSchedule.material_list.revision,
    order_source_id: "manual"
  });
  const noLockProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const noLockEvent = noLockProject.document.data.events.find((event: any) => event.id === noLockOrder.order.schedule_event_id);
  assert.equal(noLockEvent.order_status, "ordered");
  assert.equal(noLockEvent.locked, false);
  assert.equal(noLockEvent.schedule_lock.locked, false);
});

test("scope resources create independent material, labor, and equipment lists with generic schedule links", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = `project_scope_resources_${Date.now().toString(36)}`;
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Scope Resources", events: [] },
    metadata: { kind: "platform_project" }
  });
  const result = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "resource_test",
    scope: { root_items: [], measurements: { roofSquares: 42 } },
    resources: {
      terminology: {
        material: { singular: "Material", plural: "Materials", list: "Material list" },
        labor: { singular: "Labor item", plural: "Labor", list: "Work order" },
        equipment: { singular: "Vehicle", plural: "Vehicles", list: "Vehicle list" }
      },
      lists: [
        { id: "materials", resource_type: "material", title: "Roof Materials", items: [] },
        {
          id: "labor", resource_type: "labor", title: "Roofing Labor",
          items: [{ id: "install", name: "Roof installation", quantity: 16, unit: "hour" }],
          controls: { crew_assignment: true, compensation: true },
          compensation: { default_mode: "crew_default", allowed_modes: ["hourly", "piece_rate", "hybrid", "none"] },
          assignment: {
            crew_id: "crew_alpha",
            crew_name: "Alpha Crew",
            work_resource_ref: { kind: "resource_group", id: "crew_alpha", name: "Alpha Crew" }
          },
          schedule: { enabled: true, kind: "project_work", event_type_default_id: "roof_work", icon: "fa-helmet-safety" }
        },
        {
          id: "equipment", resource_type: "equipment", title: "Roofing Vehicles",
          items: [{ id: "truck", name: "Truck", quantity: 1, unit: "ea" }],
          schedule: { enabled: false }
        }
      ]
    }
  });
  assert.equal(result.count, 3);
  const labor = result.material_lists.find((list: any) => list.resource_type === "labor");
  const equipment = result.material_lists.find((list: any) => list.resource_type === "equipment");
  assert.equal(labor.current_items[0].section, "labor");
  assert.equal(labor.current_items[0].name, "Roof installation");
  assert.equal(labor.terminology.list, "Work order");
  assert.equal(equipment.current_items[0].name, "Truck");
  assert.equal(equipment.terminology.plural, "Vehicles");
  assert.equal(result.schedule_events.length, 1);
  assert.equal(result.schedule_events[0].scope_resource_list_id, labor.id);
  assert.equal(result.schedule_events[0].resource_type, "labor");
  assert.equal(result.schedule_events[0].kind, "project_work");
  assert.equal(result.schedule_events[0].assigned_crew_id, "crew_alpha");
  assert.deepEqual(result.schedule_events[0].work_resource_ref, { kind: "resource_group", id: "crew_alpha", name: "Alpha Crew" });
  assert.equal(result.schedule_events[0].lock_toggle_visible, false);
});

test("roof replacement scopes automatically create piece-rate labor and equipment defaults", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = `project_roof_resources_${Date.now().toString(36)}`;
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Roof Resource Defaults", events: [] },
    metadata: { kind: "platform_project" }
  });

  const result = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "roof_replacement",
    scope: { root_items: [], measurements: { roofSquares: 31.5, shingleSquares: 28, pitch9to12Squares: 4, ridgesLf: 50, flatRoofSquares: 0 } }
  });

  const labor = result.material_lists.find((list: any) => list.resource_type === "labor");
  const equipment = result.material_lists.find((list: any) => list.resource_type === "equipment");
  assert.ok(labor);
  assert.ok(equipment);
  assert.equal(labor.compensation.mode, "piece_rate");
  assert.equal(labor.compensation.default_mode, "piece_rate");
  assert.equal(labor.current_items[0].unit, "sq");
  assert.equal(labor.current_items[0].quantity, 28);
  assert.equal(labor.current_items[0].projected_unit_price, 85);
  assert.deepEqual(labor.current_items.map((item: any) => item.name), [
    "Shingle installation",
    "Roof tear-off",
    "Steep-slope premium (9/12-12/12)",
    "Ridge installation"
  ]);
  assert.ok(!labor.current_items.some((item: any) => item.name === "Flat roof installation"));
  assert.deepEqual(equipment.current_items.map((item: any) => item.name), ["Disposal trailer", "Portable toilet", "Truck"]);
  // The preset declares equipment scheduling, but generation is suppressed
  // until the org's equipment.scheduling capability is on.
  assert.equal(equipment.schedule.enabled, true);
  assert.ok(!equipment.schedule_event_id);
  assert.ok(!result.schedule_events.some((event: any) => event.resource_type === "equipment"));

  const staleEquipmentSchedule = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${equipment.id}/schedule-event`, {});
  assert.equal(staleEquipmentSchedule.event.resource_type, "equipment");
  const cleanedEquipmentSchedule = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "roof_replacement",
    scope: { root_items: [], measurements: { roofSquares: 31.5, shingleSquares: 28, pitch9to12Squares: 4, ridgesLf: 50 } }
  });
  const cleanedEquipment = cleanedEquipmentSchedule.material_lists.find((list: any) => list.resource_type === "equipment");
  assert.ok(!cleanedEquipment.schedule_event_id);
  const projectAfterEquipmentCleanup = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(projectAfterEquipmentCleanup.document.data.events.find((event: any) => event.id === staleEquipmentSchedule.event.id).status, "canceled");

  // With the equipment.scheduling capability on, the same initialize call
  // generates the equipment schedule event the plumbing always carried.
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.equipment": true, "equipment.scheduling": true }
  });
  const enabledRun = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "roof_replacement",
    force_regenerate: true,
    scope: { root_items: [], measurements: { roofSquares: 31.5, shingleSquares: 28, pitch9to12Squares: 4, ridgesLf: 50 } }
  });
  const enabledEquipment = enabledRun.material_lists.find((list: any) => list.resource_type === "equipment");
  const equipmentEvent = enabledRun.schedule_events.find((event: any) => event.resource_type === "equipment");
  assert.ok(equipmentEvent, "equipment schedule event should generate when the capability is on");
  assert.equal(equipmentEvent.kind, "equipment");
  assert.equal(equipmentEvent.equipment_list_id, enabledEquipment.id);
  assert.equal(equipmentEvent.icon, "fa-truck-pickup");
  // Turning the capability back off restores suppression and cancels the event.
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.equipment": false }
  });
  const disabledRun = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "roof_replacement",
    scope: { root_items: [], measurements: { roofSquares: 31.5, shingleSquares: 28, pitch9to12Squares: 4, ridgesLf: 50 } }
  });
  assert.ok(!disabledRun.schedule_events.some((event: any) => event.resource_type === "equipment"));
  const projectAfterDisable = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(projectAfterDisable.document.data.events.find((event: any) => event.id === equipmentEvent.id).status, "canceled");

  const repeated = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "roof_replacement",
    scope: { root_items: [], measurements: { roofSquares: 31.5 } }
  });
  assert.equal(repeated.created_count, 0);
  assert.equal(repeated.material_lists.filter((list: any) => list.resource_type === "labor").length, 1);
  assert.equal(repeated.material_lists.filter((list: any) => list.resource_type === "equipment").length, 1);

  const laborOnly = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "roof_replacement",
    resource_type: "labor",
    force_regenerate: true,
    scope: { root_items: [], measurements: { roofSquares: 36, shingleSquares: 32 } },
    resource_overrides: {
      roofing_labor: {
        assignment: { work_resource_ref: { kind: "resource_group", id: "crew_roof", name: "Roof Crew" } },
        compensation: { mode: "hourly", default_mode: "piece_rate", estimated_hours: 24, user_overridden: true },
        items: [{ id: "shingle_installation", projected_unit_price: 95 }]
      }
    }
  });
  assert.equal(laborOnly.count, 1);
  assert.equal(laborOnly.material_lists[0].resource_type, "labor");
  assert.equal(laborOnly.material_lists[0].compensation.mode, "hourly");
  assert.equal(laborOnly.material_lists[0].compensation.estimated_hours, 24);
  assert.equal(laborOnly.material_lists[0].assignment.work_resource_ref.id, "crew_roof");
  assert.equal(laborOnly.material_lists[0].current_items[0].quantity, 32);
  assert.equal(laborOnly.material_lists[0].current_items[0].projected_unit_price, 95);
});

test("order packaging derives rounded-up order quantities in order units", async () => {
  const client = createSessionClient();
  const { orgId, suffix } = await register(client);
  const { createItem, getOrganizationPricebook } = await import("../pricebook/storage.js");
  const created = await getOrganizationPricebook(orgId);
  const withShingles = await createItem(created.manifest.id, {
    id: "hdz_shingles",
    name: "GAF Timberline HDZ",
    category: "shingle_roofs",
    unit: "sq",
    unitPrice: 398,
    formulaConfig: { tokens: [{ type: "number", value: "1" }] },
    order_packaging: { order_unit: "bundle", order_unit_plural: "bundles", packages_per_unit: 3, description: "3 bundles per square" }
  }, created.manifest.revision);
  const withDripEdge = await createItem(withShingles.manifest.id, {
    id: "drip_edge_test",
    name: "Drip Edge",
    category: "flashing",
    unit: "lf",
    unitPrice: 3.25,
    formulaConfig: { tokens: [{ type: "number", value: "1" }] },
    order_packaging: { order_unit: "piece", order_unit_plural: "pieces", units_per_package: 10, description: "10 ft piece" }
  }, withShingles.manifest.revision);
  await createItem(withDripEdge.manifest.id, {
    id: "weatherwatch_test",
    name: "GAF WeatherWatch",
    category: "leak_barriers",
    unit: "sq",
    unitPrice: 92,
    formulaConfig: { tokens: [{ type: "number", value: "1" }] },
    order_packaging: { order_unit: "roll", order_unit_plural: "rolls", units_per_package: 1.5, description: "1.5-square roll (50 ft)" }
  }, withDripEdge.manifest.revision);

  const projectId = "project_packaging_test";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "300 Packaging Way", title: "Packaging Test Roof", project_type: "residential" },
    metadata: { kind: "platform_project" }
  });

  const response = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, {
    title: "Packaged Materials",
    items: [
      { section: "shingles", quantity: 20, pricebook_ref: { pricebook_id: created.manifest.id, item_id: "hdz_shingles" } },
      { section: "flashing", quantity: 104, pricebook_ref: { pricebook_id: created.manifest.id, item_id: "drip_edge_test" } },
      { section: "leak_barriers", quantity: 10, pricebook_ref: { pricebook_id: created.manifest.id, item_id: "weatherwatch_test" } },
      { section: "accessories", name: "Loose accessory", quantity: 4, unit: "ea" }
    ]
  });

  const items = response.material_list.current_items;
  const shingles = items.find((item: any) => item.pricebook_ref?.item_id === "hdz_shingles");
  assert.equal(shingles.quantity, 20);
  assert.equal(shingles.unit, "sq");
  assert.equal(shingles.order_quantity, 60);
  assert.equal(shingles.order_unit, "bundles");
  assert.equal(shingles.order_covered_quantity, 20);
  assert.equal(shingles.order_packaging.packages_per_unit, 3);

  const dripEdge = items.find((item: any) => item.pricebook_ref?.item_id === "drip_edge_test");
  assert.equal(dripEdge.order_quantity, 11);
  assert.equal(dripEdge.order_unit, "pieces");
  assert.equal(dripEdge.order_covered_quantity, 110);

  const weatherwatch = items.find((item: any) => item.pricebook_ref?.item_id === "weatherwatch_test");
  assert.equal(weatherwatch.order_quantity, 7);
  assert.equal(weatherwatch.order_unit, "rolls");
  assert.equal(weatherwatch.order_covered_quantity, 10.5);

  const loose = items.find((item: any) => item.name === "Loose accessory");
  assert.equal(loose.order_quantity, 4);
  assert.equal(loose.order_unit, "ea");
  assert.equal(loose.order_packaging, undefined);

  const updated = await client.request("POST", `/v1/materials/organizations/${orgId}/material-lists/${response.material_list.id}/versions`, {
    expected_revision: response.material_list.revision,
    reason: "revision",
    update_items: [{ id: shingles.id, quantity: 21 }]
  });
  const updatedShingles = updated.material_list.current_items.find((item: any) => item.id === shingles.id);
  assert.equal(updatedShingles.order_quantity, 63);
  assert.equal(updatedShingles.order_unit, "bundles");
});
