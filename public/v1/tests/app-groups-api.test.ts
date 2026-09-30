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
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
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
    const data = response.body ? JSON.parse(response.body) : null;
    return { statusCode: response.statusCode, data, body: response.body };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-app-groups-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  if (app) await app.close();
  await closePlatformFixtureStores();
  const [{ closePayrollDatabase }, { closeWorkforceDatabase }, { closeWorkDatabase }] = await Promise.all([
    import("../payroll/storage.js"),
    import("../workforce/storage.js"),
    import("../work/storage.js")
  ]);
  (await closePayrollDatabase());
  (await closeWorkforceDatabase());
  (await closeWorkDatabase());
  await closeSqlStoresForTests();
  try {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error: any) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
  }
});

async function registerOwner(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(),
    email: `app-groups-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Payroll Owner",
    company: "Payroll Test Org",
    organization_id: `org_payroll_${suffix}`
  });
  await enableExpandedPlatformFixture(String(registered.organization.id));
  await enableExpandedPlatformFixture(String(registered.organization.id), { "platform.money": true, "apps.payroll": true });
  return { orgId: String(registered.organization.id), ownerUserId: String(registered.user.id) };
}

test("app layouts persist independently, validate defaults and require organization authorization", async () => {
  const owner=createSessionClient(), other=createSessionClient();
  const {orgId}=await registerOwner(owner);
  await registerOwner(other);
  const url=`/v1/platform/organizations/${orgId}/app-groups`;
  assert.deepEqual((await owner.request('GET',url)).groups,{});
  const layout={default:'inbox',members:{inbox:'group',center:'both'}};
  await owner.request('PUT',url+'/communications',layout);
  await owner.request('PUT',url+'/payroll',{default:'',members:{exports:'standalone'}});
  const result=await owner.request('GET',url);
  assert.deepEqual(result.groups.communications,layout);
  assert.equal(result.groups.payroll.members.exports,'standalone');
  assert.ok((await other.raw('GET',url)).statusCode>=400);
  assert.ok((await other.raw('PUT',url+'/communications',layout)).statusCode>=400);
  assert.ok((await owner.raw('PUT',url+'/communications',{default:'center',members:{center:'standalone'}})).statusCode>=400);
  assert.ok((await owner.raw('PUT',url+'/communications',{default:'',members:{center:'group'}})).statusCode>=400);
  assert.ok((await owner.raw('PUT',url+'/communications',{...layout,permissions:{'*':true}})).statusCode>=400);
  assert.ok((await app.inject({method:'PUT',url:url+'/communications',payload:layout})).statusCode>=400);
  assert.deepEqual((await owner.request('GET',url)).groups.communications,layout);
});
