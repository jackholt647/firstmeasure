// FM-351: the server-side TikTok Purchase for a paid credit checkout: what is sent, when, and how delivery retries.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

let tiktok: typeof import("../platform/tiktok-events.js");
let internal: typeof import("../internal/storage.js");

const config = { pixelId: "DBN2ED3C77UF91065S40", accessToken: "tiktok_test_token", testEventCode: "" };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function purchase(overrides: Partial<import("../platform/tiktok-events.js").TiktokPurchase> = {}) {
  return {
    sessionId: `cs_live_Fixture${Math.random().toString(36).slice(2)}`,
    orgId: "org_tiktok_fixture",
    email: "  Owner@Example.TEST ",
    amountMinor: 2500,
    currency: "usd",
    quantity: 25,
    paidAtMs: Date.UTC(2026, 10, 6, 12, 0, 0),
    livemode: true,
    pageUrl: "https://app.1m8.ai/portal/index.php?paid=1",
    ...overrides
  };
}

function tiktokResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

before(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tiktok-events-"));
  Object.assign(process.env, { NODE_ENV: "test", INTERNAL_STORAGE_ROOT: path.join(root, "internal"), FIRSTMEASURE_DATABASE_MODE: "sqlite", DATABASE_URL: "" });
  tiktok = await import("../platform/tiktok-events.js");
  internal = await import("../internal/storage.js");
});

test("the Purchase body follows Events API 2.0 with normalized, hashed matching fields", () => {
  const input = purchase({ sessionId: "cs_live_Abc", phone: "+1 (555) 010-2233", ttclid: "E.C.P.click", ttp: "ttp-cookie", ip: "203.0.113.9", userAgent: "Mozilla/5.0 Fixture" });
  const payload = tiktok.tiktokPurchasePayload(input, { pixelId: config.pixelId }) as any;
  assert.equal(payload.event_source, "web");
  assert.equal(payload.event_source_id, "DBN2ED3C77UF91065S40");
  assert.equal(payload.test_event_code, undefined);
  assert.equal(payload.data.length, 1);
  const event = payload.data[0];
  assert.equal(event.event, "Purchase");
  assert.equal(event.event_id, "stripe_purchase:cs_live_Abc");
  assert.equal(event.event_time, Math.floor(input.paidAtMs / 1000));
  assert.deepEqual(event.user, {
    email: sha("owner@example.test"),
    phone: sha("+15550102233"),
    external_id: sha("org_tiktok_fixture"),
    ttclid: "E.C.P.click",
    ttp: "ttp-cookie",
    ip: "203.0.113.9",
    user_agent: "Mozilla/5.0 Fixture"
  });
  // 2,500 cents is 25.00, not the credit's advertised price.
  assert.equal(event.properties.value, 25);
  assert.equal(event.properties.currency, "USD");
  assert.equal(event.properties.order_id, "cs_live_Abc");
  assert.deepEqual(event.properties.contents, [{ content_id: "firstmate_account_credit", content_name: "FirstMate account credit", quantity: 25, price: 1 }]);
  assert.deepEqual(event.page, { url: "https://app.1m8.ai/portal/index.php?paid=1" });
});

test("unknown matching fields are left out, a phone without its country code is not guessed, and minor units follow the currency", () => {
  const event = (tiktok.tiktokPurchasePayload(purchase({ phone: "(555) 010-2233" }), { pixelId: config.pixelId }) as any).data[0];
  assert.deepEqual(Object.keys(event.user).sort(), ["email", "external_id"]);
  assert.equal(tiktok.majorUnits(2500, "JPY"), 2500);
  assert.equal(tiktok.majorUnits(12345, "KWD"), 12.345);
  assert.equal(tiktok.majorUnits(1999, "EUR"), 19.99);
});

test("only paid live purchases are sent live; test payments need a test event code", () => {
  assert.deepEqual(tiktok.tiktokPurchaseDecision(purchase(), config), { send: true, test: false });
  assert.equal(tiktok.tiktokPurchaseDecision(purchase(), { ...config, accessToken: "" }).reason, "missing_access_token");
  assert.equal(tiktok.tiktokPurchaseDecision(purchase({ amountMinor: 0 }), config).reason, "not_a_paid_purchase");
  assert.equal(tiktok.tiktokPurchaseDecision(purchase({ livemode: false }), config).reason, "stripe_test_mode");
  assert.deepEqual(tiktok.tiktokPurchaseDecision(purchase({ livemode: false }), { ...config, testEventCode: "TEST42" }), { send: true, test: true });
});

test("checkout keeps the browser's TikTok ids, address and user agent, and never a relay's", () => {
  const browser = tiktok.tiktokCheckoutAttribution({}, {
    headers: { cookie: "a=1; _ttp=ttp%20value; fm_ttclid=click.1", "user-agent": "Mozilla/5.0 Browser", "x-forwarded-for": "198.51.100.4, 203.0.113.77, 10.0.0.5" },
    ip: "10.0.0.5"
  });
  assert.deepEqual(browser, { ttclid: "click.1", ttp: "ttp value", client_ip: "203.0.113.77", client_user_agent: "Mozilla/5.0 Browser" });
  // PHP's bridge sends no user agent from a private address: record neither.
  const relayed = tiktok.tiktokCheckoutAttribution({ ttclid: "from.body" }, { headers: {}, ip: "10.124.16.5" }, { ttclid: "from.signup" });
  assert.deepEqual(relayed, { ttclid: "from.body" });
  assert.deepEqual(tiktok.tiktokCheckoutAttribution({}, undefined, { ttclid: "from.signup" }), { ttclid: "from.signup" });
});

test("a queued purchase is delivered once, its result logged, and a second enqueue of the same checkout is refused", async () => {
  const input = purchase();
  const requests: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return tiktokResponse({ code: 0, message: "OK", request_id: "req_1", data: {} });
  }) as typeof fetch;
  const queued = await tiktok.enqueueTiktokPurchase(input, config, { deliverNow: false });
  assert.equal(queued.status, "queued");
  assert.equal((await tiktok.enqueueTiktokPurchase(input, config, { deliverNow: false })).status, "already_queued");
  assert.deepEqual(await tiktok.drainTiktokEventsOutbox({ config, fetchImpl }), { attempted: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://business-api.tiktok.com/open_api/v1.3/event/track/");
  assert.equal(requests[0].headers["Access-Token"], "tiktok_test_token");
  assert.equal(requests[0].body.data[0].event_id, `stripe_purchase:${input.sessionId}`);
  const id = tiktok.tiktokOutboxId(input.sessionId);
  assert.equal(await internal.readInternalDocument(tiktok.TIKTOK_EVENTS_OUTBOX, id), null);
  assert.equal(((await internal.readInternalDocument(tiktok.TIKTOK_EVENTS_LOG, id))?.data as any).status, "delivered");
  // A duplicate callback after delivery does not queue it again.
  assert.equal((await tiktok.enqueueTiktokPurchase(input, config, { deliverNow: false })).status, "already_queued");
  assert.deepEqual(await tiktok.drainTiktokEventsOutbox({ config, fetchImpl }), { attempted: 0 });
  assert.equal(requests.length, 1);
});

test("delivery retries TikTok's temporary failures with the same event, and gives up after the last attempt", async () => {
  const input = purchase();
  const id = tiktok.tiktokOutboxId(input.sessionId);
  await internal.saveInternalDocument(tiktok.TIKTOK_EVENTS_OUTBOX, id, { data: {
    event_id: `stripe_purchase:${input.sessionId}`, org_id: input.orgId, session_id: input.sessionId, test: false,
    payload: tiktok.tiktokPurchasePayload(input, { pixelId: config.pixelId }), attempts: 0, next_attempt_at: new Date(0).toISOString(), lease_until: "", lease_owner: ""
  } });
  let clock = Date.now();
  const bodies: string[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    bodies.push(init.body);
    return tiktokResponse({ code: 50000, message: "System error", request_id: "req_retry" });
  }) as typeof fetch;
  for (let attempt = 1; attempt <= tiktok.TIKTOK_RETRY_DELAYS_MS.length; attempt += 1) {
    const result = await tiktok.deliverTiktokOutboxEntry(id, { config, fetchImpl, now: () => clock });
    assert.equal(result.reason, "retry");
    // Not due again until its delay has passed.
    assert.equal((await tiktok.deliverTiktokOutboxEntry(id, { config, fetchImpl, now: () => clock })).reason, "not_due");
    clock += tiktok.TIKTOK_RETRY_DELAYS_MS[attempt - 1]! + 1;
  }
  const last = await tiktok.deliverTiktokOutboxEntry(id, { config, fetchImpl, now: () => clock });
  assert.equal(last.reason, "failed");
  assert.equal(bodies.length, tiktok.TIKTOK_RETRY_DELAYS_MS.length + 1);
  assert.equal(new Set(bodies).size, 1, "every attempt resends the same event");
  assert.equal(await internal.readInternalDocument(tiktok.TIKTOK_EVENTS_OUTBOX, id), null);
  const log = await internal.readInternalDocument(tiktok.TIKTOK_EVENTS_LOG, id);
  assert.equal((log?.data as any).status, "failed");
  assert.equal((log?.data as any).code, 50000);
});

test("a rejected event (HTTP 200 with an error code) is not retried, and a network failure is", async () => {
  for (const [response, expected] of [
    [async () => tiktokResponse({ code: 40002, message: "Invalid parameter" }), "failed"],
    [async () => { throw new Error("connect ETIMEDOUT"); }, "retry"]
  ] as const) {
    const input = purchase();
    const id = tiktok.tiktokOutboxId(input.sessionId);
    await internal.saveInternalDocument(tiktok.TIKTOK_EVENTS_OUTBOX, id, { data: {
      event_id: `stripe_purchase:${input.sessionId}`, session_id: input.sessionId, payload: tiktok.tiktokPurchasePayload(input, { pixelId: config.pixelId }),
      attempts: 0, next_attempt_at: new Date(0).toISOString(), lease_until: "", lease_owner: ""
    } });
    const result = await tiktok.deliverTiktokOutboxEntry(id, { config, fetchImpl: response as unknown as typeof fetch });
    assert.equal(result.reason, expected);
  }
});
