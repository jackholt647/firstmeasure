import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Experimental signup is admin-only, with independent sessions and workflow provisioning", async () => {
  const cwd = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-experiment-auth-"));
  process.chdir(root);
  process.env.FIRSTMATE_ENV = "test";
  process.env.PLATFORM_SESSION_SECRET = "isolated-test-session-secret";
  process.env.PUBLIC_BASE_URL = "https://experimental.example.test";
  process.env.CORS_ALLOWED_ORIGINS = "https://experimental.example.test,https://evil.example";
  process.env.PUBLIC_REGISTRATION_ENABLED = "false";
  process.env.EXPERIMENTAL_ACCOUNTS_ADMIN_EMAILS = "admin@example.test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  const { createIdentity, listOrganizations, patchIdentity, readGlobal } = await import("../platform/storage.js");
  const { hashPassword } = await import("../platform/auth.js");
  const app = await buildApp();
  await app.ready();
  const origin = process.env.PUBLIC_BASE_URL;
  const base = "/v1/signup-sandbox";
  try {
    const identity = await createIdentity({ email: "admin@example.test", name: "Admin", password_hash: await hashPassword("admin-test-password"), status: "active" });
    await createIdentity({ email: "customer@example.test", password_hash: await hashPassword("customer-test-password"), status: "active" });
    const before = (await listOrganizations()).length;
    for (const [url, payload] of [["/v1/platform/auth/register", {}], ["/v1/platform/auth/legacy-action", { action: "register" }], ["/v1/platform/organizations", {}]] as const) {
      const response = await app.inject({ method: "POST", url, payload });
      assert.equal(response.statusCode, 403, response.body);
    }
    assert.equal((await listOrganizations()).length, before);
    for (const url of ["/state", "/test-orgs", "/export"]) assert.equal((await app.inject(`${base}${url}`)).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: `${base}/workflows/swf_instant_full_org/instances`, headers: { origin }, payload: {} })).statusCode, 401);
    for (const payload of [{email:"admin@example.test",password:"wrong"},{email:"customer@example.test",password:"customer-test-password"}]) {
      const rejected = await app.inject({ method: "POST", url: `${base}/admin/login`, headers: { origin }, payload });
      assert.equal(rejected.statusCode, 401, rejected.body);
    }
    const login = await app.inject({ method: "POST", url: `${base}/admin/login`, headers: { origin }, payload: {email:"admin@example.test",password:"admin-test-password"} });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    assert.match(String(login.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
    const headers = { origin, cookie };
    assert.equal((await app.inject({ url: `${base}/state`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method:"POST",url:`${base}/workflows/swf_instant_full_org/instances`,headers:{cookie,origin:"https://evil.example"},payload:{} })).statusCode,403);
    const customized = await app.inject({method:"PATCH",url:`${base}/workflows/swf_instant_full_org`,headers,payload:{defaults:{app_flags:{"apps.equipment":false}}}});
    assert.equal(customized.statusCode,200,customized.body);
    const created = await app.inject({method:"POST",url:`${base}/workflows/swf_instant_full_org/instances`,headers,payload:{label:"Gated test"}});
    assert.equal(created.statusCode, 200, created.body);
    const record = created.json().test_org;
    assert.equal(((await readGlobal(record.org_id)).data.app_flags as any).apps.equipment,false);
    const companyLogin = await app.inject({method:"POST",url:"/v1/platform/auth/login",headers:{origin},payload:{email:record.email,password:record.password}});
    assert.equal(companyLogin.statusCode,200,companyLogin.body);
    const customerCookies = (companyLogin.headers["set-cookie"] as string[]).map(x=>x.split(';')[0]).join('; ');
    assert.equal((await app.inject({url:`${base}/state`,headers:{cookie:customerCookies}})).statusCode,401);
    assert.notEqual(record.password, "test1234");
    assert.ok(record.password.length >= 32);
    assert.equal((await app.inject({url:`${base}/admin/session`,headers})).statusCode,200);
    const reopened = await app.inject({method:"POST",url:`${base}/test-orgs/${record.id}/login`,headers,payload:{}});
    assert.equal(reopened.statusCode,200,reopened.body);
    assert.ok(reopened.headers["set-cookie"]);
    assert.equal((await app.inject({url:`${base}/state`,headers:{cookie:cookie+'tampered'}})).statusCode,401);
    await patchIdentity(String(identity.id), { status: "disabled" });
    assert.equal((await app.inject({url:`${base}/state`,headers})).statusCode,401);
  } finally {
    await app.close();
    await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
    process.chdir(cwd);
    await rm(root,{recursive:true,force:true,maxRetries:5});
  }
});
