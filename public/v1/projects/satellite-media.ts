// A project's top-down satellite image, saved as ordinary project media (docs/architecture/custom-fields.md, "Project media references and cover").
//
// The image a project shows when no cover is chosen used to be drawn from the FirstMeasure report (or Google's static
// map) every time it was shown, and it was never in the project's photo library. Here it is saved once into the
// library as a normal photo through the media store, so the photos API lists it like any other photo, it can be
// shared to the customer portal like any other, and `cover_photo` names it when no cover is chosen.
//
// When: when a linked report completes (firstmeasure/project-events.ts), and lazily the first time the Photos tab,
// the Customer Portal tab or the project overview needs the project's media (POST .../satellite-media). Nothing here
// creates a project: a project that does not exist is left alone.
//
// Once per project and source: `satellite_media[source]` on the project records that the image was saved, so a
// repeat saves nothing, and a satellite photo someone removed from the library is not put back.
import { createHash } from "node:crypto";
import { env } from "../src/config/env.js";
import { readDocument, readMediaMetadata, storeMediaUpload, type JsonObject } from "../platform/storage.js";
import { updateProjectData } from "../platform/project_document_mutation.js";

export const SATELLITE_MEDIA_SOURCE = "satellite_top_down";
export const SATELLITE_MEDIA_LABEL = "Top-down satellite";
export type SatelliteSourceKey = "firstmeasure" | "google_static_map";

type SatelliteImage = { source: SatelliteSourceKey; bytes: Buffer; artifact?: string; reportId?: string };
export type SatelliteMediaDeps = {
  /** Reads the linked report's top-down image (in tests, a fixture). */
  firstMeasureImage?: (orgId: string, reportId: string) => Promise<{ bytes: Buffer; artifact: string } | null>;
  /** Fetches Google's static satellite map for a point (in tests, a fixture; never the network). */
  googleStaticMap?: (point: { lat: number; lng: number }) => Promise<Buffer | null>;
};
export type SatelliteMediaResult = {
  status: "no_project" | "unavailable" | "existing" | "saved";
  media_id?: string;
  source?: SatelliteSourceKey;
  cover_set?: boolean;
  photos?: unknown[];
  custom_field_values?: JsonObject;
  satellite_media?: JsonObject;
};

const obj = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const clean = (value: unknown) => String(value ?? "").trim();
const identity = (raw: unknown) => { const photo = obj(raw); return clean(photo.media_id || photo.mediaId || photo.id); };
const TOP_DOWN_PSEUDO_ID = "top_down_thumbnail";

/** The report a platform project links (as firstmeasure/project-events.ts resolves it). */
function linkedReportId(project: JsonObject) {
  const measurement = obj(project.measurement_project || project.measurement), raw = obj(measurement.raw);
  return clean(measurement.id || measurement.project_id || raw.id || raw.project_id || project.measurement_project_id || project.folder);
}

function finite(value: unknown, limit: number) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

/** The project's coordinates, read where the My Projects tile reads them (project, then report, then pins). */
export function projectSatellitePoint(project: JsonObject) {
  const measurement = obj(project.measurement_project || project.measurement), raw = obj(measurement.raw);
  for (const candidate of [project, raw, measurement]) {
    const lat = finite(candidate.lat ?? candidate.latitude, 90), lng = finite(candidate.lng ?? candidate.longitude, 180);
    if (lat !== null && lng !== null && !(lat === 0 && lng === 0)) return { lat, lng };
  }
  for (const pins of [project.pins, raw.pins, measurement.pins]) {
    for (const pin of Array.isArray(pins) ? pins : []) {
      const lat = finite(obj(pin).lat ?? obj(pin).latitude, 90), lng = finite(obj(pin).lng ?? obj(pin).longitude, 180);
      if (lat !== null && lng !== null && !(lat === 0 && lng === 0)) return { lat, lng };
    }
  }
  return null;
}

/** Media id for a project's satellite image from one source: the same on every attempt, so a retry never duplicates. */
export function satelliteMediaId(orgId: string, projectId: string, source: SatelliteSourceKey) {
  return `satellite_${createHash("sha256").update(`${orgId}\u0000${projectId}\u0000${source}`).digest("hex").slice(0, 32)}`;
}

/** The completed report's top-down image, read from its artifacts as the thumbnail endpoint does. */
async function defaultFirstMeasureImage(orgId: string, reportId: string) {
  const storage = await import("../firstmeasure/storage.js");
  const manifest = obj(await storage.readManifest(reportId).catch(() => null));
  // Only a completed report of this organization.
  if (clean(obj(manifest.organization_ref).id) !== orgId || clean(manifest.status).toLowerCase() !== "completed") return null;
  const names = new Set((await storage.listProjectFiles(reportId).catch(() => [])).map((file) => clean(obj(file).name)));
  const raw = obj(manifest);
  const preferred = clean(raw.thumbnail_source || raw.thumbnail_artifact_name);
  const candidates = [preferred, "browser_thumbnail.webp", "browser_thumbnail.jpg", "browser_thumbnail.jpeg", "browser_thumbnail.png", "google.png", "azure.png", "apple.png", "rgb.png", "rgb.jpg"]
    .filter((name) => name && !/^internal-(resource|markup)-/i.test(name));
  for (const name of candidates) {
    if (!names.has(name)) continue;
    const artifact = await storage.readArtifact(reportId, name).catch(() => null);
    const content: unknown = artifact?.content;
    const bytes = Buffer.isBuffer(content) ? content : (content instanceof Uint8Array ? Buffer.from(content) : null);
    if (bytes?.length) return { bytes, artifact: name };
  }
  return null;
}

/** The key for Maps Static requests: the one reports fetch their google.png with (PROVIDER_KEYS.md, maps_static_api_key). */
export function staticMapApiKey() {
  return clean(env.googleMapsStaticApiKey) || clean(env.googleMapsApiKey);
}

async function defaultGoogleStaticMap(point: { lat: number; lng: number }) {
  const key = staticMapApiKey();
  if (!key) { console.warn("Satellite image: no Maps Static key is configured"); return null; }
  const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
  url.searchParams.set("center", `${point.lat},${point.lng}`);
  url.searchParams.set("zoom", "20");
  url.searchParams.set("size", "640x400");
  url.searchParams.set("scale", "2");
  url.searchParams.set("maptype", "satellite");
  url.searchParams.set("key", key);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !clean(response.headers.get("content-type")).startsWith("image/")) {
      // Never log the URL: it carries the key.
      console.warn("Satellite image: Maps Static refused", response.status, clean(response.headers.get("x-staticmap-api-warning")).slice(0, 200));
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length ? bytes : null;
  } catch (error) {
    console.warn("Satellite image: Maps Static request failed", error instanceof Error ? error.name : "error");
    return null;
  }
}

/** The best satellite image the project can have now that it has not saved yet, or null. */
async function availableImage(orgId: string, project: JsonObject, saved: JsonObject, deps: SatelliteMediaDeps): Promise<SatelliteImage | null> {
  const reportId = linkedReportId(project);
  if (reportId && !saved.firstmeasure) {
    const image = await (deps.firstMeasureImage || defaultFirstMeasureImage)(orgId, reportId).catch(() => null);
    if (image?.bytes?.length) return { source: "firstmeasure", bytes: image.bytes, artifact: image.artifact, reportId };
  }
  // The report's own image is better; the static map is only for a project that has none (yet).
  if (saved.firstmeasure || saved.google_static_map) return null;
  const point = projectSatellitePoint(project);
  if (!point) return null;
  const bytes = await (deps.googleStaticMap || defaultGoogleStaticMap)(point).catch(() => null);
  return bytes?.length ? { source: "google_static_map", bytes } : null;
}

async function normalizedJpeg(bytes: Buffer) {
  const sharp = (await import("sharp")).default;
  return await sharp(bytes, { failOn: "none", limitInputPixels: 40_000_000 }).rotate().jpeg({ quality: 88 }).toBuffer();
}

async function mediaExists(orgId: string, mediaId: string) {
  try { return obj(await readMediaMetadata(orgId, mediaId)); }
  catch (error) {
    const code = obj(error).statusCode, errno = obj(error).code;
    if (code === 404 || errno === "ENOENT" || errno === "media_not_found") return null;
    throw error;
  }
}

function photoReference(media: JsonObject, projectId: string, source: SatelliteSourceKey, extra: JsonObject) {
  const mediaId = clean(media.id);
  const variants = obj(media.variants);
  const now = new Date().toISOString();
  const metadata = {
    ...obj(media.metadata),
    source: SATELLITE_MEDIA_SOURCE,
    satellite_source: source,
    label: SATELLITE_MEDIA_LABEL,
    alt: "Top-down satellite image",
    media_type: "image",
    mime_type: clean(media.content_type) || "image/jpeg",
    thumbnail_variant: variants.thumb_320 ? "thumb_320" : "original",
    ...extra
  };
  return {
    id: mediaId,
    photo_id: mediaId,
    media_id: mediaId,
    kind: "media_reference",
    variant: "original",
    file_name: clean(media.file_name) || "top-down-satellite.jpg",
    content_type: clean(media.content_type) || "image/jpeg",
    mime_type: clean(media.content_type) || "image/jpeg",
    media_type: "image",
    size_bytes: Number(media.size_bytes || 0),
    variants: Object.keys(variants),
    owner: { collection: "projects", id: projectId, field: "photos" },
    field: "photos",
    label: SATELLITE_MEDIA_LABEL,
    alt: "Top-down satellite image",
    source: SATELLITE_MEDIA_SOURCE,
    uploaded_at: clean(media.created_at) || now,
    updated_at: now,
    metadata
  };
}

function coverValues(data: JsonObject) {
  return obj(data.custom_field_values || data.custom_fields);
}

function resultFrom(status: SatelliteMediaResult["status"], data: JsonObject, extra: Partial<SatelliteMediaResult> = {}): SatelliteMediaResult {
  return {
    status,
    photos: Array.isArray(data.photos) ? data.photos : [],
    custom_field_values: coverValues(data),
    satellite_media: obj(data.satellite_media),
    ...extra
  };
}

/**
 * Save the project's top-down satellite image into its media library once, and make it the cover when no cover is
 * chosen. Returns what the project now holds so a caller can update the copy it shows. Never creates a project.
 */
export async function ensureProjectSatelliteMedia(orgId: string, projectId: string, deps: SatelliteMediaDeps = {}): Promise<SatelliteMediaResult> {
  const id = clean(projectId);
  if (!orgId || !id) return { status: "no_project" };
  const document = await readDocument(orgId, "projects", id).catch(() => null);
  if (!document || !document.data || typeof document.data !== "object") return { status: "no_project" };
  const project: JsonObject = { ...obj(document.data), id };
  if (project.deleted_at || project.in_trash) return { status: "no_project" };
  const saved = obj(project.satellite_media);
  const image = await availableImage(orgId, project, saved, deps);
  if (!image) return resultFrom(Object.keys(saved).some((key) => obj(saved[key]).media_id) ? "existing" : "unavailable", project);

  const mediaId = satelliteMediaId(orgId, id, image.source);
  let media = await mediaExists(orgId, mediaId);
  if (!media) {
    const bytes = await normalizedJpeg(image.bytes).catch(() => null);
    if (!bytes?.length) return resultFrom("unavailable", project);
    media = obj(await storeMediaUpload(orgId, {
      id: mediaId,
      ownerType: "project",
      ownerId: id,
      slot: "photos",
      collection: "projects",
      scope: "projects",
      fileName: "top-down-satellite.jpg",
      contentType: "image/jpeg",
      bytes,
      // Always make the small renditions: the tile and the gallery read thumb_320.
      thumbnails: { large_only: false },
      metadata: {
        field: "photos",
        document_collection: "projects",
        document_id: id,
        source: SATELLITE_MEDIA_SOURCE,
        satellite_source: image.source,
        label: SATELLITE_MEDIA_LABEL,
        ...(image.reportId ? { firstmeasure_project_id: image.reportId } : {}),
        ...(image.artifact ? { source_artifact: image.artifact } : {}),
        uploaded_at: new Date().toISOString()
      }
    }));
  }
  const reference = photoReference(media, id, image.source, {
    ...(image.reportId ? { firstmeasure_project_id: image.reportId } : {}),
    ...(image.artifact ? { source_artifact: image.artifact } : {})
  });

  let coverSet = false;
  let outcome: SatelliteMediaResult["status"] = "saved";
  const written = await updateProjectData(orgId, id, (data) => {
    coverSet = false;
    const marker = obj(data.satellite_media);
    if (obj(marker[image.source]).media_id) { outcome = "existing"; return null; }
    outcome = "saved";
    // The generated stand-in for the satellite image is display state; the saved photo replaces it.
    const photos = (Array.isArray(data.photos) ? data.photos : []).filter((photo) => {
      const item = obj(photo);
      return identity(item) !== TOP_DOWN_PSEUDO_ID && clean(item.designator || obj(item.metadata).designator) !== TOP_DOWN_PSEUDO_ID;
    });
    if (!photos.some((photo) => identity(photo) === mediaId)) photos.push(reference);
    const values = coverValues(data);
    const coverId = clean(obj(values.cover_photo).media_id);
    // The cover this writer chose (a static map) gives way to the report's own image; a cover a person chose stays.
    const autoCover = clean(marker.auto_cover_media_id);
    const takeCover = !coverId || (image.source === "firstmeasure" && !!autoCover && coverId === autoCover);
    const next: JsonObject = {
      ...data,
      photos,
      satellite_media: {
        ...marker,
        [image.source]: { media_id: mediaId, saved_at: new Date().toISOString(), ...(image.reportId ? { report_id: image.reportId } : {}) },
        ...(takeCover ? { auto_cover_media_id: mediaId } : {})
      }
    };
    if (takeCover) {
      const cover = { ...values, cover_photo: { media_id: mediaId } };
      next.custom_field_values = cover;
      next.custom_fields = cover;
      coverSet = true;
    }
    return next;
  });
  const data = obj(obj(written).data);
  if (!written) {
    const current = obj(obj(await readDocument(orgId, "projects", id).catch(() => null)).data);
    return resultFrom(outcome, current, { media_id: mediaId, source: image.source, cover_set: false });
  }
  return resultFrom(outcome, data, { media_id: mediaId, source: image.source, cover_set: coverSet });
}

/** Every project of the organization that links this report gets the report's satellite image. Never throws. */
export async function saveSatelliteMediaForReport(orgId: string, projectIds: string[]) {
  for (const projectId of projectIds) {
    try { await ensureProjectSatelliteMedia(orgId, projectId); }
    catch (error) { console.warn("Saving the project's satellite image failed", projectId, error); }
  }
}
