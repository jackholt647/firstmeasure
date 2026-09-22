import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any;
let storageRoot = "";

function setCookieValues(value: string[] | string | undefined) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((entry) => entry.split(";")[0])
    .filter((entry): entry is string => Boolean(entry));
}

function browser() {
  const jar = new Map<string, string>();
  const request = async (method: string, url: string, payload?: unknown) => {
    const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    const csrf = jar.get("fm_platform_session_csrf");
    const response = await app.inject({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": decodeURIComponent(csrf) } : {})
      }
    });
    for (const pair of setCookieValues(response.headers["set-cookie"])) {
      const divider = pair.indexOf("=");
      if (divider > 0) jar.set(pair.slice(0, divider), pair.slice(divider + 1));
    }
    const data = JSON.parse(response.body || "{}");
    return { response, data, jar };
  };
  return { request, jar };
}

async function register(client: ReturnType<typeof browser>, email: string, orgId: string) {
  const { response, data } = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email,
    password: "correct horse battery staple",
    name: email.split("@")[0],
    company: `${orgId} Company`,
    organization_id: orgId
  });
  assert.equal(response.statusCode, 201, response.body);
  return data;
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-account-switching-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
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

test("accounts can be added, switched, and revoked without exposing session ids", async () => {
  const first = browser();
  const second = browser();
  const firstEmail = "first.account@example.test";
  const secondEmail = "second.account@example.test";
  await register(first, firstEmail, "account_switch_one");
  await register(second, secondEmail, "account_switch_two");

  assert.ok(first.jar.get("fm_platform_session_accounts"), "the opaque account-device cookie is set");
  assert.equal(first.jar.get("fm_platform_session_accounts")?.includes(firstEmail), false);

  const added = await first.request("POST", "/v1/platform/auth/accounts/add", {
    email: secondEmail,
    password: "correct horse battery staple"
  });
  assert.equal(added.response.statusCode, 200, added.response.body);
  assert.equal(added.data.identity.email, secondEmail);

  const listed = await first.request("GET", "/v1/platform/auth/accounts");
  assert.equal(listed.response.statusCode, 200, listed.response.body);
  assert.equal(listed.data.accounts.length, 2);
  assert.ok(listed.data.accounts.every((account: any) => !Object.hasOwn(account, "session_id")));
  const firstAccount = listed.data.accounts.find((account: any) => account.email === firstEmail);
  assert.ok(firstAccount);

  const switched = await first.request("POST", "/v1/platform/auth/accounts/switch", { account_id: firstAccount.account_id });
  assert.equal(switched.response.statusCode, 200, switched.response.body);
  assert.equal(switched.data.identity.email, firstEmail);

  const removed = await first.request("POST", "/v1/platform/auth/accounts/remove", { account_id: firstAccount.account_id });
  assert.equal(removed.response.statusCode, 200, removed.response.body);
  const session = await first.request("GET", "/v1/platform/auth/session");
  assert.equal(session.data.authenticated, false);
});

test("adding an account preserves the active account when the remembered-device cookie is missing", async () => {
  const active = browser();
  const other = browser();
  const activeEmail = "active.account@example.test";
  const otherEmail = "other.account@example.test";
  await register(active, activeEmail, "account_switch_recovery_one");
  await register(other, otherEmail, "account_switch_recovery_two");

  active.jar.delete("fm_platform_session_accounts");
  const added = await active.request("POST", "/v1/platform/auth/accounts/add", {
    email: otherEmail,
    password: "correct horse battery staple"
  });
  assert.equal(added.response.statusCode, 200, added.response.body);

  const renamed = await active.request("PATCH", `/v1/platform/identities/${added.data.identity.id}`, {
    name: "Renamed Other Account"
  });
  assert.equal(renamed.response.statusCode, 200, renamed.response.body);

  const listed = await active.request("GET", "/v1/platform/auth/accounts");
  assert.equal(listed.response.statusCode, 200, listed.response.body);
  assert.deepEqual(
    new Set(listed.data.accounts.map((account: any) => account.email)),
    new Set([activeEmail, otherEmail])
  );
  assert.equal(listed.data.accounts.find((account: any) => account.email === otherEmail)?.name, "Renamed Other Account");

  const originalAccount = listed.data.accounts.find((account: any) => account.email === activeEmail);
  assert.ok(originalAccount);
  const switched = await active.request("POST", "/v1/platform/auth/accounts/switch", { account_id: originalAccount.account_id });
  assert.equal(switched.response.statusCode, 200, switched.response.body);
  const listedAfterSwitch = await active.request("GET", "/v1/platform/auth/accounts");
  assert.equal(
    listedAfterSwitch.data.accounts.find((account: any) => account.email === otherEmail)?.name,
    "Renamed Other Account"
  );
});
