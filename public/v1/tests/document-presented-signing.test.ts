import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { putProjectContacts } from "./helpers/project-contacts.js";

// Signing in person from a presentation, and the portal preview staff open
// after sending. The presenter route records the presenter-witnessed evidence
// class; the preview reads documents through links that can never write.

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}
function createSessionClient() {
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => await (app.inject as any)({ method, url, payload,
    headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) } });
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session"), csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-presented-signing-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", PLATFORM_HEARTBEAT_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), CRM_STORAGE_ROOT: path.join(storageRoot, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook") });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

async function setup() {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner User", company: "Presented Signing Org", organization_id: `org_presented_${suffix}` });
  const orgId = String(data.organization.id), userId = String(data.user.id);
  await enableExpandedPlatformFixture(orgId);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "platform.documents": true, "documents.esign": true, "documents.payments": true, "platform.customer_portal": true, "customer_portal.payments": true } });
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/present_project`, { data: { id: "present_project", address: "1 Showroom Way", title: "Jane Homeowner", project_type: "residential", photos: [] }, metadata: { kind: "platform_project" } });
  await putProjectContacts(client, orgId, "present_project", [{ name: "Jane Homeowner", email: "jane@example.test" }]);
  const storage = await import("../documents/storage.js");
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/present_project/documents`, { document_type: "contract", params: { body: "Roof replacement as presented" } });
  await storage.saveDocumentInstance(orgId, created.document.id, { ...created.document, output_defs: { sig_customer: { type: "signature", signer_id: "customer", required: true } } });
  return { client, orgId, userId, documentId: String(created.document.id) };
}

test("in person: issued without an invitation email, signed on the presenter route with an attestation, then sealed and on record", async () => {
  const { client, orgId, userId, documentId } = await setup();
  // In person the customer signs on the presenter's screen: nothing is emailed to sign.
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, { recipients: [{ signer_id: "customer", name: "Jane Homeowner", email: "jane@example.test" }], consent_contact: "support@example.test", include_portal: false, include_pdf: false });
  assert.deepEqual(sent.emailed, []);
  const present = `/v1/documents/organizations/${orgId}/documents/${documentId}/signing/present`;
  const review = await client.request("POST", `${present}/prepare`, {});
  assert.equal(review.presenter_attestation_required, true);
  assert.deepEqual(review.fields, ["sig_customer"]);
  assert.equal(review.signer.name, "Jane Homeowner");
  // The contract shown beside the signature is the retained review copy the content hash covers.
  const pdf = await client.raw("GET", `${present}/pdf`);
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
  assert.equal(pdf.headers["cache-control"], "private, no-store");
  const value = (witnessed: boolean) => ({ value: { type: "typed", signer_name: "Jane Homeowner", text: "Jane Homeowner", style: "script",
    __signing: { signer_id: review.signer.id, challenge: review.challenge, content_hash: review.content_hash, consent: { intent: true, electronic_records: true, can_access_and_retain: true, presenter_witnessed: witnessed, disclosure_hash: review.disclosure.hash } } } });
  // The presenter's attestation is required; consent alone is not enough here.
  const unwitnessed = await client.raw("POST", `${present}/outputs/sig_customer`, value(false));
  assert.equal(unwitnessed.statusCode, 400, unwitnessed.body);
  assert.equal(unwitnessed.json().error || unwitnessed.json().code, "signature_witness_required");
  // Only a signature is taken in person here.
  assert.equal((await client.raw("POST", `${present}/outputs/not_a_field`, value(true))).statusCode, 403);
  const signed = await client.request("POST", `${present}/outputs/sig_customer`, value(true));
  assert.ok(["signed", "completed"].includes(signed.status), signed.status);

  const signing = await import("../documents/signing/service.js");
  await signing.drainSigningOutbox();
  const status = await client.request("GET", `${present}/status`);
  assert.equal(status.signing.status, "completed");
  assert.equal(status.signing.seal_status, "sealed");
  const evidence = (await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/signing/evidence`)).packages[0];
  const receipt = evidence.receipts.sig_customer;
  assert.equal(receipt.evidence.authentication, "presenter_witnessed_in_person");
  assert.equal(receipt.evidence.actor_user_id, userId);
  assert.equal(receipt.evidence.consent.presenter_witnessed, true);
  assert.deepEqual(evidence.ledger.map((entry: any) => entry.kind), ["receipt", "executed", "sealed"]);
  assert.equal(evidence.ledger_check.ok, true);
  // The executed copy is what the left side shows once signed.
  const executed = await client.raw("GET", `${present}/pdf`);
  assert.ok(executed.rawPayload.length > pdf.rawPayload.length);

  // Presenting needs the issuing permission.
  const users = await import("../platform/storage.js");
  const owner = await users.readDocument(orgId, "users", userId);
  await users.upsertDocument(orgId, "users", { id: userId, data: { permission_overrides: { ...((owner.data as any).permission_overrides || {}), issue_documents: false } } });
  assert.equal((await client.raw("POST", `${present}/prepare`, {})).statusCode, 403);
  await users.upsertDocument(orgId, "users", { id: userId, data: { permission_overrides: (owner.data as any).permission_overrides || {} } });
});

test("open what they see: the portal preview reads the document but can never sign, accept, pay or mark it viewed", async () => {
  const { client, orgId, documentId } = await setup();
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, { recipients: [{ signer_id: "customer", name: "Jane Homeowner", email: "jane@example.test" }], consent_contact: "support@example.test", include_pdf: false });
  // Staff get the preview of the document, not the customer's own link.
  const preview = new URL(String(sent.preview_url));
  assert.equal(preview.pathname, "/customer_portal/preview.php");
  assert.equal(preview.searchParams.get("document"), documentId);
  assert.equal(preview.hash, "");
  const live = new URL(String(sent.portal_url));
  assert.notEqual(preview.searchParams.get("id"), live.searchParams.get("id"));

  const documentsOf = (payload: any): any[] => JSON.stringify(payload).includes(documentId) ? (function walk(value: any): any[] {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (value && typeof value === "object") return value.id === documentId && "public_token" in value ? [value] : Object.values(value).flatMap(walk);
    return [];
  })(payload) : [];
  // The preview needs a staff session of the organization.
  assert.ok((await (app.inject as any)({ method: "GET", url: `/v1/platform/customer-portals/preview/${preview.searchParams.get("id")}` })).statusCode >= 400);
  const previewDocs = documentsOf(await client.request("GET", `/v1/platform/customer-portals/preview/${preview.searchParams.get("id")}`));
  assert.ok(previewDocs.length >= 1);
  assert.ok(previewDocs.every((doc) => /^preview_/.test(String(doc.public_token))), "every place the preview names the document uses the read-only link");
  const token = String(previewDocs[0].public_token);
  assert.notEqual(token, sent.snapshot.public_token);
  // The customer's own portal still carries the customer's link.
  const liveDocs = documentsOf((await (app.inject as any)({ method: "GET", url: `/v1/platform/customer-portals/${live.searchParams.get("id")}` })).json());
  assert.equal(liveDocs[0]?.public_token, sent.snapshot.public_token);

  // Reading works: the document, its workflow and its PDF.
  const read = await (app.inject as any)({ method: "GET", url: `/v1/documents/public/${encodeURIComponent(token)}` });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().document.id, documentId);
  // Every write is refused on the server, whatever the page does.
  for (const [url, payload] of [
    ["outputs/sig_customer", { value: { type: "typed", signer_name: "Staff Member" } }],
    ["signing/prepare", {}],
    ["signing/decline", { reason: "testing" }],
    ["view", {}],
    ["payments/checkout", { output_key: "deposit" }],
    ["payments/payment-method-intent", { type: "card" }]
  ] as const) {
    const refused = await (app.inject as any)({ method: "POST", url: `/v1/documents/public/${encodeURIComponent(token)}/${url}`, payload });
    assert.equal(refused.statusCode, 403, `${url}: ${refused.body}`);
    assert.equal(refused.json().error || refused.json().code, "portal_preview_read_only", url);
  }
  // A preview link cannot be guessed or altered into a working one, and nothing was signed.
  const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal((await (app.inject as any)({ method: "GET", url: `/v1/documents/public/${encodeURIComponent(forged)}` })).statusCode, 404);
  const storage = await import("../documents/storage.js");
  assert.equal(((await storage.readDocumentInstance(orgId, documentId)).outputs as any)?.sig_customer, undefined);
});

