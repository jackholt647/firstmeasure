// Markup on project documents that are not media (delivered report PDFs): projects/document-markup.ts.
// Round trip, who may read and write it, what a key and the data may be, and a project merge.
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
type Json = Record<string, any>;

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, options: { csrf?: boolean } = {}) => {
    const sendCsrf = options.csrf !== false && csrf && !["GET", "HEAD"].includes(method);
    const response = await app.inject({ method, url, payload, headers: { ...(cookie ? { cookie } : {}), ...(sendCsrf ? { "x-platform-csrf": csrf } : {}) } });
    const setCookie = response.headers["set-cookie"];
    const session = readCookie(setCookie, "fm_platform_session"), csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (session || csrfCookie) {
      cookie = [session || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    return response;
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-document-markup-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.CALLS_STORAGE_ROOT = path.join(storageRoot, "calls");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeChannelsDatabase } = await import("../channels/storage.js");
  const { closeCallsDatabase } = await import("../calls/storage.js");
  await closeChannelsDatabase();
  await closeCallsDatabase();
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error: any) { if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error; }
  }
});

async function registerOwner(label: string) {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(), email: `markup-${label}-${suffix}@example.test`, password: "correct horse battery staple",
    name: `Markup ${label}`, company: `Markup ${label} Org`, organization_id: `org_markup_${label}_${suffix}`
  });
  const orgId = String(registered.organization.id), userId = String(registered.user.id);
  await enableExpandedPlatformFixture(orgId, { "platform.project_docs": true, "platform.project_photos": true });
  const storage = await import("../platform/storage.js");
  const user = await storage.readDocument(orgId, "users", userId);
  const setPermissions = (overrides: Json) => storage.upsertDocument(orgId, "users", { id: userId, data: { ...user.data, permission_overrides: overrides } });
  const markup = (projectId: string, key: string) => `/v1/platform/organizations/${orgId}/projects/${encodeURIComponent(projectId)}/document-markup/${encodeURIComponent(key)}`;
  return { client, orgId, userId, setPermissions, markup, storage };
}

const sample = (text = "Check flashing") => ({ schema: 1, pages: { "1": [{ type: "pen", points: [[0.1, 0.2], [0.3, 0.4]], color: "#e11d48" }], "3": [{ type: "text", x: 0.5, y: 0.5, text }] } });

test("markup on a report saves, reads back and counts revisions; the saver comes from the session", async () => {
  const { client, orgId, userId, markup, storage } = await registerOwner("owner");
  await storage.upsertDocument(orgId, "projects", { id: "p_report", data: { title: "Report project", branch_id: "default" } });
  const url = markup("p_report", "roof_report_pdf");

  assert.deepEqual(await client.request("GET", url), { ok: true, layer: null }, "no markup yet");

  const first = await client.request("PUT", url, { data: sample(), updated_by_name: "Forged Name", actor: "someone@else.test", organization_id: "other_org" });
  assert.equal(first.ok, true);
  assert.deepEqual(first.layer.data, sample());
  assert.equal(first.layer.revision, 1);
  assert.equal(first.layer.doc_key, "roof_report_pdf");
  assert.equal(first.layer.updated_by_name, "Markup owner","the name is the signed-in person's");
  assert.ok(first.layer.updated_at);
  assert.equal(first.layer.updated_by_email, undefined, "the saver's email is not returned");

  const read = await client.request("GET", url);
  assert.deepEqual(read.layer, first.layer);

  const { markupDocumentId } = await import("../projects/document-markup.js");
  const stored = await storage.readDocument(orgId, "project_document_markup", markupDocumentId("p_report", "roof_report_pdf"));
  assert.equal(stored.metadata.updated_by_user_id, userId);
  assert.match(String(stored.metadata.updated_by_email), /^markup-owner-.*@example\.test$/);
  assert.equal(stored.data.project_id, "p_report");

  const second = await client.request("PUT", url, { data: sample("Replace boot"), expected_revision: 1 });
  assert.equal(second.layer.revision, 2);
  assert.equal(second.layer.data.pages["3"][0].text, "Replace boot");

  const stale = await client.raw("PUT", url, { data: sample("Old tab"), expected_revision: 1 });
  assert.equal(stale.statusCode, 409, "a save from an older copy is refused");
  const firstAgain = await client.raw("PUT", url, { data: sample("Old tab"), expected_revision: 0 });
  assert.equal(firstAgain.statusCode, 409, "expected_revision 0 means no markup yet");
  assert.equal((await client.request("GET", url)).layer.data.pages["3"][0].text, "Replace boot");

  // Keys are per document and per project; a key is lower-cased.
  assert.equal((await client.request("GET", markup("p_report", "customer_report_pdf"))).layer, null);
  assert.equal((await client.request("GET", markup("p_report", "ROOF_REPORT_PDF"))).layer.revision, 2);
  await storage.upsertDocument(orgId, "projects", { id: "p_other", data: { title: "Other", branch_id: "default" } });
  assert.equal((await client.request("GET", markup("p_other", "roof_report_pdf"))).layer, null);
  const keyed = await client.request("PUT", markup("p_other", "report:fm_123.v2-final"), { data: { schema: 1, pages: {} } });
  assert.equal(keyed.layer.doc_key, "report:fm_123.v2-final");
});

test("another organization, a missing project and missing permissions are refused", async () => {
  const owner = await registerOwner("first");
  const stranger = await registerOwner("second");
  await owner.storage.upsertDocument(owner.orgId, "projects", { id: "p_private", data: { title: "Private", branch_id: "default" } });
  const url = owner.markup("p_private", "roof_report_pdf");
  await owner.client.request("PUT", url, { data: sample() });

  const anonymous = await app.inject({ method: "GET", url });
  assert.equal(anonymous.statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url, payload: { data: sample() } })).statusCode, 401);

  assert.equal((await stranger.client.raw("GET", url)).statusCode, 403, "another organization's path");
  assert.equal((await stranger.client.raw("PUT", url, { data: sample("Taken") })).statusCode, 403);
  assert.equal((await stranger.client.raw("GET", stranger.markup("p_private", "roof_report_pdf"))).statusCode, 404, "the project is not in the caller's organization");
  assert.equal((await stranger.client.raw("PUT", stranger.markup("p_private", "roof_report_pdf"), { data: sample("Taken") })).statusCode, 404);
  assert.equal((await owner.client.request("GET", url)).layer.revision, 1, "nothing was written");

  assert.equal((await owner.client.raw("GET", owner.markup("p_missing", "roof_report_pdf"))).statusCode, 404);
  assert.equal((await owner.client.raw("PUT", owner.markup("p_missing", "roof_report_pdf"), { data: sample() })).statusCode, 404, "markup never creates a project");
  await owner.storage.upsertDocument(owner.orgId, "projects", { id: "p_trashed", data: { title: "Gone", deleted_at: "2026-10-01T00:00:00Z" } });
  assert.equal((await owner.client.raw("GET", owner.markup("p_trashed", "roof_report_pdf"))).statusCode, 404);

  assert.equal((await owner.client.raw("PUT", url, { data: sample() }, { csrf: false })).statusCode, 403, "a write needs the CSRF token");

  await owner.setPermissions({ manage_projects: false });
  assert.equal((await owner.client.raw("GET", url)).statusCode, 200, "viewing the project is enough to read");
  assert.equal((await owner.client.raw("PUT", url, { data: sample("View only") })).statusCode, 403, "changing it needs manage_projects");

  await owner.setPermissions({ view_projects: false, manage_projects: false });
  assert.equal((await owner.client.raw("GET", url)).statusCode, 404, "a project the caller cannot see answers as missing");
  await owner.setPermissions({});
});

test("invalid document keys and markup data are refused", async () => {
  const { client, orgId, markup, storage } = await registerOwner("checks");
  await storage.upsertDocument(orgId, "projects", { id: "p_checks", data: { title: "Checks", branch_id: "default" } });

  for (const key of ["bad key", "a*b", "a/b", "café"]) {
    assert.equal((await client.raw("GET", markup("p_checks", key))).statusCode, 400, `GET key ${JSON.stringify(key)}`);
    assert.equal((await client.raw("PUT", markup("p_checks", key), { data: sample() })).statusCode, 400, `PUT key ${JSON.stringify(key)}`);
  }
  assert.equal((await client.raw("GET", markup("p_checks", "x".repeat(100)))).statusCode, 200, "100 characters is allowed");
  assert.equal((await client.raw("GET", markup("p_checks", "x".repeat(101)))).statusCode, 414, "a longer key never reaches the handler");
  const { normalizeDocKey } = await import("../projects/document-markup.js");
  assert.throws(() => normalizeDocKey("x".repeat(101)), /1 to 100 characters/, "the router answers 414 past 100; the check says the same");

  const url = markup("p_checks", "roof_report_pdf");
  const big = { schema: 1, pages: { "1": Array.from({ length: 6000 }, (_, i) => ({ type: "pen", points: [[i / 6000, 0.123456789], [0.987654321, 0.5]], color: "#0000ff" })) } };
  const invalid: Array<[string, unknown]> = [
    ["no data", undefined],
    ["an array", [{ pages: {} }]],
    ["a string", "pages"],
    ["no pages", { schema: 1 }],
    ["pages as a list", { schema: 1, pages: [[]] }],
    ["page 0", { schema: 1, pages: { "0": [] } }],
    ["page 5001", { schema: 1, pages: { "5001": [] } }],
    ["page 01", { schema: 1, pages: { "01": [] } }],
    ["page 1.5", { schema: 1, pages: { "1.5": [] } }],
    ["page name", { schema: 1, pages: { first: [] } }],
    ["page as an object", { schema: 1, pages: { "1": { type: "pen" } } }],
    ["item as a number", { schema: 1, pages: { "1": [3] } }],
    ["item as a list", { schema: 1, pages: { "1": [[0.1, 0.2]] } }],
    ["item null", { schema: 1, pages: { "1": [null] } }],
    ["schema as text", { schema: "1", pages: {} }],
    ["schema 0", { schema: 0, pages: {} }],
    ["over 512 KB", big]
  ];
  for (const [label, data] of invalid) {
    const response = await client.raw("PUT", url, data === undefined ? {} : { data });
    assert.equal(response.statusCode, 400, `${label}: ${response.body}`);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 512 * 1024, "the large case is over the limit");
  assert.equal((await client.raw("PUT", url, { data: sample(), expected_revision: -1 })).statusCode, 400);
  assert.equal((await client.request("GET", url)).layer, null, "nothing invalid was saved");
  const edge = await client.request("PUT", url, { data: { schema: 1, pages: { "5000": [{}], "1": [] } } });
  assert.equal(edge.layer.revision, 1, "page 5000, an empty page and an empty item are allowed");
});

test("a project merge moves markup to the survivor and keeps the survivor's own", async () => {
  const { orgId, storage } = await registerOwner("merge");
  const markupStore = await import("../projects/document-markup.js");
  const saver = { user_id: "u_merge", name: "Merge Person" };
  await markupStore.saveProjectDocumentMarkup(orgId, "p_merged", "roof_report_pdf", sample("From merged"), saver);
  await markupStore.saveProjectDocumentMarkup(orgId, "p_merged", "customer_report_pdf", sample("Merged customer"), saver);
  await markupStore.saveProjectDocumentMarkup(orgId, "p_survivor", "customer_report_pdf", sample("Survivor customer"), saver);

  const textOn = async (projectId: string, key: string) => ((await markupStore.readProjectDocumentMarkup(orgId, projectId, key))?.data as any)?.pages["3"][0].text;
  const { projectReferenceAdapters } = await import("../contacts/references.js");
  const adapter = projectReferenceAdapters().find((entry) => entry.id === "project-document-markup");
  assert.ok(adapter, "registered with the project merge");
  assert.equal(await adapter!.repoint(orgId, "p_merged", "p_survivor"), 1);

  assert.equal(await textOn("p_survivor", "roof_report_pdf"), "From merged");
  assert.equal((await markupStore.readProjectDocumentMarkup(orgId, "p_merged", "roof_report_pdf")), null, "moved, not copied");
  assert.equal(await textOn("p_survivor", "customer_report_pdf"), "Survivor customer");
  assert.equal(await textOn("p_merged", "customer_report_pdf"), "Merged customer", "the survivor's own is kept and the merged one stays where it was");
  const moved = await storage.readDocument(orgId, "project_document_markup", markupStore.markupDocumentId("p_survivor", "roof_report_pdf"));
  assert.equal(moved.data.merged_from_project_id, "p_merged");
  assert.equal(moved.metadata.updated_by_name, "Merge Person");
});
