/**
 * Flood protection for "claim the next project" (FM-387).
 *
 * Every path that claims a next project (the staff console's legacy actions
 * `claim_next_for_me` and `execute_hot_swap`, `POST /queue/claim-next` and
 * `POST /queue/claim-next/compat`) counts one attempt for the verified caller
 * before it does any queue or database work. More than CLAIM_LIMIT attempts in
 * any CLAIM_WINDOW_MS window blocks that person for SHORT_BLOCK_MS; a block
 * that starts within REPEAT_WINDOW_MS of the previous block's end lasts
 * LONG_BLOCK_MS instead. A block has a fixed end: attempts during it are
 * refused, are not counted and do not extend it. A refused attempt gets the
 * empty-queue answer (`queue_empty`, 404), so nothing new reaches the browser.
 *
 * Someone clicking Next one claim at a time never comes near the limit; it is
 * for scripts that ask again the moment the queue answers empty.
 *
 * Empty-claim cooldown (2026-11-16): when a person's claim finds nothing,
 * `noteEmptyClaim` starts a short cooldown for them (the
 * `production_queue_empty_claim_cooldown_seconds` setting, read by the
 * callers). Until it ends, their queue claims are answered "No project
 * available" with `retry_after` before any queue or database work. When a
 * project turns ready, every waiting technician clicks at once and all but one
 * find nothing; the cooldown keeps those others from asking again in a loop.
 * A cooldown only starts after an empty answer, so a claim that can succeed is
 * never delayed by it; targeted claims (hot swap) pass `honorCooldown: false`.
 *
 * The count is shared by every process on every host: with PostgreSQL it is one
 * row per person in an unlogged table, updated by one statement per allowed
 * attempt. Each process remembers the blocks it has seen, so attempts during a
 * block are refused without a query. Without PostgreSQL (tests, local runs)
 * the count is in memory.
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";

import { knownPrincipal, principalEmail } from "../platform/security/principal.js";
import { isFirstMeasurePostgresEnabled, queryPostgres, withPostgresTransaction } from "../src/database/postgres.js";

export const CLAIM_LIMIT = 10;
export const CLAIM_WINDOW_MS = 5_000;
export const SHORT_BLOCK_MS = 5_000;
export const LONG_BLOCK_MS = 60_000;
export const REPEAT_WINDOW_MS = 60_000;

/** What `claimNextInQueue` throws when nothing can be claimed; a refused attempt answers the same. */
export const QUEUE_EMPTY_CODE = "queue_empty";
export const QUEUE_EMPTY_MESSAGE = "No eligible project was found in the queue.";

/**
 * The legacy-action answer for an empty queue: what `injectJson` makes of the
 * 404 from `/queue/claim-next/compat` (the FirstMeasure error handler's body).
 */
export function legacyQueueEmptyResult(retryAfterSeconds?: number) {
  if (!retryAfterSeconds) {
    return { ok: false, success: false, status_code: 404, error: QUEUE_EMPTY_CODE, message: QUEUE_EMPTY_MESSAGE, details: null };
  }
  return {
    ok: false, success: false, status_code: 404, error: QUEUE_EMPTY_CODE, message: QUEUE_EMPTY_MESSAGE,
    retry_after: retryAfterSeconds, details: { retry_after: retryAfterSeconds }
  };
}

export type ClaimLimitState = {
  /** Attempt times inside the current window, oldest first. */
  attempts: number[];
  /** End of the latest block (in the past once it is over); 0 when never blocked. */
  blockedUntil: number;
};

export type ClaimLimitStep = {
  state: ClaimLimitState;
  allowed: boolean;
  /** Set only on the attempt that started a block. */
  started?: { blockMs: number; attempts: number };
};

/** One attempt at `now`. The PostgreSQL statement below is this function in SQL; keep them the same. */
export function stepClaimLimit(state: ClaimLimitState, now: number): ClaimLimitStep {
  if (state.blockedUntil > now) return { state, allowed: false };
  const attempts = [...state.attempts.filter((time) => time > now - CLAIM_WINDOW_MS), now];
  if (attempts.length <= CLAIM_LIMIT) return { state: { attempts, blockedUntil: state.blockedUntil }, allowed: true };
  const blockMs = state.blockedUntil > 0 && now - state.blockedUntil < REPEAT_WINDOW_MS ? LONG_BLOCK_MS : SHORT_BLOCK_MS;
  return { state: { attempts: [], blockedUntil: now + blockMs }, allowed: false, started: { blockMs, attempts: attempts.length } };
}

export type ClaimAttempt = {
  allowed: boolean;
  blockedUntil?: number;
  started?: { blockMs: number; attempts: number };
  /** End of the person's empty-claim cooldown, when one is running. */
  cooldownUntil?: number;
  /** Why a refused attempt was refused. */
  reason?: "flood" | "cooldown";
  /** Whole seconds until the person may ask again (refused attempts only). */
  retryAfterSeconds?: number;
};

export type ClaimAttemptOptions = {
  /** False for targeted claims (hot swap), which an empty-queue cooldown must not stop. Default true. */
  honorCooldown?: boolean;
};

const memory = new Map<string, ClaimLimitState>();
/** Empty-claim cooldown ends without PostgreSQL. */
const memoryCooldowns = new Map<string, number>();
/** Blocks this process has seen, by identity: refused without asking the store. */
const knownBlocks = new Map<string, number>();
/** Cooldowns this process has seen or started, by identity. */
const knownCooldowns = new Map<string, number>();
const MAX_TRACKED = 10_000;

function rememberUntil(map: Map<string, number>, identity: string, until: number, now: number) {
  if (map.size >= MAX_TRACKED) {
    for (const [key, end] of map) if (end <= now) map.delete(key);
    if (map.size >= MAX_TRACKED) map.clear();
  }
  map.set(identity, until);
}

function rememberBlock(identity: string, until: number, now: number) {
  rememberUntil(knownBlocks, identity, until, now);
}

function secondsUntil(until: number, now: number) {
  return Math.max(1, Math.ceil((until - now) / 1000));
}

function attemptInMemory(identity: string, now: number): ClaimAttempt {
  const step = stepClaimLimit(memory.get(identity) ?? { attempts: [], blockedUntil: 0 }, now);
  memory.delete(identity);
  if (memory.size >= MAX_TRACKED) memory.delete(memory.keys().next().value as string);
  memory.set(identity, step.state);
  const cooldownUntil = memoryCooldowns.get(identity) ?? 0;
  return {
    allowed: step.allowed,
    blockedUntil: step.state.blockedUntil,
    ...(step.started ? { started: step.started } : {}),
    ...(cooldownUntil > now ? { cooldownUntil } : {})
  };
}

const TABLE = "firstmeasure_claim_rate_limits";
let schema: Promise<void> | undefined;
let lastSweep = 0;

async function ensureSchema() {
  schema ??= withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('firstmeasure-claim-rate-limits-v1'))");
    // Unlogged: a crash or failover only forgets who is mid-window.
    await client.query(`CREATE UNLOGGED TABLE IF NOT EXISTS ${TABLE} (
      identity TEXT PRIMARY KEY,
      attempts_ms BIGINT[] NOT NULL DEFAULT '{}',
      blocked_until_ms BIGINT NOT NULL DEFAULT 0,
      block_ms BIGINT NOT NULL DEFAULT 0,
      block_attempts INTEGER NOT NULL DEFAULT 0,
      block_token TEXT NOT NULL DEFAULT '',
      updated_at_ms BIGINT NOT NULL
    )`);
    await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS cooldown_until_ms BIGINT NOT NULL DEFAULT 0`);
  }).catch((error) => { schema = undefined; throw error; });
  await schema;
}

// stepClaimLimit as one atomic upsert ($1 identity, $2 now in ms, $3 this attempt's token).
// Every SET expression reads the row as it was, so `t.blocked_until_ms` is the previous block's end.
const WINDOW = `(ARRAY(SELECT a FROM unnest(t.attempts_ms) AS a WHERE a > $2::bigint - ${CLAIM_WINDOW_MS}) || $2::bigint)`;
const BLOCKED = `t.blocked_until_ms > $2::bigint`;
const OVER = `cardinality(${WINDOW}) > ${CLAIM_LIMIT}`;
const NEW_BLOCK_MS = `(CASE WHEN t.blocked_until_ms > 0 AND $2::bigint - t.blocked_until_ms < ${REPEAT_WINDOW_MS} THEN ${LONG_BLOCK_MS} ELSE ${SHORT_BLOCK_MS} END)`;
export const CLAIM_ATTEMPT_SQL = `INSERT INTO ${TABLE} AS t (identity, attempts_ms, updated_at_ms)
  VALUES ($1, ARRAY[$2::bigint], $2::bigint)
  ON CONFLICT (identity) DO UPDATE SET
    attempts_ms = CASE WHEN ${BLOCKED} THEN t.attempts_ms WHEN ${OVER} THEN '{}'::bigint[] ELSE ${WINDOW} END,
    blocked_until_ms = CASE WHEN ${BLOCKED} THEN t.blocked_until_ms WHEN ${OVER} THEN $2::bigint + ${NEW_BLOCK_MS} ELSE t.blocked_until_ms END,
    block_ms = CASE WHEN NOT ${BLOCKED} AND ${OVER} THEN ${NEW_BLOCK_MS} ELSE t.block_ms END,
    block_attempts = CASE WHEN NOT ${BLOCKED} AND ${OVER} THEN cardinality(${WINDOW}) ELSE t.block_attempts END,
    block_token = CASE WHEN NOT ${BLOCKED} AND ${OVER} THEN $3 ELSE t.block_token END,
    updated_at_ms = $2::bigint
  RETURNING blocked_until_ms, block_ms, block_attempts, block_token, cooldown_until_ms`;

/** Start (or keep the later of) an empty-claim cooldown ($1 identity, $2 now in ms, $3 cooldown end). */
export const EMPTY_CLAIM_COOLDOWN_SQL = `INSERT INTO ${TABLE} AS t (identity, cooldown_until_ms, updated_at_ms)
  VALUES ($1, $3::bigint, $2::bigint)
  ON CONFLICT (identity) DO UPDATE SET
    cooldown_until_ms = GREATEST(t.cooldown_until_ms, $3::bigint),
    updated_at_ms = $2::bigint`;

async function attemptInPostgres(identity: string, now: number): Promise<ClaimAttempt> {
  await ensureSchema();
  const token = randomUUID();
  const result = await queryPostgres<{ blocked_until_ms: string; block_ms: string; block_attempts: number; block_token: string; cooldown_until_ms: string }>(
    CLAIM_ATTEMPT_SQL, [identity, now, token]
  );
  const row = result.rows[0]!;
  const blockedUntil = Number(row.blocked_until_ms);
  const cooldownUntil = Number(row.cooldown_until_ms ?? 0);
  const cooldown = cooldownUntil > now ? { cooldownUntil } : {};
  if (now - lastSweep > 10 * 60_000) {
    lastSweep = now;
    // Rows of people who have not claimed for an hour carry nothing a later attempt needs.
    void queryPostgres(`DELETE FROM ${TABLE} WHERE updated_at_ms < $1`, [now - 60 * 60_000]).catch(() => undefined);
  }
  if (blockedUntil <= now) return { allowed: true, blockedUntil, ...cooldown };
  return {
    allowed: false,
    blockedUntil,
    ...cooldown,
    ...(row.block_token === token ? { started: { blockMs: Number(row.block_ms), attempts: Number(row.block_attempts) } } : {})
  };
}

let lastStoreWarning = 0;
/** After a store failure, claims are allowed without asking it for a while, so the limiter adds no load to a struggling database. */
let storeDownUntil = 0;
const STORE_RETRY_MS = 10_000;

/**
 * Count one claim attempt for `identity` (a verified email). Allowed when the
 * store cannot answer: the limiter must never stop claims on its own.
 */
export async function recordClaimAttempt(
  identity: string,
  log?: FastifyBaseLogger,
  now = Date.now(),
  options: ClaimAttemptOptions = {}
): Promise<ClaimAttempt> {
  const honorCooldown = options.honorCooldown !== false;
  const key = identity.trim().toLowerCase();
  if (!key) return { allowed: true };
  const known = knownBlocks.get(key);
  if (known !== undefined) {
    if (known > now) return { allowed: false, blockedUntil: known, reason: "flood", retryAfterSeconds: secondsUntil(known, now) };
    knownBlocks.delete(key);
  }
  if (honorCooldown) {
    // Refused without asking the store or counting the attempt: the cooldown is the answer.
    const cooling = knownCooldowns.get(key);
    if (cooling !== undefined) {
      if (cooling > now) return { allowed: false, cooldownUntil: cooling, reason: "cooldown", retryAfterSeconds: secondsUntil(cooling, now) };
      knownCooldowns.delete(key);
    }
  }
  if (now < storeDownUntil) return { allowed: true };
  let attempt: ClaimAttempt;
  try {
    attempt = isFirstMeasurePostgresEnabled() ? await attemptInPostgres(key, now) : attemptInMemory(key, now);
  } catch (error) {
    storeDownUntil = now + STORE_RETRY_MS;
    if (now - lastStoreWarning > 60_000) {
      lastStoreWarning = now;
      log?.warn({ err: error }, "Claim rate limit store unavailable; allowing claims");
    }
    return { allowed: true };
  }
  if (!attempt.allowed && attempt.blockedUntil) {
    rememberBlock(key, attempt.blockedUntil, now);
    attempt = { ...attempt, reason: "flood", retryAfterSeconds: secondsUntil(attempt.blockedUntil, now) };
  } else if (attempt.allowed && honorCooldown && attempt.cooldownUntil && attempt.cooldownUntil > now) {
    // Started by another process, or before this one restarted.
    rememberUntil(knownCooldowns, key, attempt.cooldownUntil, now);
    attempt = { ...attempt, allowed: false, reason: "cooldown", retryAfterSeconds: secondsUntil(attempt.cooldownUntil, now) };
  }
  if (attempt.started) {
    log?.warn({
      claim_rate_limit: {
        email: key,
        block_seconds: attempt.started.blockMs / 1000,
        attempts: attempt.started.attempts,
        window_seconds: CLAIM_WINDOW_MS / 1000,
        blocked_until: new Date(attempt.blockedUntil ?? now).toISOString()
      }
    }, `Claim next blocked for ${key}: ${attempt.started.attempts} attempts in ${CLAIM_WINDOW_MS / 1000} s, blocked ${attempt.started.blockMs / 1000} s`);
  }
  return attempt;
}

/**
 * Start an empty-claim cooldown of `cooldownMs` for `identity` (a verified
 * email) after their claim found nothing. Never throws: after a store failure
 * only this process remembers the cooldown.
 */
export async function noteEmptyClaim(identity: string, cooldownMs: number, now = Date.now()) {
  const key = identity.trim().toLowerCase();
  if (!key || !(cooldownMs > 0)) return null;
  const until = now + Math.round(cooldownMs);
  rememberUntil(knownCooldowns, key, Math.max(until, knownCooldowns.get(key) ?? 0), now);
  if (!isFirstMeasurePostgresEnabled()) {
    rememberUntil(memoryCooldowns, key, Math.max(until, memoryCooldowns.get(key) ?? 0), now);
    return until;
  }
  if (now < storeDownUntil) return until;
  try {
    await ensureSchema();
    await queryPostgres(EMPTY_CLAIM_COOLDOWN_SQL, [key, now, until]);
  } catch {
    storeDownUntil = now + STORE_RETRY_MS;
  }
  return until;
}

export type ClaimAdmission = { allowed: boolean; retryAfterSeconds?: number; reason?: "flood" | "cooldown" };

/**
 * Count a claim attempt for the verified caller of `request`. Our own service
 * code (the system principal) is not counted: the legacy action that injects
 * `/queue/claim-next/compat` already counted the person it acts for.
 * `allowed` is false when the attempt must be refused.
 */
export async function admitClaimAttempt(request: FastifyRequest, options: ClaimAttemptOptions = {}): Promise<ClaimAdmission> {
  const principal = knownPrincipal(request);
  if (principal.kind === "system") return { allowed: true };
  const attempt = await recordClaimAttempt(principalEmail(principal), request.log, Date.now(), options);
  if (attempt.allowed) return { allowed: true };
  // A flood block answers exactly like an empty queue (FM-387: nothing new reaches the browser);
  // only a cooldown, which follows an empty answer the person already saw, says when to ask again.
  return {
    allowed: false,
    ...(attempt.reason === "cooldown" && attempt.retryAfterSeconds ? { retryAfterSeconds: attempt.retryAfterSeconds } : {}),
    ...(attempt.reason ? { reason: attempt.reason } : {})
  };
}

/**
 * Start the empty-claim cooldown for the verified caller of `request` (never
 * the system principal: the legacy action notes the person it acts for).
 * Returns whole seconds until they may ask again, or null when none started.
 */
export async function noteEmptyClaimForRequest(request: FastifyRequest, cooldownSeconds: number): Promise<number | null> {
  const principal = knownPrincipal(request);
  if (principal.kind === "system" || !(cooldownSeconds > 0)) return null;
  const now = Date.now();
  const until = await noteEmptyClaim(principalEmail(principal), cooldownSeconds * 1000, now);
  return until ? secondsUntil(until, now) : null;
}

/** Test seam: the counts and remembered blocks are process-global. */
export function resetClaimRateLimits() {
  memory.clear();
  memoryCooldowns.clear();
  knownCooldowns.clear();
  knownBlocks.clear();
  lastSweep = 0;
  storeDownUntil = 0;
}
