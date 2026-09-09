import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { reconcileReferralLedgers } from "../src/scripts/referral_ledger_reconcile.js";

test("historical reconciliation preserves relationships, upgrades overlapping IDs, and is idempotent", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "firstmeasure-referral-reconcile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { ensureReferralDatabase } = await import("../internal/crm/referrals.js");
  const fixture = async (name: string, codeId: string, authoritative: boolean) => {
    process.env.CRM_STORAGE_ROOT = path.join(root, name);
    await ensureReferralDatabase();
    const file = path.join(root, name, "databases", "referrals.sqlite");
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO referral_partners(id,type,display_name,metadata_json,created_at,updated_at) VALUES ('campaign','acquisition_campaign','Main',?,'2026-09-01','2026-09-01')")
      .run(authoritative ? '{"bonus_offer_sets":{"keep-this-offer":{}}}' : '{}');
    db.prepare("INSERT INTO referral_codes(id,partner_id,code,metadata_json,created_at,updated_at) VALUES (?,'campaign','MAIN',?,'2026-09-01','2026-09-01')")
      .run(codeId, authoritative ? '{"authority":"compatibility"}' : '{}');
    db.close();
    return file;
  };
  const target = await fixture("target", "canonical-code", true);
  const nodeA = await fixture("web-a", "node-a-code", false);
  const nodeB = await fixture("web-b", "node-b-code", false);
  const attribution = (file: string, id: string, code: string, org: string, status = "signup_completed") => {
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO referral_attributions(id,partner_id,code_id,status,referred_org_id,referred_email,signup_completed_at,created_at,updated_at,metadata_json) VALUES (?,'campaign',?,?,?,?,?,'2026-09-01','2026-09-09',?)")
      .run(id, code, status, org, org ? `${org}@example.test` : "", org ? "2026-09-09" : "", '{"acquisition_bonus_token":"original-public-token"}');
    db.close();
  };
  attribution(target, "shared-landing-id", "canonical-code", "", "viewed");
  attribution(nodeA, "shared-landing-id", "node-a-code", "org-overlap");
  attribution(nodeB, "shared-landing-id", "node-b-code", "org-overlap");
  attribution(nodeA, "signup-a", "node-a-code", "org-a");
  attribution(nodeB, "signup-b", "node-b-code", "org-b");
  for (const [file, code] of [[nodeA, "node-a-code"], [nodeB, "node-b-code"]]) {
    const db = new DatabaseSync(file!);
    db.prepare("INSERT INTO referral_events(id,partner_id,code_id,code,event_type,event_count,created_at,updated_at) VALUES ('shared-event','campaign',?,'MAIN','landing',2,'2026-09-01','2026-09-09')").run(code!);
    db.prepare("INSERT INTO referral_reward_ledger(id,attribution_id,partner_id,code_id,amount,status,created_at,updated_at) VALUES ('shared-reward','shared-landing-id','campaign',?,5,'pending','2026-09-01','2026-09-09')").run(code!);
    db.close();
  }
  const before = readFileSync(target);
  const plan = reconcileReferralLedgers({ target, sources: [nodeA, nodeB] });
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.counts.referral_attributions, { insert: 2, update: 1 });
  assert.deepEqual(plan.counts.referral_codes, { insert: 0, update: 0 });
  assert.deepEqual(plan.counts.referral_reward_ledger, { insert: 1, update: 0 });
  assert.deepEqual(readFileSync(target), before, "dry-run cannot alter target database bytes");
  const backup = path.join(root, "pre-merge.sqlite");
  const applied = reconcileReferralLedgers({ target, sources: [nodeA, nodeB], apply: true, confirmPlan: plan.digest, backup });
  assert.equal(applied.applied, true);
  const inspect = new DatabaseSync(target, { readOnly: true });
  assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM referral_attributions WHERE code_id='canonical-code' AND status='signup_completed'").get()?.n, 3);
  assert.match(String(inspect.prepare("SELECT metadata_json FROM referral_partners WHERE id='campaign'").get()?.metadata_json), /keep-this-offer/);
  assert.equal(inspect.prepare("SELECT attribution_id FROM referral_reward_ledger").get()?.attribution_id, "shared-landing-id");
  assert.equal(inspect.prepare("SELECT event_count FROM referral_events").get()?.event_count, 2);
  inspect.close();
  const backupDb = new DatabaseSync(backup, { readOnly: true });
  assert.equal(backupDb.prepare("SELECT status FROM referral_attributions").get()?.status, "viewed");
  backupDb.close();
  const repeat = reconcileReferralLedgers({ target, sources: [nodeA, nodeB] });
  assert.deepEqual(repeat.conflicts, []);
  assert.ok(Object.values(repeat.counts).every(count => count.insert === 0 && count.update === 0));

  await t.test("conflicting identity aborts without partial writes or backup overwrite", async () => {
    const bad = await fixture("conflict", "bad-code", false);
    attribution(bad, "shared-landing-id", "bad-code", "wrong-org");
    attribution(bad, "new-but-must-not-apply", "bad-code", "another-org");
    const conflict = reconcileReferralLedgers({ target, sources: [bad] });
    assert.equal(conflict.conflicts.length, 1);
    assert.match(conflict.conflicts[0]!.reason, /another organization/);
    assert.throws(() => reconcileReferralLedgers({ target, sources: [bad], apply: true, confirmPlan: conflict.digest, backup: path.join(root, "must-not-create.sqlite") }), /contains conflicts/);
    const check = new DatabaseSync(target, { readOnly: true });
    assert.equal(check.prepare("SELECT COUNT(*) n FROM referral_attributions WHERE id='new-but-must-not-apply'").get()?.n, 0);
    check.close();
    assert.throws(() => reconcileReferralLedgers({ target, sources: [nodeA], apply: true, confirmPlan: repeat.digest, backup }), /new path/);
  });

  await t.test("legacy target unique event index is detected during dry-run; attribution-only recovery leaves it intact", async () => {
    const legacy = await fixture("legacy-unique-target", "legacy-code", true);
    const legacyDb = new DatabaseSync(legacy);
    legacyDb.exec("CREATE UNIQUE INDEX idx_referral_events_unique ON referral_events(partner_id,actor_email,actor_org_id,event_type)");
    legacyDb.exec("CREATE UNIQUE INDEX idx_referral_attr_org_unique ON referral_attributions(referred_org_id) WHERE referred_org_id<>''");
    legacyDb.exec("INSERT INTO referral_events(id,partner_id,code_id,event_type,event_count,created_at,updated_at) VALUES ('older-event','campaign','legacy-code','landing',17,'2026-09-01','2026-09-09')");
    legacyDb.close();
    const full = reconcileReferralLedgers({ target: legacy, sources: [nodeA, nodeB] });
    assert.equal(full.conflicts.filter(conflict => /UNIQUE event key/.test(conflict.reason)).length, 2);
    assert.throws(() => reconcileReferralLedgers({ target: legacy, sources: [nodeA, nodeB], apply: true, confirmPlan: full.digest, backup: path.join(root, "must-not-apply-unique.sqlite") }), /contains conflicts/);
    const attributionOnly = reconcileReferralLedgers({ target: legacy, sources: [nodeA, nodeB], scope: "attributions" });
    assert.deepEqual(attributionOnly.conflicts, []);
    assert.deepEqual(attributionOnly.counts.referral_attributions, { insert: 3, update: 0 });
    assert.deepEqual(attributionOnly.counts.referral_events, { insert: 0, update: 0 });
    assert.deepEqual(attributionOnly.counts.referral_reward_ledger, { insert: 0, update: 0 });
    reconcileReferralLedgers({ target: legacy, sources: [nodeA, nodeB], scope: "attributions", apply: true, confirmPlan: attributionOnly.digest, backup: path.join(root, "before-attribution-only.sqlite") });
    const check = new DatabaseSync(legacy, { readOnly: true });
    assert.equal(check.prepare("SELECT COUNT(*) n FROM referral_attributions").get()?.n, 3);
    assert.equal(check.prepare("SELECT event_count FROM referral_events").get()?.event_count, 17);
    assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='idx_referral_events_unique'").get()?.n, 1);
    assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='idx_referral_attr_org_unique'").get()?.n, 1);
    check.close();
    const again = reconcileReferralLedgers({ target: legacy, sources: [nodeA, nodeB], scope: "attributions" });
    assert.ok(Object.values(again.counts).every(count => count.insert === 0 && count.update === 0));
  });

  await t.test("attribution-only preflight covers noncompleted org uniqueness, scope purity, and existing bonus conflicts", async () => {
    const occupied = await fixture("noncompleted-org-target", "occupied-code", true);
    attribution(occupied, "held-org-id", "occupied-code", "org-a", "viewed");
    const occupiedDb = new DatabaseSync(occupied);
    occupiedDb.exec("CREATE UNIQUE INDEX idx_referral_attr_org_unique ON referral_attributions(referred_org_id) WHERE referred_org_id<>''");
    occupiedDb.close();
    const noncompleted = reconcileReferralLedgers({ target: occupied, sources: [nodeA], scope: "attributions" });
    assert.ok(noncompleted.conflicts.some(conflict => /different attribution ID/.test(conflict.reason)));

    const unmapped = await fixture("unmapped-source", "unmapped-code", false);
    const unmappedDb = new DatabaseSync(unmapped);
    unmappedDb.exec("UPDATE referral_codes SET code='NEW-UNAPPROVED-CODE'");
    unmappedDb.close();
    attribution(unmapped, "unmapped-attribution", "unmapped-code", "unmapped-org");
    const unknownCode = reconcileReferralLedgers({ target, sources: [unmapped], scope: "attributions" });
    assert.ok(unknownCode.conflicts.some(conflict => /cannot create a missing code/.test(conflict.reason)));
    assert.deepEqual(unknownCode.counts.referral_codes, { insert: 0, update: 0 });
    assert.deepEqual(unknownCode.counts.referral_partners, { insert: 0, update: 0 });

    const bonusConflict = await fixture("bonus-conflict-target", "bonus-code", true);
    attribution(bonusConflict, "shared-landing-id", "bonus-code", "org-overlap");
    const bonusDb = new DatabaseSync(bonusConflict);
    bonusDb.exec(`UPDATE referral_attributions SET metadata_json='{"acquisition_bonus_token":"canonical-token"}'`);
    bonusDb.close();
    const bonusPlan = reconcileReferralLedgers({ target: bonusConflict, sources: [nodeA], scope: "attributions" });
    assert.ok(bonusPlan.conflicts.some(conflict => /different advertised bonus token/.test(conflict.reason)), "completed rows must not bypass token conflict checks");
  });
});
