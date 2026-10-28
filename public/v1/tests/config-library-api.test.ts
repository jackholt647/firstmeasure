import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The config library API (config-library/api.ts): who may call it, an agent key, browser reads, and a sandbox test
// organization's starting state restored after Get Started changed it.
const root = await mkdtemp(path.join(os.tmpdir(), "config-library-api-"));
Object.assign(process.env, {
  FIRSTMATE_ENV: "development", FIRSTMEASURE_DATA_ENVIRONMENT: "development", FIRSTMEASURE_DATABASE_MODE: "sqlite", CONFIG_LIBRARY_SOURCE: "store",
  PLATFORM_STORAGE_ROOT: path.join(root, "platform"), SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"),
  PLATFORM_SESSION_SECRET: "isolated-config-library-api-test-secret", FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "firstmeasure-index.sqlite"), INTERNAL_STORAGE_ROOT: path.join(root, "internal"), PLATFORM_HEARTBEAT_DISABLED: "1"
});
const home = process.cwd();
after(async () => {
  process.chdir(home);
  (await import("../config-library/library.js")).stopLibrarySync();
  const { closePlatformFixtureStores } = await import("./helpers/platform-fixture.js");
  await closePlatformFixtureStores();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function session(app: any, orgId: string, email: string, userId: string) {
  const storage = await import("../platform/storage.js");
  const { env } = await import("../src/config/env.js");
  const identity = await storage.findIdentityByEmail(email).catch(() => null) || await storage.createIdentity({ email, name: email });
  await storage.addIdentityMembership(String(identity.id), orgId, userId, "owner").catch(() => undefined);
  await storage.upsertDocument(orgId, "users", { id: userId, data: { identity_id: identity.id, email, status: "active", role: "owner", org_permissions: { level: "owner", items: {} } } });
  const auth = await storage.createAuthSession({ identity_id: identity.id, organization_id: orgId, user_id: userId, role: "owner" });
  const signature = createHmac("sha256", env.platformSessionSecret).update(auth.sessionId).digest("base64url");
  return (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, payload,
    headers: { cookie: `fm_platform_session=${auth.sessionId}.${signature}`, "x-platform-csrf": String(auth.session.csrf_token), ...headers } });
}

test("config library API: gate, agent key, browser reads and a test organization's starting state", async () => {
  const { z } = await import("zod");
  const { registerLibraryKind } = await import("../config-library/kinds.js");
  registerLibraryKind({ kind: "api_test_label", title: "Labels", description: "A test kind.", browser: true, schema: z.object({ label: z.string().min(1) }).strict(), titleOf: (data) => data.label });

  const service = await import("../signup-sandbox/service.js");
  const storage = await import("../platform/storage.js");

  await service.ensureSeedData();
  const instance = await service.createTestInstance("swf_mvp_platform", { label: "Config library fixture" });
  const sandboxOrg = String(instance.testOrg.org_id);
  await storage.createOrganization({ id: "org_plain_cl", name: "Plain" });

  const { buildApp } = await import("../src/app.js");
  const app = await buildApp();
  await app.ready();
  const sandboxOwner = await session(app, sandboxOrg, "owner@sandbox-cl.test", "sb_owner_cl");
  const plainOwner = await session(app, "org_plain_cl", "owner@plain-cl.test", "plain_owner_cl");

  // Only the development tools audience (and platform administrators) may edit.
  assert.equal((await app.inject({ method: "GET", url: "/v1/config-library/kinds" })).statusCode, 401);
  assert.equal((await plainOwner("GET", "/v1/config-library/kinds")).statusCode, 403);
  const kinds = await sandboxOwner("GET", "/v1/config-library/kinds");
  assert.equal(kinds.statusCode, 200, kinds.body);
  assert.ok(kinds.json().kinds.some((kind: any) => kind.kind === "api_test_label" && kind.schema.type === "object"));

  // Saving needs CSRF; a bad entry says why; history and revert.
  assert.equal((await sandboxOwner("PUT", "/v1/config-library/entries/api_test_label/hello", { data: { label: "Hi" } }, { "x-platform-csrf": "wrong" })).statusCode, 403);
  const invalid = await sandboxOwner("PUT", "/v1/config-library/entries/api_test_label/hello", { data: { label: "" } });
  assert.equal(invalid.statusCode, 400);
  assert.ok(invalid.json().details?.errors?.length || /not saved/.test(invalid.body), invalid.body);
  assert.equal((await sandboxOwner("PUT", "/v1/config-library/entries/api_test_label/hello", { data: { label: "Hi" } })).json().entry.revision, 1);
  assert.equal((await sandboxOwner("PUT", "/v1/config-library/entries/api_test_label/hello", { data: { label: "Hello" }, expected_revision: 0 })).statusCode, 409);
  assert.equal((await sandboxOwner("PUT", "/v1/config-library/entries/api_test_label/hello", { data: { label: "Hello" }, expected_revision: 1 })).json().entry.revision, 2);
  const revisions = (await sandboxOwner("GET", "/v1/config-library/entries/api_test_label/hello/revisions")).json().revisions;
  assert.deepEqual(revisions.map((r: any) => [r.revision, r.updated_by]), [[2, "owner@sandbox-cl.test"], [1, "owner@sandbox-cl.test"]]);
  assert.equal((await sandboxOwner("POST", "/v1/config-library/entries/api_test_label/hello/revert", { revision: 1 })).json().entry.data.label, "Hi");

  // Pages read browser kinds without signing in.
  const read = await app.inject({ method: "GET", url: "/v1/config-library/read/api_test_label" });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().entries.map((entry: any) => [entry.id, entry.data.label]), [["hello", "Hi"]]);

  // Keys: administrators only; a key edits entries but reaches nothing else.
  assert.equal((await sandboxOwner("POST", "/v1/config-library/keys", { name: "codex" })).statusCode, 403);
  const { saveInternalUser } = await import("../internal/storage.js");
  await saveInternalUser({ email: "admin@1m8-cl.test", name: "Platform admin", role: "admin", status: "active" });
  const admin = await session(app, "org_plain_cl", "admin@1m8-cl.test", "admin_cl");
  const created = await admin("POST", "/v1/config-library/keys", { name: "codex", days: 7 });
  assert.equal(created.statusCode, 200, created.body);
  const bearer = { authorization: `Bearer ${created.json().key}` };
  const byKey = await app.inject({ method: "PUT", url: "/v1/config-library/entries/api_test_label/hello", payload: { data: { label: "From an agent" } }, headers: bearer });
  assert.equal(byKey.statusCode, 200, byKey.body);
  assert.match(byKey.json().entry.updated_by, /^key:ck_.* codex$/);
  assert.equal((await app.inject({ method: "GET", url: "/v1/config-library/keys", headers: bearer })).statusCode, 401, "a key never manages keys");
  assert.equal((await app.inject({ method: "GET", url: `/v1/config-library/organizations/${sandboxOrg}/state`, headers: bearer })).statusCode, 401, "nor organizations");
  assert.equal((await app.inject({ method: "GET", url: "/v1/config-library/kinds", headers: { authorization: "Bearer fmck_" + "x".repeat(43) } })).statusCode, 401);

  // A sandbox test organization recorded its start at creation; Get Started changes it; restore puts it back.
  const stateUrl = `/v1/config-library/organizations/${sandboxOrg}/state`;
  const before = (await storage.readGlobal(sandboxOrg)).data as any;
  const state = await sandboxOwner("GET", stateUrl);
  assert.equal(state.statusCode, 200, state.body);
  assert.ok(state.json().initial?.captured_at, "recorded at creation");
  assert.deepEqual(state.json().changed, []);
  assert.equal(typeof state.json().flags["platform.materials"], "boolean", "flags are flat, defaults filled in");
  await storage.mutateGlobal(sandboxOrg, (current: any) => ({ data: { app_offers: (current.data.app_offers || []).filter((id: string) => id !== "project.materials"), app_activations: { "project.materials": { started_at: "now", user_id: "sb_owner_cl" } }, credits_balance: 25 } }));
  const { guidedStore } = await import("../guided-experiences/store.js");
  await guidedStore().prepare("INSERT INTO guided_progress (organization_id, subject_id, experience_id, started_at, updated_at) VALUES (?,?,?,?,?)").run(sandboxOrg, "", "materials.tab_tutorial", "now", "now");
  const flipped = await sandboxOwner("PATCH", stateUrl, { path: "flags.platform.top_bar", value: !state.json().flags["platform.top_bar"] });
  assert.equal(flipped.statusCode, 200, flipped.body);
  assert.deepEqual(flipped.json().changed.map((change: any) => change.path), ["flags.platform.top_bar", "settings.app_activations", "settings.app_offers"]);
  assert.equal((await sandboxOwner("PATCH", stateUrl, { path: "settings.credits_balance", value: 1 })).statusCode, 400, "money is not state");
  // Restore one path, then everything.
  const one = await sandboxOwner("POST", `${stateUrl}/restore`, { paths: ["flags.platform.top_bar"] });
  assert.deepEqual(one.json().changed.map((change: any) => change.path), ["settings.app_activations", "settings.app_offers"]);
  assert.equal(one.json().guided.progress, 0, "a partial restore leaves guided progress");
  assert.equal((await plainOwner("POST", `${stateUrl}/restore`, {})).statusCode, 403, "another organization's member may not");
  const restored = await sandboxOwner("POST", `${stateUrl}/restore`, {});
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().guided.progress, 1, "Get Started tours replay");
  assert.deepEqual(restored.json().changed, []);
  const afterRestore = (await storage.readGlobal(sandboxOrg)).data as any;
  assert.deepEqual(afterRestore.app_offers, before.app_offers);
  assert.equal(afterRestore.app_activations, undefined, "a setting added since the start is removed");
  assert.equal(afterRestore.credits_balance, 25, "money is never restored");
  assert.equal(restored.json().initial.restores, 2);
  assert.equal((await plainOwner("POST", "/v1/config-library/organizations/org_plain_cl/state/capture", {})).statusCode, 403, "only the development tools audience");
  await app.close();
});
