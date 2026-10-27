import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/* 1M8-248: impersonating from the Customers tab finds the user's sign-in identity through the user record,
   even when the record's email differs from the sign-in email. */
let app: any;
let storageRoot = "";

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-customer-impersonation-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
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
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

const admin = { "x-internal-user-email": "impersonation-admin@example.test" };
async function impersonate(payload: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: "/v1/internal/legacy-action", headers: admin, payload: { action: "admin_impersonate_user", ...payload } });
  return { status: response.statusCode, data: JSON.parse(response.body || "{}") };
}

test("Customers tab impersonation uses the user record's identity when its email differs from the sign-in email (1M8-248)", async () => {
  const registered = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/register",
    payload: { phone: nextTestPhone(), email: "office@impersonate.example.test", password: "correct horse battery staple", name: "Office", company: "Impersonate Co", organization_id: "org_impersonate" }
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const created = await app.inject({ method: "POST", url: "/v1/internal/users", payload: { email: "impersonation-admin@example.test", name: "Admin", role: "admin", permissions: { "*": true } } });
  assert.ok(created.statusCode < 400, created.body);

  // A profile email edited before 1M8-244 locked it: the record says crystal@, the person signs in as office@.
  const storage = await import("../platform/storage.js");
  const { findIdentityByEmail, listDocuments, upsertDocument } = storage;
  const identity = await findIdentityByEmail("office@impersonate.example.test");
  const user = (await listDocuments("org_impersonate", "users")).find((entry: any) => (entry.data?.identity_id || entry.metadata?.identity_id) === identity.id) as any;
  assert.ok(user, "registered user record");
  await upsertDocument("org_impersonate", "users", { id: user.id, data: { email: "crystal@impersonate.example.test" } }, { replace: false });

  // The Customers tab lists the record's email and id, and sends both.
  const detail = await app.inject({ method: "GET", url: "/v1/internal/organizations/org_impersonate", headers: admin });
  assert.equal(detail.statusCode, 200, detail.body);
  const detailBody = JSON.parse(detail.body);
  const listed = (detailBody.organization?.users ?? detailBody.users ?? []).find((entry: any) => entry.email === "crystal@impersonate.example.test");
  assert.equal(listed?.id, user.id, JSON.stringify((detailBody.users ?? []).map((u: any) => [u.id, u.email, u.identity_id])) + " want " + user.id);

  const byEmailOnly = await impersonate({ email: "crystal@impersonate.example.test", org_id: "org_impersonate" });
  assert.equal(byEmailOnly.status, 404);
  assert.equal(byEmailOnly.data.error, "identity_not_found");

  const byUser = await impersonate({ email: "crystal@impersonate.example.test", org_id: "org_impersonate", user_id: user.id });
  assert.equal(byUser.status, 200, JSON.stringify(byUser.data));
  assert.equal(byUser.data.success, true);
  assert.equal(byUser.data.org_id, "org_impersonate");
  assert.equal(byUser.data.user_id, user.id);

  // A user id from another organization never selects a membership there.
  const wrongOrg = await impersonate({ email: "crystal@impersonate.example.test", org_id: "org_other", user_id: user.id });
  assert.equal(wrongOrg.status, 404);

  // Email-only impersonation of a matching account still works.
  const plain = await impersonate({ email: "office@impersonate.example.test", org_id: "org_impersonate" });
  assert.equal(plain.status, 200, JSON.stringify(plain.data));
});

test("the Customers tab sends the user id with an impersonation", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../measure/internal/portal_scripts/customers.js", import.meta.url), "utf8");
  assert.match(source, /impersonateUser\('\$\{esc\(u\.email\)\}', '\$\{esc\(u\.name\|\|u\.email\)\}', '\$\{esc\(u\.id\|\|''\)\}'\)/);
  assert.match(source, /user_id: userId \|\| ''/);
});
