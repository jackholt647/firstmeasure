import { gunzipSync, gzipSync } from "node:zlib";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { readInternalUser } from "../internal/storage.js";
import { authContextFromRequest, requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, forbidden, notFound, PlatformError } from "../platform/errors.js";
import { publishRealtimeEvent } from "../platform/realtime.js";
import { findIdentityByEmail, readIdentity, readOrganization, searchIdentities, searchOrganizations } from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { archiveOverview, runReplayArchive } from "./archive.js";
import { REPLAY_BLOB_KEY, replayBlobKey } from "./hash.js";
import {
  deleteReplaySession, listReplayPages, listReplaySessions, markReplayWatched, readReplayPageUrl, missingReplayBlobs, readReplayBlobs, readReplayChunkSizes,
  readReplayChunks, readReplaySession, replayStorageTotals, storeReplayBlob, storeReplayChunk
} from "./storage.js";
import {
  allowReplayPage, countReplayRules, decideReplay, excludedReplayPages, listReplayRuleLog, pageExcluded, pagePathOf, listReplayRules, readReplayMode, readReplayRules, removeReplayRule, REPLAY_MODES,
  setReplayMode, upsertReplayRules, type ReplayMode, type RuleInput, type RuleKind
} from "./targeting.js";

/**
 * Session replay routes (docs/architecture/session-replay.md), under /v1/platform.
 *
 * Recording: a signed-in person the targeting rules say to record (session-replay/targeting.ts: the platform mode,
 * then their own rule, then their organization's). The organization is always the session's own; the page never
 * names one. Viewing replays and deciding who is recorded: platform administrators only (full internal admins, the
 * same people who may change FirstMeasure prices). Customer organization owners and admins can do neither.
 */
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
  meta: z.record(z.unknown()).nullable().optional(),
  // Pages (path and hash) reached during the chunk, with the time each was reached.
  paths: z.array(z.tuple([z.string().max(500), z.number().finite()])).max(50).optional()
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
  return (await decideReplay({ identityId: ctx.identityId, orgId: ctx.orgId })).record;
}

async function requireRecorder(request: FastifyRequest) {
  const ctx = await requirePlatformAuth(request, { csrf: true });
  if (!(await replayEnabled(ctx))) throw forbidden("session_replay_off", "Session replay is off for this person.");
  return ctx;
}

const ruleKind = z.enum(["person", "organization", "page"]);
const ruleInputSchema = z.object({
  kind: ruleKind,
  // A person by identity id or email; an organization by id.
  target: z.string().trim().min(1).max(320),
  enabled: z.boolean(),
  // Either an end time, a number of days from now, or neither (until removed).
  expires_at: z.number().int().min(0).nullable().optional(),
  days: z.number().positive().max(3650).nullable().optional(),
  reason: z.string().trim().max(500).optional()
}).strict();

/** A rule as an administrator or a script names it, resolved to the identity or organization it is about. */
async function resolveRuleInput(input: z.infer<typeof ruleInputSchema>): Promise<RuleInput> {
  const now = Date.now();
  const expires = input.days ? now + Math.round(input.days * 86_400_000) : input.expires_at || 0;
  if (expires && expires <= now) throw badRequest("replay_rule_expired", "That end time has already passed.");
  if (input.kind === "page") {
    // A page is only ever excluded: a pattern over the path and hash, such as /portal/billing or /portal/#settings*.
    const pattern = input.target.trim().toLowerCase();
    if (!/^[/*#]/.test(pattern) || /[?\s]/.test(pattern)) {
      throw badRequest("invalid_page_pattern", "A page is a path such as /portal/billing, optionally with * for anything; no query string.");
    }
    if (input.enabled) throw badRequest("page_rules_exclude_only", "A page rule can only stop recording on that page.");
    return { kind: "page", target_id: pattern.slice(0, 300), enabled: false, expires_at: expires, reason: input.reason || "", label: pattern.slice(0, 300), detail: "" };
  }
  if (input.kind === "person") {
    const identity = input.target.includes("@")
      ? await findIdentityByEmail(input.target).catch(() => null)
      : await readIdentity(input.target).catch(() => null);
    if (!identity?.id) throw notFound("person_not_found", `No one signs in as ${input.target}.`);
    return { kind: "person", target_id: text(identity.id), enabled: input.enabled, expires_at: expires, reason: input.reason || "",
      label: text(identity.email), detail: text(identity.name) };
  }
  let organization: JsonObject;
  try { organization = await readOrganization(input.target); } catch { throw notFound("organization_not_found", `There is no organization ${input.target}.`); }
  return { kind: "organization", target_id: text(organization.id) || input.target, enabled: input.enabled, expires_at: expires,
    reason: input.reason || "", label: text(organization.name) || input.target, detail: text(organization.id) || input.target };
}

/** The organizations a person belongs to (ids and names, at most `limit`). */
async function personOrganizations(identity: JsonObject, limit = 5) {
  const memberships = (Array.isArray(identity.memberships) ? identity.memberships : []).map(asObject)
    .map((m) => text(m.organization_id)).filter(Boolean);
  const ids = [...new Set(memberships)];
  const names = await organizationNames(ids.slice(0, limit));
  return { total: ids.length, organizations: ids.slice(0, limit).map((id) => ({ organization_id: id, name: names[id] || id })) };
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
      exclude_pages: await excludedReplayPages(),
      mask_all_inputs: false,
      csrf_cookie: `${env.platformSessionCookieName}_csrf`
    };
  });

  app.post("/session-replay/chunks", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const ctx = await requireRecorder(request);
    const { header: body, ...decoded } = readChunk(request.body);
    // A page that loaded on a page not to be recorded is refused, so a recorder from before page rules (a tab left
    // open) stops there too. Current recorders pause on such pages and never send them.
    const excludedPages = await excludedReplayPages();
    if (excludedPages.length) {
      const loadedAt = text(asObject(body.meta).url) || await readReplayPageUrl(body.session_id, body.page_id);
      if (loadedAt && pageExcluded(excludedPages, pagePathOf(loadedAt))) {
        throw forbidden("session_replay_page_excluded", "This page is not recorded.");
      }
    }
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
      meta: body.meta ?? null,
      paths: body.paths
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

  // ---------------------------------------------------------------------------
  // Who is recorded (session-replay/targeting.ts)
  // ---------------------------------------------------------------------------
  app.get("/session-replay/admin/targeting", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    const kind = ruleKind.safeParse(text(query.kind)).success ? text(query.kind) as RuleKind : undefined;
    const state = ["recording", "excluded", "expired"].includes(text(query.state)) ? text(query.state) as "recording" | "excluded" | "expired" : undefined;
    const [mode, counts, page] = await Promise.all([
      readReplayMode(true), countReplayRules(), listReplayRules({ kind, state, cursor: text(query.cursor) || undefined, limit: Number(query.limit) || 50 })
    ]);
    return { ok: true, now: Date.now(), mode, counts, rules: page.rules, next: page.next };
  });

  app.put("/session-replay/admin/targeting/mode", async (request) => {
    const { email } = await requireReplayAdmin(request, true);
    const body = z.object({ mode: z.enum(REPLAY_MODES as [ReplayMode, ...ReplayMode[]]), reason: z.string().trim().max(500).optional() }).strict()
      .parse(request.body ?? {});
    return { ok: true, mode: await setReplayMode(body.mode, email, body.reason || "") };
  });

  // Sets up to 500 rules at once: { rules: [{ kind, target, enabled, days | expires_at, reason }] }. All or nothing.
  app.put("/session-replay/admin/targeting/rules", async (request) => {
    const { email } = await requireReplayAdmin(request, true);
    const body = z.object({ rules: z.array(ruleInputSchema).min(1).max(500) }).strict().parse(request.body ?? {});
    const resolved: RuleInput[] = [];
    for (const input of body.rules) resolved.push(await resolveRuleInput(input));
    return { ok: true, rules: await upsertReplayRules(resolved, email) };
  });

  app.delete("/session-replay/admin/targeting/rules/:kind/:targetId", async (request) => {
    const { email } = await requireReplayAdmin(request, true);
    const params = asObject(request.params);
    const kind = ruleKind.parse(text(params.kind));
    const reason = text(asObject(request.query).reason).slice(0, 500);
    // A page pattern holds slashes, so it may come as ?target= instead of in the path.
    const removed = await removeReplayRule(kind, text(asObject(request.query).target) || text(params.targetId), email, reason);
    if (!removed) throw notFound("replay_rule_not_found", "There is no such rule.");
    return { ok: true, removed };
  });

  // Record a page that is never recorded for a while: { target, minutes, reason }; minutes 0 stops at once.
  app.put("/session-replay/admin/targeting/pages/allow", async (request) => {
    const { email } = await requireReplayAdmin(request, true);
    const body = z.object({ target: z.string().trim().min(1).max(300), minutes: z.number().min(0).max(24 * 60), reason: z.string().trim().max(500).optional() })
      .strict().parse(request.body ?? {});
    const rule = await allowReplayPage(body.target.toLowerCase(), body.minutes ? Date.now() + Math.round(body.minutes * 60_000) : 0, email, body.reason || "");
    if (!rule) throw notFound("replay_rule_not_found", "That page is not in the list of pages never recorded.");
    return { ok: true, rule };
  });

  // People and organizations matching a search, a page at a time, each with its rule and what would happen now.
  app.get("/session-replay/admin/targeting/search", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    const q = text(query.q);
    const limit = Math.max(1, Math.min(50, Number(query.limit) || 20));
    const want = text(query.kind) || "all";
    if (q.length < 2) return { ok: true, people: [], organizations: [] };
    const [identities, organizations] = await Promise.all([
      want === "organizations" ? [] : searchIdentities(q, limit),
      want === "people" ? [] : searchOrganizations(q, limit)
    ]);
    const [personRules, orgRules, mode] = await Promise.all([
      readReplayRules("person", identities.map((i) => text(i.id))), readReplayRules("organization", organizations.map((o) => text(o.id))), readReplayMode()
    ]);
    const now = Date.now();
    const people = await Promise.all(identities.map(async (identity) => {
      const id = text(identity.id);
      const memberships = await personOrganizations(identity, 3);
      return { identity_id: id, email: text(identity.email), name: text(identity.name), ...memberships, rule: personRules.get(id) || null };
    }));
    const orgs = organizations.map((org) => {
      const id = text(org.id);
      return { organization_id: id, name: text(org.name) || id, rule: orgRules.get(id) || null };
    });
    return { ok: true, now, mode: mode.mode, people, organizations: orgs };
  });

  // Why a person is or is not recorded, in each organization they belong to (or the one named).
  app.get("/session-replay/admin/targeting/explain", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    const person = text(query.person);
    if (!person) throw badRequest("missing_person", "Name a person by email or identity id.");
    const identity = person.includes("@") ? await findIdentityByEmail(person).catch(() => null) : await readIdentity(person).catch(() => null);
    if (!identity?.id) throw notFound("person_not_found", `No one signs in as ${person}.`);
    const orgIds = text(query.org_id) ? [text(query.org_id)]
      : [...new Set((Array.isArray(identity.memberships) ? identity.memberships : []).map(asObject).map((m) => text(m.organization_id)).filter(Boolean))].slice(0, 50);
    const names = await organizationNames(orgIds);
    const decisions = await Promise.all(orgIds.map(async (orgId) => ({
      organization_id: orgId, name: names[orgId] || orgId, ...(await decideReplay({ identityId: text(identity.id), orgId }, Date.now()))
    })));
    return { ok: true, identity_id: text(identity.id), email: text(identity.email), name: text(identity.name), decisions };
  });

  app.get("/session-replay/admin/targeting/log", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    return { ok: true, entries: await listReplayRuleLog({ before: Number(query.before) || undefined, limit: Number(query.limit) || 50 }) };
  });

  // Earlier form of an organization rule (record everyone in it, until removed); kept for scripts and tests.
  app.put("/session-replay/admin/organizations/:orgId", async (request) => {
    const { email } = await requireReplayAdmin(request, true);
    const orgId = text(asObject(request.params).orgId);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body ?? {});
    const [rule] = await upsertReplayRules([await resolveRuleInput({ kind: "organization", target: orgId, enabled })], email);
    return { ok: true, organization_id: orgId, enabled: rule!.enabled };
  });

  app.get("/session-replay/admin/sessions", async (request) => {
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    const sessions = await listReplaySessions({
      organizationId: text(query.org_id) || undefined,
      before: Number(query.before) || undefined,
      limit: Number(query.limit) || 50,
      userQuery: text(query.q) || undefined,
      page: text(query.page) || undefined
    });
    const names = await organizationNames(sessions.map((s) => s.organization_id));
    return { ok: true, now: Date.now(), sessions: sessions.map((s) => ({ ...s, organization_name: names[s.organization_id] || s.organization_id })) };
  });

  // Pages seen in recordings, most visited first, for filtering sessions and choosing pages not to record.
  app.get("/session-replay/admin/pages", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    const query = asObject(request.query);
    const pages = await listReplayPages({ query: text(query.q) || undefined, organizationId: text(query.org_id) || undefined, limit: Number(query.limit) || 50 });
    return { ok: true, pages, excluded: await excludedReplayPages() };
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
