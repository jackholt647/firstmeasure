/**
 * What an offline photo needs from the server, through the real app (docs/architecture/offline.md, "Photos and files"):
 * the record id a device made, the time the photo was taken, a repeat that replaces instead of duplicating, and the
 * routes the media contract queues (public/libraries/platform-offline/contracts/media.js).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture, nextTestPhone } from "./helpers/platform-fixture.js";

let app: any = null;
let storageRoot = "";

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-offline-photos-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error",
    PUBLIC_BASE_URL: "https://app.example.test", CORS_ALLOWED_ORIGINS: "https://app.example.test",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    FIRSTMEASURE_INTERNAL_API_SECRET: "offline-photos-fixture-secret"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

/** Signs up an owner the way the portal does and keeps their session. */
async function owner() {
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method, url, payload, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {}) } });
    const session = readCookie(response.headers["set-cookie"], "fm_platform_session"), token = readCookie(response.headers["set-cookie"], "fm_platform_session_csrf");
    if (session || token) {
      cookie = [session || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", token || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((token || "").split("=")[1] || csrf);
    }
    return response;
  };
  const suffix = randomUUID().slice(0, 8);
  const registered = await raw("POST", "/v1/platform/auth/register", { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner", company: "Offline Photos Org", organization_id: `org_offline_photos_${suffix}` });
  assert.equal(registered.statusCode < 400, true, registered.body);
  const orgId = String(registered.json().organization.id), userId = String(registered.json().user.id);
  await enableExpandedPlatformFixture(orgId);
  return { orgId, userId, raw };
}

async function picture(width: number, height: number, color: { r: number; g: number; b: number }) {
  const sharp = (await import("sharp")).default;
  return await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

/** The form the browser sends (platform-api.js media.upload), with a boundary of its own. */
function form(fields: Record<string, unknown>, file: { name: string; type: string; bytes: Buffer }, boundary = `----fm${randomUUID().replace(/-/g, "")}`) {
  const chunks: Buffer[] = [];
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.bytes, Buffer.from("\r\n"));
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${typeof value === "object" ? JSON.stringify(value) : String(value)}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

const TAKEN = "2026-11-10T16:20:00.000Z";
const deviceId = () => `media_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

test("a photo's record keeps the id its device made and the time it was taken; the same photo again replaces it", async () => {
  const me = await owner();
  const { orgId } = me;
  const storage = await import("../platform/storage.js");
  await storage.upsertDocument(orgId, "projects", { id: "project_offline_a", data: { title: "First project" } });
  await storage.upsertDocument(orgId, "projects", { id: "project_offline_b", data: { title: "Second project" } });
  const upload = (id: string | undefined, bytes: Buffer, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const body = form({ id, owner_type: "project", owner_id: "project_offline_a", slot: "photos", collection: "projects", scope: "projects", replace_slot: false, thumbnails: true, compression: { quality: 0.88, max_width: 2400, max_height: 2400 }, metadata: { field: "photos", source: "project_camera_capture", uploaded_at: "2026-11-11T09:00:00.000Z", taken_at: TAKEN }, ...extra }, { name: "roof.jpg", type: "image/jpeg", bytes });
    return me.raw("POST", `/v1/platform/organizations/${orgId}/media`, body.payload, { ...body.headers, ...headers });
  };
  const list = async (query = "?project_id=project_offline_a") => (await me.raw("GET", `/v1/platform/organizations/${orgId}/media${query}`)).json().media as any[];

  const id = deviceId();
  const large = await picture(1600, 1200, { r: 30, g: 90, b: 200 });
  const first = await upload(id, large);
  assert.equal(first.statusCode, 201, first.body);
  const media = first.json().media;
  assert.equal(media.id, id, "the device's id is the record's id");
  assert.deepEqual(media.owner, { type: "project", id: "project_offline_a", slot: "photos" });
  assert.deepEqual([media.metadata.taken_at, media.metadata.uploaded_at, media.metadata.project_id, media.metadata.uploaded_by_user_id], [TAKEN, "2026-11-11T09:00:00.000Z", "project_offline_a", me.userId]);
  assert.deepEqual(Object.keys(media.variants).sort(), ["original", "thumb_160", "thumb_320", "thumb_640"]);
  assert.deepEqual([media.width, media.height, media.variants.thumb_320.width, media.variants.thumb_320.height], [1600, 1200, 320, 240]);
  assert.ok(Date.parse(media.created_at) > Date.parse(TAKEN), "the record's own time is when it arrived");
  // Every list that shows a time has the capture time to show.
  assert.deepEqual((await list()).map((item) => [item.id, item.metadata.taken_at]), [[id, TAKEN]]);
  assert.equal((await me.raw("GET", `/v1/platform/organizations/${orgId}/media/${id}`)).json().media.metadata.taken_at, TAKEN);

  // The same photo sent again (a retry whose first answer was lost): one record, replaced.
  const smaller = await picture(1280, 960, { r: 30, g: 90, b: 200 });
  const again = await upload(id, smaller);
  assert.equal(again.statusCode, 201, again.body);
  assert.deepEqual([again.json().media.id, again.json().media.width, again.json().media.size_bytes], [id, 1280, smaller.length]);
  assert.deepEqual((await list()).map((item) => [item.id, item.width]), [[id, 1280]], "replaced, not added");
  const file = await me.raw("GET", `/v1/platform/organizations/${orgId}/media/${id}/file?variant=original`);
  assert.equal(file.rawPayload.length, smaller.length);

  // The id cannot be taken over for another owner.
  const elsewhere = await upload(id, large, { owner_id: "project_offline_b" });
  assert.deepEqual([elsewhere.statusCode, elsewhere.json().error?.code || elsewhere.json().error], [409, "media_id_taken"]);
  assert.deepEqual((await list("?project_id=project_offline_b")), []);

  // Without an id the server still names the record, and a slot upload is still named by its slot.
  const unnamed = await upload(undefined, large);
  assert.match(unnamed.json().media.id, /^media_[0-9a-f]{16}$/);
  assert.notEqual(unnamed.json().media.id, id);
  const logo = await upload(undefined, large, { owner_type: "organization", owner_id: orgId, slot: "logo", replace_slot: true, metadata: undefined });
  assert.equal(logo.statusCode, 201, logo.body);
  assert.match(logo.json().media.id, /_logo$/);
  assert.equal(logo.json().media.metadata.taken_at, undefined);

  // The queue's key: a repeat (here with another boundary, as the app's uploader sends it) gets the first answer.
  const keyed = deviceId(), key = `fmo1-${randomUUID()}`;
  const offline = { "idempotency-key": key, "x-fm-offline-user": me.userId, "x-fm-offline-org": orgId, "x-fm-offline-replay": "1" };
  const sent = await upload(keyed, large, {}, offline);
  const repeat = await upload(keyed, large, {}, offline);
  assert.deepEqual([sent.statusCode, repeat.statusCode, repeat.headers["idempotency-replayed"], repeat.json().media.id], [201, 201, "true", keyed]);
  assert.equal((await list()).filter((item) => item.id === keyed).length, 1);
});

test("the project's photo list and pairing take a photo once however often they are repeated, and a replayed list never adds a photo that did not arrive", async () => {
  const me = await owner();
  const { orgId } = me;
  const storage = await import("../platform/storage.js");
  await storage.upsertDocument(orgId, "projects", { id: "project_offline_list", data: { title: "List project" } });
  const bytes = await picture(1400, 1000, { r: 200, g: 120, b: 20 });
  const send = (fields: Record<string, unknown>) => { const body = form({ slot: "photos", replace_slot: false, thumbnails: true, ...fields }, { name: "site.jpg", type: "image/jpeg", bytes }); return me.raw("POST", `/v1/platform/organizations/${orgId}/media`, body.payload, body.headers); };
  const reference = (id: string) => ({ id, photo_id: id, media_id: id, kind: "media_reference", label: "site.jpg", metadata: { taken_at: TAKEN } });
  const save = (photos: unknown[], remove: string[] = [], headers: Record<string, string> = {}) => me.raw("POST", `/v1/platform/organizations/${orgId}/projects/project_offline_list/photos`, { photos, remove }, headers);
  const ids = (response: any) => (response.json().photos as any[]).map((photo) => photo.id);

  // A project photo: the upload, then the list save, as the device replays them.
  const projectPhoto = deviceId();
  assert.equal((await send({ id: projectPhoto, owner_type: "project", owner_id: "project_offline_list", collection: "projects", scope: "projects", metadata: { taken_at: TAKEN } })).statusCode, 201);
  const saved = await save([reference(projectPhoto)], [], { "x-fm-offline-replay": "1" });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual([saved.json().ok, saved.json().project_id, ids(saved)], [true, "project_offline_list", [projectPhoto]]);
  assert.deepEqual(ids(await save([reference(projectPhoto)], [], { "x-fm-offline-replay": "1" })), [projectPhoto], "the same save again leaves one entry");

  // A replayed save names a photo whose upload failed or was discarded on the device: it is not added.
  const lost = deviceId();
  assert.deepEqual(ids(await save([reference(projectPhoto), reference(lost)], [], { "x-fm-offline-replay": "1" })), [projectPhoto]);
  // An ordinary save is as before (the page uploads first and saves only what arrived).
  assert.deepEqual(ids(await save([reference(projectPhoto), reference(lost)])), [projectPhoto, lost]);
  assert.deepEqual(ids(await save([reference(projectPhoto)], [lost])), [projectPhoto]);

  // A photo with no project yet (the Feed camera), then pairing, twice.
  const feedPhoto = deviceId();
  const unassigned = await send({ id: feedPhoto, owner_type: "organization", metadata: { source: "feed_camera_capture", upload_batch_id: "feed_batch_1", taken_at: TAKEN } });
  assert.equal(unassigned.statusCode, 201, unassigned.body);
  assert.deepEqual([unassigned.json().media.id, unassigned.json().media.owner.type, unassigned.json().media.owner.slot, unassigned.json().media.metadata.project_id], [feedPhoto, "organization", "photos", undefined]);
  assert.deepEqual(((await me.raw("GET", `/v1/platform/organizations/${orgId}/media?unassigned=true`)).json().media as any[]).map((item) => item.id), [feedPhoto]);
  const assign = () => me.raw("POST", `/v1/platform/organizations/${orgId}/media/assign`, { project_id: "project_offline_list", media_ids: [feedPhoto] });
  const paired = await assign();
  assert.equal(paired.statusCode, 200, paired.body);
  assert.deepEqual([paired.json().assigned, paired.json().already_assigned, ids(paired)], [[feedPhoto], [], [projectPhoto, feedPhoto]]);
  const repeated = await assign();
  assert.deepEqual([repeated.statusCode, repeated.json().assigned, repeated.json().already_assigned, ids(repeated)], [200, [], [feedPhoto], [projectPhoto, feedPhoto]], "safe to repeat");
  // The paired photo's entry carries the time it was taken.
  const entry = (repeated.json().photos as any[]).find((photo) => photo.id === feedPhoto);
  assert.equal(entry.metadata.taken_at, TAKEN);
  assert.deepEqual(((await me.raw("GET", `/v1/platform/organizations/${orgId}/media?unassigned=true`)).json().media as any[]), []);
});
