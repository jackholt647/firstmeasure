import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

/** Removing a person archives them; workforce.users.restore brings them back intact (workforce/user-archive.ts). */
const dir = await mkdtemp(path.join(os.tmpdir(), "user-archive-"));
Object.assign(process.env, {
  NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", APPOINTMENT_CONFIRMATIONS_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error",
  PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), MESSAGING_STORAGE_ROOT: path.join(dir, "messaging")
});
let app: any = null;
const ORG = "org_user_archive";
before(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Archive test" });
  await enableExpandedPlatformFixture(ORG, { "platform.multiple_branches": true });
  await s.upsertDocument(ORG, "branch", { id: "east", data: { name: "East" } });
  await s.upsertDocument(ORG, "branch", { id: "west", data: { name: "West" } });
});
after(async () => {
  await (await import("../firstmeasure/job_runtime.js")).stopFirstMeasureJobRuntime().catch(() => {});
  if (app) await app.close();
  await closePlatformFixtureStores();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

/** A signed-in member of ORG with their own session cookie. */
async function member(id: string, data: Record<string, unknown>) {
  const s = await import("../platform/storage.js");
  const { env } = await import("../src/config/env.js");
  const { createHmac } = await import("node:crypto");
  const identity = await s.createIdentity({ email: `${id}@example.test`, name: id });
  await s.addIdentityMembership(String(identity.id), ORG, id, "member");
  await s.upsertDocument(ORG, "users", { id, data: { identity_id: identity.id, email: `${id}@example.test`, name: id, status: "active", ...data } });
  const auth = await s.createAuthSession({ identity_id: identity.id, organization_id: ORG, user_id: id, role: "member" });
  const signature = createHmac("sha256", env.platformSessionSecret).update(auth.sessionId).digest("base64url");
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, payload, headers: { cookie: `fm_platform_session=${auth.sessionId}.${signature}`, "x-platform-csrf": String(auth.session.csrf_token) } });
    let body: any = null; try { body = response.json(); } catch { body = null; }
    return { status: response.statusCode, body };
  };
  return { raw };
}
const restore = (client: { raw: Function }, userId: string) => client.raw("POST", `/v1/publication/organizations/${ORG}/actions/invoke`, { action: "workforce.users.restore", target: { scope: "organization", organizationId: ORG, id: userId }, input: {}, idempotencyKey: `restore-${userId}-${Math.random()}` });

test("removing a person archives them: kept for the record, refused at sign-in, restored intact", async () => {
  const s = await import("../platform/storage.js");
  const admin = await member("admin", { branch_id: "east", branch_ids: ["east", "west"], org_permissions: { level: "super_admin", items: {} }, access_role_ids: [], permission_overrides: { "*": true } });
  const ann = await member("ann", { branch_id: "east", access_role_ids: ["sales"], assignment_tag_ids: ["bilingual"] });
  assert.equal((await ann.raw("GET", "/v1/platform/auth/session")).status, 200);

  const removed = await admin.raw("DELETE", `/v1/platform/organizations/${ORG}/users/ann?reason=Left%20the%20company`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.archived, true);
  const kept = (await s.readDocument(ORG, "users", "ann")).data as Record<string, unknown>;
  assert.equal(kept.deleted, true);
  assert.equal(kept.status, "disabled");
  assert.equal(kept.deleted_by, "admin");
  assert.ok(String(kept.deleted_at).length > 0);
  assert.equal(kept.archived_reason, "Left the company");
  assert.deepEqual(kept.access_role_ids, ["sales"], "roles stay attached");
  // Archived: every request on their session is refused.
  const refused = await ann.raw("GET", `/v1/platform/organizations/${ORG}/projects`);
  assert.equal(refused.status, 403);
  assert.equal(refused.body?.error?.code || refused.body?.code || refused.body?.error, "user_disabled");
  // You cannot archive yourself.
  assert.equal((await admin.raw("DELETE", `/v1/platform/organizations/${ORG}/users/admin`)).status, 403);

  const back = await restore(admin, "ann");
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const restored = (await s.readDocument(ORG, "users", "ann")).data as Record<string, unknown>;
  assert.equal(restored.status, "active");
  for (const key of ["deleted", "deleted_at", "deleted_by", "archived_reason", "status_before_archive"]) assert.equal(key in restored, false, `${key} is cleared`);
  assert.deepEqual(restored.access_role_ids, ["sales"]);
  assert.deepEqual(restored.assignment_tag_ids, ["bilingual"]);
  assert.equal((await ann.raw("GET", "/v1/platform/auth/session")).status, 200, "they can sign in again");
});

test("restoring needs manage_company_users and the person in a branch the caller manages; a suspended person stays suspended", async () => {
  const s = await import("../platform/storage.js");
  const eastAdmin = await member("east_admin", { branch_id: "east", org_permissions: { level: "viewer", items: {} }, permission_overrides: { manage_company_users: true } });
  const viewer = await member("viewer", { branch_id: "east", org_permissions: { level: "viewer", items: {} } });
  await s.upsertDocument(ORG, "users", { id: "wes", data: { name: "Wes", status: "disabled", deleted: true, deleted_at: "2026-10-01T00:00:00Z", deleted_by: "admin", status_before_archive: "active", branch_id: "west" } });
  await s.upsertDocument(ORG, "users", { id: "erin", data: { name: "Erin", status: "disabled", deleted: true, deleted_at: "2026-10-01T00:00:00Z", deleted_by: "admin", status_before_archive: "disabled", branch_id: "east" } });
  const denied = await restore(viewer, "erin");
  assert.equal(denied.status, 403, "no manage_company_users");
  const outside = await restore(eastAdmin, "wes");
  assert.equal(outside.status, 403, "west is outside an east-only manager's reach");
  assert.equal(((await s.readDocument(ORG, "users", "wes")).data as any).deleted, true);
  const own = await restore(eastAdmin, "erin");
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(((await s.readDocument(ORG, "users", "erin")).data as any).status, "disabled", "suspended before, suspended after");
  // Archiving across branches is refused the same way.
  await s.upsertDocument(ORG, "users", { id: "wendy", data: { name: "Wendy", status: "active", branch_id: "west" } });
  assert.equal((await eastAdmin.raw("DELETE", `/v1/platform/organizations/${ORG}/users/wendy`)).status, 403);
  assert.equal(((await s.readDocument(ORG, "users", "wendy")).data as any).deleted, undefined);
});
