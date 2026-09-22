/**
 * Server halves of the `portal.*` widget pack.
 *
 * Registers into the SAME shared resolver registry the document and website
 * widgets use (`documents/widgets/registry.ts`). Imported for side effect
 * before the API boots.
 *
 * Contract: docs/customer-portal-v2-spec.md §6, docs/document-engine-contracts.md §11.
 *
 * Every resolver here follows two rules:
 *
 * 1. NO PORTAL CONTEXT, NO DATA. `ctx.portal` is set only when the definition is
 *    being resolved for a customer portal render. Without it every resolver
 *    returns null and the client renders a placeholder. That is what stops a
 *    `portal.*` widget dropped on a public marketing page from serving project
 *    data to the open internet.
 *
 * 2. NEVER THROW. The registry guards resolvers, but a resolver that degrades to
 *    null renders a placeholder while one that throws can take a page down.
 */

import {
  registerDocumentWidgetResolver,
  type WidgetResolveContext
} from "../documents/widgets/registry.js";
import { listEventRecords } from "../work/storage.js";
import { renderCustomerEventLabel, workEventCustomerDescriptor } from "../work/events.js";
import { customerPortalDocumentId } from "./portal_settings.js";
import type { JsonObject } from "./storage.js";
import { env } from "../src/config/env.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function clampLimit(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.round(parsed)));
}

function configMode(value: unknown, fallback = "automatic") {
  const mode = cleanText(value || fallback).toLowerCase();
  return ["automatic", "manual", "hybrid"].includes(mode) ? mode : fallback;
}

function portalMediaFileUrl(ctx: WidgetResolveContext, mediaIdValue: unknown, variant = "original") {
  const mediaId = cleanText(mediaIdValue);
  const portal = asObject(ctx.portal);
  const uuid = cleanText(portal.portal_uuid);
  if (!mediaId || !uuid) return ctx.services.media.fileUrl(ctx.organizationId, mediaId, variant);
  const prefix = portal.preview === true ? "customer-portals/preview" : "customer-portals";
  return `/v1/platform/${prefix}/${encodeURIComponent(uuid)}/media/${encodeURIComponent(mediaId)}/file?variant=${encodeURIComponent(variant)}`;
}

function mediaIdFrom(value: unknown) {
  const object = asObject(value);
  return cleanText(object.media_id || object.mediaId || object.id || value);
}

async function configuredMedia(ctx: WidgetResolveContext, value: unknown) {
  const mediaId = mediaIdFrom(value);
  if (!mediaId) return null;
  const metadata = asObject(await ctx.services.media.readMediaMetadata(ctx.organizationId, mediaId).catch(() => null));
  return {
    media_id: mediaId,
    url: portalMediaFileUrl(ctx, mediaId, cleanText(asObject(value).variant) || "original"),
    content_type: cleanText(metadata.content_type),
    file_name: cleanText(metadata.file_name || metadata.name)
  };
}

function finiteNumber(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function projectPoint(project: JsonObject) {
  const measurement = asObject(project.measurement_project || project.measurement);
  const raw = asObject(measurement.raw);
  const lat = finiteNumber(project.lat, project.latitude, measurement.lat, measurement.latitude, raw.lat, raw.latitude);
  const lng = finiteNumber(project.lng, project.longitude, measurement.lng, measurement.longitude, raw.lng, raw.longitude);
  return lat === null || lng === null ? null : { lat, lng };
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function coarsePoint(point: { lat: number; lng: number }) {
  // Roughly neighborhood precision. Never return rooftop coordinates for a
  // different customer's project.
  return { lat: Number(point.lat.toFixed(2)), lng: Number(point.lng.toFixed(2)) };
}

function projectType(project: JsonObject) {
  return cleanText(project.project_type || project.type || project.scope_type).toLowerCase();
}

function projectStatus(project: JsonObject) {
  const status = cleanText(project.status || project.project_status || "active").toLowerCase().replace(/[\s-]+/g, "_");
  if (["complete", "completed", "done", "closed"].includes(status)) return "completed";
  if (["in_progress", "scheduled", "open"].includes(status)) return "active";
  return status;
}

function neighborhoodLabel(project: JsonObject) {
  const explicit = cleanText(project.neighborhood || project.city || project.locality);
  if (explicit) return explicit;
  const parts = cleanText(project.address || project.project_address).split(",").map((part) => part.trim()).filter(Boolean);
  // A city/state label is useful without exposing a street or house number.
  return parts.length >= 3 ? parts.slice(-2).join(", ") : "Nearby project";
}

function googleStaticMapUrl(center: { lat: number; lng: number }, pins: Array<{ lat: number; lng: number }>) {
  const key = cleanText(env.googleMapsApiKey);
  if (!key || !pins.length) return "";
  const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
  url.searchParams.set("center", `${center.lat},${center.lng}`);
  url.searchParams.set("zoom", "11");
  url.searchParams.set("size", "640x360");
  url.searchParams.set("scale", "2");
  url.searchParams.set("maptype", "roadmap");
  url.searchParams.append("markers", `color:0x2563eb|label:Y|${center.lat},${center.lng}`);
  pins.forEach((pin) => url.searchParams.append("markers", `color:0xef4444|${pin.lat},${pin.lng}`));
  url.searchParams.set("key", key);
  return url.toString();
}

/** The project this render is scoped to, or null when there is no portal context. */
function portalProject(ctx: WidgetResolveContext) {
  if (!ctx.portal) return null;
  const project = asObject(ctx.project);
  const projectId = cleanText(project.id) || cleanText(ctx.portal.project_id);
  if (!projectId) return null;
  return { project, projectId, orgId: cleanText(ctx.organizationId) };
}

async function readPortalRecord(ctx: WidgetResolveContext, orgId: string, projectId: string) {
  const documentId = customerPortalDocumentId(projectId);
  if (!documentId) return {};
  const record = await ctx.services.platform.readDocument(orgId, "customer_portals", documentId).catch(() => null);
  return asObject(asObject(record).data);
}

/** Media ids the business has explicitly shared to this portal. */
function sharedMediaIds(portalData: JsonObject) {
  return asArray(portalData.shared_items)
    .map((item) => asObject(item))
    .filter((item) => cleanText(item.type || "media") === "media")
    .map((item) => cleanText(item.item_id || item.media_id))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// portal.activity_feed
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("portal.activity_feed", async (ctx, config) => {
  const scope = portalProject(ctx);
  if (!scope) return null;
  try {
    const limit = clampLimit(config.limit, 10, 50);
    const mode = configMode(config.source_mode);
    const allowedTypes = new Set(asArray(config.event_types).map(cleanText).filter(Boolean));
    const daysBack = Math.max(0, Math.min(3650, Math.round(Number(config.days_back) || 0)));
    const cutoff = daysBack ? Date.now() - daysBack * 86_400_000 : 0;
    // Over-fetch: most project events are internal, so the customer-visible
    // subset is much smaller than the raw row count.
    const rows = mode === "manual" ? [] : (await listEventRecords(scope.orgId, { project_id: scope.projectId, limit: Math.min(500, limit * 12) }));
    const entries: JsonObject[] = [];
    for (const row of rows) {
      const event = asObject(row);
      const type = cleanText(event.type);
      if (allowedTypes.size && !allowedTypes.has(type)) continue;
      if (cutoff && Date.parse(cleanText(event.created_at)) < cutoff) continue;
      const descriptor = workEventCustomerDescriptor(type);
      // Default deny: only events carrying an explicit customer descriptor are
      // eligible, and the label is composed from allowlisted payload keys only.
      if (!descriptor) continue;
      const label = renderCustomerEventLabel(type, asObject(event.payload));
      if (!label) continue;
      entries.push({
        id: cleanText(event.id),
        label,
        icon: cleanText(descriptor.icon) || "fa-circle-check",
        at: cleanText(event.created_at)
      });
    }
    if (mode !== "automatic") {
      for (const value of asArray(config.manual_entries)) {
        const entry = asObject(value);
        const label = cleanText(entry.label || entry.title).slice(0, 180);
        if (!label) continue;
        entries.push({
          id: cleanText(entry.id) || `manual_${entries.length + 1}`,
          label,
          detail: cleanText(entry.detail || entry.description).slice(0, 500),
          icon: cleanText(entry.icon) || "fa-circle-check",
          at: cleanText(entry.at || entry.date)
        });
      }
    }
    entries.sort((left, right) => cleanText(right.at).localeCompare(cleanText(left.at)));
    if (config.newest_first === false) entries.reverse();
    return { entries: entries.slice(0, limit) };
  } catch {
    return { entries: [] };
  }
});

// ---------------------------------------------------------------------------
// portal.reviews
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("portal.reviews", async (ctx, config) => {
  const scope = portalProject(ctx);
  if (!scope) return null;
  try {
    // This widget is unfinished and intentionally dark by default. The catalog
    // also omits it, but the runtime gate is required for older published pages
    // and seeded definitions that may already contain portal.reviews nodes.
    const { isCapabilityEnabled } = await import("./capabilities.js");
    if (!(await isCapabilityEnabled(scope.orgId, "feedback.portal_reviews"))) {
      return { disabled: true };
    }
    const { listFeedbackRequestRecords, readFeedbackSettings } = await import("../feedback/storage.js");
    const branchId = cleanText(asObject(scope.project).branch_id) || "default";
    const read = await readFeedbackSettings(scope.orgId, branchId).catch(() => null);
    const settings = asObject(asObject(read).settings);
    const review = asObject(settings.review);
    const surveyScale = Number(asObject(settings.survey).scale) || 5;

    const records = await listFeedbackRequestRecords(scope.orgId).catch(() => []);
    const rated = records
      .map((record) => asObject(asObject(record).data))
      .filter((record) => Number(record.rating) > 0);

    const scale = rated.reduce((max, record) => Math.max(max, Number(record.rating_scale) || 5), 5);
    const total = rated.reduce((sum, record) => sum + Number(record.rating || 0), 0);
    // Normalize to a 5-point display scale so a 10-point survey does not render
    // as "9.2 out of 5".
    const average = rated.length ? (total / rated.length) * (5 / scale) : 0;

    // `review.mode === "never"` means this org keeps feedback private. Honor it
    // here too, not just on the rating page — otherwise the widget would publish
    // comments the org explicitly chose not to surface.
    const commentsAllowed = cleanText(review.mode).toLowerCase() !== "never";
    const limit = clampLimit(config.limit, 3, 20);
    const reviews = commentsAllowed
      ? rated
        .filter((record) => cleanText(record.comment))
        // Only positive feedback is shown publicly, using the org's own
        // review-routing threshold. Ratings and threshold are each normalized to
        // a 5-point scale first, because a record's survey scale can differ from
        // the org's current one (older records survive a settings change).
        .filter((record) => fivePoint(record.rating, record.rating_scale) >= fivePoint(review.threshold || 4, surveyScale))
        .sort((left, right) => cleanText(right.rated_at).localeCompare(cleanText(left.rated_at)))
        .slice(0, limit)
        .map((record) => ({
          // First name + last initial only: a review widget is a public surface
          // and full customer names do not belong on one.
          author: publicReviewAuthor(asObject(record.contact)),
          rating: Math.round((Number(record.rating) || 0) * (5 / (Number(record.rating_scale) || 5))),
          comment: cleanText(record.comment).slice(0, 600),
          at: cleanText(record.rated_at)
        }))
      : [];

    const destinations = asArray(review.destinations)
      .map((entry) => asObject(entry))
      .filter((entry) => entry.enabled !== false && cleanText(entry.url))
      .map((entry) => ({ label: cleanText(entry.label), url: cleanText(entry.url), icon: cleanText(entry.icon) || "fa-star" }));

    return {
      average_rating: Number(average.toFixed(2)),
      rating_count: rated.length,
      reviews,
      destinations
    };
  } catch {
    return { average_rating: 0, rating_count: 0, reviews: [], destinations: [] };
  }
});

/**
 * A job title a customer should see, or "" — never a permission slug.
 *
 * `data.role` holds access levels like "super_admin" / "viewer" / "custom".
 * Rendering those on a "meet your team" card is both meaningless to a customer
 * and a small disclosure of internal structure, so only an actual job title
 * counts.
 */
function customerFacingRole(data: JsonObject) {
  const title = cleanText(data.title || data.job_title || data.position);
  if (!title) return "";
  const SYSTEM_ROLES = ["super_admin", "admin", "owner", "manager", "member", "viewer", "custom", "crew", "office"];
  return SYSTEM_ROLES.includes(title.toLowerCase().replace(/\s+/g, "_")) ? "" : title;
}

/** Normalize a rating expressed on an arbitrary survey scale onto 5 points. */
function fivePoint(rating: unknown, scale: unknown) {
  const value = Number(rating) || 0;
  const denominator = Number(scale) || 5;
  return denominator > 0 ? (value * 5) / denominator : 0;
}

/** "Jordan R." — never a full name on a customer-visible reviews widget. */
function publicReviewAuthor(contact: JsonObject) {
  const name = cleanText(contact.name);
  if (!name) return "Verified customer";
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  if (!last) return first || "Verified customer";
  return `${first} ${last.slice(0, 1).toUpperCase()}.`;
}

// ---------------------------------------------------------------------------
// portal.team
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("portal.team", async (ctx, config) => {
  const scope = portalProject(ctx);
  if (!scope) return null;
  try {
    const mode = configMode(config.source_mode);
    const userIds = new Set<string>();
    if (mode !== "manual") {
      for (const userId of [...asArray(asObject(scope.project).assigned_user_ids), ...asArray(asObject(scope.project).team_user_ids)]) {
        const id = cleanText(userId);
        if (id) userIds.add(id);
      }
      for (const userId of [asObject(scope.project).manager_user_id, asObject(scope.project).salesperson_user_id, asObject(scope.project).coordinator_user_id]) {
        const id = cleanText(userId);
        if (id) userIds.add(id);
      }
      for (const eventValue of asArray(asObject(scope.project).events)) {
        for (const userId of asArray(asObject(eventValue).assigned_user_ids)) {
          const id = cleanText(userId);
          if (id) userIds.add(id);
        }
      }
      const calendarEvents = await ctx.services.platform.listDocuments(scope.orgId, "calendar_events").catch(() => []);
      for (const documentValue of calendarEvents) {
        const data = asObject(asObject(documentValue).data);
        if (cleanText(data.project_id) !== scope.projectId) continue;
        for (const userId of asArray(data.assigned_user_ids)) {
          const id = cleanText(userId);
          if (id) userIds.add(id);
        }
      }
    }
    for (const selected of asArray(config.selected_user_ids)) {
      const id = cleanText(asObject(selected).user_id || selected);
      if (id) userIds.add(id);
    }

    const showRole = config.show_role !== false;
    const showBio = config.show_bio === true;
    const members: JsonObject[] = [];
    for (const userId of [...userIds].slice(0, 24)) {
      const record = await ctx.services.platform.readDocument(scope.orgId, "users", userId).catch(() => null);
      if (!record) continue;
      const data = asObject(asObject(record).data);
      const profile = asObject(data.profile);
      const name = cleanText(data.name || data.full_name || profile.name);
      if (!name) continue;
      const avatarMediaId = cleanText(profile.avatar_media_id || data.avatar_media_id);
      // Deliberately narrow projection: name, role, photo. No email, no phone,
      // no employment or compensation fields — this renders to a customer.
      members.push({
        id: userId,
        name,
        ...(showRole ? { role: customerFacingRole({ ...data, ...profile }) } : {}),
        ...(showBio ? { bio: cleanText(profile.customer_bio || data.customer_bio || profile.bio || data.bio).slice(0, 500) } : {}),
        avatar_url: avatarMediaId
          ? portalMediaFileUrl(ctx, avatarMediaId, "original")
          : cleanText(profile.profile_photo || profile.avatar_url || data.avatar_url || data.photo_url || data.profile_photo_url)
      });
    }
    if (mode !== "automatic") {
      for (const value of asArray(config.manual_members)) {
        const member = asObject(value);
        const name = cleanText(member.name).slice(0, 100);
        if (!name) continue;
        const photo = await configuredMedia(ctx, member.photo || member.avatar);
        members.push({
          id: cleanText(member.id) || `manual_${members.length + 1}`,
          name,
          ...(showRole ? { role: cleanText(member.role).slice(0, 100) } : {}),
          ...(showBio ? { bio: cleanText(member.bio).slice(0, 500) } : {}),
          avatar_url: cleanText(photo?.url || member.avatar_url)
        });
      }
    }
    const orderedIds = asArray(config.member_order).map((value) => cleanText(asObject(value).user_id || value));
    if (orderedIds.length) {
      const rank = new Map(orderedIds.map((id, index) => [id, index]));
      members.sort((a, b) => (rank.get(cleanText(a.id)) ?? 999) - (rank.get(cleanText(b.id)) ?? 999));
    }
    return { members: members.slice(0, clampLimit(config.limit, 12, 24)) };
  } catch {
    return { members: [] };
  }
});

// ---------------------------------------------------------------------------
// portal.portfolio  (before/after pairs)
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("portal.portfolio", async (ctx, config) => {
  const scope = portalProject(ctx);
  if (!scope) return null;
  try {
    const mode = configMode(config.source_mode);
    const pairs: JsonObject[] = [];
    const limit = clampLimit(config.limit, 4, 24);

    if (mode !== "automatic") {
      for (const value of asArray(config.manual_pairs)) {
        if (pairs.length >= limit) break;
        const pair = asObject(value);
        const beforeMedia = await configuredMedia(ctx, pair.before || pair.before_media);
        const afterMedia = await configuredMedia(ctx, pair.after || pair.after_media);
        if (!beforeMedia?.url || !afterMedia?.url) continue;
        pairs.push({
          id: cleanText(pair.id) || `manual_${pairs.length + 1}`,
          label: cleanText(pair.label).slice(0, 120),
          caption: cleanText(pair.caption).slice(0, 500),
          before_url: beforeMedia.url,
          after_url: afterMedia.url
        });
      }
    }

    if (mode === "manual" || pairs.length >= limit) return { pairs: pairs.slice(0, limit) };

    const portalData = await readPortalRecord(ctx, scope.orgId, scope.projectId);
    const mediaIds = sharedMediaIds(portalData);
    if (!mediaIds.length) return { pairs };

    const before: JsonObject[] = [];
    const after: JsonObject[] = [];
    const beforeTag = cleanText(config.before_tag || "before").toLowerCase();
    const afterTag = cleanText(config.after_tag || "after").toLowerCase();
    for (const mediaId of mediaIds.slice(0, 60)) {
      const metadata = asObject(await ctx.services.media.readMediaMetadata(scope.orgId, mediaId).catch(() => null));
      const tags = asArray(metadata.tags).map((tag) => cleanText(tag).toLowerCase());
      const url = portalMediaFileUrl(ctx, mediaId, "original");
      const entry = { media_id: mediaId, url, pair_key: cleanText(metadata.pair_key), at: cleanText(metadata.created_at) };
      if (tags.includes(beforeTag)) before.push(entry);
      else if (tags.includes(afterTag)) after.push(entry);
    }

    // Pair explicitly when the media carries a pair_key, otherwise fall back to
    // positional pairing so the widget is useful before anyone adopts pair keys.
    const usedAfter = new Set<number>();
    for (const beforeEntry of before) {
      if (pairs.length >= limit) break;
      let matchIndex = beforeEntry.pair_key
        ? after.findIndex((entry, index) => !usedAfter.has(index) && entry.pair_key === beforeEntry.pair_key)
        : -1;
      if (matchIndex < 0) matchIndex = after.findIndex((_entry, index) => !usedAfter.has(index));
      const afterEntry = matchIndex >= 0 ? after[matchIndex] : null;
      if (!afterEntry) break;
      usedAfter.add(matchIndex);
      pairs.push({
        id: cleanText(beforeEntry.media_id),
        label: cleanText(beforeEntry.pair_key),
        caption: "",
        before_url: beforeEntry.url,
        after_url: afterEntry.url
      });
    }
    return { pairs };
  } catch {
    return { pairs: [] };
  }
});

// ---------------------------------------------------------------------------
// portal.welcome_video
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("portal.welcome_video", async (ctx, config) => {
  // The only portal.* widget that works without portal context: its source is a
  // configured media id, not project data, so it is safe on any surface.
  const mediaId = mediaIdFrom(config.media || config.media_id);
  if (!mediaId) return null;
  try {
    const orgId = cleanText(ctx.organizationId);
    const metadata = asObject(await ctx.services.media.readMediaMetadata(orgId, mediaId).catch(() => null));
    return {
      media_id: mediaId,
      url: portalMediaFileUrl(ctx, mediaId, "original"),
      poster_url: cleanText(metadata.poster_media_id)
        ? portalMediaFileUrl(ctx, cleanText(metadata.poster_media_id), "original")
        : "",
      content_type: cleanText(metadata.content_type)
    };
  } catch {
    return null;
  }
});

// ---------------------------------------------------------------------------
// portal.nearby_jobs
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("portal.nearby_jobs", async (ctx, config) => {
  const scope = portalProject(ctx);
  if (!scope) return null;
  try {
    const center = projectPoint(scope.project);
    if (!center) return { center: null, jobs: [], map_image_url: "" };
    const radius = Math.max(0.5, Math.min(100, Number(config.radius_miles) || 10));
    const limit = clampLimit(config.limit, 8, 30);
    const selectionMode = cleanText(config.selection_mode || "automatic").toLowerCase();
    const selectedProjectIds = new Set(asArray(config.selected_project_ids).map((value) => cleanText(asObject(value).project_id || value)).filter(Boolean));
    const allowedTypes = new Set(asArray(config.project_types).map((value) => cleanText(value).toLowerCase()).filter(Boolean));
    const allowedStatuses = new Set(asArray(config.statuses).map((value) => cleanText(value).toLowerCase()).filter(Boolean));
    const portalRecords = await ctx.services.platform.listDocuments(scope.orgId, "customer_portals").catch(() => []);
    const sharedByProject = new Map<string, string[]>();
    for (const documentValue of portalRecords) {
      const data = asObject(asObject(documentValue).data);
      if (cleanText(data.status || "active").toLowerCase() !== "active") continue;
      const id = cleanText(data.project_id);
      if (id) sharedByProject.set(id, sharedMediaIds(data));
    }
    const projects = await ctx.services.platform.listDocuments(scope.orgId, "projects").catch(() => []);
    const jobs: JsonObject[] = [];
    for (const documentValue of projects) {
      const project: JsonObject = { id: cleanText(asObject(documentValue).id), ...asObject(asObject(documentValue).data) };
      const id = cleanText(project.id);
      const automaticallyEligible = selectionMode !== "selected" && project.showcase_opt_in === true;
      const explicitlySelected = selectionMode !== "automatic" && selectedProjectIds.has(id);
      if (!id || id === scope.projectId || (!automaticallyEligible && !explicitlySelected)) continue;
      const type = projectType(project);
      const status = projectStatus(project);
      if (allowedTypes.size && !allowedTypes.has(type)) continue;
      if (allowedStatuses.size && !allowedStatuses.has(status)) continue;
      const mediaIds = sharedByProject.get(id) || [];
      if (!mediaIds.length) continue;
      const point = projectPoint(project);
      if (!point) continue;
      const distance = haversineMiles(center, point);
      if (distance > radius) continue;
      const coarse = coarsePoint(point);
      jobs.push({
        id,
        label: cleanText(project.showcase_title).slice(0, 100) || "Completed project",
        neighborhood: neighborhoodLabel(project),
        project_type: type,
        status,
        distance_miles: Number(distance.toFixed(1)),
        lat: coarse.lat,
        lng: coarse.lng,
        thumbnail_media_id: config.show_thumbnails === false ? "" : mediaIds[0]!
      });
    }
    jobs.sort((a, b) => Number(a.distance_miles) - Number(b.distance_miles));
    const selected = jobs.slice(0, limit);
    await Promise.all(selected.map(async (job) => {
      const mediaId = cleanText(job.thumbnail_media_id);
      job.thumbnail_url = "";
      delete job.thumbnail_media_id;
      if (!mediaId) return;
      const file = await ctx.services.media.readMediaFile(scope.orgId, mediaId, "thumb_320").catch(() => null);
      if (!file || !cleanText(file.contentType).startsWith("image/") || !file.bytes.length || file.bytes.length > 196_608) return;
      job.thumbnail_url = `data:${cleanText(file.contentType)};base64,${file.bytes.toString("base64")}`;
    }));
    const safeCenter = coarsePoint(center);
    return {
      center: safeCenter,
      radius_miles: radius,
      jobs: selected,
      map_image_url: googleStaticMapUrl(safeCenter, selected.map((job) => ({ lat: Number(job.lat), lng: Number(job.lng) })))
    };
  } catch {
    return { center: null, jobs: [], map_image_url: "" };
  }
});

// ---------------------------------------------------------------------------
// portal.recurring
// ---------------------------------------------------------------------------

const CADENCE_LABELS: Record<string, string> = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
  quarterly: "Every quarter",
  yearly: "Every year"
};

/** "Every 3 months" / "Every week" — plain language, never an RRULE. */
function cadenceLabel(recurrence: JsonObject) {
  const frequency = cleanText(recurrence.frequency).toLowerCase();
  const interval = Math.max(1, Math.round(Number(recurrence.interval) || 1));
  if (interval === 1) return CADENCE_LABELS[frequency] || "Recurring";
  const unit = { daily: "days", weekly: "weeks", monthly: "months", quarterly: "quarters", yearly: "years" }[frequency];
  return unit ? `Every ${interval} ${unit}` : "Recurring";
}

registerDocumentWidgetResolver("portal.recurring", async (ctx) => {
  const scope = portalProject(ctx);
  if (!scope) return null;
  try {
    const documents = await ctx.services.platform.listDocuments(scope.orgId, "recurrence_series").catch(() => []);
    const now = Date.now();
    const series: JsonObject[] = [];
    for (const documentValue of documents) {
      const data = asObject(asObject(documentValue).data);
      if (cleanText(data.project_id) !== scope.projectId) continue;
      if (cleanText(data.status || "active") !== "active") continue;
      // Only visit-shaped series belong in a customer view — payment schedules
      // and payables ride the same engine and are not "your recurring visits".
      const kind = cleanText(data.kind || data.target_kind || "calendar_event");
      if (kind && !["calendar_event", "appointment", "visit"].includes(kind)) continue;

      const occurrences = asArray(data.occurrences)
        .map((entry) => cleanText(asObject(entry).start_at || asObject(entry).at))
        .filter(Boolean)
        .sort();
      const next = occurrences.find((value) => Date.parse(value) >= now) || cleanText(data.next_at);
      series.push({
        title: cleanText(data.title) || "Recurring visit",
        cadence: cadenceLabel(asObject(data.recurrence)),
        next_at: next || ""
      });
    }
    return { series };
  } catch {
    return { series: [] };
  }
});

export const PORTAL_DOC_WIDGET_IDS = [
  "portal.activity_feed",
  "portal.reviews",
  "portal.team",
  "portal.portfolio",
  "portal.welcome_video",
  "portal.nearby_jobs",
  "portal.recurring"
] as const;
