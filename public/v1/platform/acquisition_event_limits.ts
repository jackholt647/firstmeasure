/**
 * Abuse protection for the public signup-funnel event route (`POST /v1/platform/acquisition/event`).
 *
 * One signup form sends a burst when it loads and a steady trickle while someone types; the form batches them, up to
 * ACQUISITION_EVENT_BATCH_LIMIT a request. Each visitor address gets a bucket of 300 events that refills at 300 a
 * minute: a page's normal burst never comes near it (an older cached form that sends one request per keystroke
 * still fits), and one address cannot flood the single compatibility ledger. Buckets are per web node, in memory.
 */
const EVENTS_PER_MINUTE = 300;
const BUCKET_CAPACITY = 300;
const MAX_TRACKED_ADDRESSES = 50_000;

const buckets = new Map<string, { tokens: number; refilledAt: number }>();

/** Spend `cost` events for `address`. Returns 0 when allowed, or the whole seconds to wait before retrying. */
export function consumeAcquisitionEventTokens(address: string, cost: number, now = Date.now()) {
  const key = address || "unknown";
  const bucket = buckets.get(key) || { tokens: BUCKET_CAPACITY, refilledAt: now };
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + Math.max(0, now - bucket.refilledAt) / 60_000 * EVENTS_PER_MINUTE);
  bucket.refilledAt = now;
  buckets.delete(key);
  if (buckets.size >= MAX_TRACKED_ADDRESSES) buckets.delete(buckets.keys().next().value as string);
  buckets.set(key, bucket);
  if (bucket.tokens < cost) return Math.max(1, Math.ceil((cost - bucket.tokens) / EVENTS_PER_MINUTE * 60));
  bucket.tokens -= cost;
  return 0;
}

/** Test seam: the buckets are process-global. */
export function resetAcquisitionEventLimits() {
  buckets.clear();
}

const PRIVATE_ADDRESS = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:|unknown$)/i;

/**
 * The visitor's address. The load balancer appends the address it received from as the last public entry of
 * X-Forwarded-For (NGINX then appends the balancer's private address); entries before it are whatever the visitor
 * sent, so only the rightmost public entry is trusted.
 */
export function acquisitionVisitorAddress(forwardedFor: string, socketAddress: string) {
  const entries = String(forwardedFor || "").split(",").map((entry) => entry.trim().replace(/^::ffff:/i, "")).filter(Boolean);
  for (const entry of entries.reverse()) {
    if (!PRIVATE_ADDRESS.test(entry)) return entry;
  }
  return String(socketAddress || "").replace(/^::ffff:/i, "");
}
