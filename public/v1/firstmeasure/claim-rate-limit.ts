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
export function legacyQueueEmptyResult() {
  return { ok: false, success: false, status_code: 404, error: QUEUE_EMPTY_CODE, message: QUEUE_EMPTY_MESSAGE, details: null };
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

export type ClaimAttempt = { allowed: boolean; blockedUntil?: number; started?: { blockMs: number; attempts: number } };

const memory = new Map<string, ClaimLimitState>();
/** Blocks this process has seen, by identity: refused without asking the store. */
const knownBlocks = new Map<string, number>();
const MAX_TRACKED = 10_000;

function rememberBlock(identity: string, until: number, now: number) {
  if (knownBlocks.size >= MAX_TRACKED) {
    for (const [key, end] of knownBlocks) if (end <= now) knownBlocks.delete(key);
    if (knownBlocks.size >= MAX_TRACKED) knownBlocks.clear();
  }
  knownBlocks.set(identity, until);
}

function attemptInMemory(identity: string, now: number): ClaimAttempt {
  const step = stepClaimLimit(memory.get(identity) ?? { attempts: [], blockedUntil: 0 }, now);
  memory.delete(identity);
  if (memory.size >= MAX_TRACKED) memory.delete(memory.keys().next().value as string);
  memory.set(identity, step.state);
  return { allowed: step.allowed, blockedUntil: step.state.blockedUntil, ...(step.started ? { started: step.started } : {}) };
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
  RETURNING blocked_until_ms, block_ms, block_attempts, block_token`;

async function attemptInPostgres(identity: string, now: number): Promise<ClaimAttempt> {
  await ensureSchema();
  const token = randomUUID();
  const result = await queryPostgres<{ blocked_until_ms: string; block_ms: string; block_attempts: number; block_token: string }>(
    CLAIM_ATTEMPT_SQL, [identity, now, token]
  );
  const row = result.rows[0]!;
  const blockedUntil = Number(row.blocked_until_ms);
  if (now - lastSweep > 10 * 60_000) {
    lastSweep = now;
    // Rows of people who have not claimed for an hour carry nothing a later attempt needs.
    void queryPostgres(`DELETE FROM ${TABLE} WHERE updated_at_ms < $1`, [now - 60 * 60_000]).catch(() => undefined);
  }
  if (blockedUntil <= now) return { allowed: true, blockedUntil };
  return {
    allowed: false,
    blockedUntil,
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
export async function recordClaimAttempt(identity: string, log?: FastifyBaseLogger, now = Date.now()): Promise<ClaimAttempt> {
  const key = identity.trim().toLowerCase();
  if (!key) return { allowed: true };
  const known = knownBlocks.get(key);
  if (known !== undefined) {
    if (known > now) return { allowed: false, blockedUntil: known };
    knownBlocks.delete(key);
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
  if (!attempt.allowed && attempt.blockedUntil) rememberBlock(key, attempt.blockedUntil, now);
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
 * Count a claim attempt for the verified caller of `request`. Our own service
 * code (the system principal) is not counted: the legacy action that injects
 * `/queue/claim-next/compat` already counted the person it acts for.
 * Returns false when the attempt must be refused.
 */
export async function admitClaimAttempt(request: FastifyRequest) {
  const principal = knownPrincipal(request);
  if (principal.kind === "system") return true;
  return (await recordClaimAttempt(principalEmail(principal), request.log)).allowed;
}

/** Test seam: the counts and remembered blocks are process-global. */
export function resetClaimRateLimits() {
  memory.clear();
  knownBlocks.clear();
  lastSweep = 0;
  storeDownUntil = 0;
}
