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

test("adding another account accepts the login form's identifier field (1M8-223)", async () => {
  const client = browser();
  await register(client, "add.first@example.test", "add_account_first");
  await register(browser(), "add.second@example.test", "add_account_second");
  const added = await client.request("POST", "/v1/platform/auth/accounts/add", { identifier: "add.second@example.test", password: PASSWORD });
  assert.equal(added.response.statusCode, 200, added.response.body);
  assert.equal(added.data.organization.id, "add_account_second");
  const wrong = await client.request("POST", "/v1/platform/auth/accounts/add", { identifier: "add.first@example.test", password: "not the password" });
  assert.equal(wrong.data.error, "invalid_credentials");
});

test("the owner and the last active super admin cannot be suspended, archived or demoted; other super admins can (1M8-235)", async () => {
  const owner = browser();
  const registered = await register(owner, "guard.owner@example.test", "admin_guard_org");
  const ownerId = registered.user?.id || registered.membership?.user_id;
  const create = async (email: string, level: string) => {
    const result = await owner.request("POST", "/v1/platform/organizations/admin_guard_org/users", { data: { email, name: email, send_invite: false, role: "viewer", status: "invited" } });
    assert.equal(result.response.statusCode, 201, result.response.body);
    const id = result.data.document.id;
    if (level !== "viewer") {
      const set = await owner.request("PATCH", `/v1/platform/organizations/admin_guard_org/users/${id}`, { data: { role: level, org_permissions: { level, items: {} } } });
      assert.equal(set.response.statusCode, 200, set.response.body);
    }
    return id;
  };
  const invitedAdmin = await create("guard.invited@example.test", "super_admin");
  const viewer = await create("guard.viewer@example.test", "viewer");

  // An invited super admin can be suspended and archived (revoked) by the owner.
  const suspend = await owner.request("PATCH", `/v1/platform/organizations/admin_guard_org/users/${invitedAdmin}`, { data: { status: "disabled" } });
  assert.equal(suspend.response.statusCode, 200, suspend.response.body);
  const revoke = await owner.request("DELETE", `/v1/platform/organizations/admin_guard_org/users/${invitedAdmin}`);
  assert.equal(revoke.response.statusCode, 200, revoke.response.body);

  // The owner cannot change themselves, and nothing without another super admin acting can change the owner (1M8-251).
  const promoted = await create("guard.admin@example.test", "super_admin");
  assert.ok(ownerId);
  const suspendOwner = await owner.request("PATCH", `/v1/platform/organizations/admin_guard_org/users/${ownerId}`, { data: { status: "disabled" } });
  assert.equal(suspendOwner.data.error, "owner_protected");
  const { assertOrganizationKeepsAdmin } = await import("../platform/api.js");
  await assert.rejects(assertOrganizationKeepsAdmin("admin_guard_org", ownerId, { archived: true }), /account owner/);
  await assert.rejects(assertOrganizationKeepsAdmin("admin_guard_org", ownerId, { level: "viewer" }), /account owner/);
  await assert.doesNotReject(assertOrganizationKeepsAdmin("admin_guard_org", viewer, { archived: true }));

  // A migrated organization has no signup owner: its super admins carry the level. The last active one is kept.
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument("admin_guard_org", "users", { id: ownerId, data: { org_permissions: { level: "super_admin", items: {} } } }, { replace: false });
  await assert.doesNotReject(assertOrganizationKeepsAdmin("admin_guard_org", promoted, { disabled: true }), "another super admin remains");
  const suspendPromoted = await owner.request("PATCH", `/v1/platform/organizations/admin_guard_org/users/${promoted}`, { data: { status: "disabled" } });
  assert.equal(suspendPromoted.response.statusCode, 200, suspendPromoted.response.body);
  await assert.rejects(assertOrganizationKeepsAdmin("admin_guard_org", ownerId, { disabled: true }), /at least one/);
  await assert.rejects(assertOrganizationKeepsAdmin("admin_guard_org", ownerId, { level: "admin" }), /at least one/);
});

test("when the owner leaves, another active super admin can lower and archive them; nobody else can (1M8-251)", async () => {
  const owner = browser();
  const registered = await register(owner, "handover.owner@example.test", "handover_org");
  const ownerId = registered.user?.id || registered.membership?.user_id;
  assert.ok(ownerId);
  // People who already have a sign-in elsewhere, added here and signed in to this account.
  const member = async (email: string, level: string) => {
    await register(browser(), email, `${email.split("@")[0].replace(/\W/g, "_")}_home`);
    const added = await owner.request("POST", "/v1/platform/organizations/handover_org/users", { data: { email, name: email } });
    assert.equal(added.response.statusCode, 201, added.response.body);
    const id = added.data.document.id;
    const set = await owner.request("PATCH", `/v1/platform/organizations/handover_org/users/${id}`, { data: { role: level, org_permissions: { level, items: {} } } });
    assert.equal(set.response.statusCode, 200, set.response.body);
    const client = browser();
    const login = await client.request("POST", "/v1/platform/auth/legacy-action", { action: "login", email, password: PASSWORD, organization_id: "handover_org" });
    assert.equal(login.data.organization?.id, "handover_org", login.response.body);
    return { id, client };
  };
  const manager = await member("handover.manager@example.test", "admin");
  const admin = await member("handover.admin@example.test", "super_admin");
  const ownerRecord = async () => (await admin.client.request("GET", "/v1/platform/organizations/handover_org/users")).data.documents.find((doc: any) => doc.id === ownerId)?.data;

  // An admin who manages users but is not a super admin cannot touch the owner.
  const managerArchive = await manager.client.request("POST", "/v1/platform/portal-action", { action: "org_users_delete_my", user_id: ownerId });
  assert.equal(managerArchive.data.error, "owner_protected", JSON.stringify(managerArchive.data));
  assert.equal((await ownerRecord()).role, "owner");

  // Another active super admin lowers the departed owner, then archives them; the account keeps its super admin.
  const lowered = await admin.client.request("POST", "/v1/platform/portal-action", { action: "org_users_set_perms_my", user_id: ownerId, perm_level: "viewer", perm_items_json: "{}" });
  assert.equal(lowered.data.success, true, JSON.stringify(lowered.data));
  assert.equal((await ownerRecord()).role, "viewer");
  const archived = await admin.client.request("DELETE", `/v1/platform/organizations/handover_org/users/${ownerId}`);
  assert.equal(archived.response.statusCode, 200, archived.response.body);
  assert.equal((await ownerRecord())?.deleted, true);

  // The guard itself is unchanged: the last active super admin is still kept.
  const lastAdmin = await manager.client.request("POST", "/v1/platform/portal-action", { action: "org_users_delete_my", user_id: admin.id });
  assert.equal(lastAdmin.data.error, "last_admin_protected", JSON.stringify(lastAdmin.data));
});

test("a user's email stays their sign-in email: invitations move with it, signed-in accounts refuse (1M8-244)", async () => {
  const owner = browser();
  const registered = await register(owner, "signin.owner@example.test", "signin_email_org");
  const ownerId = registered.user?.id || registered.membership?.user_id;
  assert.ok(ownerId);
  const forgot = (email: string) => browser().request("POST", "/v1/platform/auth/legacy-action", { action: "forgot_password", email });

  // An account someone signs in to keeps its email: changing only the record left reset and impersonation on the old one.
  const ownEmail = await owner.request("PATCH", `/v1/platform/organizations/signin_email_org/users/${ownerId}`, { data: { email: "signin.renamed@example.test" } });
  assert.equal(ownEmail.data.error, "sign_in_email_locked", ownEmail.response.body);
  assert.equal((await forgot("signin.owner@example.test")).data.message, "Password reset code sent.");
  const users = await owner.request("GET", "/v1/platform/organizations/signin_email_org/users");
  assert.ok((users.data.documents || []).some((doc: any) => doc.data?.email === "signin.owner@example.test"));

  // An invitation nobody has used moves with the corrected email, so the activation and reset lookups find it.
  const invited = await owner.request("POST", "/v1/platform/organizations/signin_email_org/users", { data: { email: "signin.typo@example.test", name: "Typo", send_invite: false } });
  assert.equal(invited.response.statusCode, 201, invited.response.body);
  const fixed = await owner.request("PATCH", `/v1/platform/organizations/signin_email_org/users/${invited.data.document.id}`, { data: { email: "signin.fixed@example.test" } });
  assert.equal(fixed.response.statusCode, 200, fixed.response.body);
  assert.equal((await forgot("signin.fixed@example.test")).data.message, "Password reset code sent.");
  assert.notEqual((await forgot("signin.typo@example.test")).response.statusCode, 200);
  const { findIdentityByEmail } = await import("../platform/storage.js");
  assert.equal((await findIdentityByEmail("signin.fixed@example.test")).id, invited.data.document.data.identity_id);

  // Someone who also belongs to another organization keeps their email too.
  await register(browser(), "signin.elsewhere@example.test", "signin_email_other");
  const added = await owner.request("POST", "/v1/platform/organizations/signin_email_org/users", { data: { email: "signin.elsewhere@example.test", name: "Elsewhere" } });
  assert.equal(added.response.statusCode, 201, added.response.body);
  const moved = await owner.request("PATCH", `/v1/platform/organizations/signin_email_org/users/${added.data.document.id}`, { data: { email: "signin.hijack@example.test" } });
  assert.equal(moved.data.error, "sign_in_email_locked", moved.response.body);
});

test("adding a person who is already in the account never replaces them, and no whole-record write leaves it without its owner (1M8-245)", async () => {
  const owner = browser();
  const registered = await register(owner, "readd.owner@example.test", "readd_guard_org");
  const ownerId = registered.user?.id || registered.membership?.user_id;
  assert.ok(ownerId);
  const ownerRecord = async () => (await owner.request("GET", "/v1/platform/organizations/readd_guard_org/users")).data.documents.find((doc: any) => doc.id === ownerId)?.data;
  const add = (email: string) => owner.request("POST", "/v1/platform/organizations/readd_guard_org/users", { data: { email, name: email, role: "viewer", status: "invited", permissions: {} } });

  // People's Invite with the owner's own email (any case) is refused, and the owner stays the owner.
  for (const email of ["readd.owner@example.test", " Readd.Owner@Example.test "]) {
    const own = await add(email);
    assert.equal(own.response.statusCode, 409, own.response.body);
    assert.equal(own.data.error, "org_user_exists");
  }
  const portalOwn = await owner.request("POST", "/v1/platform/portal-action", { action: "org_users_add_my", email: "readd.owner@example.test", name: "Me", perm_level: "viewer" });
  assert.equal(portalOwn.data.error, "org_user_exists", JSON.stringify(portalOwn.data));
  assert.equal((await ownerRecord()).role, "owner");
  assert.equal((await owner.request("GET", "/v1/platform/organizations/readd_guard_org/global")).response.statusCode, 200, "the owner keeps their access");

  // Another member's email is refused too; once they are archived they can be added again.
  const member = await add("readd.member@example.test");
  assert.equal(member.response.statusCode, 201, member.response.body);
  assert.equal((await add("readd.member@example.test")).data.error, "org_user_exists");
  const archived = await owner.request("DELETE", `/v1/platform/organizations/readd_guard_org/users/${member.data.document.id}`);
  assert.equal(archived.response.statusCode, 200, archived.response.body);
  assert.equal((await add("readd.member@example.test")).response.statusCode, 201);

  // Whole-record writers (PUT, the canvassing invite) keep the owner and the last super admin.
  const { assertOrgUserWriteKeepsAdmin } = await import("../platform/api.js");
  await assert.rejects(assertOrgUserWriteKeepsAdmin("readd_guard_org", ownerId, { email: "readd.owner@example.test", role: "viewer" }), /account owner/);
  await assert.rejects(assertOrgUserWriteKeepsAdmin("readd_guard_org", ownerId, null), /account owner/);
  await assert.doesNotReject(assertOrgUserWriteKeepsAdmin("readd_guard_org", ownerId, { role: "owner", permissions: { "*": true } }));
  await assert.doesNotReject(assertOrgUserWriteKeepsAdmin("readd_guard_org", member.data.document.id, { role: "viewer" }));
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument("readd_guard_org", "users", { id: ownerId, data: { role: "super_admin", org_permissions: { level: "super_admin", items: {} } } }, { replace: false });
  await assert.rejects(assertOrgUserWriteKeepsAdmin("readd_guard_org", ownerId, { role: "manager", org_permissions: { level: "manager", items: {} } }), /at least one/);
  const { createOrInviteCanvassingUser } = await import("../canvassing/service.js");
  await assert.rejects(createOrInviteCanvassingUser("readd_guard_org", "default", { email: "readd.owner@example.test", role: "canvasser" }), /at least one/);
  assert.equal((await ownerRecord()).org_permissions.level, "super_admin");
});
