/**
 * Idempotency receipts for queued offline changes (docs/architecture/offline.md#server).
 *
 * A change queued on a device is sent with `Idempotency-Key: fmo1-<uuid>` and
 * is sent again when its answer never arrived. The first request runs and its
 * answer is kept; a repeat gets that answer and the handler does not run.
 *
 * - Only keys with the `fmo1-` prefix are ours. Routes that read
 *   `Idempotency-Key` themselves (payment receipts, the public API) use their
 *   own keys and are not touched.
 * - Only for a signed-in session, and a receipt belongs to that session's user
 *   and organization. `X-FM-Offline-User` / `X-FM-Offline-Org` can only refuse:
 *   identity always comes from the session.
 * - A key is claimed with an INSERT that fails on conflict, in the shared
 *   store, so two web nodes never both run the handler. Nothing here is
 *   remembered in the process except the requests it is running right now.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../src/config/env.js";
import { requestPrincipal, type Principal } from "../security/principal.js";
import { openSqlStore, type SqlStore } from "../sql_store.js";

export const OFFLINE_KEY_PREFIX = "fmo1-";
const KEY_PATTERN = /^fmo1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** How long a receipt answers repeats. */
export const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A request that has not marked its claim for this long is taken to have died with its process. */
export const ABANDONED_AFTER_MS = 2 * 60 * 1000;
/** A running request marks its claim this often, so a long upload is not taken for abandoned. */
const HEARTBEAT_MS = 30 * 1000;
/** A request that never answers (a hijacked stream) stops marking its claim after this long. */
const HEARTBEAT_LIMIT_MS = 30 * 60 * 1000;
/** A larger answer is not kept; a repeat gets `{ ok: true, replayed: true }` with the first status. */
export const MAX_STORED_BODY_BYTES = 1024 * 1024;
/** A JSON body larger than this is compared by length, not hashed. */
const MAX_HASHED_BODY_BYTES = 8 * 1024 * 1024;
/**
 * A multipart body's length depends on the boundary its sender chose, and the
 * page and the native uploader choose differently for the same file and
 * fields. Lengths this close are the same upload.
 */
const MULTIPART_LENGTH_SLACK = 2048;
/**
 * 4xx answers that describe the moment, not the request: the session, a CSRF
 * token, a lock, a rate limit, a revision that moved. They free the key, so
 * the same change runs again after a sign-in, a fresh token or a merge.
 */
const UNKEPT_STATUSES = new Set([401, 403, 408, 409, 423, 425, 429]);
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const PRUNE_BATCH = 500;

type BodyKind = "none" | "json" | "multipart" | "other";
type Fingerprint = { method: string; path: string; bodyKind: BodyKind; bodyHash: string; bodyLength: number };
type Owner = { orgId: string; userId: string };
type Claim = Owner & { key: string; token: string; startedAt: number; settled: boolean; heartbeat: NodeJS.Timeout | null };
type Outcome =
  | { kind: "run"; token: string }
  | { kind: "replay"; status: number; body: string | null }
  | { kind: "busy" }
  | { kind: "reused" };

let database: SqlStore | null = null;
let databasePath = "";

/** The shared receipts store. Exported for tests, which age rows instead of waiting. */
export function offlineIdempotencyStore() {
  const filename = path.resolve(env.platformStorageRoot, "offline-idempotency.sqlite");
  if (database && databasePath === filename) return database;
  databasePath = filename;
  database = openSqlStore({
    id: "offline_idempotency",
    filename,
    schemaVersion: 1,
    initialize: async (db) => {
      // Times are epoch milliseconds (BIGINT: they do not fit PostgreSQL's INTEGER).
      await db.exec(`
        CREATE TABLE IF NOT EXISTS offline_idempotency (
          organization_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          body_kind TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          body_length BIGINT NOT NULL,
          state TEXT NOT NULL,
          claim TEXT NOT NULL,
          status INTEGER NOT NULL DEFAULT 0,
          response_json TEXT,
          created_at BIGINT NOT NULL,
          claimed_at BIGINT NOT NULL,
          completed_at BIGINT NOT NULL DEFAULT 0,
          expires_at BIGINT NOT NULL,
          PRIMARY KEY (organization_id, user_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS offline_idempotency_expires_idx ON offline_idempotency(expires_at);
      `);
    }
  });
  return database;
}

function header(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
}

/** The signed-in session's user and organization, or null for every other kind of caller. */
function sessionOwner(principal: Principal): Owner | null {
  const auth = principal.kind === "customer" || principal.kind === "staff" ? principal.auth : null;
  return auth && auth.userId && auth.orgId ? { orgId: String(auth.orgId), userId: String(auth.userId) } : null;
}

/** JSON with object keys in order, so the same content always hashes the same. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function isParsedBody(body: unknown) {
  if (body === null || body === undefined) return false;
  if (typeof body !== "object") return true;
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) return false;
  // A stream (a body no parser read) is not content we can hash.
  return typeof (body as { pipe?: unknown }).pipe !== "function";
}

/**
 * What makes two requests the same request. A parsed body (JSON, or a form's
 * fields) is hashed. A multipart body is a stream the handler has yet to read,
 * so it is told apart by its length; so is anything else.
 */
export function requestFingerprint(request: FastifyRequest): Fingerprint {
  const contentType = header(request, "content-type").toLowerCase();
  const declared = Number(header(request, "content-length"));
  const bodyLength = Number.isFinite(declared) && header(request, "content-length") !== "" ? declared : -1;
  const base = { method: request.method, path: request.url };
  if (contentType.startsWith("multipart/")) return { ...base, bodyKind: "multipart", bodyHash: "", bodyLength };
  if (request.body === undefined || request.body === null) return { ...base, bodyKind: "none", bodyHash: "", bodyLength: Math.max(bodyLength, 0) };
  if (isParsedBody(request.body) && bodyLength <= MAX_HASHED_BODY_BYTES) {
    try {
      return { ...base, bodyKind: "json", bodyHash: createHash("sha256").update(canonicalJson(request.body)).digest("hex"), bodyLength };
    } catch {
      // Too deeply nested to walk: fall back to its length.
    }
  }
  return { ...base, bodyKind: "other", bodyHash: "", bodyLength };
}

function sameRequest(row: Record<string, unknown>, fingerprint: Fingerprint) {
  if (String(row.method) !== fingerprint.method || String(row.path) !== fingerprint.path || String(row.body_kind) !== fingerprint.bodyKind) return false;
  if (fingerprint.bodyKind === "json") return String(row.body_hash) === fingerprint.bodyHash;
  const stored = Number(row.body_length);
  // A length neither side declared (a streamed body) cannot tell requests apart.
  if (stored < 0 || fingerprint.bodyLength < 0) return true;
  return Math.abs(stored - fingerprint.bodyLength) <= (fingerprint.bodyKind === "multipart" ? MULTIPART_LENGTH_SLACK : 0);
}

const WHERE_KEY = "organization_id = ? AND user_id = ? AND idempotency_key = ?";

async function claimKey(owner: Owner, key: string, fingerprint: Fingerprint): Promise<Outcome> {
  const db = offlineIdempotencyStore();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = Date.now();
    const token = randomUUID();
    // The claim: whoever inserts the row runs the request. Never read first.
    const inserted = await db.prepare(`INSERT INTO offline_idempotency
      (organization_id, user_id, idempotency_key, method, path, body_kind, body_hash, body_length, state, claim, status, response_json, created_at, claimed_at, completed_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, NULL, ?, ?, 0, ?)
      ON CONFLICT (organization_id, user_id, idempotency_key) DO NOTHING`)
      .run(owner.orgId, owner.userId, key, fingerprint.method, fingerprint.path, fingerprint.bodyKind, fingerprint.bodyHash, fingerprint.bodyLength, token, now, now, now + RECEIPT_TTL_MS);
    if (inserted.changes === 1) return { kind: "run", token };

    const row = await db.prepare(`SELECT * FROM offline_idempotency WHERE ${WHERE_KEY}`).get(owner.orgId, owner.userId, key);
    if (!row) continue; // Freed between the insert and the read.
    const held = String(row.claim);
    if (String(row.state) === "done") {
      if (Number(row.expires_at) <= now) {
        await db.prepare(`DELETE FROM offline_idempotency WHERE ${WHERE_KEY} AND claim = ?`).run(owner.orgId, owner.userId, key, held);
        continue;
      }
      if (!sameRequest(row, fingerprint)) return { kind: "reused" };
      return { kind: "replay", status: Number(row.status) || 200, body: row.response_json === null || row.response_json === undefined ? null : String(row.response_json) };
    }
    if (now - Number(row.claimed_at) > ABANDONED_AFTER_MS) {
      // Its request died without answering. Take the row over; only one taker's update matches the old claim.
      const taken = await db.prepare(`UPDATE offline_idempotency
        SET method = ?, path = ?, body_kind = ?, body_hash = ?, body_length = ?, claim = ?, created_at = ?, claimed_at = ?, expires_at = ?
        WHERE ${WHERE_KEY} AND state = 'running' AND claim = ?`)
        .run(fingerprint.method, fingerprint.path, fingerprint.bodyKind, fingerprint.bodyHash, fingerprint.bodyLength, token, now, now, now + RECEIPT_TTL_MS, owner.orgId, owner.userId, key, held);
      if (taken.changes === 1) return { kind: "run", token };
      continue;
    }
    return sameRequest(row, fingerprint) ? { kind: "busy" } : { kind: "reused" };
  }
  return { kind: "busy" };
}

async function keepAnswer(claim: Claim, status: number, body: string | null) {
  const now = Date.now();
  await offlineIdempotencyStore().prepare(`UPDATE offline_idempotency
    SET state = 'done', status = ?, response_json = ?, completed_at = ?, expires_at = ?
    WHERE ${WHERE_KEY} AND state = 'running' AND claim = ?`)
    .run(status, body, now, now + RECEIPT_TTL_MS, claim.orgId, claim.userId, claim.key, claim.token);
}

async function freeKey(claim: Claim) {
  await offlineIdempotencyStore().prepare(`DELETE FROM offline_idempotency WHERE ${WHERE_KEY} AND state = 'running' AND claim = ?`)
    .run(claim.orgId, claim.userId, claim.key, claim.token);
}

async function markClaim(claim: Claim) {
  await offlineIdempotencyStore().prepare(`UPDATE offline_idempotency SET claimed_at = ? WHERE ${WHERE_KEY} AND state = 'running' AND claim = ?`)
    .run(Date.now(), claim.orgId, claim.userId, claim.key, claim.token);
}

/** Removes up to `batch` expired receipts. Returns how many went. */
export async function pruneOfflineIdempotency(now = Date.now(), batch = PRUNE_BATCH) {
  const result = await offlineIdempotencyStore().prepare(`DELETE FROM offline_idempotency
    WHERE (organization_id, user_id, idempotency_key) IN (
      SELECT organization_id, user_id, idempotency_key FROM offline_idempotency WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)`)
    .run(now, Math.max(1, Math.floor(batch)));
  return result.changes;
}

let lastPruneAt = 0;
function pruneNowAndThen(request: FastifyRequest) {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  void pruneOfflineIdempotency(now).catch((error) => request.log.warn({ err: error }, "Offline idempotency receipts were not pruned."));
}

/** What a repeat is answered with: the JSON that was sent, or a stand-in when it was not JSON or too large to keep. */
function answerToKeep(reply: FastifyReply, payload: unknown, status: number): string | null {
  if (payload === null || payload === undefined || payload === "") return null;
  const type = String(reply.getHeader("content-type") ?? "").toLowerCase();
  const standIn = JSON.stringify(status < 400 ? { ok: true, replayed: true } : { ok: false, error: "request_failed", replayed: true });
  if (!type.includes("json")) return standIn;
  if (typeof payload === "string") return Buffer.byteLength(payload) <= MAX_STORED_BODY_BYTES ? payload : standIn;
  if (Buffer.isBuffer(payload)) return payload.length <= MAX_STORED_BODY_BYTES ? payload.toString("utf8") : standIn;
  return standIn;
}

/** The client went away before its request had fully arrived, so an error answer may be about half a body. */
function requestWasCutShort(request: FastifyRequest) {
  const raw = request.raw as { aborted?: boolean; destroyed?: boolean; complete?: boolean };
  return raw.aborted === true || (raw.destroyed === true && raw.complete === false);
}

/** A route that hands the request to another host (the compatibility proxy): that host runs the handler and keeps the receipt. */
function forwardsElsewhere(reply: FastifyReply) {
  return typeof (reply as unknown as { from?: unknown }).from === "function";
}

function refuse(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ ok: false, error, message });
}

export function installOfflineIdempotency(app: FastifyInstance) {
  const running = new WeakMap<FastifyRequest, Claim>();

  async function settle(request: FastifyRequest, claim: Claim, status: number, body: () => string | null) {
    if (claim.settled) return;
    claim.settled = true;
    if (claim.heartbeat) clearInterval(claim.heartbeat);
    try {
      // 5xx: nothing is known to have happened, so the change may run again.
      const keep = status >= 200 && status < 500 && !UNKEPT_STATUSES.has(status) && !(status >= 400 && requestWasCutShort(request));
      if (keep) await keepAnswer(claim, status, body());
      else await freeKey(claim);
    } catch (error) {
      request.log.warn({ err: error }, "An offline idempotency receipt was not saved.");
    }
  }

  // preHandler: the body is parsed (its hash needs it) and, on covered routes, the route gate has passed.
  app.addHook("preHandler", async (request, reply) => {
    if (!MUTATING.has(request.method)) return;
    const key = header(request, "idempotency-key").toLowerCase();
    const keyed = key.startsWith(OFFLINE_KEY_PREFIX);
    const saysUser = header(request, "x-fm-offline-user");
    const saysOrg = header(request, "x-fm-offline-org");
    if (!keyed && !saysUser && !saysOrg) return;

    // Not signed in (or an unreadable credential): the handler answers as it always has, and the queue waits for a sign-in.
    const owner = await requestPrincipal(request).then(sessionOwner, () => null);
    if (!owner) return;
    if ((saysUser && saysUser !== owner.userId) || (saysOrg && saysOrg !== owner.orgId)) {
      return refuse(reply, 409, "offline_identity_mismatch", "This change was made by another person or in another organization.");
    }
    if (!keyed || forwardsElsewhere(reply)) return;
    if (!KEY_PATTERN.test(key)) return refuse(reply, 400, "idempotency_key_invalid", "An offline Idempotency-Key is fmo1- followed by a UUID.");

    pruneNowAndThen(request);
    const outcome = await claimKey(owner, key, requestFingerprint(request));
    if (outcome.kind === "replay") {
      reply.code(outcome.status).header("Idempotency-Replayed", "true");
      return outcome.body === null ? reply.send() : reply.type("application/json; charset=utf-8").send(outcome.body);
    }
    if (outcome.kind === "busy") {
      reply.header("Retry-After", "2");
      return refuse(reply, 409, "idempotency_in_progress", "The first request with this Idempotency-Key is still running.");
    }
    if (outcome.kind === "reused") return refuse(reply, 422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request.");

    const claim: Claim = { ...owner, key, token: outcome.token, startedAt: Date.now(), settled: false, heartbeat: null };
    claim.heartbeat = setInterval(() => {
      if (claim.settled || Date.now() - claim.startedAt > HEARTBEAT_LIMIT_MS) { if (claim.heartbeat) clearInterval(claim.heartbeat); return; }
      void markClaim(claim).catch(() => undefined);
    }, HEARTBEAT_MS);
    claim.heartbeat.unref?.();
    running.set(request, claim);
  });

  // Registered before response compression, so the payload here is the JSON text the handler produced.
  // The receipt is written before the answer leaves: an answer the device never receives is still replayed.
  app.addHook("onSend", async (request, reply, payload) => {
    const claim = running.get(request);
    if (claim) await settle(request, claim, reply.statusCode, () => answerToKeep(reply, payload, reply.statusCode));
    return payload;
  });

  // A reply that never went through onSend (a hijacked stream). While `sent` is false the handler is still
  // working for a client that left, and onSend will settle it.
  app.addHook("onResponse", async (request, reply) => {
    const claim = running.get(request);
    if (!claim || claim.settled || !reply.sent) return;
    const status = reply.raw.statusCode || reply.statusCode;
    await settle(request, claim, status, () => JSON.stringify({ ok: true, replayed: true }));
  });
}
