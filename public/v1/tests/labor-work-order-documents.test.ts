// Work order documents written from a labor list or a project's whole work order column, and ordering with
// scheduling off.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "labor-work-orders-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_work_orders";
const base = { orgId: ORG, branchId: "default", identity: {}, organization: {}, user: {}, capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } };
const owner = { ...base, userId: "owner", role: "owner", permissions: { "*": true } } as any;
const ITEMS = [
  { id: "l1", name: "Tear off", quantity: 30, unit: "sq", projected_unit_price: 40, metadata: { compensation_kind: "piece_rate" } },
  { id: "l2", name: "Salaried hours", quantity: 8, unit: "hour", projected_unit_price: 30, metadata: { compensation_kind: "cost_rate", projection_only: true } }
];

let ready: Promise<void> | null = null;
function setup() {
  return ready ||= (async () => {
    const s = await import("../platform/storage.js");
    await s.createOrganization({ id: ORG, name: "Work orders" });
    await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
    // The Equipment app is on: an equipment list is made below.
    await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true, "platform.documents": true, "apps.equipment": true });
    await s.upsertDocument(ORG, "projects", { id: "project", data: { title: "12 Elm street", address: "12 Elm St", events: [] } });
  })();
}
async function labor(title: string, name: string) {
  return (await import("../materials/storage.js")).createMaterialList(ORG, "project", { title, resource_type: "labor", items: ITEMS, assignment: { work_resource_ref: { id: `crew_${name}`, kind: "resource_group", name } } }, owner);
}

test("a labor list's work order is a work_order document, updated in place and marked out of date when the list changes", async () => {
  await setup();
  const w = await import("../labor/work-order-documents.js"), docs = await import("../documents/storage.js"), m = await import("../materials/storage.js");
  const list = await labor("Roof labor", "Crew A");
  const id = String(list.id);
  assert.deepEqual(await w.listWorkOrderDocuments(ORG, "project"), [], "nothing is written until asked");

  const first = await w.generateWorkOrderDocument(ORG, "project", { list_id: id }, owner);
  assert.equal(first.document_id, w.workOrderDocumentId({ list_id: id }));
  assert.equal(first.scope, "list"); assert.equal(first.list_id, id); assert.equal(first.stale, false);
  const document = await docs.readDocumentInstance(ORG, first.document_id);
  assert.equal(document.document_type, "work_order"); assert.equal(document.project_id, "project");
  assert.equal((document.template_ref as any).template_id, w.WORK_ORDER_TEMPLATE_ID, "the seeded work order template, not an empty definition");
  const params = document.params as any;
  assert.equal(params.assignee_name, "Crew A");
  assert.deepEqual(params.rows.map((row: any) => [row.name, row.amount]), [["Tear off", "$1,200.00"], ["Salaried hours", ""]], "a projection-only line is shown without pay");
  assert.equal(params.total_label, "$1,200.00");
  assert.ok(!params.scheduled_date, "no date without scheduling");
  assert.ok((await docs.listProjectDocuments(ORG, "project")).some((row: any) => row.id === first.document_id), "it is one of the project's documents");

  // The list changes: the document says so, and generating again updates the same document rather than adding one.
  await m.patchMaterialList(ORG, id, { title: "Roof labor, revised" }, owner);
  assert.equal((await w.listWorkOrderDocuments(ORG, "project"))[0]!.stale, true);
  const again = await w.generateWorkOrderDocument(ORG, "project", { list_id: id }, owner);
  assert.equal(again.document_id, first.document_id); assert.equal(again.stale, false);
  assert.equal((await docs.listProjectDocuments(ORG, "project")).filter((row: any) => row.document_type === "work_order").length, 1);
  assert.match(String((await docs.readDocumentInstance(ORG, first.document_id)).title), /revised/);
});

test("the project's work order covers every work order list, and only labor lists can be written alone", async () => {
  await setup();
  const w = await import("../labor/work-order-documents.js"), m = await import("../materials/storage.js");
  await labor("Gutters", "Crew B");
  const equipment = await m.createMaterialList(ORG, "project", { title: "Dumpster", resource_type: "equipment", items: [{ id: "e1", name: "30 yd dumpster", quantity: 1, unit: "ea", projected_unit_price: 450 }] }, owner);
  await assert.rejects(() => w.generateWorkOrderDocument(ORG, "project", { list_id: String(equipment.id) }, owner), /labor list/);
  const whole = await w.generateWorkOrderDocument(ORG, "project", {}, owner);
  assert.equal(whole.scope, "project"); assert.equal(whole.document_id, w.workOrderDocumentId({ project_id: "project" }));
  const params = (await (await import("../documents/storage.js")).readDocumentInstance(ORG, whole.document_id)).params as any;
  assert.equal(params.columns[0].key, "list", "several lists name the list on each row");
  assert.ok(params.rows.some((row: any) => row.name === "30 yd dumpster" && row.amount === ""), "equipment is listed but is not pay");
  assert.match(params.assignee_name, /Crew A/); assert.match(params.assignee_name, /Crew B/);
  assert.ok((await w.listWorkOrderDocuments(ORG, "project")).some((row) => row.scope === "project" && !row.stale));
});

test("with scheduling off an order keeps its delivery date on the order and makes no schedule event", async () => {
  await setup();
  const m = await import("../materials/storage.js"), s = await import("../platform/storage.js");
  const list = await m.createMaterialList(ORG, "project", { title: "Shingles", resource_type: "material", items: [{ id: "m1", name: "Shingles", quantity: 30, unit: "bundle", projected_unit_price: 40 }], schedule: { enabled: true } }, owner);
  const window = { date: "2026-11-02", start_at: "2026-11-02T07:00:00.000Z", end_at: "2026-11-03T07:00:00.000Z", precision: "day" };
  const ordered = await m.createMaterialOrder(ORG, String(list.id), { order_source_id: "manual", scheduled_window: window, delivery_status: "scheduled" }, owner);
  assert.equal((ordered.order as any).scheduled_window.date, "2026-11-02", "the date the supplier is told stays on the order");
  assert.equal((ordered.order as any).schedule_event_id || "", "");
  const project = await s.readDocument(ORG, "projects", "project");
  assert.deepEqual(((project as any).data?.events || []).filter((event: any) => event.kind === "material_delivery" || event.scope_resource_list_id === list.id), []);
});
