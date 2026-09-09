import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";

const root = mkdtempSync(path.join(tmpdir(), "firstmeasure-referral-cluster-"));
process.env.FIRSTMATE_ENV = "test";
process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
process.env.CRM_STORAGE_ROOT = path.join(root, "compatibility-crm");
process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
if (process.env.TEST_POSTGRES_URL) {
  process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
  process.env.DATABASE_URL = process.env.TEST_POSTGRES_URL;
  process.env.POSTGRES_POOL_MAX = "1";
}

test("cross-node campaign signup retains the advertised bonus and appears in the staff report", async (t) => {
  const referrals = await import("../internal/crm/referrals.js");
  const { createReferralService, referralServiceRoutes } = await import("../internal/crm/referrals_service.js");
  const { createOrganization, saveGlobal } = await import("../platform/storage.js");
  await referrals.ensureReferralDatabase();
  await referrals.saveAcquisitionCampaign({
    code: "main", display_name: "Main campaign",
    bonus_offer_sets: {
      "offer-set-1": { id: "offer-set-1", token: "advertised-token", label: "Advertised offer", status: "active", tiers: [{ customer_pays: 100, match_percent: 25 }] }
    }
  });
  const compatibility = Fastify();
  await compatibility.register(referralServiceRoutes("test-private-secret"), { prefix: "/v1/private/referrals" });
  await compatibility.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await compatibility.close(); rmSync(root, { recursive: true, force: true }); });
  const address = compatibility.server.address();
  assert.ok(address && typeof address === "object");
  const config = { deploymentTopology: "cluster", clusterNodeRole: "web", legacyServiceUrl: `http://127.0.0.1:${address.port}`, legacyProxySecret: "test-private-secret" } as const;
  const webA = createReferralService(config);
  const webB = createReferralService(config);
  const landing = await webA.publicAcquisitionLookup({ cid: "main", xid: "advertised-token" });
  assert.equal(landing.bonus_offer?.token, "advertised-token");
  const org = await createOrganization({ name: "Isolated referral test" });
  await saveGlobal(String(org.id), { data: { credits_ledger: [{ ts: new Date().toISOString(), delta: -7, reason: "isolated report fixture" }] } });
  const completion = await webB.completeAcquisitionSignup({
    org_id: String(org.id), email: "bonus@example.test", acquisition_code: "main",
    acquisition_attribution_id: landing.acquisition_attribution_id, acquisition_bonus_token: "advertised-token"
  });
  assert.equal(completion.success, true);
  const status = await webA.acquisitionBonusOfferForOrganization(String(org.id));
  assert.equal(status.offer_enabled, true);
  assert.equal(status.offer?.token, "advertised-token");
  await referrals.saveAcquisitionCampaign({ id: landing.campaign?.id, display_name: "Renamed main campaign" });
  const afterRename = await webB.acquisitionBonusOfferForOrganization(String(org.id));
  assert.equal(afterRename.offer?.token, "advertised-token", "editing a campaign name must not erase its stored bonus sets");
  const quote = await webB.acquisitionBonusQuoteForOrganization(String(org.id), 100, "advertised-token");
  assert.equal(quote.valid, true);
  assert.equal(quote.bonus_dollars, 25);
  const report = await referrals.acquisitionCampaignReport({});
  assert.equal(report.summary.signups, 1);
  assert.equal(report.summary.spend, 7);
  assert.equal(report.recent_signups[0]?.org_id, org.id);
  assert.equal(report.recent_signups[0]?.attribution_id, landing.acquisition_attribution_id);

  await t.test("private RPC rejects untrusted callers and unsupported operations", async () => {
    assert.equal((await compatibility.inject({ method: "POST", url: "/v1/private/referrals/completeAcquisitionSignup", payload: { args: [] } })).statusCode, 403);
    assert.equal((await compatibility.inject({ method: "POST", url: "/v1/private/referrals/saveAcquisitionCampaign", headers: { "x-firstmeasure-legacy-proxy": "test-private-secret" }, payload: { args: [] } })).statusCode, 404);
    const unavailable = createReferralService({ ...config, legacyProxySecret: "wrong-secret" });
    await assert.rejects(unavailable.publicAcquisitionLookup({ cid: "main" }), /temporarily unavailable/);
  });

  await t.test("campaign report includes new signups after more than 20,000 older visits", async () => {
    const db = new DatabaseSync(path.join(root, "compatibility-crm", "databases", "referrals.sqlite"));
    const code = db.prepare("SELECT id, partner_id FROM referral_codes WHERE code='main'").get()!;
    const insert = db.prepare("INSERT INTO referral_attributions (id,partner_id,code_id,status,created_at,updated_at) VALUES (?,?,?,'viewed','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')");
    db.exec("BEGIN");
    for (let i = 0; i < 20001; i++) insert.run(`old-${i}`, String(code.partner_id), String(code.id));
    db.exec("COMMIT");
    db.close();
    const current = await referrals.acquisitionCampaignReport({ start: "2026-09-01", end: "2027-09-30" });
    assert.equal(current.summary.signups, 1);
    assert.equal(current.summary.views, 1);
    assert.equal(current.recent_signups[0]?.org_id, org.id);
    const historical = await referrals.acquisitionCampaignReport({ start: "2026-08-01", end: "2026-08-01" });
    assert.equal(historical.summary.views, 20001);
  });
});
