import { gunzipSync, gzipSync } from "node:zlib";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { readInternalUser } from "../internal/storage.js";
import { authContextFromRequest, requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { effectiveCapabilities, isCapabilityEnabled, saveCapabilityValues } from "../platform/capabilities.js";
import { badRequest, conflict, forbidden, notFound, PlatformError } from "../platform/errors.js";
import { publishRealtimeEvent } from "../platform/realtime.js";
import { listIdentityMemberships, listOrganizations, readOrganization } from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { archiveOverview, runReplayArchive } from "./archive.js";
import { REPLAY_BLOB_KEY, replayBlobKey } from "./hash.js";
import {
  deleteReplaySession, listReplaySessions, listReplaySettings, markReplayWatched, missingReplayBlobs, readReplayBlobs, readReplayChunkSizes,
  readReplayChunks, readReplaySession, recordReplaySetting, replayStorageTotals, storeReplayBlob, storeReplayChunk
} from "./storage.js";

/**
 * Session replay routes (docs/architecture/session-replay.md), under /v1/platform.
 *
 * Recording: any signed-in person whose organization has `platform.session_replay`
 * on. The organization is always the session's own; the page never names one.
 * Viewing and switching it on: platform administrators only (full internal admins,
 * the same people who may change FirstMeasure prices).
 */
export const SESSION_REPLAY_CAPABILITY = "platform.session_replay";
// A recorder uploads every 20 seconds; while an administrator has the session open live, every 2. Each chunk's reply
// carries the interval, and starting to watch also nudges the page over its platform event stream.
const CHUNK_INTERVAL_MS = 20_000;
const WATCHED_INTERVAL_MS = 2_000;
const WATCH_MS = 15_000;
const LIVE_MS = 60_000;
// Chunks and blobs arrive as a binary frame: 4-byte big-endian header length, header JSON, then the payload bytes.
const FRAME_TYPE = "application/vnd.firstmate.replay-frame";
const MAX_FRAME_HEADER = 256 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 20 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

const chunkSchema = z.object({
  session_id: z.string().regex(/^[a-z0-9]{8,40}$/),
  page_id: z.string().regex(/^[a-z0-9]{4,40}$/),
  seq: z.number().int().min(0).max(10_000_000),
  page_started_at: z.number().finite(),
  t_start: z.number().finite(),
  t_end: z.number().finite(),
  events: z.number().int().min(0).max(10_000_000),
  raw_bytes: z.number().int().min(0).max(256 * 1024 * 1024),
  encoding: z.enum(["gzip", "identity", "json"]),
  data: z.string().max(12_000_000).optional(),
  json: z.string().max(12_000_000).optional(),
  meta: z.record(z.unknown()).nullable().optional()
}).strict();

const chunkHeaderSchema = chunkSchema.omit({ data: true, json: true }).extend({ encoding: z.enum(["gzip", "identity"]) });

const blobSchema = z.object({
  key: z.string().regex(REPLAY_BLOB_KEY),
  raw_bytes: z.number().int().min(0).max(MAX_BLOB_BYTES * 4),
  encoding: z.enum(["gzip", "identity"]),
  data: z.string().max(30_000_000)
}).strict();

const blobHeaderSchema = blobSchema.omit({ data: true });

function readFrame(body: Buffer) {
  const headerLength = body.length >= 4 ? body.readUInt32BE(0) : -1;
  if (headerLength < 2 || headerLength > MAX_FRAME_HEADER || 4 + headerLength > body.length) {
    throw badRequest("invalid_replay_frame", "This replay upload is not a valid frame.");
  }
  let header: unknown;
  try { header = JSON.parse(body.subarray(4, 4 + headerLength).toString("utf8")); }
  catch { throw badRequest("invalid_replay_frame", "This replay upload is not a valid frame."); }
  return { header, payload: body.subarray(4 + headerLength) };
}

async function replayEnabled(ctx: PlatformAuthContext) {
  const resolution = ctx.capabilities || await effectiveCapabilities(ctx.orgId, ctx.userId);
  return resolution.effectiveByKey[SESSION_REPLAY_CAPABILITY] === true;
}

async function requireRecorder(request: FastifyRequest) {
  const ctx = await requirePlatformAuth(request, { csrf: true });
  if (!(await replayEnabled(ctx))) throw forbidden("session_replay_off", "Session replay is off for this organization.");
  return ctx;
}

async function requireReplayAdmin(request: FastifyRequest, csrf = false) {
  const ctx = await requirePlatformAuth(request, { csrf });
  const email = text(ctx.identity.email).toLowerCase();
  const user = email ? await readInternalUser(email).catch(() => null) : null;
  const permissions = asObject(user?.permissions);
  // Customer organization owners and admins do not qualify: replays show every
  // member's screens, so only platform administrators read them for now.
  const admin = user && !user.disabled && user.status === "active" && (["admin", "system_admin"].includes(text(user.role).toLowerCase())
    || user.is_admin === true || permissions.is_admin_legacy === true || permissions.platform_admin === true);
  if (!admin) throw forbidden("platform_admin_required", "Only platform administrators can use session replay.");
  return { ctx, email };
}

/** A chunk as uploaded: a frame (the recorder), or JSON with base64 or text (older recorders, other transports). */
function readChunk(body: unknown) {
  if (Buffer.isBuffer(body)) {
    const frame = readFrame(body);
    const header = chunkHeaderSchema.parse(frame.header);
    return { header, ...decodeChunk(header.encoding, frame.payload) };
  }
  const header = chunkSchema.parse(body ?? {});
  const bytes = header.encoding === "json" ? Buffer.from(header.json ?? "", "utf8") : Buffer.from(header.data ?? "", "base64");
  return { header, ...decodeChunk(header.encoding === "json" ? "identity" : header.encoding, bytes) };
}

function decodeChunk(encoding: string, bytes: Buffer) {
  if (encoding === "identity") return { stored: gzipSync(bytes), raw: bytes.length };
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw badRequest("invalid_replay_chunk", "Replay chunks must be gzip data.");
  return { stored: bytes, raw: -1 };
}

async function organizationNames(ids: string[]) {
  const names: Record<string, string> = {};
  await Promise.all([...new Set(ids)].filter(Boolean).map(async (id) => {
    try { names[id] = text((await readOrganization(id)).name) || id; } catch { names[id] = id; }
  }));
  return names;
}

export async function registerSessionReplayRoutes(app: FastifyInstance) {
  app.addContentTypeParser(FRAME_TYPE, { parseAs: "buffer", bodyLimit: 32 * 1024 * 1024 }, (_request, body, done) => done(null, body));

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------
  app.get("/session-replay/config", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const ctx = await authContextFromRequest(request);
    if (!ctx) return { ok: true, enabled: false, reason: "signed_out" };
    if (!(await replayEnabled(ctx))) return { ok: true, enabled: false, reason: "off" };
    return {
      ok: true,
      enabled: true,
      org_id: ctx.orgId,
      user_id: ctx.userId,
      chunk_interval_ms: CHUNK_INTERVAL_MS,
      mask_all_inputs: false,
      csrf_cookie: `${env.platformSessionCookieName}_csrf`
    };
  });

  app.post("/session-replay/chunks", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const ctx = await requireRecorder(request);
    const { header: body, ...decoded } = readChunk(request.body);
    if (!decoded.stored.length || decoded.stored.length > MAX_CHUNK_BYTES) throw badRequest("invalid_replay_chunk", "This replay chunk is empty or too large.");
    const { status: result, watched_until } = await storeReplayChunk({
      organization_id: ctx.orgId,
      user_id: ctx.userId,
      user_email: text(ctx.identity.email || ctx.user.email).toLowerCase(),
      user_name: text(ctx.user.name || ctx.identity.name),
      session_id: body.session_id,
      page_id: body.page_id,
      seq: body.seq,
      page_started_at: body.page_started_at,
      t_start: body.t_start,
      t_end: Math.max(body.t_start, body.t_end),
      events: body.events,
      bytes_raw: decoded.raw >= 0 ? decoded.raw : body.raw_bytes,
      data: decoded.stored,
      meta: body.meta ?? null
    });
    if (result === "conflict") throw conflict("session_replay_conflict", "This replay session belongs to another person or organization.");
    // The recorder starts a new session on 409, as it does for a conflict.
    if (result === "archived") throw conflict("session_replay_archived", "This replay session has been archived.");
    if (result === "full") throw new PlatformError("session_replay_full", 413, "This replay session has reached its size limit.");
    return { ok: true, stored: result === "stored", next_ms: watched_until > Date.now() ? WATCHED_INTERVAL_MS : CHUNK_INTERVAL_MS };
  });

  app.post("/session-replay/blobs/missing", async (request) => {
    const ctx = await requireRecorder(request);
    const keys = z.object({ keys: z.array(z.string().regex(REPLAY_BLOB_KEY)).max(500) }).strict().parse(request.body ?? {}).keys;
    return { ok: true, missing: await missingReplayBlobs(ctx.orgId, [...new Set(keys)]) };
  });

  app.post("/session-replay/blobs", { bodyLimit: 32 * 1024 * 1024 }, async (request) => {
    const ctx = await requireRecorder(request);
    let body: z.infer<typeof blobHeaderSchema>;
    let bytes: Buffer;
    if (Buffer.isBuffer(request.body)) {
      const frame = readFrame(request.body);
      body = blobHeaderSchema.parse(frame.header);
      bytes = frame.payload;
    } else {
      const parsed = blobSchema.parse(request.body ?? {});
      body = parsed;
      bytes = Buffer.from(parsed.data, "base64");
    }
    let raw: Buffer;
    try { raw = body.encoding === "gzip" ? gunzipSync(bytes, { maxOutputLength: MAX_BLOB_BYTES * 4 }) : bytes; }
    catch { throw badRequest("invalid_replay_blob", "This replay blob is not valid gzip data."); }
    const content = raw.toString("utf8");
    if (replayBlobKey(content) !== body.key) throw badRequest("replay_blob_mismatch", "This replay blob does not match its key.");
    const stored = body.encoding === "gzip" ? bytes : gzipSync(raw);
    if (stored.length > MAX_BLOB_BYTES) throw badRequest("replay_blob_too_large", "This replay blob is too large.");
    return { ok: true, stored: await storeReplayBlob(ctx.orgId, body.key, raw.length, stored) };
  });

  // ---------------------------------------------------------------------------
  // Viewing and switching on (platform administrators)
  // ---------------------------------------------------------------------------
  app.get("/session-replay/admin/me", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { ctx, email } = await requireReplayAdmin(request);
    return { ok: true, admin: true, email, org_id: ctx.orgId, org_name: text(ctx.organization.name), csrf: ctx.csrfToken };
  });

  app.get("/session-replay/admin/organizations", async (request) => {
    const { ctx } = await requireReplayAdmin(request);
    const query = text(asObject(request.query).q).toLowerCase();
    const [settings, totals, memberships] = await Promise.all([
      listReplaySettings(), replayStorageTotals(), listIdentityMemberships(ctx.identityId).catch(() => [])
    ]);
    const ids = new Set<string>([ctx.orgId, ...settings.map((s) => s.organization_id), ...totals.map((t) => t.organization_id)]);
    for (const membership of memberships as JsonObject[]) ids.add(text(asObject(membership.organization).id));
    if (query) {
      const all = await listOrganizations();
      for (const org of all) {
        if (ids.size > 400) break;
        const name = text(org.name).toLowerCase(), id = text(org.id).toLowerCase();
        if (name.includes(query) || id.includes(query)) ids.add(text(org.id));
      }
    }
    ids.delete("");
    const names = await organizationNames([...ids]);
    const settingByOrg = new Map(settings.map((s) => [s.organization_id, s]));
    const totalByOrg = new Map(totals.map((t) => [t.organization_id, t]));
    const rows = await Promise.all([...ids].map(async (id) => ({
      organization_id: id,
      name: names[id] || id,
      enabled: await isCapabilityEnabled(id, SESSION_REPLAY_CAPABILITY).catch(() => false),
      current: id === ctx.orgId,
      setting: settingByOrg.get(id) || null,
      totals: totalByOrg.get(id) || null
    })));
    const filtered = query ? rows.filter((row) => row.name.toLowerCase().includes(query) || row.organization_id.toLowerCase().includes(query)) : rows;
    filtered.sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    return { ok: true, organizations: filtered.slice(0, 100) };
  });

  app.put("/session-replay/admin/organizations/:orgId", async (request) => {
    const { email } = await requireReplayAdmin(request, true);
    const orgId = text(asObject(request.params).orgId);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body ?? {});
    try { await readOrganization(orgId); } catch { throw notFound("organization_not_found", "That organization does not exist."); }
    await saveCapabilityValues(orgId, { [SESSION_REPLAY_CAPABILITY]: enabled });
    await recordReplaySetting(orgId, enabled, email);
    return { ok: true, organization_id: orgId, enabled: await isCapabilityEnabled(orgId, SESSION_REPLAY_CAPABILITY) };
  });

  app.get("/session-replay/admin/sessions", async (request) => {
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    const sessions = await listReplaySessions({
      organizationId: text(query.org_id) || undefined,
      before: Number(query.before) || undefined,
      limit: Number(query.limit) || 50,
      userQuery: text(query.q) || undefined
    });
    const names = await organizationNames(sessions.map((s) => s.organization_id));
    return { ok: true, now: Date.now(), sessions: sessions.map((s) => ({ ...s, organization_name: names[s.organization_id] || s.organization_id })) };
  });

  app.get("/session-replay/admin/sessions/:sessionId", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    const sessionId = text(asObject(request.params).sessionId);
    const found = await readReplaySession(sessionId);
    if (!found) throw notFound("session_replay_not_found", "That replay session does not exist.");
    // The viewer asks with watch=1: its recorder then uploads every 2 seconds until nobody has looked for WATCH_MS.
    const now = Date.now();
    if (text(asObject(request.query).watch) === "1" && !found.session.archived_at && now - found.session.last_at < LIVE_MS
      && await markReplayWatched(sessionId, now, now + WATCH_MS)) {
      await publishRealtimeEvent({
        organization_id: found.session.organization_id, topic: "session_replay.watch", user_ids: [found.session.user_id],
        payload: { session_id: sessionId, interval_ms: WATCHED_INTERVAL_MS }
      }).catch(() => null);
    }
    const names = await organizationNames([found.session.organization_id]);
    return { ok: true, now, ...found, organization_name: names[found.session.organization_id], chunk_sizes: await readReplayChunkSizes(sessionId) };
  });

  app.get("/session-replay/admin/sessions/:sessionId/chunks", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    const sessionId = text(asObject(request.params).sessionId);
    const query = asObject(request.query);
    const pageId = text(query.page_id);
    if (!pageId) throw badRequest("missing_page", "A page id is required.");
    const chunks = await readReplayChunks(sessionId, pageId, Number(query.after_seq ?? -1), Number(query.limit) || 200);
    return { ok: true, chunks: chunks.map((chunk) => ({ ...chunk, data: chunk.data.toString("base64") })) };
  });

  app.get("/session-replay/admin/blobs", async (request) => {
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    const orgId = text(query.org_id);
    const keys = text(query.keys).split(",").map(text).filter((key) => REPLAY_BLOB_KEY.test(key)).slice(0, 200);
    if (!orgId) throw badRequest("missing_organization", "An organization is required.");
    const blobs = await readReplayBlobs(orgId, keys);
    return { ok: true, blobs: Object.fromEntries([...blobs].map(([key, data]) => [key, data.toString("base64")])) };
  });

  app.delete("/session-replay/admin/sessions/:sessionId", async (request) => {
    await requireReplayAdmin(request, true);
    return { ok: true, deleted: await deleteReplaySession(text(asObject(request.params).sessionId)) };
  });

  app.get("/session-replay/admin/stats", async (request) => {
    await requireReplayAdmin(request);
    const [totals, archive] = await Promise.all([replayStorageTotals(), archiveOverview()]);
    const names = await organizationNames(totals.map((t) => t.organization_id));
    return { ok: true, organizations: totals.map((t) => ({ ...t, name: names[t.organization_id] || t.organization_id })), archive };
  });

  // Archives (session-replay/archive.ts). A dry run writes only its report; a real run archives now what the
  // platform worker would archive later (sessions with no chunk for `older_than_hours`, default the job's setting).
  app.get("/session-replay/admin/archive", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    return { ok: true, ...(await archiveOverview()) };
  });

  app.post("/session-replay/admin/archive", async (request) => {
    await requireReplayAdmin(request, true);
    const body = z.object({
      dry_run: z.boolean().default(true),
      older_than_hours: z.number().min(0).max(24 * 3650).optional(),
      organization_id: z.string().max(120).optional(),
      session_ids: z.array(z.string().regex(/^[a-z0-9]{8,40}$/)).max(500).optional(),
      limit: z.number().int().min(1).max(5000).optional()
    }).strict().parse(request.body ?? {});
    const report = await runReplayArchive({
      dryRun: body.dry_run,
      olderThanMs: body.older_than_hours === undefined ? undefined : body.older_than_hours * 3600_000,
      organizationId: body.organization_id || undefined,
      sessionIds: body.session_ids,
      limit: body.limit
    });
    return { ok: true, report };
  });
}
