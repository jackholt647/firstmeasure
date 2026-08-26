import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

const storageRoot = mkdtempSync(path.join(tmpdir(), "firstmate-google-auth-"));
process.env.FIRSTMATE_ENV = "test";
process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
process.env.GOOGLE_AUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";

const claimsByCredential: Record<string, Record<string, unknown>> = {
  "existing-google": {
    sub: "google-existing-1",
    email: "owner@example.com",
    email_verified: true,
    name: "Existing Owner",
    picture: "https://example.test/owner.png"
  },
  "existing-other-google": {
    sub: "google-existing-2",
    email: "owner@example.com",
    email_verified: true,
    name: "Existing Owner"
  },
  "workspace-google": {
    sub: "google-workspace-1",
    email: "invite@workspace.example",
    email_verified: true,
    name: "Workspace Invite",
    hd: "workspace.example"
  },
  "new-google": {
    sub: "google-new-1",
    email: "new.user@gmail.com",
    email_verified: true,
    name: "New Google User"
  },
  "new-google-with-phone": {
    sub: "google-new-2",
    email: "new.phone.user@gmail.com",
    email_verified: true,
    name: "New Google User With Phone"
  },
  "new-workspace-google": {
    sub: "google-new-workspace-1",
    email: "owner@newworkspace.example",
    email_verified: true,
    name: "New Workspace Owner",
    hd: "newworkspace.example"
  },
  "unverified-google": {
    sub: "google-unverified-1",
    email: "unverified@gmail.com",
    email_verified: false
  }
};

test("Google authentication registers, links, and logs in exact-email accounts", async (t) => {
  const [{ registerPlatformApi }, storage] = await Promise.all([
    import("../platform/api.js"),
    import("../platform/storage.js")
  ]);
  const audiences: string[] = [];
  const app = Fastify({ logger: false });
  await app.register(registerPlatformApi, {
    prefix: "/v1/platform",
    googleIdTokenVerifier: async (credential, audience) => {
      audiences.push(audience);
      const claims = claimsByCredential[credential];
      if (!claims) throw new Error("invalid token");
      return claims;
    }
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  await t.test("publishes the public client configuration", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/platform/auth/google/config" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      enabled: true,
      client_id: "test-client.apps.googleusercontent.com"
    });
  });

  await t.test("links a password account by exact verified email and preserves password login", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: "Owner@Example.com",
        password: "correct-horse-battery-staple",
        name: "Existing Owner",
        phone: "+1 555 100 2000"
      }
    });
    assert.equal(registered.statusCode, 201, registered.body);
    assert.equal(registered.json().organization.name, "Your Company");
    const sessionCookie = String(registered.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
    const organizationId = String(registered.json().organization.id);
    const onboardingProfile = await app.inject({
      method: "POST",
      url: "/v1/platform/portal-action",
      headers: { cookie: sessionCookie },
      payload: {
        action: "org_update_my",
        actor_email: "owner@example.com",
        actor_org_id: organizationId,
        full_name: "Onboarded Owner",
        phone: "+1 555 999 0000",
        name: "Onboarded Company",
        website: "https://onboarded.example"
      }
    });
    assert.equal(onboardingProfile.statusCode, 200, onboardingProfile.body);
    assert.equal(onboardingProfile.json().org.name, "Onboarded Company");
    const onboardedIdentity = await storage.findIdentityByEmail("owner@example.com");
    assert.equal(onboardedIdentity.name, "Onboarded Owner");
    assert.equal(onboardedIdentity.phone, "(555) 999-0000");
    const onboardedUserId = String((onboardedIdentity.memberships as Array<Record<string, unknown>>)[0]?.user_id || "");
    const onboardedUser = await storage.readDocument(organizationId, "users", onboardedUserId);
    assert.equal((onboardedUser.data as Record<string, unknown>).name, "Onboarded Owner");
    assert.equal((onboardedUser.data as Record<string, unknown>).phone, "(555) 999-0000");
    const onboardedGlobal = await storage.readGlobal(organizationId);
    assert.equal(((onboardedGlobal.data as Record<string, unknown>).contact as Record<string, unknown>).website, "https://onboarded.example");

    const googleLogin = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "existing-google" }
    });
    assert.equal(googleLogin.statusCode, 200, googleLogin.body);
    assert.equal(googleLogin.json().first_login, false);
    assert.equal(googleLogin.json().linked_google, true);
    assert.match(String(googleLogin.headers["set-cookie"]), /fm_platform_session=/);

    const identity = await storage.findIdentityByEmail("owner@example.com");
    assert.equal((identity.metadata as Record<string, unknown>).email_verified, true);
    assert.equal(
      (((identity.metadata as Record<string, unknown>).auth_providers as Record<string, unknown>).google as Record<string, unknown>).sub,
      "google-existing-1"
    );

    const passwordLogin = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/login",
      payload: { email: "owner@example.com", password: "correct-horse-battery-staple" }
    });
    assert.equal(passwordLogin.statusCode, 200, passwordLogin.body);
  });

  await t.test("rejects a different Google subject after an email is linked", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "existing-other-google" }
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "google_account_mismatch");
  });

  await t.test("activates an invited Google Workspace identity", async () => {
    const organization = await storage.createOrganization({ name: "Workspace Company" });
    const identity = await storage.createIdentity({
      email: "invite@workspace.example",
      status: "invited",
      name: "Workspace Invite",
      password_hash: ""
    });
    const user = await storage.upsertDocument(String(organization.id), "users", {
      id: "user_workspace_invite",
      data: {
        identity_id: identity.id,
        email: identity.email,
        name: "Workspace Invite",
        status: "invited",
        role: "member",
        permissions: { view_reports: true }
      }
    }, { replace: true });
    await storage.addIdentityMembership(String(identity.id), String(organization.id), String(user.id), "member");

    const response = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "workspace-google" }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().identity.status, "active");
    assert.equal(response.json().membership.organization_id, organization.id);
    const linked = await storage.findIdentityByEmail("invite@workspace.example");
    assert.equal(
      ((((linked.metadata as Record<string, unknown>).auth_providers as Record<string, unknown>).google as Record<string, unknown>).hosted_domain),
      "workspace.example"
    );
  });

  await t.test("creates a new Google account without a phone for onboarding", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "new-google" }
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().first_login, true);
    assert.equal(response.json().identity.phone, "");
    assert.match(String(response.headers["set-cookie"]), /fm_platform_session=/);

    const identity = await storage.findIdentityByEmail("new.user@gmail.com");
    const organizationId = String(response.json().organization.id);
    const userId = String((identity.memberships as Array<Record<string, unknown>>)[0]?.user_id || "");
    const userBeforeOnboarding = await storage.readDocument(organizationId, "users", userId);
    assert.equal((userBeforeOnboarding.data as Record<string, unknown>).phone, "");

    const onboarding = await app.inject({
      method: "POST",
      url: "/v1/platform/portal-action",
      headers: { cookie: String(response.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "" },
      payload: {
        action: "org_update_my",
        actor_email: "new.user@gmail.com",
        actor_org_id: organizationId,
        phone: "5551234567"
      }
    });
    assert.equal(onboarding.statusCode, 200, onboarding.body);
    const onboardedIdentity = await storage.findIdentityByEmail("new.user@gmail.com");
    const onboardedUser = await storage.readDocument(organizationId, "users", userId);
    assert.equal(onboardedIdentity.phone, "(555) 123-4567");
    assert.equal((onboardedUser.data as Record<string, unknown>).phone, "(555) 123-4567");
  });

  await t.test("creates and signs in a new Google-only account", async () => {
    const invalidPhone = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "new-google-with-phone", phone: "555-0101" }
    });
    assert.equal(invalidPhone.statusCode, 400, invalidPhone.body);
    assert.equal(invalidPhone.json().error, "invalid_phone_number");

    const response = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: {
        credential: "new-google-with-phone",
        phone: "+1 555 222 3333",
        campaign: "google-test"
      }
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().first_login, true);
    assert.equal(response.json().identity.email, "new.phone.user@gmail.com");
    assert.equal(response.json().organization.name, "Your Company");
    assert.match(String(response.headers["set-cookie"]), /fm_platform_session=/);
    const identity = await storage.findIdentityByEmail("new.phone.user@gmail.com");
    assert.equal(identity.phone, "(555) 222-3333");
    assert.equal(identity.password_hash, "");
    assert.equal(identity.password_algo, "google");
    assert.equal((identity.memberships as unknown[]).length, 1);
  });

  await t.test("prefills a new Workspace organization's website from Google's hosted domain", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "new-workspace-google", phone: "(555) 444-5555" }
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().first_login, true);
    const organizationId = String(response.json().organization.id);
    const global = await storage.readGlobal(organizationId);
    assert.equal(
      ((global.data as Record<string, unknown>).contact as Record<string, unknown>).website,
      "newworkspace.example"
    );

    await storage.saveGlobal(organizationId, { data: { contact: { website: "" } } });
    const relogin = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "new-workspace-google" }
    });
    assert.equal(relogin.statusCode, 200, relogin.body);
    const sessionCookie = String(relogin.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
    const onboarding = await app.inject({
      method: "POST",
      url: "/v1/platform/portal-action",
      headers: { cookie: sessionCookie },
      payload: {
        action: "org_get_my",
        actor_email: "owner@newworkspace.example",
        actor_org_id: organizationId
      }
    });
    assert.equal(onboarding.statusCode, 200, onboarding.body);
    assert.equal(onboarding.json().workspace_website_suggestion, "newworkspace.example");
  });

  await t.test("rejects Google credentials without a verified email", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/google",
      payload: { credential: "unverified-google" }
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "unverified_google_email");
  });

  assert.ok(audiences.length >= 7);
  assert.ok(audiences.every((audience) => audience === "test-client.apps.googleusercontent.com"));
});
