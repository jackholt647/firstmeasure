import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-documents-test-"));
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
  // The documents API is mounted centrally by the integrator in src/app.ts;
  // until that lands the test registers the plugin itself.
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  const alreadyMounted = appSource.includes("registerDocumentsApi");
  if (!alreadyMounted) {
    const { registerDocumentsApi } = await import("../documents/api.js");
    await app.register(registerDocumentsApi, { prefix: "/v1/documents" });
  }
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

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Documents Test Org",
    organization_id: `org_documents_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "platform.documents": true,
      "documents.templates_studio": true,
      "documents.workflow_authoring": true,
      "documents.theme_authoring": true,
      "documents.advanced_definition_editing": true,
      "documents.custom_folders": true,
      "documents.designer_profile": true,
      "documents.esign": true,
      "documents.payments": true,
      "documents.agent": true,
      "documents.ingestion": true,
      "platform.customer_portal": true,
      "customer_portal.payments": true,
      "platform.money": true,
      "money.take_payment": true
    }
  });
  return { orgId };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "100 Document Lane",
      title: "Jane Homeowner",
      project_type: "residential",
      contacts: [{ name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222" }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

// Audit reproductions: passing means the documented defect is present.
// Isolated temporary stores and disabled outbound email use the existing fixture.
test("e-signature audit: reproduce integrity and signer-isolation gaps", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await createProject(client, orgId, "esign_audit");
  const { readDocumentInstance, saveDocumentInstance, readDocumentSnapshot } = await import("../documents/storage.js");
  const { recordDocumentOutput } = await import("../documents/service.js");
  const fresh = async (extraDefs: Record<string, any> = {}) => {
    const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/esign_audit/documents`, {
      document_type: "contract", title: "Isolated signature audit", params: { body: "Original terms", effective_date: "2026-09-26" }
    });
    const id = created.document.id;
    if (Object.keys(extraDefs).length) {
      const doc = await readDocumentInstance(orgId, id);
      await saveDocumentInstance(orgId, id, { ...doc, output_defs: { ...doc.output_defs as any, ...extraDefs } });
    }
    await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${id}/issue`, {});
    const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${id}/send`, {});
    return { id, token: sent.snapshot.public_token, snapshotId: sent.snapshot.id };
  };
  const post = (token: string, key: string, value: any, evidence = {}) => client.request("POST", `/v1/documents/public/${token}/outputs/${key}`, { value, evidence });

  const first = await fresh();
  const invalid = await post(first.token, "sig_customer", { type: "drawn", image_data: "not-an-image", signed_at: "1900-01-01" });
  assert.equal(invalid.document.status, "completed");
  let saved = await readDocumentInstance(orgId, first.id);
  assert.equal((saved.outputs as any).sig_customer.signed_at, "1900-01-01");
  await post(first.token, "sig_customer", { text: "Replacement Person" }, { witnessed_by_user_id: "invented-witness" });
  saved = await readDocumentInstance(orgId, first.id);
  assert.equal((saved.outputs as any).sig_customer.signer_name, "Replacement Person");
  const exposed = await client.request("GET", `/v1/documents/public/${first.token}`);
  assert.equal(exposed.snapshot.outputs.sig_customer.evidence.witnessed_by_user_id, "invented-witness");
  await post(first.token, "sig_customer", {});
  saved = await readDocumentInstance(orgId, first.id);
  assert.equal(saved.status, "completed");
  assert.equal(Boolean((saved.outputs as any).sig_customer.signer_name), false);
  console.log("AUDIT: malformed image accepted as complete; client date trusted; signature replaced and cleared without reverting completed status; client witness exposed.");

  const stale = await fresh();
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${stale.id}`, { params: { body: "Changed terms" } });
  const resent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${stale.id}/send`, {});
  await post(stale.token, "sig_customer", { text: "Old Link Signer" });
  saved = await readDocumentInstance(orgId, stale.id);
  assert.equal(saved.status, "completed");
  assert.equal((saved.params as any).body, "Changed terms");
  const oldSnap = await readDocumentSnapshot(orgId, stale.snapshotId);
  const newSnap = await readDocumentSnapshot(orgId, resent.snapshot.id);
  assert.equal((oldSnap.params as any).body, "Original terms");
  assert.equal(Boolean((newSnap.outputs as any).sig_customer), false);
  console.log("AUDIT: old link signs current instance with changed terms; latest snapshot remains unsigned.");

  const multi = await fresh({ sig_second: { type: "signature", required: true, signer: "customer" } });
  await post(multi.token, "sig_customer", { text: "Same Bearer" });
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${multi.id}`, { params: { body: "Edited after first signature" } });
  const done = await post(multi.token, "sig_second", { text: "Same Bearer" });
  assert.equal(done.document.status, "completed");
  assert.equal(((await readDocumentInstance(orgId, multi.id)).params as any)?.body, "Edited after first signature");
  console.log("AUDIT: same unauthenticated bearer completes both required customer signer slots; terms can be edited between signatures.");

  const party = await fresh({ sig_company_alias: { type: "signature", required: true, party: "company" } });
  await post(party.token, "sig_company_alias", { text: "Public Customer" });
  console.log("AUDIT: party=company alone does not prevent public signature writes.");

  const race = await fresh({ sig_second: { type: "signature", required: true, signer: "customer" } });
  await Promise.all([
    recordDocumentOutput(orgId, race.id, "sig_customer", { value: { text: "A" } }, {}, null, { snapshotId: race.snapshotId, surface: "public" }),
    recordDocumentOutput(orgId, race.id, "sig_second", { value: { text: "B" } }, {}, null, { snapshotId: race.snapshotId, surface: "public" })
  ]);
  saved = await readDocumentInstance(orgId, race.id);
  console.log("AUDIT concurrent result:", JSON.stringify({ keys: Object.keys(saved.outputs as any), status: saved.status }));
  assert.ok(!(saved.outputs as any).sig_customer || !(saved.outputs as any).sig_second, "concurrent writes lose one signature");

  const pdf = await fresh();
  const beforePdf = await client.raw("GET", `/v1/documents/public/${pdf.token}/pdf`);
  assert.equal(beforePdf.statusCode, 200);
  await post(pdf.token, "sig_customer", { text: "PDF Signer" });
  const afterPdf = await client.raw("GET", `/v1/documents/public/${pdf.token}/pdf`);
  assert.equal(afterPdf.statusCode, 200);
  assert.deepEqual(afterPdf.rawPayload, beforePdf.rawPayload);
  console.log("AUDIT: PDF fetched before signature is byte-identical after signing.");

  const cap = await fresh({ answer: { type: "value" } });
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "documents.esign": false });
  const skipped = await post(cap.token, "answer", "anything");
  assert.equal(skipped.document.status, "completed");
  assert.equal(Boolean(((await readDocumentInstance(orgId, cap.id)).outputs as any)?.sig_customer), false);
  console.log("AUDIT: disabling e-sign removes signature completion gate; unrelated output completes unsigned contract.");
  const forgedImport = await post(cap.token, "sig_customer", { text: "Forged Import" }, { capture_mode: "imported" });
  assert.equal(forgedImport.document.status, "completed");
  console.log("AUDIT: public capture_mode=imported bypasses disabled e-sign capability.");
});


