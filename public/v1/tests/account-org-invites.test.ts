import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/* 1M8-204, 1M8-212 and 1M8-213: accounts in several organizations, invitations to a second organization, activation codes. */
let app: any;
let storageRoot = "";
const sent: Array<{ To: string; Subject: string; TextBody: string; HtmlBody: string }> = [];
const realFetch = globalThis.fetch;

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
    return { response, data: JSON.parse(response.body || "{}") };
  };
  return { request, jar };
}

const PASSWORD = "correct horse battery staple";
async function register(client: ReturnType<typeof browser>, email: string, orgId: string) {
  const { response, data } = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(), email, password: PASSWORD, name: email.split("@")[0], company: `${orgId} Company`, organization_id: orgId
  });
  assert.equal(response.statusCode, 201, response.body);
  return data;
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-account-org-invites-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input?.url || input).startsWith("https://api.postmarkapp.com/")) {
      sent.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ MessageID: `test-${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error: any) { if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error; }
  }
});

test("inviting someone who already has an account adds them and sends a sign-in link to the inviting organization", async () => {
  const inviter = browser();
  const invitee = browser();
  await register(inviter, "owner.inviting@example.test", "invite_org_new");
  await register(invitee, "member.existing@example.test", "invite_org_old");

  const existing = await inviter.request("POST", "/v1/platform/organizations/invite_org_new/users", { data: { email: "member.existing@example.test", name: "Existing Member" } });
  assert.equal(existing.response.statusCode, 201, existing.response.body);
  assert.equal(existing.data.existing_account, true);
  const joinUrl = new URL(existing.data.activate_url);
  assert.equal(joinUrl.pathname, "/portal/login.php");
  assert.equal(joinUrl.searchParams.get("org"), "invite_org_new");
  const joinEmail = sent.find((email) => email.To === "member.existing@example.test");
  assert.ok(joinEmail);
  assert.match(joinEmail.Subject, /added to invite_org_new Company/);
  assert.doesNotMatch(joinEmail.TextBody, /set your password/);

  const fresh = await inviter.request("POST", "/v1/platform/organizations/invite_org_new/users", { data: { email: "brand.new@example.test", name: "Brand New" } });
  assert.equal(fresh.response.statusCode, 201, fresh.response.body);
  assert.equal(fresh.data.existing_account, false);
  const activateUrl = new URL(fresh.data.activate_url);
  assert.equal(activateUrl.pathname, "/portal/activate.php");
  assert.equal(activateUrl.searchParams.get("org"), "invite_org_new");

  // Signing in from the invitation opens the inviting organization, and the inviter sees them signed in.
  const signIn = browser();
  const login = await signIn.request("POST", "/v1/platform/auth/legacy-action", { action: "login", email: "member.existing@example.test", password: PASSWORD, organization_id: "invite_org_new" });
  assert.equal(login.response.statusCode, 200, login.response.body);
  assert.equal(login.data.organization.id, "invite_org_new");
  const users = await inviter.request("GET", "/v1/platform/organizations/invite_org_new/users");
  const joined = (users.data.documents || []).find((doc: any) => doc.data?.email === "member.existing@example.test");
  assert.equal(joined?.data?.status, "active");
  assert.ok(joined?.data?.last_login_at);

  // Without the invitation's organization the person still lands in their first company.
  const plain = await browser().request("POST", "/v1/platform/auth/login", { identifier: "member.existing@example.test", password: PASSWORD });
  assert.equal(plain.data.organization.id, "invite_org_old");
});

test("an invited person's code is an activation code", async () => {
  const owner = browser();
  await register(owner, "owner.activation@example.test", "activation_org");
  await owner.request("POST", "/v1/platform/organizations/activation_org/users", { data: { email: "activate.me@example.test", name: "Activate Me" } });
  const before = sent.length;
  const activation = await browser().request("POST", "/v1/platform/auth/legacy-action", { action: "forgot_password", purpose: "activation", email: "activate.me@example.test" });
  assert.equal(activation.response.statusCode, 200, activation.response.body);
  assert.equal(activation.data.message, "Activation code sent.");
  assert.match(sent[before]!.Subject, /^1m8 Activation Code: \d{6}$/);
  const reset = await browser().request("POST", "/v1/platform/auth/legacy-action", { action: "forgot_password", email: "activate.me@example.test" });
  assert.equal(reset.data.message, "Password reset code sent.");
  assert.match(sent[before + 1]!.Subject, /^1m8 Verification Code: \d{6}$/);
});

test("remembered accounts carry their organization, and a tab opened as another account cannot refresh this account's orders", async () => {
  const client = browser();
  await register(client, "tab.one@example.test", "stale_tab_one");
  await register(browser(), "tab.two@example.test", "stale_tab_two");
  const added = await client.request("POST", "/v1/platform/auth/accounts/add", { email: "tab.two@example.test", password: PASSWORD });
  assert.equal(added.response.statusCode, 200, added.response.body);
  const listed = await client.request("GET", "/v1/platform/auth/accounts");
  assert.deepEqual(listed.data.accounts.map((account: any) => account.organization_id).sort(), ["stale_tab_one", "stale_tab_two"]);

  // The browser is now signed in to stale_tab_two; a tab still showing stale_tab_one asks for its orders.
  const stale = await client.request("POST", "/v1/firstmeasure/projects/list", { refresh: true, filter: "org", page: 1, limit: 20, actor: { email: "tab.one@example.test", organization_id: "stale_tab_one" } });
  assert.equal(stale.response.statusCode, 403, stale.response.body);
  assert.equal(stale.data.error, "organization_forbidden");
  const current = await client.request("POST", "/v1/firstmeasure/projects/list", { refresh: true, filter: "org", page: 1, limit: 20, actor: { email: "tab.two@example.test", organization_id: "stale_tab_two" } });
  assert.equal(current.response.statusCode, 200, current.response.body);
});
