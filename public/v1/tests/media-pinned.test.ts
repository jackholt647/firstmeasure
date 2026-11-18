import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// FM-560: a photo is pinned to the top of its project's Photos tab with PATCH .../media/:id {pinned}. The pin is on
// the media record: metadata.pinned (always written, false when unpinned) and pinned_at, the order of the pinned.

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  return async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: { ...(cookie ? { cookie } : {}), ...(csrf && method !== "GET" ? { "x-platform-csrf": csrf } : {}) }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    return { statusCode: response.statusCode as number, data: response.body ? JSON.parse(response.body) : null };
  };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-media-pinned-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    PLATFORM_HEARTBEAT_DISABLED: "1",
    WORK_SCHEDULER_DISABLED: "1",
    EMAIL_OUTBOUND_DISABLED: "1",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    MESSAGING_STORAGE_ROOT: path.join(storageRoot, "messaging"),
    V1_LOG_LEVEL: "error"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkDatabase } = await import("../work/storage.js");
  await closeWorkDatabase();
  const { closeCommunicationsDatabase } = await import("../messaging/communications_storage.js");
  await closeCommunicationsDatabase();
  await closeSqlStoresForTests();
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

test("pinning a project photo writes metadata.pinned and pinned_at; unpinning keeps pinned:false", async () => {
  const call = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await call("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `media-pinned-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Pin Owner",
    company: "Pin Roofing Co",
    organization_id: `org_pin_${suffix}`
  });
  assert.ok(registered.statusCode < 400, JSON.stringify(registered.data));
  const orgId = String(registered.data.organization.id);
  await enableExpandedPlatformFixture(orgId);
  const { storeMediaUpload } = await import("../platform/storage.js");
  const media = await storeMediaUpload(orgId, { bytes: Buffer.from("not really a picture"), fileName: "roof.jpg", contentType: "image/jpeg", ownerType: "project", ownerId: "p_pin", slot: "photos", collection: "projects", scope: "projects", thumbnails: { enabled: false }, metadata: { tags: ["front"] } }) as any;
  const url = `/v1/platform/organizations/${orgId}/media/${media.id}`;

  const pinned = await call("PATCH", url, { pinned: true });
  assert.equal(pinned.statusCode, 200, JSON.stringify(pinned.data));
  assert.equal(pinned.data.media.metadata.pinned, true);
  assert.ok(Date.parse(pinned.data.media.metadata.pinned_at) > 0, "pinned_at orders the pinned photos");
  assert.deepEqual(pinned.data.media.metadata.tags, ["front"], "the rest of the record is kept");
  assert.equal((await call("GET", url)).data.media.metadata.pinned, true, "stored");

  const unpinned = await call("PATCH", url, { pinned: false });
  assert.equal(unpinned.statusCode, 200);
  assert.equal(unpinned.data.media.metadata.pinned, false, "an unpin is written, so an older copy cannot bring the pin back");
  assert.equal("pinned_at" in unpinned.data.media.metadata, false);

  const invalid = await call("PATCH", url, { pinned: "yes" });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.data.error || invalid.data.code, "media_pinned_invalid");
  assert.equal((await call("PATCH", url, {})).statusCode, 400, "an empty update is still refused");

  // Tags and a pin in one request both apply.
  const both = await call("PATCH", url, { pinned: true, tags: ["back"] });
  assert.equal(both.statusCode, 200);
  assert.equal(both.data.media.metadata.pinned, true);
  assert.deepEqual(both.data.media.metadata.tags, ["back"]);
});
