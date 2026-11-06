// TikTok Events API: a server-side Purchase for every paid credit checkout (FM-351), beside the Meta Conversions API.
//
// What counts: the money a customer pays for FirstMate account credit, once, when Stripe confirms the checkout is
// paid (stripeFulfillFromSession). Spending credit on a report is not a purchase and sends nothing.
//
// Delivery never holds up checkout: fulfillment commits the credit, then enqueues the event in the
// `tiktok_events_outbox` internal collection. Every web process drains the outbox (the first attempt starts at
// once), with bounded retries; the final result is written to `tiktok_events_log` and logged. The event id is
// `stripe_purchase:<checkout session id>`, the same id the Meta purchase uses, and a retry resends the same body,
// so TikTok counts it once.
//
// Test payments never reach live reporting: a Stripe test-mode purchase is sent only with a test event code
// (TIKTOK_EVENTS_TEST_EVENT_CODE, shown in Events Manager's Test Events tab), otherwise skipped.
import { createHash, randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import { deleteInternalDocument, listInternalDocuments, readInternalDocument, saveInternalDocument } from "../internal/storage.js";
import { acquisitionVisitorAddress, isPrivateAddress } from "./acquisition_event_limits.js";

type JsonObject = Record<string, unknown>;

export const TIKTOK_EVENTS_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
export const TIKTOK_EVENTS_OUTBOX = "tiktok_events_outbox";
export const TIKTOK_EVENTS_LOG = "tiktok_events_log";
/** Wait before attempt 2, 3, ...; after the last the event is recorded as failed. */
export const TIKTOK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const LEASE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
// TikTok's own "try again" answers: rate limited and internal errors.
const RETRYABLE_TIKTOK_CODES = new Set([40100, 50000, 50002]);
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export type TiktokConfig = { pixelId: string; accessToken: string; testEventCode: string };

export function tiktokConfig(): TiktokConfig {
  return {
    pixelId: String(env.tiktokPixelId || "").trim(),
    accessToken: String(env.tiktokEventsAccessToken || "").trim(),
    testEventCode: String(env.tiktokEventsTestEventCode || "").trim()
  };
}

function text(value: unknown) {
  return value == null ? "" : String(value).trim();
}

/** Internal document ids are lowercased; Stripe's ids are not, so the documents are keyed by a hash of the id. */
export function tiktokOutboxId(sessionId: string) {
  return `purchase_${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`;
}

export function tiktokHash(value: string) {
  return value ? createHash("sha256").update(value).digest("hex") : "";
}

/** E.164 only (a leading + and 8 to 15 digits); a number without its country code is left out, not guessed. */
export function tiktokE164(phone: unknown) {
  const raw = text(phone);
  if (!raw.startsWith("+")) return "";
  const digits = raw.replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : "";
}

export function majorUnits(amountMinor: number, currency: string) {
  const code = currency.toUpperCase();
  const digits = ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
  const factor = 10 ** digits;
  return Math.round(amountMinor) / factor;
}

function readCookie(header: unknown, name: string) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

type RequestLike = { headers: Record<string, string | string[] | undefined>; ip?: string };

function header(request: RequestLike, name: string) {
  const value = request.headers[name];
  return text(Array.isArray(value) ? value.join(", ") : value);
}

/**
 * The browser context a later purchase needs, read when the customer starts checkout: TikTok's click id and
 * `_ttp` cookie, and the customer's own address and browser. They travel in the checkout's metadata, because the
 * webhook that confirms payment comes from Stripe, not the customer. A request relayed by PHP carries no browser
 * user agent and a private address; then neither is recorded rather than recording the relay's.
 */
export function tiktokCheckoutAttribution(body: JsonObject, request?: RequestLike, fallback: { ttclid?: string } = {}) {
  const cookie = request?.headers.cookie;
  const fields: Record<string, string> = {};
  const ttclid = text(body.ttclid) || readCookie(cookie, "fm_ttclid") || readCookie(cookie, "ttclid") || text(fallback.ttclid);
  const ttp = text(body._ttp || body.ttp) || readCookie(cookie, "_ttp");
  if (ttclid) fields.ttclid = ttclid.slice(0, 500);
  if (ttp) fields.ttp = ttp.slice(0, 500);
  const userAgent = request ? header(request, "user-agent") : "";
  if (request && userAgent) {
    const ip = acquisitionVisitorAddress(header(request, "x-forwarded-for"), text(request.ip));
    if (ip && !isPrivateAddress(ip)) fields.client_ip = ip.slice(0, 100);
    fields.client_user_agent = userAgent.slice(0, 500);
  }
  return fields;
}

export type TiktokPurchase = {
  sessionId: string;
  orgId: string;
  email: string;
  phone?: string;
  amountMinor: number;
  currency: string;
  /** Units of credit the customer paid for (the checkout line's quantity). */
  quantity?: number;
  paidAtMs: number;
  livemode: boolean;
  pageUrl: string;
  ttclid?: string;
  ttp?: string;
  ip?: string;
  userAgent?: string;
};

/** The Events API 2.0 body for one purchase; optional fields are left out when unknown. */
export function tiktokPurchasePayload(purchase: TiktokPurchase, config: { pixelId: string; testEventCode?: string }) {
  const currency = purchase.currency.toUpperCase();
  const value = majorUnits(purchase.amountMinor, currency);
  const user: JsonObject = {};
  const email = text(purchase.email).toLowerCase();
  if (email) user.email = tiktokHash(email);
  const phone = tiktokE164(purchase.phone);
  if (phone) user.phone = tiktokHash(phone);
  if (purchase.orgId) user.external_id = tiktokHash(purchase.orgId);
  if (purchase.ttclid) user.ttclid = purchase.ttclid;
  if (purchase.ttp) user.ttp = purchase.ttp;
  if (purchase.ip) user.ip = purchase.ip;
  if (purchase.userAgent) user.user_agent = purchase.userAgent;
  const quantity = Number.isFinite(purchase.quantity) && Number(purchase.quantity) >= 1 ? Math.round(Number(purchase.quantity)) : 1;
  const payload: JsonObject = {
    event_source: "web",
    event_source_id: config.pixelId,
    data: [{
      event: "Purchase",
      event_time: Math.floor(purchase.paidAtMs / 1000),
      event_id: `stripe_purchase:${purchase.sessionId}`,
      user,
      properties: {
        currency,
        value,
        content_type: "product",
        order_id: purchase.sessionId,
        contents: [{
          content_id: "firstmate_account_credit",
          content_name: "FirstMate account credit",
          quantity,
          price: Math.round((value / quantity) * 1000) / 1000
        }]
      },
      page: { url: purchase.pageUrl }
    }]
  };
  if (config.testEventCode) payload.test_event_code = config.testEventCode;
  return payload;
}

/** Whether a purchase is sent, and as a live or a test event. */
export function tiktokPurchaseDecision(purchase: Pick<TiktokPurchase, "sessionId" | "amountMinor" | "currency" | "livemode">, config: TiktokConfig) {
  if (!config.pixelId) return { send: false as const, reason: "missing_pixel_id" };
  if (!config.accessToken) return { send: false as const, reason: "missing_access_token" };
  if (!purchase.sessionId || !Number.isFinite(purchase.amountMinor) || purchase.amountMinor <= 0 || !/^[A-Za-z]{3}$/.test(purchase.currency)) {
    return { send: false as const, reason: "not_a_paid_purchase" };
  }
  if (!purchase.livemode && !config.testEventCode) return { send: false as const, reason: "stripe_test_mode" };
  return { send: true as const, test: Boolean(config.testEventCode) };
}

/**
 * Called once a paid checkout's credit is committed. Returns what to record on the fulfilled checkout; never
 * throws, and never waits for TikTok.
 */
export async function enqueueTiktokPurchase(purchase: TiktokPurchase, config = tiktokConfig(), options: { deliverNow?: boolean } = {}) {
  const decision = tiktokPurchaseDecision(purchase, config);
  const eventId = `stripe_purchase:${purchase.sessionId}`;
  if (!decision.send) return { status: "skipped", reason: decision.reason, event_id: eventId };
  try {
    const id = tiktokOutboxId(purchase.sessionId);
    if (await readInternalDocument(TIKTOK_EVENTS_OUTBOX, id) || await readInternalDocument(TIKTOK_EVENTS_LOG, id)) {
      return { status: "already_queued", event_id: eventId };
    }
    const now = new Date().toISOString();
    await saveInternalDocument(TIKTOK_EVENTS_OUTBOX, id, {
      data: {
        event_id: eventId,
        org_id: purchase.orgId,
        session_id: purchase.sessionId,
        test: decision.test,
        payload: tiktokPurchasePayload(purchase, { pixelId: config.pixelId, testEventCode: config.testEventCode }),
        attempts: 0,
        next_attempt_at: now,
        lease_until: "",
        lease_owner: "",
        queued_at: now
      }
    });
    if (options.deliverNow !== false) setImmediate(() => { void deliverTiktokOutboxEntry(id, { config }).catch((error) => logDelivery("tiktok_events_delivery_error", { event_id: eventId, error: text((error as Error)?.message || error) })); });
    return { status: "queued", event_id: eventId, ...(decision.test ? { test: true } : {}), queued_at: now };
  } catch (error) {
    logDelivery("tiktok_events_enqueue_failed", { alert: true, event_id: eventId, org_id: purchase.orgId, error: text((error as Error)?.message || error) });
    return { status: "enqueue_failed", event_id: eventId };
  }
}

function logDelivery(event: string, fields: JsonObject) {
  console.warn(JSON.stringify({ event, ...fields }));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/** One delivery attempt for a queued event, when it is due and nobody else holds it. */
export async function deliverTiktokOutboxEntry(id: string, options: { config?: TiktokConfig; fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const config = options.config ?? tiktokConfig();
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!config.accessToken) return { delivered: false, reason: "missing_access_token" };
  const current = await readInternalDocument(TIKTOK_EVENTS_OUTBOX, id);
  if (!current) return { delivered: false, reason: "not_queued" };
  const entry = asObject(current.data);
  if (Date.parse(text(entry.next_attempt_at)) > now() || Date.parse(text(entry.lease_until)) > now()) return { delivered: false, reason: "not_due" };
  // Claim it, then read back: another process that claimed it at the same moment wins and this one stands down.
  const owner = `${process.pid}:${randomUUID()}`;
  await saveInternalDocument(TIKTOK_EVENTS_OUTBOX, id, { data: { lease_owner: owner, lease_until: new Date(now() + LEASE_MS).toISOString() } });
  const claimed = asObject((await readInternalDocument(TIKTOK_EVENTS_OUTBOX, id))?.data);
  if (text(claimed.lease_owner) !== owner) return { delivered: false, reason: "claimed_elsewhere" };

  const attempt = Number(entry.attempts || 0) + 1;
  let http = 0;
  let body: JsonObject = {};
  let error = "";
  try {
    const response = await fetchImpl(TIKTOK_EVENTS_URL, {
      method: "POST",
      headers: { "Access-Token": config.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(entry.payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    http = response.status;
    body = asObject(await response.json().catch(() => null));
  } catch (caught) {
    error = text((caught as Error)?.message || caught) || "request_failed";
  }
  const code = typeof body.code === "number" ? body.code : null;
  const ok = !error && http >= 200 && http < 300 && code === 0;
  const result = {
    event_id: text(entry.event_id),
    org_id: text(entry.org_id),
    session_id: text(entry.session_id),
    test: entry.test === true,
    attempt,
    http: http || null,
    code,
    message: text(body.message).slice(0, 500) || error.slice(0, 500) || null,
    request_id: text(body.request_id) || null
  };
  if (ok) {
    await saveInternalDocument(TIKTOK_EVENTS_LOG, id, { data: { ...result, status: "delivered", delivered_at: new Date(now()).toISOString(), queued_at: entry.queued_at } });
    await deleteInternalDocument(TIKTOK_EVENTS_OUTBOX, id);
    logDelivery("tiktok_events_delivered", result);
    return { delivered: true, ...result };
  }
  const retryable = Boolean(error) || http === 429 || http >= 500 || (code != null && RETRYABLE_TIKTOK_CODES.has(code));
  if (!retryable || attempt > TIKTOK_RETRY_DELAYS_MS.length) {
    await saveInternalDocument(TIKTOK_EVENTS_LOG, id, { data: { ...result, status: "failed", failed_at: new Date(now()).toISOString(), queued_at: entry.queued_at } });
    await deleteInternalDocument(TIKTOK_EVENTS_OUTBOX, id);
    logDelivery("tiktok_events_failed", { alert: true, ...result });
    return { delivered: false, reason: "failed", ...result };
  }
  const next = new Date(now() + TIKTOK_RETRY_DELAYS_MS[attempt - 1]!).toISOString();
  await saveInternalDocument(TIKTOK_EVENTS_OUTBOX, id, { data: { attempts: attempt, next_attempt_at: next, lease_owner: "", lease_until: "", last_result: result } });
  logDelivery("tiktok_events_retry", { ...result, next_attempt_at: next });
  return { delivered: false, reason: "retry", next_attempt_at: next, ...result };
}

/** Every queued event that is due. The outbox only holds undelivered events, so it stays small. */
export async function drainTiktokEventsOutbox(options: { config?: TiktokConfig; fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const config = options.config ?? tiktokConfig();
  if (!config.accessToken) return { attempted: 0 };
  const now = options.now ?? Date.now;
  let attempted = 0;
  for (const document of await listInternalDocuments(TIKTOK_EVENTS_OUTBOX)) {
    const entry = asObject(document.data);
    if (Date.parse(text(entry.next_attempt_at)) > now() || Date.parse(text(entry.lease_until)) > now()) continue;
    attempted += 1;
    await deliverTiktokOutboxEntry(text(document.id), { ...options, config });
  }
  return { attempted };
}

export function startTiktokEventsOutbox(app: { addHook: (name: "onClose", hook: () => Promise<void>) => unknown; log: { warn: (value: unknown, message: string) => void } }) {
  if (process.env.NODE_ENV === "test" || !tiktokConfig().accessToken) return;
  const timer = setInterval(() => {
    void drainTiktokEventsOutbox().catch((error) => app.log.warn({ err: error }, "TikTok events outbox failed"));
  }, 60_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
