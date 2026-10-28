import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The project's top-down satellite image is saved once as an ordinary library photo
// (projects/satellite-media.ts): it appears in the project's photos, it is the cover when
// no cover is chosen, a repeat saves nothing, and nothing creates a project.

let root = "";
let storage: typeof import("../platform/storage.js");
let satellite: typeof import("../projects/satellite-media.js");
const org = "satellite_media_test";

async function png(width = 1200, height = 800, color = { r: 40, g: 120, b: 60 }) {
  const sharp = (await import("sharp")).default;
  return await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

const neverGoogle = async () => { throw new Error("the static map must not be fetched"); };

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "project-satellite-media-"));
  process.env.PLATFORM_STORAGE_ROOT = root;
  if (process.env.TEST_POSTGRES_URL) Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: process.env.TEST_POSTGRES_URL, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local" });
  storage = await import("../platform/storage.js");
  satellite = await import("../projects/satellite-media.js");
  await storage.createOrganization({ id: org, name: "Satellite media test" });
});

after(async () => {
  try { const { closeSqlStoresForTests } = await import("../platform/sql_store.js"); await closeSqlStoresForTests(); } catch {}
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

const photosOf = async (projectId: string) => ((await storage.readDocument(org, "projects", projectId)).data.photos as any[]) || [];
const coverOf = async (projectId: string) => ((await storage.readDocument(org, "projects", projectId)).data.custom_field_values as any)?.cover_photo?.media_id || "";
const projectMedia = async (projectId: string): Promise<any[]> => (await storage.listMedia(org)).filter((item: any) => item.owner?.type === "project" && item.owner?.id === projectId);

test("a completed report's top-down image is saved once as a library photo and becomes the cover", async () => {
  const bytes = await png();
  let reads = 0;
  const deps = { firstMeasureImage: async (orgId: string, reportId: string) => { reads += 1; assert.equal(orgId, org); assert.equal(reportId, "report_1"); return { bytes, artifact: "google.png" }; }, googleStaticMap: neverGoogle };
  await storage.upsertDocument(org, "projects", { id: "p_report", data: { title: "Report project", measurement_project: { id: "report_1", status: "completed" }, photos: [
    // The generated stand-in a client may have saved before; the saved photo replaces it.
    { id: "top_down_thumbnail", kind: "external_image", designator: "top_down_thumbnail", src: "https://example.test/thumb" }
  ] } });

  const first = await satellite.ensureProjectSatelliteMedia(org, "p_report", deps);
  assert.equal(first.status, "saved");
  assert.equal(first.source, "firstmeasure");
  assert.equal(first.cover_set, true);
  const mediaId = first.media_id!;
  assert.equal(mediaId, satellite.satelliteMediaId(org, "p_report", "firstmeasure"));

  const photos = await photosOf("p_report");
  assert.deepEqual(photos.map((photo) => photo.media_id || photo.id), [mediaId], "the photos list has the saved photo and no stand-in");
  const photo = photos[0];
  assert.equal(photo.kind, "media_reference");
  assert.equal(photo.label, "Top-down satellite");
  assert.equal(photo.metadata.source, "satellite_top_down");
  assert.equal(photo.metadata.satellite_source, "firstmeasure");
  assert.equal(photo.content_type, "image/jpeg");
  assert.equal(photo.designator, undefined, "an ordinary photo, not the generated thumbnail");
  assert.equal(await coverOf("p_report"), mediaId);

  const media = await projectMedia("p_report");
  assert.equal(media.length, 1);
  assert.equal(media[0].id, mediaId);
  assert.equal(media[0].kind, "image");
  assert.ok(media[0].variants.thumb_320, "the tile's 320px rendition exists");
  assert.equal(media[0].metadata.source, "satellite_top_down");

  const before = await storage.readDocument(org, "projects", "p_report");
  const again = await satellite.ensureProjectSatelliteMedia(org, "p_report", deps);
  assert.equal(again.status, "existing");
  assert.equal(reads, 1, "a saved image is not read again");
  const afterRepeat = await storage.readDocument(org, "projects", "p_report");
  assert.equal(afterRepeat.revision, before.revision, "a repeat writes nothing");
  assert.equal((await photosOf("p_report")).length, 1);
  assert.equal((await projectMedia("p_report")).length, 1);
});

test("a cover someone chose stays; the satellite photo is added beside it", async () => {
  await storage.upsertDocument(org, "projects", { id: "p_chosen", data: { title: "Chosen", measurement_project: { id: "report_2" } } });
  const upload = await storage.storeMediaUpload(org, { ownerType: "project", ownerId: "p_chosen", slot: "photos", collection: "projects", fileName: "front.png", contentType: "image/png", bytes: await png(400, 300, { r: 200, g: 10, b: 10 }) });
  await storage.upsertDocument(org, "projects", { id: "p_chosen", data: { title: "Chosen", measurement_project: { id: "report_2" }, photos: [{ id: upload.id, media_id: upload.id, kind: "media_reference" }], custom_field_values: { cover_photo: { media_id: upload.id } } } });
  const result = await satellite.ensureProjectSatelliteMedia(org, "p_chosen", { firstMeasureImage: async () => ({ bytes: await png(), artifact: "azure.png" }), googleStaticMap: neverGoogle });
  assert.equal(result.status, "saved");
  assert.equal(result.cover_set, false);
  assert.equal(await coverOf("p_chosen"), upload.id);
  assert.deepEqual((await photosOf("p_chosen")).map((photo) => photo.media_id), [upload.id, result.media_id]);
});

test("without a report the static map is saved once the project has coordinates, and the report's image takes over its cover", async () => {
  let fetched = 0;
  const google = async (point: { lat: number; lng: number }) => { fetched += 1; assert.deepEqual(point, { lat: 39.74, lng: -104.99 }); return await png(1280, 800, { r: 90, g: 90, b: 90 }); };
  await storage.upsertDocument(org, "projects", { id: "p_map", data: { title: "No coordinates" } });
  const none = await satellite.ensureProjectSatelliteMedia(org, "p_map", { googleStaticMap: google });
  assert.equal(none.status, "unavailable");
  assert.equal(fetched, 0, "no coordinates, no fetch");
  assert.equal((await photosOf("p_map")).length, 0);

  await storage.upsertDocument(org, "projects", { id: "p_map", data: { title: "Coordinates", lat: 39.74, lng: -104.99 } });
  const map = await satellite.ensureProjectSatelliteMedia(org, "p_map", { googleStaticMap: google });
  assert.equal(map.status, "saved");
  assert.equal(map.source, "google_static_map");
  assert.equal(await coverOf("p_map"), map.media_id);
  assert.equal((await satellite.ensureProjectSatelliteMedia(org, "p_map", { googleStaticMap: google })).status, "existing");
  assert.equal(fetched, 1, "the static map is fetched once");

  const data = (await storage.readDocument(org, "projects", "p_map")).data;
  await storage.upsertDocument(org, "projects", { id: "p_map", data: { ...data, measurement_project: { id: "report_3", status: "completed" } } });
  const report = await satellite.ensureProjectSatelliteMedia(org, "p_map", { firstMeasureImage: async () => ({ bytes: await png(), artifact: "google.png" }), googleStaticMap: google });
  assert.equal(report.status, "saved");
  assert.equal(report.source, "firstmeasure");
  assert.equal(report.cover_set, true, "the cover this writer chose gives way to the report's own image");
  assert.equal(await coverOf("p_map"), report.media_id);
  assert.equal((await photosOf("p_map")).filter((photo) => photo.metadata?.source === "satellite_top_down").length, 2);
  assert.equal(fetched, 1);
});

test("a satellite photo removed from the library is not put back", async () => {
  const deps = { firstMeasureImage: async () => ({ bytes: await png(), artifact: "google.png" }), googleStaticMap: neverGoogle };
  await storage.upsertDocument(org, "projects", { id: "p_removed", data: { title: "Removed", measurement_project: { id: "report_4" } } });
  assert.equal((await satellite.ensureProjectSatelliteMedia(org, "p_removed", deps)).status, "saved");
  const data = (await storage.readDocument(org, "projects", "p_removed")).data;
  await storage.upsertDocument(org, "projects", { id: "p_removed", data: { ...data, photos: [] } });
  assert.equal(await coverOf("p_removed"), "", "removing the cover photo clears the cover");
  const again = await satellite.ensureProjectSatelliteMedia(org, "p_removed", deps);
  assert.equal(again.status, "existing");
  assert.equal((await photosOf("p_removed")).length, 0);
});

test("asking for a project that does not exist creates nothing", async () => {
  let reads = 0;
  const result = await satellite.ensureProjectSatelliteMedia(org, "p_missing", { firstMeasureImage: async () => { reads += 1; return { bytes: await png(), artifact: "google.png" }; }, googleStaticMap: neverGoogle });
  assert.equal(result.status, "no_project");
  assert.equal(reads, 0);
  await assert.rejects(() => storage.readDocument(org, "projects", "p_missing"));
  assert.equal((await projectMedia("p_missing")).length, 0);
});

test("a report of another organization or one not yet completed gives no image", async () => {
  // The default reader checks the report's organization and status before reading any artifact.
  const source = await (await import("node:fs/promises")).readFile(new URL("../projects/satellite-media.ts", import.meta.url), "utf8");
  assert.match(source, /organization_ref\)\.id\) !== orgId \|\| clean\(manifest\.status\)\.toLowerCase\(\) !== "completed"/);
  await storage.upsertDocument(org, "projects", { id: "p_pending", data: { title: "Pending", measurement_project: { id: "report_missing" } } });
  const result = await satellite.ensureProjectSatelliteMedia(org, "p_pending", { googleStaticMap: neverGoogle });
  assert.equal(result.status, "unavailable");
});

test("while the report is still processing, the static map is fetched with the Maps Static key and becomes the cover (FM-292)", async () => {
  const { env } = await import("../src/config/env.js");
  const keys = env as unknown as Record<string, string>;
  const saved = { stat: keys.googleMapsStaticApiKey, server: keys.googleMapsApiKey };
  const realFetch = globalThis.fetch;
  const asked: URL[] = [];
  const image = await png(1280, 800, { r: 70, g: 80, b: 90 });
  keys.googleMapsStaticApiKey = "maps-static-key";
  keys.googleMapsApiKey = "server-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(new URL(String(input instanceof Request ? input.url : input)));
    return new Response(new Uint8Array(image), { status: 200, headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  try {
    assert.equal(satellite.staticMapApiKey(), "maps-static-key", "reports fetch google.png with this key; the server key may not allow Maps Static");
    // An ordered report that has not completed: its own image is not used yet, so the static map stands in.
    await storage.upsertDocument(org, "projects", { id: "p_processing", data: { title: "Processing", lat: 38.97, lng: -76.49, measurement_project: { id: "report_processing", status: "processing" } } });
    const result = await satellite.ensureProjectSatelliteMedia(org, "p_processing");
    assert.equal(result.status, "saved");
    assert.equal(result.source, "google_static_map");
    assert.equal(result.cover_set, true);
    assert.equal(await coverOf("p_processing"), result.media_id);
    assert.deepEqual((await photosOf("p_processing")).map((photo) => photo.media_id), [result.media_id]);
    const maps = asked.filter((url) => url.hostname === "maps.googleapis.com");
    assert.equal(maps.length, 1);
    assert.equal(maps[0].searchParams.get("key"), "maps-static-key");
    assert.equal(maps[0].searchParams.get("maptype"), "satellite");

    keys.googleMapsStaticApiKey = "";
    assert.equal(satellite.staticMapApiKey(), "server-key", "without a Maps Static key the server key is the fallback");
  } finally {
    globalThis.fetch = realFetch;
    keys.googleMapsStaticApiKey = saved.stat;
    keys.googleMapsApiKey = saved.server;
  }
});
