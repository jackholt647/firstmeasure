/**
 * The offline server pieces through the real app (docs/architecture/offline.md#server):
 * how media files may be kept, a lead whose project id was made on the device,
 * and the receipts hook in front of a real route.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import test, { after, before } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture, nextTestPhone } from "./helpers/platform-fixture.js";
import { mediaFileCaching } from "../platform/media_variants.js";

let app: any = null;
let storageRoot = "";

const KEEP = "private, max-age=31536000, immutable";
const ASK = "private, no-cache";

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-offline-routes-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error",
    PUBLIC_BASE_URL: "https://app.example.test", CORS_ALLOWED_ORIGINS: "https://app.example.test",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    FIRSTMEASURE_INTERNAL_API_SECRET: "offline-routes-fixture-secret"
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
  const registered = await raw("POST", "/v1/platform/auth/register", { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner", company: "Offline Test Org", organization_id: `org_offline_${suffix}` });
  assert.equal(registered.statusCode < 400, true, registered.body);
  const orgId = String(registered.json().organization.id), userId = String(registered.json().user.id);
  await enableExpandedPlatformFixture(orgId);
  return { orgId, userId, raw };
}

async function picture(width: number, height: number, color: { r: number; g: number; b: number }) {
  const sharp = (await import("sharp")).default;
  return (await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()).toString("base64");
}

test("how each kind of media answer may be kept", () => {
  const record = (extra: Record<string, unknown> = {}) => ({
    id: "media_0123456789abcdef", owner: { type: "project", id: "p1", slot: "photos" }, created_at: "2026-11-10T10:00:00.000Z", updated_at: "2026-11-10T10:00:00.000Z", size_bytes: 500, content_type: "image/jpeg",
    variants: { original: { path: "original/original.jpg", size_bytes: 500 }, thumb_320: { path: "renditions/thumb_320.webp", size_bytes: 40 }, display_2400: { path: "renditions/display_2400.webp", size_bytes: 300 } },
    ...extra
  });
  const kept = (media: unknown, variant: string, v = "") => mediaFileCaching(media, variant, v)?.cacheControl;
  const tag = (media: unknown, variant: string, v = "") => mediaFileCaching(media, variant, v)?.etag;

  // A rendition is made once, at upload: kept for a year.
  assert.deepEqual([kept(record(), "thumb_320"), kept(record(), "display_2400"), kept(record(), "thumb_640"), kept(record(), "display")], [KEEP, KEEP, KEEP, KEEP]);
  // The original can be replaced by another upload under the same id: asked about every time.
  assert.deepEqual([kept(record(), "original"), kept(record(), "")], [ASK, ASK]);
  // No such variant (a document has no thumbnail): nothing to say.
  assert.equal(mediaFileCaching(record({ content_type: "application/pdf", variants: { original: { path: "original/original.pdf", content_type: "application/pdf" } } }), "thumb_320"), null);
  assert.equal(mediaFileCaching(record(), "poster"), null);

  // A slot record's id is the slot; the next upload replaces it.
  const avatar = record({ id: "user_u-1_avatar", owner: { type: "user", id: "U 1", slot: "avatar" } });
  assert.deepEqual([kept(avatar, "thumb_320"), kept(avatar, "original")], [ASK, ASK]);

  // A markup thumbnail is rendered again on every save: kept only when the URL names the revision it shows.
  const marked = (revision: number) => record({ variants: { ...record().variants, thumb_320_markup: { path: "renditions/thumb_320_markup.webp", size_bytes: 55, markup_revision: revision, updated_at: `2026-11-10T11:0${revision}:00.000Z` } } });
  assert.deepEqual([kept(marked(3), "thumb_320_markup", "3"), kept(marked(3), "thumb_320_markup"), kept(marked(3), "thumb_320_markup", "2"), kept(marked(3), "thumb_320_markup", "1762772400000")], [KEEP, ASK, ASK, ASK]);
  assert.notEqual(tag(marked(3), "thumb_320_markup", "3"), tag(marked(4), "thumb_320_markup", "3"), "a new markup is a new tag");
  // No markup rendition yet (the plain thumbnail is served in its place): one may appear under the same URL.
  assert.equal(kept(record(), "thumb_320_markup", "1"), ASK);

  // The tag follows the bytes: a new upload under the id changes it, a rename or a tag does not.
  assert.equal(tag(record(), "thumb_320"), tag(record({ updated_at: "2026-11-12T00:00:00.000Z", file_name: "renamed.jpg", tags: ["roof"] }), "thumb_320"));
  assert.notEqual(tag(record(), "thumb_320"), tag(record({ created_at: "2026-11-12T00:00:00.000Z" }), "thumb_320"));
  assert.notEqual(tag(record(), "thumb_320"), tag(record(), "original"));
  assert.match(String(tag(record(), "thumb_320")), /^"[A-Za-z0-9_-]{22}"$/);
});

test("the media file route says how long a file may be kept, and only to someone who may read it", async () => {
  const mine = await owner();
  const theirs = await owner();
  const { orgId } = mine;
  const storage = await import("../platform/storage.js");
  await storage.upsertDocument(orgId, "projects", { id: "project_offline_media", data: { title: "Media project" } });
  const upload = async (extra: Record<string, unknown>, base64: string) => {
    const response = await mine.raw("POST", `/v1/platform/organizations/${orgId}/media`, { owner_type: "project", owner_id: "project_offline_media", slot: "photos", collection: "projects", scope: "projects", file_name: "roof.png", content_type: "image/png", base64, ...extra });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().media;
  };
  const media = await upload({}, await picture(1400, 1000, { r: 200, g: 40, b: 40 }));
  assert.ok(media.variants.thumb_320, "a large photo gets thumbnails");
  const file = (variant = "", headers: Record<string, string> = {}, who = mine, id = media.id) => who.raw("GET", `/v1/platform/organizations/${orgId}/media/${id}/file${variant ? `?variant=${variant}` : ""}`, undefined, headers);

  // A rendition: kept for a year, and a conditional request is answered without the file.
  const thumb = await file("thumb_320");
  assert.deepEqual([thumb.statusCode, thumb.headers["cache-control"]], [200, KEEP]);
  const thumbTag = String(thumb.headers.etag);
  assert.match(thumbTag, /^"[A-Za-z0-9_-]{22}"$/);
  const unchanged = await file("thumb_320", { "if-none-match": thumbTag });
  assert.deepEqual([unchanged.statusCode, unchanged.body, unchanged.headers.etag, unchanged.headers["cache-control"]], [304, "", thumbTag, KEEP]);
  const part = await file("thumb_320", { range: "bytes=0-9" });
  assert.deepEqual([part.statusCode, part.rawPayload.length, part.headers["cache-control"]], [206, 10, KEEP]);

  // The original: always asked about.
  for (const variant of ["", "original"]) {
    const original = await file(variant);
    assert.deepEqual([original.statusCode, original.headers["cache-control"]], [200, ASK]);
    assert.equal((await file(variant, { "if-none-match": String(original.headers.etag) })).statusCode, 304);
    assert.notEqual(original.headers.etag, thumbTag);
  }

  // Who may read the file has not changed, with or without a matching tag.
  const signedOut = await app.inject({ method: "GET", url: `/v1/platform/organizations/${orgId}/media/${media.id}/file?variant=thumb_320`, headers: { "if-none-match": thumbTag } });
  assert.equal(signedOut.statusCode, 401);
  const otherOrganization = await file("thumb_320", { "if-none-match": thumbTag }, theirs);
  assert.ok([401, 403, 404].includes(otherOrganization.statusCode), `another organization got ${otherOrganization.statusCode}`);
  for (const refused of [signedOut, otherOrganization]) assert.notEqual(refused.headers["cache-control"], KEEP);

  // An answer that is not the file is never kept.
  const missing = await file("poster");
  assert.deepEqual([missing.statusCode, missing.headers["cache-control"], missing.headers.etag], [404, undefined, undefined]);

  // Renaming and tagging do not change the bytes, so the browser's copy stays good.
  await mine.raw("PATCH", `/v1/platform/organizations/${orgId}/media/${media.id}`, { name: "North slope", tags: ["roof"] });
  assert.equal((await file("thumb_320", { "if-none-match": thumbTag })).statusCode, 304);

  // Markup: the thumbnail is rendered again on each save, and only a URL naming that revision is kept.
  const mark = async (x: number) => (await mine.raw("PUT", `/v1/platform/organizations/${orgId}/media/${media.id}/markup/photo_markup`, { data: { schema: 1, items: [{ id: "s1", type: "stroke", color: "#d93025", size: 2.2, points: [{ x: 0.1, y: 0.2 }, { x, y: 0.7 }] }] } })).json();
  const firstMarkup = await mark(0.8);
  const revision = String(firstMarkup.media.markup_thumbnail.revision);
  const named = await file(`thumb_320_markup&v=${revision}`);
  assert.deepEqual([named.statusCode, named.headers["cache-control"]], [200, KEEP]);
  assert.equal((await file("thumb_320_markup")).headers["cache-control"], ASK, "no revision in the URL");
  assert.equal((await file(`thumb_320_markup&v=${Date.now()}`)).headers["cache-control"], ASK, "a cache-buster is not a revision");
  const secondMarkup = await mark(0.3);
  const nextRevision = String(secondMarkup.media.markup_thumbnail.revision);
  assert.notEqual(nextRevision, revision);
  const stale = await file(`thumb_320_markup&v=${revision}`, { "if-none-match": String(named.headers.etag) });
  assert.deepEqual([stale.statusCode, stale.headers["cache-control"]], [200, ASK], "the old revision's URL now gets the new picture and may not keep it");
  assert.notEqual(stale.headers.etag, named.headers.etag);
  assert.equal((await file(`thumb_320_markup&v=${nextRevision}`)).headers["cache-control"], KEEP);
  assert.equal((await file("thumb_320", { "if-none-match": thumbTag })).statusCode, 304, "the plain thumbnail is untouched by markup");

  // Another picture uploaded under the same id: whoever asks about the original hears of it.
  const originalTag = String((await file("original")).headers.etag);
  await upload({ id: media.id }, await picture(1500, 900, { r: 20, g: 40, b: 220 }));
  const replaced = await file("original", { "if-none-match": originalTag });
  assert.equal(replaced.statusCode, 200);
  assert.notEqual(replaced.headers.etag, originalTag);

  // A slot upload keeps its id from one file to the next, so nothing of it is kept without asking.
  const slot = await upload({ owner_type: "organization", owner_id: orgId, slot: "team_photo", replace_slot: true, collection: "", scope: "" }, await picture(1400, 1000, { r: 10, g: 160, b: 90 }));
  assert.equal((await file("thumb_320", {}, mine, slot.id)).headers["cache-control"], ASK);

  // Receipts are never kept, as before.
  const receipt: any = await storage.storeMediaUpload(orgId, { ownerType: "project", ownerId: "project_offline_media", slot: "receipts", fileName: "receipt.png", contentType: "image/png", bytes: Buffer.from(await picture(40, 40, { r: 1, g: 1, b: 1 }), "base64"), metadata: { project_id: "project_offline_media", document_type: "receipt", uploaded_by_user_id: mine.userId } });
  const receiptFile = await file("", {}, mine, receipt.id);
  assert.deepEqual([receiptFile.statusCode, receiptFile.headers["cache-control"], receiptFile.headers.etag], [200, "private, no-store", undefined]);
});

test("a lead made on a device keeps the project id the device gave it, and a repeat is one lead", async () => {
  const mine = await owner();
  const { orgId, userId } = mine;
  const storage = await import("../platform/storage.js");
  const contacts = await import("../contacts/records.js");
  const { listEventRecords } = await import("../work/storage.js");
  const leads = `/v1/platform/organizations/${orgId}/leads`;
  const offline = (key: string) => ({ "idempotency-key": key, "x-fm-offline-user": userId, "x-fm-offline-org": orgId, "x-fm-offline-replay": "1" });
  const projectId = `project_dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const key = `fmo1-${randomUUID()}`;
  // A name and nothing else: nothing a second run could match the contact by.
  const body = { project_id: projectId, address: "12 Offline Way", summary: "Hail damage, wants an inspection", contacts: [{ name: "Nadia Offline" }] };

  const first = await mine.raw("POST", leads, body, { ...offline(key), "accept-encoding": "gzip" });
  assert.equal(first.statusCode, 201, first.body);
  // Sent compressed; what is kept for a repeat is the JSON itself.
  assert.equal(first.headers["content-encoding"], "gzip", "the first answer went out compressed");
  const firstJson = JSON.parse(gunzipSync(first.rawPayload).toString("utf8"));
  assert.equal(firstJson.project.id, projectId);
  assert.equal(firstJson.contacts.length, 1);

  // The answer was lost on the way; the device sends the change again.
  const repeat = await mine.raw("POST", leads, body, offline(key));
  assert.deepEqual([repeat.statusCode, repeat.headers["idempotency-replayed"]], [201, "true"]);
  assert.deepEqual(repeat.json(), firstJson);
  const people = async () => (await contacts.listAllContacts(orgId)).filter((contact: any) => contact.name === "Nadia Offline").length;
  assert.equal(await people(), 1, "one contact");
  assert.equal((await storage.readDocument(orgId, "projects", projectId)).id, projectId);
  assert.equal((await listEventRecords(orgId, { project_id: projectId, type: "lead.received" })).length, 1, "the lead arrived once");
  assert.equal((await listEventRecords(orgId, { project_id: projectId, type: "project.created" })).length, 1);

  // Without its receipt (a new key, or none), the same id is refused before anything is written again.
  for (const headers of [offline(`fmo1-${randomUUID()}`), {}]) {
    const again = await mine.raw("POST", leads, body, headers);
    assert.deepEqual([again.statusCode, again.json().error], [409, "project_exists"]);
  }
  assert.equal(await people(), 1, "and no second contact");

  // The id is used exactly as sent, so it must already be a clean one.
  for (const bad of ["short", "Project_UPPER_0001", "has spaces in it", "../projects/escape", "x".repeat(81), "-starts-with-a-hyphen"]) {
    const refused = await mine.raw("POST", leads, { ...body, project_id: bad }, offline(`fmo1-${randomUUID()}`));
    assert.deepEqual([refused.statusCode, refused.json().error], [400, "invalid_project_id"], bad);
  }
  assert.equal(await people(), 1);

  // A lead without one still gets an id from the server.
  const online = await mine.raw("POST", leads, { address: "14 Online Way", contacts: [{ name: "Omar Online", phone: "555-020-7711" }] });
  assert.equal(online.statusCode, 201, online.body);
  assert.match(online.json().project.id, /^project_[0-9a-f]{16}$/);

  // Queued by this owner, sent under someone else's session: refused, and nothing is created.
  const other = await owner();
  const otherId = `project_dev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const wrongSession = await other.raw("POST", `/v1/platform/organizations/${other.orgId}/leads`, { ...body, project_id: otherId }, offline(`fmo1-${randomUUID()}`));
  assert.deepEqual([wrongSession.statusCode, wrongSession.json().error], [409, "offline_identity_mismatch"]);
  await assert.rejects(() => storage.readDocument(other.orgId, "projects", otherId));
});

test("the manifest route is open to anyone, and the offline headers are allowed across our own origin", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/v1/platform/offline/assets" });
  assert.equal(anonymous.statusCode, 200);
  assert.equal(typeof anonymous.json().enabled, "boolean");
  assert.ok(Object.keys(anonymous.json().files).length > 300);

  // The portal calls the API on its own origin, where no preflight happens. From our other allowed origin the
  // offline headers pass too (the CORS delegator answers a preflight with the headers that were asked for).
  const preflight = await app.inject({ method: "OPTIONS", url: "/v1/platform/organizations/org_x/leads", headers: { origin: "https://app.example.test", "access-control-request-method": "POST", "access-control-request-headers": "idempotency-key,x-fm-offline-user,x-fm-offline-org,x-fm-offline-replay" } });
  const allowed = String(preflight.headers["access-control-allow-headers"]).toLowerCase();
  for (const name of ["idempotency-key", "x-fm-offline-user", "x-fm-offline-org", "x-fm-offline-replay"]) assert.ok(allowed.includes(name), `${name} is allowed`);
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
});
