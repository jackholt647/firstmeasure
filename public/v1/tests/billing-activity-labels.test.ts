// FM-406: a customer's billing activity never names the FirstMate technician
// who rejected a report or the staff member who cancelled one, and an expedite
// charged after ordering reads "Expedite fee", not "Credit adjustment".
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextTestPhone } from "./helpers/platform-fixture.js";
import { customerLedgerEntries } from "../platform/credit_statement.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoPublic = path.resolve(here, "../..");
let app: any;
let storage: typeof import("../platform/storage.js");

before(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "billing-activity-labels-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "sqlite", DATABASE_URL: "", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", CUSTOMER_CALL_WORKER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", V1_LOG_LEVEL: "error", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "measure/index.sqlite") });
  for (const name of ["PLATFORM", "INTERNAL", "CRM", "FIRSTMEASURE", "MESSAGING", "CHANNELS", "CALLS", "PRICEBOOK"]) process.env[name + "_STORAGE_ROOT"] = path.join(root, name.toLowerCase());
  app = await (await import("../src/app.js")).buildApp();
  await app.ready();
  storage = await import("../platform/storage.js");
});

after(async () => {
  await app?.close();
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
});

function client() {
  let cookie = "", csrf = "";
  return {
    org: "",
    async request(method: string, url: string, payload?: any) {
      const response = await app.inject({ method, url, payload, headers: { cookie, ...(csrf ? { "x-platform-csrf": csrf } : {}) } });
      const set = response.headers["set-cookie"];
      if (set) {
        const pairs = (Array.isArray(set) ? set : [set]).map((v: string) => v.split(";")[0] || "");
        cookie = pairs.join("; ");
        csrf = decodeURIComponent(pairs.find((v: string) => v.startsWith("fm_platform_session_csrf="))?.split("=")[1] || "");
      }
      assert.ok(response.statusCode < 400, response.body);
      return response.json();
    }
  };
}

const OWNER = "owner@billing-activity.example.test";
const TECHNICIAN = "rashid.rater@gmail.com";
const SUPPORT = "support.person@1m8.ai";

function fixtureLedger(ts: string) {
  return [
    { ts, reason: "order_submitted", delta: -7, by_email: OWNER, applied_for_user_email: OWNER, meta: { address: "1 Main St", project_type: "residential" } },
    { ts, reason: "rejection_refund", delta: 7, by_email: TECHNICIAN, applied_for_user_email: null, meta: { address: "1 Main St", rejected_by_email: TECHNICIAN, rejected_by_name: "Rashid Ruiz", source: "firstmeasure_coverage_reject" } },
    { ts, reason: "cancellation_refund", delta: 7, by_email: SUPPORT, applied_for_user_email: OWNER, meta: { address: "2 Elm St", cancelled_by_email: SUPPORT, cancelled_by_name: "Support Person" } },
    { ts, reason: "order_expedite_upgrade", delta: -5, by_email: OWNER, meta: { address: "1 Main St", failed: { actor: { email: SUPPORT, name: "Support Person" } } } }
  ];
}

test("staff emails and the names beside them are removed; the organization's own people stay", () => {
  const [order, rejected, cancelled, expedite] = customerLedgerEntries(fixtureLedger("2026-11-12T00:00:00Z"), [OWNER.toUpperCase()]) as any[];
  assert.equal(order.by_email, OWNER);
  assert.equal(order.applied_for_user_email, OWNER);
  assert.equal(rejected.by_email, undefined);
  assert.equal(rejected.applied_for_user_email, null);
  assert.deepEqual(rejected.meta, { address: "1 Main St", source: "firstmeasure_coverage_reject" });
  assert.equal(cancelled.by_email, undefined);
  assert.equal(cancelled.applied_for_user_email, OWNER);
  assert.deepEqual(cancelled.meta, { address: "2 Elm St" });
  assert.deepEqual(expedite.meta, { address: "1 Main St", failed: { actor: {} } });
  assert.equal(expedite.delta, -5);
});

test("every billing read a customer can make leaves out FirstMate staff", async () => {
  const c = client();
  const registration = await c.request("POST", "/v1/platform/auth/register", { email: OWNER, password: "billing-activity-password-123", phone: nextTestPhone(), company: "Billing activity fixture" });
  c.org = registration.organization.id;
  const now = new Date();
  await storage.saveGlobal(c.org, { data: { credits_ledger: fixtureLedger(now.toISOString()) } });
  const reads = [
    (await c.request("POST", "/v1/platform/portal-action", { action: "org_billing_history_my", limit: 50 })).ledger,
    (await c.request("POST", "/v1/platform/portal-action", { action: "org_monthly_statement", month: now.getUTCMonth() + 1, year: now.getUTCFullYear() })).transactions,
    (await c.request("GET", `/v1/platform/organizations/${c.org}/credits/ledger?limit=50`)).ledger
  ];
  for (const ledger of reads) {
    assert.equal(ledger.length, 4);
    const text = JSON.stringify(ledger);
    assert.ok(!text.includes(TECHNICIAN) && !text.includes(SUPPORT), text);
    assert.ok(!text.includes("Rashid") && !text.includes("Support Person"), text);
    assert.ok(text.includes(OWNER), "the customer's own orderer is still shown");
  }
  const stored = await storage.readGlobal(c.org);
  assert.equal((stored.data as any).credits_ledger[1].by_email, TECHNICIAN, "the stored ledger keeps who did it");
});

test("billing activity titles expedite charges and their refunds", async () => {
  const source = await readFile(path.join(repoPublic, "libraries/apps/settings/company.js"), "utf8");
  const body = source.match(/function msLedgerTitle\(row\)\{[\s\S]*?\n    \}/)?.[0];
  assert.ok(body, "msLedgerTitle is in settings/company.js");
  const title = new Function("settingsText", "msReason", "msIsAdditionalStructureRefund", "msIsAdditionalStructureLedger",
    `${body}; return msLedgerTitle;`)(
    (_key: string, fallback: string) => fallback,
    (row: any) => String(row?.reason || "").toLowerCase(),
    () => false,
    () => false
  );
  assert.equal(title({ reason: "order_expedite_upgrade" }), "Expedite fee");
  assert.equal(title({ reason: "order_expedite_upgrade_refund" }), "Expedite fee refund");
  assert.equal(title({ reason: "order_submitted" }), "Report ordered");
  const catalog = JSON.parse(await readFile(path.join(here, "../platform/localization/catalog-source.json"), "utf8"));
  assert.equal(catalog.settings.fm_expedite_fee, "Expedite fee");
  assert.equal(catalog.settings.fm_expedite_fee_refund, "Expedite fee refund");
  for (const locale of ["cs-CZ", "da-DK", "de-DE", "el-GR", "es-ES", "fi-FI", "fr-FR", "it-IT", "ja-JP", "lt-LT", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "sv-SE"]) {
    const pack = JSON.parse(await readFile(path.join(here, `../platform/localization/packs/${locale}.json`), "utf8"));
    assert.ok(pack.settings.fm_expedite_fee && pack.settings.fm_expedite_fee_refund, `${locale} translates the expedite fee titles`);
  }
});
