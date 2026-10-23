// The Materials order window's documents and shopping lists (materials/ordering.ts): a purchase order is a
// `purchase_order` document with an organization PO number, the supplier email can carry it as a PDF, and a
// shopping list is a checklist its public link can show and, when allowed, check off.
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { putProjectContacts } from "./helpers/project-contacts.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => (app.inject as any)({
    method, url, payload,
    headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) }
  });
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const sessionCookie = readCookie(response.headers["set-cookie"], "fm_platform_session");
    const csrfCookie = readCookie(response.headers["set-cookie"], "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-materials-ordering-"));
  Object.assign(process.env, {
    NODE_ENV: "test", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), MESSAGING_STORAGE_ROOT: path.join(storageRoot, "messaging"),
    EMAIL_OUTBOUND_DISABLED: "1", COMMUNICATIONS_DELIVERY_MODE: "capture", EMAIL_DELIVERY_MODE: "capture",
    PUBLIC_BASE_URL: "https://firstmate.example.test", V1_LOG_LEVEL: "error"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

type Client = ReturnType<typeof createSessionClient>;

async function setup(client: Client) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple",
    name: "Owner User", company: "Ridgeline Roofing", organization_id: `org_ordering_${suffix}`
  });
  const orgId = data.organization.id as string;
  await enableExpandedPlatformFixture(orgId);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, { data: { app_flags: { platform: { expanded_access: true, documents: true, materials: true, pricebook: true } } } }, { replace: false });
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "platform.documents": true, "platform.materials": true, "comms.email": true, "comms.sms": true }
  });
  const projectId = "project_ordering";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "68 Northfield Rd", title: "Whitfield roof", project_type: "residential", photos: [] },
    metadata: { kind: "platform_project" }
  });
  await putProjectContacts(client, orgId, projectId, [{ name: "Dana Whitfield", email: "dana@example.test", primary: true }]);
  return { orgId, projectId, base: `/v1/materials/organizations/${orgId}/projects/${projectId}` };
}

const purchaseOrder = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  order_date: "2026-10-22",
  delivery_label: "Tue, Oct 27, 2026, Morning",
  supplier: { name: "ABC Supply · Springfield", details: "12 Mill St\norders@abc.example.test", email: "orders@abc.example.test" },
  ship_to: { name: "Whitfield roof", details: "68 Northfield Rd" },
  buyer: { name: "Ridgeline Roofing", details: "Owner User" },
  lines: [
    { name: "Architectural shingles", details: "Color: Charcoal", sku: "SH-30", quantity: 32, unit: "bundle", unit_price_cents: 3995 },
    { name: "Ridge cap", sku: "RC-1", quantity: 3, unit: "bundle", unit_price_cents: null }
  ],
  delivery_cents: 7500,
  list_ids: ["list_a"],
  ...extra
});

test("a purchase order is a numbered purchase_order document, kept per order and rendered to PDF", async () => {
  const client = createSessionClient();
  const { orgId, base } = await setup(client);

  const first = await client.request("POST", `${base}/purchase-orders/preview`, purchaseOrder("supplier_abc:list_a"));
  assert.equal(first.po_number, "PO-1001");
  assert.match(first.document_id, /^doc_po_/);
  assert.equal(first.params.total_cents, 32 * 3995 + 7500, "known prices plus delivery");
  assert.equal(first.params.prices_complete, false, "one line has no price yet");
  assert.match(first.params.terms, /PO number/, "the template's default terms are used until edited");
  const text = JSON.stringify(first.preview.resolved_definition);
  assert.ok(text.includes("Purchase Order"), "the preview is the purchase order template");

  // The same order keeps its document and number while it is edited.
  const edited = await client.request("POST", `${base}/purchase-orders/preview`, purchaseOrder("supplier_abc:list_a", { notes: "Call before unloading.", terms: "Net 30." }));
  assert.equal(edited.document_id, first.document_id);
  assert.equal(edited.po_number, "PO-1001");
  assert.equal(edited.params.terms, "Net 30.");
  const stored = (await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${first.document_id}`)).document;
  assert.equal(stored.document_type, "purchase_order");
  assert.equal(stored.params.notes, "Call before unloading.");

  // Another supplier's order takes the next number; a number typed by hand is kept.
  const other = await client.request("POST", `${base}/purchase-orders/preview`, purchaseOrder("supplier_beacon:list_b"));
  assert.equal(other.po_number, "PO-1002");
  const typed = await client.request("POST", `${base}/purchase-orders/preview`, purchaseOrder("supplier_beacon:list_b", { po_number: "JOB-77" }));
  assert.equal(typed.po_number, "JOB-77");

  const pdf = await client.raw("POST", `${base}/purchase-orders/pdf`, purchaseOrder("supplier_abc:list_a"));
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.equal(pdf.headers["x-purchase-order-number"], "PO-1001");
  assert.ok(pdf.rawPayload.subarray(0, 5).toString() === "%PDF-", "a PDF file");

  const invalid = await client.raw("POST", `${base}/purchase-orders/preview`, { key: "x", lines: [] });
  assert.equal(invalid.statusCode, 400, "a purchase order needs lines");
});

test("the supplier email carries the purchase order PDF when asked", async () => {
  const client = createSessionClient();
  const { orgId, projectId, base } = await setup(client);
  const sent = await client.request("POST", `${base}/supplier-emails`, {
    to: "orders@abc.example.test", subject: "Material order - 68 Northfield Rd", text: "Please deliver the attached order.",
    idempotency_key: "order_email_1", purchase_order: purchaseOrder("supplier_abc:list_a")
  });
  assert.equal(sent.purchase_order.po_number, "PO-1001");
  assert.equal(sent.message.channel, "email");
  const feed = await client.request("GET", `/v1/comms/organizations/${orgId}/projects/${projectId}/email/threads/${sent.message.conversation_id}`);
  const message = feed.thread.messages.find((entry: any) => entry.id === sent.message.id) || feed.thread.messages[0];
  assert.deepEqual(message.metadata.email.attachments.map((entry: any) => entry.name), ["purchase-order-po-1001.pdf"]);

  const plain = await client.request("POST", `${base}/supplier-emails`, { to: "orders@abc.example.test", subject: "Order", text: "Table in the body only.", idempotency_key: "order_email_2" });
  assert.equal(plain.purchase_order, null);
});

test("a shopping list is a checklist by supplier that its link shows and, when allowed, checks off", async () => {
  const client = createSessionClient();
  const { orgId, base } = await setup(client);
  const created = (await client.request("POST", `${base}/shopping-lists`, {
    title: "Pickup for Whitfield roof",
    list_ids: ["list_a", "list_b"],
    groups: [
      { supplier: "ABC Supply", address: "12 Mill St", items: [{ name: "Ridge cap", quantity: 3, unit: "bundle", image_url: "https://img.example.test/ridge.png", material_list_id: "list_a", material_item_id: "item_1" }] },
      { supplier: "Beacon", address: "", items: [{ name: "Drip edge", quantity: 12, unit: "piece", sku: "DE-10" }, { name: "Coil nails", quantity: 2, unit: "box" }] }
    ],
    assignees: [{ kind: "organization_user", id: "user_pickup", name: "Sam Driver" }]
  })).shopping_list;
  assert.equal(created.items.length, 3);
  assert.deepEqual(created.assigned_user_ids, ["user_pickup"]);
  assert.equal(created.metadata.source, "materials_shopping_list");
  assert.equal(created.items[0].metadata.supplier, "ABC Supply");

  const viewOnly = await client.request("POST", `${base}/shopping-lists/${created.id}/share`, { permission: "view" });
  const viewToken = decodeURIComponent(viewOnly.url.split("/l/")[1]);
  const anonymous = createSessionClient();
  const view = (await anonymous.request("GET", `/v1/materials/public/shopping-lists/${encodeURIComponent(viewToken)}`)).shopping_list;
  assert.equal(view.can_check, false);
  assert.deepEqual(view.groups.map((group: any) => [group.supplier, group.items.length]), [["ABC Supply", 1], ["Beacon", 2]]);
  assert.equal(view.groups[0].items[0].image_url, "https://img.example.test/ridge.png");
  const refused = await anonymous.raw("POST", `/v1/materials/public/shopping-lists/${encodeURIComponent(viewToken)}/items/${created.items[0].id}`, { completed: true });
  assert.equal(refused.statusCode, 403, "a view-only link cannot check items off");

  const shared = await client.request("POST", `${base}/shopping-lists/${created.id}/share`, { permission: "check", recipient: { name: "Sam", email: "sam@example.test" } });
  assert.equal(shared.sent.email.ok, true);
  const token = decodeURIComponent(shared.url.split("/l/")[1]);
  const page = await anonymous.raw("GET", `/v1/materials/public/shopping-lists/${encodeURIComponent(token)}/app`);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Shopping list/);
  const checked = await anonymous.request("POST", `/v1/materials/public/shopping-lists/${encodeURIComponent(token)}/items/${created.items[1].id}`, { completed: true });
  assert.equal(checked.item.checked, true);
  const after = (await client.request("GET", `${base}/shopping-lists/${created.id}`)).shopping_list;
  assert.equal(after.completed_items, 1);
  const foreign = await anonymous.raw("POST", `/v1/materials/public/shopping-lists/${encodeURIComponent(token)}/items/not_on_this_list`, { completed: true });
  assert.equal(foreign.statusCode, 404);

  const pdf = await client.raw("GET", `${base}/shopping-lists/${created.id}/pdf`);
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.ok(pdf.rawPayload.subarray(0, 5).toString() === "%PDF-");
  const doc = await client.request("GET", `/v1/documents/organizations/${orgId}/projects/project_ordering/documents`);
  assert.ok((doc.documents || []).some((entry: any) => entry.document_type === "shopping_list"), "the PDF is a shopping_list document");
});
