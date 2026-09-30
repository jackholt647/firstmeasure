import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

async function signingConsent(client: ReturnType<typeof createSessionClient>, token: string) {
  const review = await client.request("POST", `/v1/documents/public/${token}/signing/prepare`, {});
  return { challenge: review.challenge, content_hash: review.content_hash, consent: { intent: true, electronic_records: true, can_access_and_retain: true, disclosure_hash: review.disclosure.hash } };
}

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
    if (method === "POST" && url.endsWith("/send")) payload = { consent_contact: "support@example.test", ...(payload as object || {}) };
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
  return { request, raw, withoutCsrf: (url:string) => app.inject({ method:"POST",url,payload:{label:"No csrf"},headers:{cookie} }) };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-documents-test-"));
  process.env.NODE_ENV = "test";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.WORK_SCHEDULER_DISABLED = "1";
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

test("tag catalog preserves selector IDs, checks revisions and authorization", async () => {
  const client = createSessionClient(); const {orgId} = await registerOrg(client);
  const base = `/v1/documents/organizations/${orgId}/tags`;
  const spaced = await client.request("POST", base, {label:"Insurance contract"}); assert.equal(spaced.tag.id,"insurance contract");
  assert.ok((await client.request("GET",base)).tags.some((t:any)=>t.id === "insurance contract"));
  const created = await client.request("POST", base, { label:"Proposal" });
  assert.equal(created.tag.id,"proposal");
  const renamed = await client.request("PATCH", `${base}/proposal`, { label:"Customer proposal", expected_revision:created.tag.revision });
  assert.equal(renamed.tag.id,"proposal");
  const stale = await client.raw("PATCH", `${base}/proposal`, { archived:true, expected_revision:created.tag.revision });
  assert.equal(stale.statusCode,409);
  const archived = await client.request("PATCH", `${base}/proposal`, { archived:true, expected_revision:renamed.tag.revision });
  assert.equal(archived.tag.label,"Customer proposal");
  assert.equal((await client.request("GET",base)).tags.find((t:any)=>t.id === "proposal").archived,true);
  const guest = await app.inject({method:"GET",url:base}); assert.equal(guest.statusCode,401);
  const denied = await client.withoutCsrf(base); assert.equal(denied.statusCode,403);
  const other = createSessionClient(); await registerOrg(other); assert.equal((await other.raw("GET",base)).statusCode,403);
});
