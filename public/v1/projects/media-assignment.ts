// Photos that belong to no project yet, and pairing them with one later.
//
// A photo taken from the top-level Feed camera may have nothing to file it under. It is stored as ordinary media
// owned by the organization in the `photos` slot, with no `metadata.project_id`, and its `metadata.branch_id` is the
// uploader's branch, set by the server. Who sees it: the person who took it, and anyone with `view_media` whose
// branches include the photo's branch.
//
// Pairing (`assignMediaToProject`) is the one writer that moves such a photo into a project: it changes the media
// owner and adds the photo to the project's `photos[]` in one conditional project write (never a whole-project PUT),
// and the Feed post the photo already has keeps its comments and reactions. `unassignMediaFromProject` takes back
// only photos that were paired this way.
//
// No other write can undo that: a whole-project save keeps every stored photo it does not mention
// (`withPreservedPhotos`), and only the photos endpoint (`saveProjectPhotoList`) removes one, by name.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, forbidden, notFound, PlatformError } from "../platform/errors.js";
import { canSeeUnassignedPhoto, canWriteReceiptMedia, isUnassignedPhoto, publicMediaMetadata } from "../platform/media_access.js";
import { updateProjectData } from "../platform/project_document_mutation.js";
import { readDocument, readMediaMetadata, setMediaProjectOwner, type JsonObject } from "../platform/storage.js";
import { readProjectForAccess as readProjectForMedia } from './access.js';


type Obj = JsonObject;
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const clean = (value: unknown) => String(value ?? "").trim();
const identity = (photo: unknown) => { const p = obj(photo); return clean(p.id || p.photo_id || p.media_id || p.src || p.url); };

export const UNASSIGNED_PHOTO_SLOT = "photos";
/** Marks a project photo that was paired from the organization, so only those can be returned to it. */
const PAIRED_FROM = "organization";
const TOP_DOWN_ID = "top_down_thumbnail";
const SATELLITE_SOURCE = "satellite_top_down";
const MAX_ITEMS = 100;
/** The apps whose screens upload and show photos (the same gate as the media routes). */
export const MEDIA_APPS = ["portal.photos_feed", "project.photos", "contact.media", "portal.viewer"];

// Who may see an unpaired photo is media access (platform/media_access.ts), so every media route applies it.
export { canSeeUnassignedPhoto, isUnassignedPhoto, mediaBranchId } from "../platform/media_access.js";

function isRemoved(media: unknown) {
  const data = obj(media), metadata = obj(data.metadata);
  return !!(data.deleted_at || data.trashed_at || data.in_trash || metadata.deleted_at || metadata.trashed_at || metadata.in_trash);
}

export { readProjectForAccess as readProjectForMedia } from './access.js';

type UploadRequest = { id?: string; ownerType?: string; ownerId?: string; slot?: string; replaceSlot?: boolean; metadata?: Obj };

/**
 * The upload route's own checks. Who uploaded comes from the session; a project the media names must exist and be
 * visible to the caller; an unpaired photo gets the uploader's branch; an existing media id cannot be taken over.
 */
export async function authorizeMediaUpload<T extends UploadRequest>(ctx: PlatformAuthContext, upload: T): Promise<T> {
  const ownerType = clean(upload.ownerType).toLowerCase() || "organization";
  const metadata: Obj = { ...obj(upload.metadata) };
  metadata.uploaded_by_user_id = ctx.userId;
  const email = clean(obj(ctx.identity).email || obj(ctx.user).email), name = clean(obj(ctx.user).name || obj(ctx.identity).name);
  if (email) metadata.uploaded_by_email = email; else delete metadata.uploaded_by_email;
  if (name) metadata.uploaded_by_name = name; else delete metadata.uploaded_by_name;
  let ownerId = clean(upload.ownerId);
  if (ownerType === "project") {
    const { data } = await readProjectForMedia(ctx, ownerId, "view_projects");
    ownerId = clean(data.id);
    metadata.project_id = ownerId;
  } else {
    if (ownerType === "organization") ownerId = ctx.orgId;
    if (ownerType === "organization" && clean(upload.slot) === UNASSIGNED_PHOTO_SLOT) {
      // An unpaired photo names no project; pairing it later is assignMediaToProject.
      delete metadata.project_id;
      metadata.branch_id = clean(ctx.branchId) || "default";
    } else if (clean(metadata.project_id)) {
      await readProjectForMedia(ctx, metadata.project_id, "view_projects");
    }
  }
  const id = clean(upload.id);
  if (id) {
    const existing = await readMediaMetadata(ctx.orgId, id).catch((error) => {
      if (error instanceof PlatformError && error.statusCode === 404) return null;
      throw error;
    });
    if (existing) {
      const owner = obj(existing.owner);
      if (clean(owner.type) !== ownerType || clean(owner.id) !== ownerId || !canWriteReceiptMedia(existing, ctx)) {
        throw conflict("media_id_taken", "This media id is already in use.");
      }
    }
  }
  return { ...upload, ownerType, ownerId, metadata };
}

// ── The project's photo list (the same derived cover state the browser's savePhotos writes) ──────────────────────

function isVideo(photo: unknown) {
  const p = obj(photo), metadata = obj(p.metadata);
  const type = clean(p.media_type || metadata.media_type).toLowerCase();
  if (type) return type.startsWith("video");
  return clean(p.mime_type || p.content_type || metadata.mime_type).toLowerCase().startsWith("video/");
}
const isTrashed = (photo: unknown) => { const p = obj(photo); return !!(p.in_trash || p.trashed_at); };

/** A `photos[]` entry for a media record, shaped like the one a project upload stores. */
export function projectPhotoReference(media: unknown, projectId: string) {
  const data = obj(media), metadata = obj(data.metadata), variants = obj(data.variants);
  const mediaId = clean(data.id);
  const contentType = clean(data.content_type);
  const type = contentType.startsWith("video/") ? "video" : "image";
  const label = clean(data.label || metadata.label || data.file_name) || (type === "video" ? "Project video" : "Project photo");
  const source = clean(metadata.source) || "feed_camera";
  return {
    id: mediaId,
    photo_id: mediaId,
    media_id: mediaId,
    kind: "media_reference",
    variant: "original",
    file_name: clean(data.file_name),
    content_type: contentType,
    mime_type: contentType,
    media_type: type,
    size_bytes: Number(data.size_bytes || 0),
    variants: Object.keys(variants),
    owner: { collection: "projects", id: projectId, field: "photos" },
    field: "photos",
    label,
    alt: label,
    source,
    tags: Array.isArray(data.tags) ? data.tags : Array.isArray(metadata.tags) ? metadata.tags : [],
    uploaded_at: clean(metadata.uploaded_at || data.created_at),
    updated_at: clean(data.updated_at),
    is_thumbnail: false,
    is_default_thumbnail: false,
    metadata: {
      ...metadata,
      source,
      media_type: type,
      mime_type: contentType,
      ...(variants.thumb_320 ? { thumbnail_variant: "thumb_320" } : {})
    }
  };
}

/**
 * The derived thumbnail fields after the photo list changed, in the order the browser's `primaryPhoto` uses: the
 * chosen cover (`custom_field_values.cover_photo`), else the saved satellite photo, else the generated top-down image,
 * else the first photo that is not a video. The generated top-down image is drawn in the browser, so when it is the
 * answer the stored thumbnail fields are left as they were.
 */
export function withDerivedThumbnail(data: Obj, photos: Obj[]): Obj {
  const values = obj(data.custom_field_values || data.custom_fields);
  const coverId = clean(obj(values.cover_photo).media_id);
  const coverPhoto = coverId ? photos.find((photo) => clean(photo.media_id || photo.id) === coverId) : undefined;
  let thumbnail: Obj | null | "top_down" = null;
  if (coverId && (!coverPhoto || (!isTrashed(coverPhoto) && !isVideo(coverPhoto)))) thumbnail = coverPhoto || { id: coverId, media_id: coverId };
  else {
    const satellite = photos.find((photo) => clean(photo.media_id) && clean(photo.source || obj(photo.metadata).source) === SATELLITE_SOURCE && !isTrashed(photo));
    const topDown = photos.find((photo) => photo.is_top_down_thumbnail || clean(photo.designator) === TOP_DOWN_ID);
    const generatedTopDown = clean(data.thumbnail_photo_id) === TOP_DOWN_ID;
    thumbnail = satellite || topDown || (generatedTopDown ? "top_down" : photos.find((photo) => !isTrashed(photo) && !isVideo(photo)) || null);
  }
  const targetId = thumbnail === "top_down" ? TOP_DOWN_ID : thumbnail ? identity(thumbnail) : "";
  const flagged = photos.map((photo) => { const on = !!targetId && identity(photo) === targetId; return { ...photo, is_thumbnail: on, is_default_thumbnail: on }; });
  if (thumbnail === "top_down") return { ...data, photos: flagged };
  return { ...data, photos: flagged, thumbnail_photo_id: targetId, thumbnail_photo: thumbnail ? { ...thumbnail, is_thumbnail: true, is_default_thumbnail: true } : null };
}

// ── Every write of the photo list ─────────────────────────────────────────────────────────────────────────────
//
// `photos[]` has several writers: pairing and the satellite writer here on the server, and the browser, which saves
// the list as the page last saw it, often as part of a whole-project save from a copy read before another writer's
// change (the project window saved a copy without a just-paired photo and dropped it). So a write removes only the
// photos it names in `remove`, and only the photos endpoint below names any: a whole-project save can add or change
// photos but never drops one it does not mention.

const isTransientPhoto = (photo: Obj) => /^(local|uploading)_/.test(identity(photo)) || clean(photo.src).startsWith("blob:");

/** A photo a stale copy would put back after it was returned to the Feed (or paired with another project since). */
async function leftThisProject(orgId: string, projectId: string, photo: Obj) {
  const mediaId = clean(photo.media_id);
  if (!mediaId) return false;
  const media = await readMediaMetadata(orgId, mediaId).then(obj, () => null);
  if (!media) return false;
  if (isUnassignedPhoto(media)) return true;
  return clean(obj(media.metadata).paired_from) === PAIRED_FROM && mediaProjectId(media) !== projectId;
}

/**
 * The photo list a write leaves: the writer's photos in its order (each replaces the stored photo with its identity),
 * then every stored photo it did not mention, except those in `remove`. `changed` says whether that differs from
 * what the writer sent.
 */
export async function mergeProjectPhotos(orgId: string, projectId: string, storedValue: unknown, incomingValue: unknown, removeValue: Iterable<unknown> = []) {
  const stored = (Array.isArray(storedValue) ? storedValue : []).map(obj);
  const incoming = (Array.isArray(incomingValue) ? incomingValue : []).map(obj);
  const remove = new Set([...removeValue].map(clean).filter(Boolean));
  const storedIds = new Set(stored.map(identity));
  const seen = new Set<string>();
  const photos: Obj[] = [];
  for (const photo of incoming) {
    const id = identity(photo);
    if (id && (seen.has(id) || remove.has(id))) continue;
    if (id && !storedIds.has(id) && await leftThisProject(orgId, projectId, photo)) continue;
    if (id) seen.add(id);
    photos.push(photo);
  }
  for (const photo of stored) {
    const id = identity(photo);
    if (!id || seen.has(id) || remove.has(id) || isTransientPhoto(photo)) continue;
    seen.add(id);
    photos.push(photo);
  }
  const changed = photos.length !== incoming.length || photos.some((photo, index) => photo !== incoming[index]);
  return { photos, changed };
}

/**
 * The data a whole-project save (PUT, PATCH or POST of a project, platform/api.ts) stores: its own photo changes,
 * never the loss of a photo another writer stored meanwhile. A PATCH that sends no photo list leaves it alone. When
 * photos are kept back, the thumbnail fields are derived again from the kept list.
 */
export async function withPreservedPhotos(orgId: string, projectId: string, current: Obj, next: Obj, replace: boolean): Promise<Obj> {
  if (!replace && !Object.prototype.hasOwnProperty.call(next, "photos")) return next;
  const merged = await mergeProjectPhotos(orgId, projectId, current.photos, next.photos);
  if (!merged.changed) return next;
  const derived = withDerivedThumbnail({ ...current, ...next }, merged.photos);
  return { ...next, photos: derived.photos, thumbnail_photo_id: derived.thumbnail_photo_id, thumbnail_photo: derived.thumbnail_photo };
}

/**
 * The browser's photo list writes (uploads, markup, trash, restore, delete forever: `projectMedia.savePhotos`), as one
 * conditional write of the photo list and the thumbnail fields only. `photos` are the photos as the caller has them
 * now; `remove` the ones it took out. Photos another writer added since its copy are kept.
 */
export async function saveProjectPhotoList(ctx: PlatformAuthContext, projectIdValue: unknown, photosValue: unknown, removeValue: unknown) {
  const { data: project } = await readProjectForMedia(ctx, projectIdValue, "manage_projects");
  const projectId = clean(project.id);
  const remove = Array.isArray(removeValue) ? removeValue : [];
  const written = obj(await updateProjectData(ctx.orgId, projectId, async (data) => {
    if (data.deleted_at || data.trashed_at || data.in_trash) throw notFound("project_not_found", "This project is not available.");
    const merged = await mergeProjectPhotos(ctx.orgId, projectId, data.photos, photosValue, remove);
    const next = withDerivedThumbnail(data, merged.photos);
    const same = ["photos", "thumbnail_photo_id", "thumbnail_photo"].every((key) => JSON.stringify(next[key] ?? null) === JSON.stringify(data[key] ?? null));
    return same ? null : { ...next, updated_at: new Date().toISOString() };
  }));
  const document = Object.keys(written).length ? written : obj(await readDocument(ctx.orgId, "projects", projectId));
  const data = obj(document.data);
  return {
    project_id: projectId,
    photos: Array.isArray(data.photos) ? data.photos as Obj[] : [],
    thumbnail_photo_id: clean(data.thumbnail_photo_id),
    thumbnail_photo: data.thumbnail_photo ?? null,
    project_revision: Number(document.revision || 0),
    document
  };
}

// ── Pairing ─────────────────────────────────────────────────────────────────────────────────────────────────────

function mediaIds(value: unknown) {
  const ids = [...new Set((Array.isArray(value) ? value : [value]).map(clean).filter(Boolean))];
  if (!ids.length) throw badRequest("media_required", "Choose at least one photo.");
  if (ids.length > MAX_ITEMS) throw badRequest("media_too_many", `Choose at most ${MAX_ITEMS} photos at a time.`);
  return ids;
}

async function readMediaOrMissing(orgId: string, mediaId: string) {
  try { return obj(await readMediaMetadata(orgId, mediaId)); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) throw notFound("media_not_found", "This photo is not available."); throw error; }
}

function mediaProjectId(media: Obj) {
  const owner = obj(media.owner);
  return clean(obj(media.metadata).project_id || (clean(owner.type) === "project" ? owner.id : ""));
}

/** May this caller pair this photo with `projectId`? Already paired with it is fine (a retry). */
function assertAssignable(ctx: PlatformAuthContext, media: Obj, projectId: string) {
  if (isRemoved(media)) throw notFound("media_not_found", "This photo is not available.");
  const current = mediaProjectId(media);
  if (current === projectId && clean(obj(media.owner).type) === "project") return "already";
  if (!isUnassignedPhoto(media) || !canSeeUnassignedPhoto(ctx, media)) {
    if (current) throw conflict("media_assigned_elsewhere", "This photo already belongs to a project.");
    throw notFound("media_not_found", "This photo is not available.");
  }
  if (!canWriteReceiptMedia(media, ctx)) throw forbidden("media_write_denied", "This photo cannot be changed by you.");
  return "unassigned";
}

export type MediaAssignmentResult = {
  project_id: string;
  /** Every requested item as it is now (public metadata). */
  media: Obj[];
  /** Ids this call paired; the rest were already in the project. */
  assigned: string[];
  already_assigned: string[];
  photos: Obj[];
  thumbnail_photo_id: string;
  project_revision: number;
};

async function emitMediaEvent(ctx: PlatformAuthContext, type: "media.assigned" | "media.unassigned", media: Obj, projectId: string, branchId: string) {
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({
    organization_id: ctx.orgId,
    branch_id: branchId,
    project_id: projectId,
    type,
    visibility: "system",
    idempotency_key: `${type}:${clean(media.id)}:${projectId}:${clean(media.updated_at)}`,
    payload: { media_id: clean(media.id), project_id: projectId, file_name: clean(media.file_name), kind: clean(media.kind) },
    context: { actor_user_id: ctx.userId }
  });
}

/**
 * Pair unpaired photos with a project. Needs `manage_projects` on the project and sight of each photo. Each photo is
 * claimed first (a check-and-set on its record, so two people cannot pair one photo with two projects), then the
 * project's `photos[]` is written once with its revision; if that write fails the claims are undone. Safe to retry.
 */
export async function assignMediaToProject(ctx: PlatformAuthContext, mediaIdValue: unknown, projectIdValue: unknown): Promise<MediaAssignmentResult> {
  const ids = mediaIds(mediaIdValue);
  const { data: project } = await readProjectForMedia(ctx, projectIdValue, "manage_projects");
  const projectId = clean(project.id);
  const items = new Map<string, Obj>();
  // Check every photo before changing any.
  for (const id of ids) { const media = await readMediaOrMissing(ctx.orgId, id); assertAssignable(ctx, media, projectId); items.set(id, media); }
  const assigned: string[] = [], already: string[] = [];
  const now = new Date().toISOString();
  const pairedMetadata = { paired_from: PAIRED_FROM, paired_at: now, paired_by_user_id: ctx.userId };
  let written: Obj | null = null;
  try {
    for (const id of ids) {
      if (assertAssignable(ctx, items.get(id)!, projectId) === "already") { already.push(id); continue; }
      let raced = false;
      const next = obj(await setMediaProjectOwner(ctx.orgId, id, projectId, { metadata: pairedMetadata, guard: (current) => { raced = assertAssignable(ctx, obj(current), projectId) === "already"; } }));
      if (raced) already.push(id); else assigned.push(id);
      items.set(id, next);
    }
    written = obj(await updateProjectData(ctx.orgId, projectId, (data) => {
      if (data.deleted_at || data.trashed_at || data.in_trash) throw notFound("project_not_found", "This project is not available.");
      const photos = (Array.isArray(data.photos) ? data.photos : []).map(obj);
      const present = new Set(photos.map((photo) => clean(photo.media_id || photo.id)));
      const added = ids.filter((id) => !present.has(id)).map((id) => projectPhotoReference(items.get(id), projectId));
      if (!added.length) return null;
      return { ...withDerivedThumbnail(data, [...photos, ...added]), updated_at: now };
    }));
  } catch (error) {
    for (const id of assigned) {
      await setMediaProjectOwner(ctx.orgId, id, null, { metadata: { paired_from: undefined, paired_at: undefined, paired_by_user_id: undefined } }).catch(() => undefined);
    }
    throw error;
  }
  const current = Object.keys(written).length ? written : obj(await readDocument(ctx.orgId, "projects", projectId));
  const data = obj(current.data);
  const branchId = clean(project.branch_id) || clean(ctx.branchId) || "default";
  const feed = await import("../channels/feed.js");
  // Every requested photo, so a retry after a partial failure still moves its post.
  for (const id of ids) await feed.relinkFeedMedia(ctx.orgId, id).catch((error) => console.warn("Relinking a paired photo's Feed post failed", id, error));
  for (const id of assigned) await emitMediaEvent(ctx, "media.assigned", items.get(id)!, projectId, branchId);
  return {
    project_id: projectId,
    media: ids.map((id) => publicMediaMetadata(items.get(id))),
    assigned,
    already_assigned: already,
    photos: Array.isArray(data.photos) ? data.photos as Obj[] : [],
    thumbnail_photo_id: clean(data.thumbnail_photo_id),
    project_revision: Number(current.revision || 0)
  };
}

/**
 * Return photos that were paired from the organization back to it: they leave the project's `photos[]` (and stop
 * being its cover) and become unpaired again, keeping their Feed post. Photos uploaded into the project are refused.
 */
export async function unassignMediaFromProject(ctx: PlatformAuthContext, mediaIdValue: unknown, projectIdValue: unknown) {
  const ids = mediaIds(mediaIdValue);
  const { data: project } = await readProjectForMedia(ctx, projectIdValue, "manage_projects");
  const projectId = clean(project.id);
  for (const id of ids) {
    const media = await readMediaOrMissing(ctx.orgId, id);
    if (mediaProjectId(media) !== projectId || isRemoved(media)) throw notFound("media_not_found", "This photo is not in this project.");
    if (clean(obj(media.metadata).paired_from) !== PAIRED_FROM) throw conflict("media_not_paired", "Only photos paired from the Feed can be returned to it.");
    if (!canWriteReceiptMedia(media, ctx)) throw forbidden("media_write_denied", "This photo cannot be changed by you.");
  }
  const removed = new Set(ids);
  const written = obj(await updateProjectData(ctx.orgId, projectId, (data) => {
    const photos = (Array.isArray(data.photos) ? data.photos : []).map(obj);
    const kept = photos.filter((photo) => !removed.has(clean(photo.media_id || photo.id)));
    const values = obj(data.custom_field_values || data.custom_fields);
    const coverGone = removed.has(clean(obj(values.cover_photo).media_id));
    if (kept.length === photos.length && !coverGone) return null;
    let next: Obj = { ...data, updated_at: new Date().toISOString() };
    if (coverGone) {
      const { cover_photo: _cover, ...rest } = values;
      next = { ...next, custom_field_values: rest, custom_fields: rest };
    }
    return withDerivedThumbnail(next, kept);
  }));
  const back: Obj[] = [];
  for (const id of ids) {
    back.push(obj(await setMediaProjectOwner(ctx.orgId, id, null, {
      metadata: { paired_from: undefined, paired_at: undefined, paired_by_user_id: undefined }
    })));
  }
  const current = Object.keys(written).length ? written : obj(await readDocument(ctx.orgId, "projects", projectId));
  const data = obj(current.data);
  const branchId = clean(project.branch_id) || clean(ctx.branchId) || "default";
  const feed = await import("../channels/feed.js");
  for (const media of back) {
    await feed.relinkFeedMedia(ctx.orgId, clean(media.id)).catch((error) => console.warn("Relinking an unpaired photo's Feed post failed", media.id, error));
    await emitMediaEvent(ctx, "media.unassigned", media, projectId, branchId);
  }
  return {
    project_id: projectId,
    media: back.map((media) => publicMediaMetadata(media)),
    unassigned: ids,
    photos: Array.isArray(data.photos) ? data.photos as Obj[] : [],
    thumbnail_photo_id: clean(data.thumbnail_photo_id),
    project_revision: Number(current.revision || 0)
  };
}

/** Unpaired photos this caller may see, newest first (public metadata). */
export async function listUnassignedPhotos(ctx: PlatformAuthContext, media: unknown[]) {
  return media.filter((item) => canSeeUnassignedPhoto(ctx, item))
    .sort((a, b) => clean(obj(b).created_at).localeCompare(clean(obj(a).created_at)))
    .map((item) => publicMediaMetadata(item));
}

const assignmentBody = z.object({
  project_id: z.string().trim().min(1).max(200),
  media_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_ITEMS)
}).strict();

const photoListBody = z.object({
  photos: z.array(z.record(z.string(), z.unknown())).max(5000),
  remove: z.array(z.string().trim().min(1).max(2000)).max(5000).default([])
}).strict();

/** Browser routes, inside the /v1/platform plugin. */
export function registerMediaAssignmentRoutes(app: FastifyInstance) {
  const auth = (request: FastifyRequest) => requirePlatformAuth(request, { app: MEDIA_APPS, orgId: clean(obj(request.params).orgId), csrf: true });
  app.post("/organizations/:orgId/media/assign", async (request) => {
    const ctx = await auth(request);
    const body = assignmentBody.parse(request.body ?? {});
    return { ok: true, ...(await assignMediaToProject(ctx, body.media_ids, body.project_id)) };
  });
  app.post("/organizations/:orgId/media/unassign", async (request) => {
    const ctx = await auth(request);
    const body = assignmentBody.parse(request.body ?? {});
    return { ok: true, ...(await unassignMediaFromProject(ctx, body.media_ids, body.project_id)) };
  });
  // The project's photo list, written alone (projectMedia.savePhotos in platform-api.js).
  app.post("/organizations/:orgId/projects/:projectId/photos", async (request) => {
    const ctx = await auth(request);
    const body = photoListBody.parse(request.body ?? {});
    return { ok: true, ...(await saveProjectPhotoList(ctx, clean(obj(request.params).projectId), body.photos, body.remove)) };
  });
}
