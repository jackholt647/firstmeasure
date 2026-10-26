// Photos with no project (the Feed camera) and pairing them with a project later: the upload route's checks, who
// sees an unpaired photo, the pairing writer and its published action, and the Feed post that survives pairing.
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
type Json = Record<string, any>;
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, payload, headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {}) } });
    const setCookie = response.headers["set-cookie"];
    const session = readCookie(setCookie, "fm_platform_session"), csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (session || csrfCookie) {
      cookie = [session || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    return response;
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-media-assignment-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.CALLS_STORAGE_ROOT = path.join(storageRoot, "calls");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeChannelsDatabase } = await import("../channels/storage.js");
  const { closeCallsDatabase } = await import("../calls/storage.js");
  await closeChannelsDatabase();
  await closeCallsDatabase();
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error: any) { if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error; }
  }
});

async function registerOwner() {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(), email: `media-owner-${suffix}@example.test`, password: "correct horse battery staple",
    name: "Media Owner", company: "Media Test Org", organization_id: `org_media_${suffix}`
  });
  const orgId = String(registered.organization.id), userId = String(registered.user.id);
  await enableExpandedPlatformFixture(orgId, { "platform.project_photos": true, "platform.photos_feed": true });
  const storage = await import("../platform/storage.js");
  const user = await storage.readDocument(orgId, "users", userId);
  const setPermissions = (overrides: Json) => storage.upsertDocument(orgId, "users", { id: userId, data: { ...user.data, permission_overrides: overrides } });
  return { client, orgId, userId, setPermissions, media: `/v1/platform/organizations/${orgId}/media`, feed: `/v1/channels/organizations/${orgId}/feed` };
}

const upload = (body: Json) => ({ base64: PNG, file_name: "site.png", content_type: "image/png", ...body });

test("the upload route takes the uploader from the session and checks the project it names", async () => {
  const { client, orgId, userId, media, setPermissions } = await registerOwner();
  const { upsertDocument, readMediaMetadata } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", { id: "upload_project", data: { title: "Upload project", branch_id: "default" } });

  const unpaired = (await client.request("POST", media, upload({ owner_type: "organization", owner_id: "someone_else", slot: "photos", metadata: { uploaded_by_user_id: "forged_user", project_id: "upload_project", branch_id: "forged_branch" } }))).media;
  assert.equal(unpaired.owner.type, "organization");
  assert.equal(unpaired.owner.id, orgId, "an organization owner is always the caller's organization");
  assert.equal(unpaired.owner.slot, "photos");
  assert.equal(unpaired.metadata.uploaded_by_user_id, userId, "the uploader comes from the session");
  assert.equal(unpaired.metadata.project_id, undefined, "an unpaired photo names no project");
  assert.equal(unpaired.metadata.branch_id, "default", "the branch comes from the session");

  const projectPhoto = (await client.request("POST", media, upload({ owner_type: "project", owner_id: "upload_project", slot: "photos", metadata: { uploaded_by_user_id: "forged_user" } }))).media;
  assert.equal(projectPhoto.metadata.uploaded_by_user_id, userId);
  assert.equal(projectPhoto.metadata.project_id, "upload_project");

  assert.equal((await client.raw("POST", media, upload({ owner_type: "project", owner_id: "no_such_project", slot: "photos" }))).statusCode, 404);
  assert.equal((await client.raw("POST", media, upload({ owner_type: "document", owner_id: "doc_1", metadata: { project_id: "no_such_project" } }))).statusCode, 404, "a project named in metadata is checked too");
  await upsertDocument(orgId, "projects", { id: "trashed_project", data: { title: "Gone", deleted_at: "2026-10-01T00:00:00Z" } });
  assert.equal((await client.raw("POST", media, upload({ owner_type: "project", owner_id: "trashed_project", slot: "photos" }))).statusCode, 404);

  const taken = await client.raw("POST", media, upload({ id: projectPhoto.id, owner_type: "organization", slot: "photos" }));
  assert.equal(taken.statusCode, 409, "an upload cannot take over another owner's media id");
  assert.equal((await readMediaMetadata(orgId, projectPhoto.id) as Json).owner.type, "project");

  await setPermissions({ view_projects: false, manage_projects: false });
  assert.equal((await client.raw("POST", media, upload({ owner_type: "project", owner_id: "upload_project", slot: "photos" }))).statusCode, 404, "a project the caller cannot see answers as missing");
});

test("unpaired photos are seen by their uploader and by view_media; the Feed lists them as Unassigned", async () => {
  const { client, orgId, userId, media, feed, setPermissions } = await registerOwner();
  const { storeMediaUpload } = await import("../platform/storage.js");
  const mine = (await client.request("POST", media, upload({ owner_type: "organization", slot: "photos", metadata: { uploaded_at: "2026-10-20T10:00:00Z" } }))).media;
  const theirs = await storeMediaUpload(orgId, { ownerType: "organization", ownerId: orgId, slot: "photos", fileName: "theirs.png", contentType: "image/png", bytes: Buffer.from(PNG, "base64"), metadata: { uploaded_by_user_id: "other_user", branch_id: "default" } }) as Json;

  const listed = await client.request("GET", `${media}?unassigned=true`);
  assert.deepEqual(listed.media.map((m: Json) => m.id).sort(), [mine.id, theirs.id].sort());
  const catalog = await client.request("GET", `${feed}/catalog`);
  assert.deepEqual(catalog.unassigned_media.map((m: Json) => m.id).sort(), [mine.id, theirs.id].sort());
  assert.equal(catalog.unassigned_media[0].project_id, "");
  assert.equal(catalog.can_assign_media, true);
  assert.equal(catalog.media.some((m: Json) => m.id === mine.id), false, "unpaired photos are not grouped under a project");

  await setPermissions({ view_media: false });
  assert.deepEqual((await client.request("GET", `${media}?unassigned=1`)).media.map((m: Json) => m.id), [mine.id], "without view_media only your own");
  assert.equal((await client.raw("GET", `${media}/${theirs.id}`)).statusCode, 403);
  assert.equal((await client.raw("PATCH", `${media}/${theirs.id}`, { name: "Renamed" })).statusCode, 403);
  assert.equal((await client.raw("GET", `${media}/${theirs.id}/file`)).statusCode, 403);
  assert.deepEqual((await client.request("GET", `${feed}/catalog`)).unassigned_media.map((m: Json) => m.id), [mine.id]);
  assert.equal((await client.request("GET", `${media}/${mine.id}`)).media.id, mine.id);
  assert.equal(userId.length > 0, true);
});

test("pairing moves the photo into the project, keeps its Feed thread and relinks the post", async () => {
  const { client, orgId, userId, media, feed } = await registerOwner();
  const { upsertDocument, readDocument, readMediaMetadata } = await import("../platform/storage.js");
  const { readMessageRecord } = await import("../channels/storage.js");
  const { listEventRecords } = await import("../work/storage.js");
  await upsertDocument(orgId, "projects", { id: "pair_project", data: { title: "Pair project", branch_id: "default", photos: [{ id: "video_1", media_id: "video_1", media_type: "video" }] } });
  const photo = (await client.request("POST", media, upload({ owner_type: "organization", slot: "photos", metadata: { upload_batch_id: "batch_1" } }))).media;

  // The caller's project_id is ignored for an unpaired photo: it is never rebound to a project they pick.
  const post = await client.request("POST", `${feed}/posts/resolve`, { refs: [{ kind: "media", id: photo.id, project_id: "pair_project" }] });
  const root = await readMessageRecord(orgId, post.root.id);
  assert.equal((root!.metadata.feed_source as Json[])[0]!.project_id, "");
  assert.equal(root!.metadata.feed_key, `media:${userId}:batch_1`);
  await client.request("POST", `${feed}/posts/${post.root.id}/comments`, { text: "Which job is this?" });
  await client.request("POST", `${feed}/messages/${post.root.id}/reactions`, { emoji: "👍", on: true });

  const paired = await client.request("POST", `${media}/assign`, { project_id: "pair_project", media_ids: [photo.id] });
  assert.deepEqual(paired.assigned, [photo.id]);
  assert.equal(paired.project_id, "pair_project");
  const stored = await readMediaMetadata(orgId, photo.id) as Json;
  assert.deepEqual([stored.owner.type, stored.owner.id, stored.metadata.project_id, stored.metadata.paired_from], ["project", "pair_project", "pair_project", "organization"]);
  const project = (await readDocument(orgId, "projects", "pair_project")).data as Json;
  const entry = project.photos.find((p: Json) => p.media_id === photo.id);
  assert.ok(entry, "the photo is in the project's photos");
  assert.equal(entry.owner.id, "pair_project");
  assert.equal(project.thumbnail_photo_id, photo.id, "the first photo that is not a video becomes the thumbnail, as savePhotos does");
  assert.equal(entry.is_thumbnail, true);

  const relinked = await readMessageRecord(orgId, post.root.id);
  assert.equal((relinked!.metadata.feed_source as Json[])[0]!.project_id, "pair_project", "the post now names the project");
  const thread = await client.request("POST", `${feed}/posts/lookup`, { refs: [{ kind: "media", id: photo.id, project_id: "pair_project" }] });
  assert.equal(thread.root.id, post.root.id, "the paired photo keeps its post");
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.root.reactions[0].count, 1);
  const catalog = await client.request("GET", `${feed}/catalog`);
  assert.equal(catalog.unassigned_media.length, 0);
  assert.ok(catalog.media.some((m: Json) => m.id === photo.id));

  const events = await listEventRecords(orgId, { limit: 100 } as any);
  assert.ok(events.some((event: Json) => event.type === "media.assigned" && event.project_id === "pair_project" && event.payload?.media_id === photo.id));

  const again = await client.request("POST", `${media}/assign`, { project_id: "pair_project", media_ids: [photo.id] });
  assert.deepEqual([again.assigned, again.already_assigned], [[], [photo.id]], "a retry changes nothing");
  assert.equal(((await readDocument(orgId, "projects", "pair_project")).data as Json).photos.filter((p: Json) => p.media_id === photo.id).length, 1);

  await upsertDocument(orgId, "projects", { id: "other_project", data: { title: "Other", branch_id: "default" } });
  assert.equal((await client.raw("POST", `${media}/assign`, { project_id: "other_project", media_ids: [photo.id] })).statusCode, 409, "a paired photo is not moved to another project");

  const back = await client.request("POST", `${media}/unassign`, { project_id: "pair_project", media_ids: [photo.id] });
  assert.deepEqual(back.unassigned, [photo.id]);
  const returned = await readMediaMetadata(orgId, photo.id) as Json;
  assert.deepEqual([returned.owner.type, returned.owner.slot, returned.metadata.project_id], ["organization", "photos", undefined]);
  assert.equal(((await readDocument(orgId, "projects", "pair_project")).data as Json).photos.some((p: Json) => p.media_id === photo.id), false);
  assert.equal(((await readMessageRecord(orgId, post.root.id))!.metadata.feed_source as Json[])[0]!.project_id, "");

  const uploaded = (await client.request("POST", media, upload({ owner_type: "project", owner_id: "pair_project", slot: "photos" }))).media;
  assert.equal((await client.raw("POST", `${media}/unassign`, { project_id: "pair_project", media_ids: [uploaded.id] })).statusCode, 409, "photos uploaded into the project stay there");
});

test("pairing needs manage_projects and a photo the caller can see", async () => {
  const { client, orgId, media, setPermissions } = await registerOwner();
  const { upsertDocument, storeMediaUpload, readMediaMetadata } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", { id: "guarded_project", data: { title: "Guarded", branch_id: "default" } });
  const photo = (await client.request("POST", media, upload({ owner_type: "organization", slot: "photos" }))).media;
  const hidden = await storeMediaUpload(orgId, { ownerType: "organization", ownerId: orgId, slot: "photos", fileName: "h.png", contentType: "image/png", bytes: Buffer.from(PNG, "base64"), metadata: { uploaded_by_user_id: "other_user" } }) as Json;
  const contact = await storeMediaUpload(orgId, { ownerType: "contact", ownerId: "contact_x", slot: "photos", fileName: "c.png", contentType: "image/png", bytes: Buffer.from(PNG, "base64") }) as Json;

  assert.equal((await client.raw("POST", `${media}/assign`, { project_id: "guarded_project", media_ids: [contact.id] })).statusCode, 404, "only unpaired photos can be paired");
  assert.equal((await client.raw("POST", `${media}/assign`, { project_id: "missing_project", media_ids: [photo.id] })).statusCode, 404);
  await setPermissions({ manage_projects: false });
  assert.equal((await client.raw("POST", `${media}/assign`, { project_id: "guarded_project", media_ids: [photo.id] })).statusCode, 403);
  await setPermissions({ view_media: false });
  const refused = await client.raw("POST", `${media}/assign`, { project_id: "guarded_project", media_ids: [photo.id, hidden.id] });
  assert.equal(refused.statusCode, 404, "a photo the caller cannot see is refused");
  assert.equal((await readMediaMetadata(orgId, photo.id) as Json).owner.type, "organization", "nothing changes when one photo is refused");
});

test("media.item.assign is published under manage_projects for the target project", async () => {
  const { client, orgId, media } = await registerOwner();
  const { upsertDocument, readDocument } = await import("../platform/storage.js");
  const { publishedActionPermission } = await import("../platform/publication/permission-bundles.js");
  assert.equal(publishedActionPermission("media.item.assign"), "manage_projects");
  assert.equal(publishedActionPermission("media.item.unassign"), "manage_projects");
  await upsertDocument(orgId, "projects", { id: "action_project", data: { title: "Action project", branch_id: "default" } });
  const photo = (await client.request("POST", media, upload({ owner_type: "organization", slot: "photos" }))).media;
  const result = await client.request("POST", `/v1/publication/organizations/${orgId}/actions/invoke`, {
    action: "media.item.assign", target: { scope: "project", organizationId: orgId, projectId: "action_project", id: photo.id }, input: {}, idempotencyKey: `assign-${photo.id}`
  });
  assert.deepEqual(result.value.assigned, [photo.id]);
  assert.ok(((await readDocument(orgId, "projects", "action_project")).data as Json).photos.some((p: Json) => p.media_id === photo.id));
});

test("posts made before the project-free key keep their thread", async () => {
  const { client, orgId, userId, media, feed } = await registerOwner();
  const { upsertDocument } = await import("../platform/storage.js");
  const { createChannelRecord, createMessageRecord, findChannelByDmKey } = await import("../channels/storage.js");
  await upsertDocument(orgId, "projects", { id: "legacy_project", data: { title: "Legacy", branch_id: "default" } });
  const photo = (await client.request("POST", media, upload({ owner_type: "project", owner_id: "legacy_project", slot: "photos", metadata: { upload_batch_id: "old_batch" } }))).media;
  const channel = await findChannelByDmKey(orgId, "company-feed") || await createChannelRecord({ organization_id: orgId, type: "feed", name: "Company feed", created_by: "system", dm_key: "company-feed", settings: { feed: true } });
  const legacyKey = `media:legacy_project:${userId}:old_batch`;
  const legacy = await createMessageRecord({ organization_id: orgId, channel_id: channel.id, author_id: userId, client_msg_id: createHash("sha256").update(legacyKey).digest("hex"), text: "", metadata: { feed_post: true, feed_source: [{ kind: "media", id: photo.id, project_id: "legacy_project" }], feed_key: legacyKey } });
  const refs = [{ kind: "media", id: photo.id, project_id: "legacy_project" }];
  assert.equal((await client.request("POST", `${feed}/posts/lookup`, { refs })).root.id, legacy.id);
  assert.equal((await client.request("POST", `${feed}/posts/resolve`, { refs })).root.id, legacy.id, "no second post is made");
});

test("the derived thumbnail follows the browser's order", async () => {
  const { withDerivedThumbnail } = await import("../projects/media-assignment.js");
  const photo = (id: string, extra: Json = {}) => ({ id, media_id: id, media_type: "image", ...extra });
  const covered = withDerivedThumbnail({ custom_field_values: { cover_photo: { media_id: "b" } } }, [photo("a"), photo("b")]);
  assert.equal(covered.thumbnail_photo_id, "b", "a chosen cover wins");
  const satellite = withDerivedThumbnail({}, [photo("a"), photo("sat", { source: "satellite_top_down" })]);
  assert.equal(satellite.thumbnail_photo_id, "sat");
  const generated = withDerivedThumbnail({ thumbnail_photo_id: "top_down_thumbnail", thumbnail_photo: { id: "top_down_thumbnail" } }, [photo("a")]);
  assert.equal(generated.thumbnail_photo_id, "top_down_thumbnail", "the browser's generated satellite image stays the thumbnail");
  assert.equal((generated.photos as Json[])[0]!.is_thumbnail, false);
  const first = withDerivedThumbnail({}, [photo("v", { media_type: "video" }), photo("a")]);
  assert.equal(first.thumbnail_photo_id, "a", "videos are skipped");
});
