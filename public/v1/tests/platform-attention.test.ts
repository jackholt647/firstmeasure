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
  return { request, raw };
}

type TestClient = ReturnType<typeof createSessionClient>;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-attention-test-"));
  process.env.NODE_ENV = "test";
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

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `attention-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Attention Owner",
    company: "Attention Test Org",
    organization_id: `org_attention_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { orgId: String(registered.organization.id), suffix, userId: String(registered.user.id) };
}

async function createViewer(owner: TestClient, orgId: string, suffix: string) {
  const email = `attention-viewer-${suffix}@example.test`;
  const password = "attention viewer password";
  await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: "Attention Viewer", status: "active", role: "viewer", send_invite: false }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { client };
}

function banner(overrides: Record<string, unknown> = {}) {
  return {
    id: `attention_test_${Math.random().toString(36).slice(2, 10)}`,
    key: "test_banner",
    priority: 50,
    surfaces: ["topbar", "sidebar", "notification"],
    title: "Test banner",
    body: "Body copy",
    cta_label: "Do it",
    tone: "orange",
    frontend_action: { route: { tab: "billing" } },
    state: "active",
    dismissible: { topbar: true, sidebar: false },
    ...overrides
  };
}

test("attention platform", async (t) => {
  const owner = createSessionClient();
  const { orgId, suffix } = await registerOwner(owner);
  const base = `/v1/platform/organizations/${orgId}`;

  await t.test("stored banner CRUD round-trips with normalization", async () => {
    const created = await owner.request("POST", `${base}/attention-banners`, banner({ id: "attention_crud", tone: "bogus", state: "nonsense", surfaces: ["topbar", "junk"] }));
    assert.equal(created.entry.id, "attention_crud");
    assert.equal(created.entry.tone, "orange", "unknown tone falls back to orange");
    assert.equal(created.entry.state, "active", "unknown state falls back to active");
    assert.deepEqual(created.entry.surfaces, ["topbar"], "unknown surfaces are dropped");
    assert.equal(created.entry.dismissible.notification, false, "notification surface is never dismissible");

    const listed = await owner.request("GET", `${base}/attention`);
    assert.ok(listed.entries.some((entry: any) => entry.id === "attention_crud"));

    const patched = await owner.request("PATCH", `${base}/attention-banners/attention_crud`, { title: "Renamed", priority: 70 });
    assert.equal(patched.entry.title, "Renamed");
    assert.equal(patched.entry.priority, 70);

    await owner.request("DELETE", `${base}/attention-banners/attention_crud`);
    const afterDelete = await owner.request("GET", `${base}/attention`);
    assert.ok(!afterDelete.entries.some((entry: any) => entry.id === "attention_crud"));
  });

  await t.test("write routes are guarded by the org-settings permission", async () => {
    const viewer = await createViewer(owner, orgId, suffix);
    const denied = await viewer.client.raw("POST", `${base}/attention-banners`, banner());
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(JSON.parse(denied.body).error, "permission_denied");
    const deniedPatch = await viewer.client.raw("PATCH", `${base}/attention-banners/whatever`, { title: "x" });
    assert.equal(deniedPatch.statusCode, 403);
    const deniedDelete = await viewer.client.raw("DELETE", `${base}/attention-banners/whatever`);
    assert.equal(deniedDelete.statusCode, 403);
    // Viewers can still READ the feed and manage their own dismissal state.
    const feed = await viewer.client.request("GET", `${base}/attention`);
    assert.ok(Array.isArray(feed.entries));
    const unauthenticated = createSessionClient();
    const anonymous = await unauthenticated.raw("GET", `${base}/attention`);
    assert.equal(anonymous.statusCode, 401);
  });

  await t.test("computed sources merge with stored entries and priority sorts the feed", async () => {
    const { registerAttentionSource, unregisterAttentionSource } = await import("../platform/attention.js");
    registerAttentionSource("test_source", () => [
      banner({ id: "attention_computed_high", priority: 90, source: "test_source", dismissible: {} }),
      banner({ id: "attention_computed_low", priority: 1, source: "test_source", dismissible: {} })
    ]);
    try {
      await owner.request("POST", `${base}/attention-banners`, banner({ id: "attention_stored_mid", priority: 50 }));
      const listed = await owner.request("GET", `${base}/attention`);
      const ids = listed.entries.map((entry: any) => entry.id);
      const relevant = ids.filter((id: string) => ["attention_computed_high", "attention_stored_mid", "attention_computed_low"].includes(id));
      assert.deepEqual(relevant, ["attention_computed_high", "attention_stored_mid", "attention_computed_low"], `priority desc, got ${ids.join(",")}`);
      const computed = listed.entries.find((entry: any) => entry.id === "attention_computed_high");
      assert.equal(computed.source, "test_source");
      assert.deepEqual(computed.visible_surfaces, ["topbar", "sidebar", "notification"]);
    } finally {
      unregisterAttentionSource("test_source");
      await owner.request("DELETE", `${base}/attention-banners/attention_stored_mid`);
    }
  });

  await t.test("demo source only appears when the query flag asks", async () => {
    const plain = await owner.request("GET", `${base}/attention`);
    assert.ok(!plain.entries.some((entry: any) => entry.id === "attention_demo_source"));
    const withDemo = await owner.request("GET", `${base}/attention?demo=1`);
    assert.ok(withDemo.entries.some((entry: any) => entry.id === "attention_demo_source"), "demo entry appears with ?demo=1 outside production");
  });

  await t.test("per-user dismissal only hides dismissible surfaces and does not leak between users", async () => {
    await owner.request("POST", `${base}/attention-banners`, banner({
      id: "attention_dismiss_me",
      priority: 40,
      surfaces: ["topbar", "sidebar", "notification"],
      dismissible: { topbar: true, sidebar: false }
    }));
    const state = await owner.request("PATCH", `${base}/attention/attention_dismiss_me/user-state`, { dismissed: true, seen: true });
    assert.ok(state.state.dismissed_at);
    assert.ok(state.state.seen_at);

    const listed = await owner.request("GET", `${base}/attention`);
    const entry = listed.entries.find((item: any) => item.id === "attention_dismiss_me");
    assert.ok(entry, "entry still visible on non-dismissible surfaces");
    assert.deepEqual(entry.visible_surfaces, ["sidebar", "notification"], "topbar hidden, sidebar/notification stay");
    assert.ok(entry.user_state.dismissed_at);

    // A different user in the same org still sees every surface.
    const viewer = await createViewer(owner, orgId, `${suffix}b`);
    const viewerFeed = await viewer.client.request("GET", `${base}/attention`);
    const viewerEntry = viewerFeed.entries.find((item: any) => item.id === "attention_dismiss_me");
    assert.deepEqual(viewerEntry.visible_surfaces, ["topbar", "sidebar", "notification"]);

    // Fully dismissible entries drop out of the default feed once dismissed.
    await owner.request("POST", `${base}/attention-banners`, banner({
      id: "attention_fully_dismissible",
      priority: 30,
      surfaces: ["topbar"],
      dismissible: { topbar: true }
    }));
    await owner.request("PATCH", `${base}/attention/attention_fully_dismissible/user-state`, { dismissed: true });
    const afterDismiss = await owner.request("GET", `${base}/attention`);
    assert.ok(!afterDismiss.entries.some((item: any) => item.id === "attention_fully_dismissible"));
    const includeDismissed = await owner.request("GET", `${base}/attention?include_dismissed=1`);
    assert.ok(includeDismissed.entries.some((item: any) => item.id === "attention_fully_dismissible"));

    await owner.request("DELETE", `${base}/attention-banners/attention_dismiss_me`);
    await owner.request("DELETE", `${base}/attention-banners/attention_fully_dismissible`);
  });

  await t.test("expired and done entries are filtered out", async () => {
    await owner.request("POST", `${base}/attention-banners`, banner({
      id: "attention_expired",
      expires_at: new Date(Date.now() - 60_000).toISOString()
    }));
    await owner.request("POST", `${base}/attention-banners`, banner({ id: "attention_done", state: "done" }));
    await owner.request("POST", `${base}/attention-banners`, banner({
      id: "attention_future",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      state: "waiting"
    }));
    const listed = await owner.request("GET", `${base}/attention`);
    const ids = listed.entries.map((entry: any) => entry.id);
    assert.ok(!ids.includes("attention_expired"), "expired entry filtered");
    assert.ok(!ids.includes("attention_done"), "done entry filtered");
    assert.ok(ids.includes("attention_future"), "future expiry stays");
    assert.equal(listed.entries.find((entry: any) => entry.id === "attention_future").state, "waiting");
    for (const id of ["attention_expired", "attention_done", "attention_future"]) {
      await owner.request("DELETE", `${base}/attention-banners/${id}`);
    }
  });

  await t.test("existing notifications API behavior is untouched", async () => {
    await owner.request("POST", `${base}/notifications`, { title: "Regular notification", body: "Still works" });
    const notifications = await owner.request("GET", `${base}/notifications`);
    assert.ok(notifications.notifications.some((item: any) => item.title === "Regular notification"));
    assert.equal(typeof notifications.unread_count, "number");
  });
});
