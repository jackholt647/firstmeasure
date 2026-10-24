// Signup-funnel events (POST /v1/platform/acquisition/event). Production lost nearly every one: the referral ledger
// migrated from the retired PHP module kept a UNIQUE index on (campaign, actor, type), so every anonymous visitor's
// form interaction after the first per campaign and type failed with a 500 on compatibility, which web nodes reported
// as a 503 (2026-10-24).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";

const root = mkdtempSync(path.join(tmpdir(), "firstmeasure-acquisition-events-"));
process.env.FIRSTMATE_ENV = "test";
process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
process.env.CRM_STORAGE_ROOT = path.join(root, "crm");
Object.assign(process.env, { NODE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "sqlite", DATABASE_URL: "", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", CUSTOMER_CALL_WORKER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", V1_LOG_LEVEL: "error", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "measure", "index.sqlite") });
for (const name of ["INTERNAL", "FIRSTMEASURE", "MESSAGING", "CHANNELS", "CALLS", "PRICEBOOK"]) process.env[`${name}_STORAGE_ROOT`] = path.join(root, name.toLowerCase());
const ledgerPath = path.join(root, "crm", "databases", "referrals.sqlite");

function ledger<T>(fn: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(ledgerPath);
  try { return fn(db); } finally { db.close(); }
}
const eventsOfType = (type: string) => ledger((db) => db.prepare("SELECT * FROM referral_events WHERE event_type = ?").all(type));
const interaction = (type: string, n: number) => ({ acquisition_code: "main", event_type: type, event_id: `swe_test_${type}_${n}`, unique_event: true, metadata: { signup_session_id: `sw_${n}` } });

test("signup-funnel events", async (t) => {
  const referrals = await import("../internal/crm/referrals.js");
  const { createReferralService, referralServiceRoutes } = await import("../internal/crm/referrals_service.js");
  await referrals.ensureReferralDatabase();
  await referrals.saveAcquisitionCampaign({ code: "main", display_name: "Main campaign" });
  // As on production: the index the retired PHP module created.
  ledger((db) => db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_events_unique ON referral_events(partner_id, actor_email, actor_org_id, event_type)"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await t.test("every anonymous visitor's interaction is recorded, on a ledger migrated from PHP", () => {
    for (let n = 0; n < 3; n++) assert.equal(referrals.trackAcquisitionEvent(interaction("signup_field_focus", n)).ok, true);
    const rows = eventsOfType("signup_field_focus");
    assert.equal(rows.length, 3, "one row per interaction");
    assert.ok(rows.every((row) => row.partner_id && row.actor_email === ""), "attributed to the campaign, anonymous");
    const indexes = ledger((db) => db.prepare("PRAGMA index_list(referral_events)").all().map((index) => String(index.name)));
    assert.ok(!indexes.includes("idx_referral_events_unique"), "the retired UNIQUE index is gone");
    assert.ok(indexes.includes("idx_referral_events_actor"), "the counter lookup keeps an index");
  });

  await t.test("an event without an id is still one counter row per campaign, actor and type", () => {
    referrals.trackAcquisitionEvent({ acquisition_code: "main", event_type: "offer_impression" });
    referrals.trackAcquisitionEvent({ acquisition_code: "main", event_type: "offer_impression" });
    const rows = eventsOfType("offer_impression");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.event_count, 2);
  });

  await t.test("a page's batch is recorded in one call", () => {
    const batch = Array.from({ length: referrals.ACQUISITION_EVENT_BATCH_LIMIT }, (_, n) => interaction("signup_field_input", n));
    const result = referrals.trackAcquisitionEvents(batch);
    assert.equal(result.recorded, 25);
    assert.equal(eventsOfType("signup_field_input").length, 25);
  });

  await t.test("bad input is a 400 and records nothing", () => {
    const refused = (body: unknown, pattern: RegExp) => assert.throws(() => referrals.acquisitionEventInputs(body), (error: { statusCode?: number; code?: string; message: string }) =>
      error.statusCode === 400 && error.code === "invalid_acquisition_event" && pattern.test(error.message));
    refused(null, /event object/);
    refused([], /event object/);
    refused({ acquisition_code: "main" }, /event_type is required/);
    refused({ event_type: "" }, /event_type is required/);
    refused({ event_type: "signup <script>" }, /event_type is required/);
    refused({ event_type: "x".repeat(81) }, /event_type is required/);
    refused({ event_type: "signup_ready", event_id: 7 }, /event_id/);
    refused({ event_type: "signup_ready", metadata: [1] }, /metadata/);
    refused({ event_type: "signup_ready", metadata: { note: "x".repeat(17_000) } }, /at most/);
    refused({ events: [] }, /between 1 and 25/);
    refused({ events: "nope" }, /between 1 and 25/);
    refused({ events: Array.from({ length: 26 }, (_, n) => interaction("signup_field_blur", n)) }, /between 1 and 25/);
    refused({ events: [interaction("signup_field_blur", 0), { event_type: 5 }] }, /event_type/);
    const before = eventsOfType("signup_field_blur").length;
    assert.throws(() => referrals.trackAcquisitionEvents([interaction("signup_field_blur", 1), { event_type: "" }]));
    assert.equal(eventsOfType("signup_field_blur").length, before, "a refused batch records none of its events");
  });

  await t.test("through the compatibility service: batches are recorded and a 400 stays a 400", async () => {
    const compatibility = Fastify();
    await compatibility.register(referralServiceRoutes("test-private-secret"), { prefix: "/v1/private/referrals" });
    await compatibility.listen({ host: "127.0.0.1", port: 0 });
    t.after(() => compatibility.close());
    const address = compatibility.server.address();
    assert.ok(address && typeof address === "object");
    const web = createReferralService({ deploymentTopology: "cluster", clusterNodeRole: "web", legacyServiceUrl: `http://127.0.0.1:${address.port}`, legacyProxySecret: "test-private-secret" });
    const result = await web.trackAcquisitionEvents(Array.from({ length: 7 }, (_, n) => interaction("signup_control_click", n)));
    assert.equal(result.recorded, 7);
    assert.equal(eventsOfType("signup_control_click").length, 7);
    await assert.rejects(web.trackAcquisitionEvent({ acquisition_code: "main" }), (error: { statusCode?: number; code?: string }) =>
      error.statusCode === 400 && error.code === "invalid_acquisition_event");
  });
});

test("abuse protection: a page's burst is accepted, a flood from one address is not", async () => {
  const { acquisitionVisitorAddress, consumeAcquisitionEventTokens, resetAcquisitionEventLimits } = await import("../platform/acquisition_event_limits.js");
  resetAcquisitionEventLimits();
  const now = Date.parse("2026-10-24T12:00:00Z");
  for (let i = 0; i < 7; i++) assert.equal(consumeAcquisitionEventTokens("203.0.113.5", 1, now), 0, "seven single events at once (an older cached form)");
  for (let i = 0; i < 11; i++) assert.equal(consumeAcquisitionEventTokens("203.0.113.5", 25, now), 0, "a full form fill in batches");
  const wait = consumeAcquisitionEventTokens("203.0.113.5", 25, now);
  assert.ok(wait > 0 && wait <= 6, `then told when to retry (${wait}s)`);
  assert.equal(consumeAcquisitionEventTokens("198.51.100.9", 25, now), 0, "another visitor is unaffected");
  assert.equal(consumeAcquisitionEventTokens("203.0.113.5", 25, now + 6_000), 0, "refills at 300 a minute");

  // The DigitalOcean balancer appends the visitor; NGINX appends the balancer. Earlier entries are the visitor's own.
  assert.equal(acquisitionVisitorAddress("203.0.113.5, 10.124.0.7", "127.0.0.1"), "203.0.113.5");
  assert.equal(acquisitionVisitorAddress("1.2.3.4, 203.0.113.5, 10.124.0.7", "127.0.0.1"), "203.0.113.5", "a forged entry is ignored");
  assert.equal(acquisitionVisitorAddress("2001:db8::1, 10.124.0.7", "127.0.0.1"), "2001:db8::1");
  assert.equal(acquisitionVisitorAddress("", "::ffff:198.51.100.9"), "198.51.100.9", "no proxy: the socket address");
});

test("the public route: batches, 400 for bad input, 429 with Retry-After for a flood", async (t) => {
  const { buildApp } = await import("../src/app.js");
  const { resetAcquisitionEventLimits } = await import("../platform/acquisition_event_limits.js");
  resetAcquisitionEventLimits();
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    await app.close();
    await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => {});
  });
  const send = (payload: unknown, visitor = "203.0.113.20") => app.inject({ method: "POST", url: "/v1/platform/acquisition/event", headers: { "content-type": "application/json", "x-forwarded-for": `${visitor}, 10.124.0.7` }, payload: JSON.stringify(payload) });
  const single = await send(interaction("signup_widget_ready", 1));
  assert.equal(single.statusCode, 200, single.body);
  assert.equal(single.json().ok, true);
  const batch = await send({ events: Array.from({ length: 7 }, (_, n) => interaction("signup_mode_change", n)) });
  assert.equal(batch.statusCode, 200, batch.body);
  assert.equal(batch.json().recorded, 7);
  const stored = eventsOfType("signup_mode_change");
  assert.equal(stored.length, 7);
  assert.match(String(JSON.parse(String(stored[0]?.metadata_json)).request?.forwarded_for), /203\.0\.113\.20/, "each event keeps the request metadata");
  const bad = await send({ event_type: "" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_acquisition_event");
  let limited;
  for (let i = 0; i < 14 && !limited; i++) {
    const response = await send({ events: Array.from({ length: 25 }, (_, n) => interaction("signup_field_change", i * 25 + n)) }, "203.0.113.99");
    if (response.statusCode === 429) limited = response;
    else assert.equal(response.statusCode, 200, response.body);
  }
  assert.ok(limited, "a flood from one address is refused");
  assert.equal(limited.json().error, "acquisition_events_rate_limited");
  assert.ok(Number(limited.headers["retry-after"]) > 0, "with Retry-After");
  assert.equal((await send(interaction("signup_widget_ready", 2), "203.0.113.21")).statusCode, 200, "other visitors still recorded");
});
