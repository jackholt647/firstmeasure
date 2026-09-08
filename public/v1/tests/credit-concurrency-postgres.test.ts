import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

test("same-organization credit mutations retain all debits and ledger rows", { skip: !databaseUrl }, async () => {
  assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-credit-concurrency-"));
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl,
    DATABASE_ADMIN_URL: databaseUrl, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false",
    FIRSTMEASURE_JOB_WORKERS: "0", PLATFORM_STORAGE_ROOT: root });
  const storage = await import("../platform/storage.js");
  const database = await import("../src/database/postgres.js");
  try {
    const source = await readFile(new URL("../platform/api.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function applyCreditDelta("), end = source.indexOf("async function creditChargeForToken(", start);
    assert.ok(start >= 0 && end > start);
    const ctx = vm.createContext({ ...storage, asObject: (x: unknown) => x || {}, numericValue: (x: unknown) => Number(x) || 0,
      badRequest: (code: string, message: string) => Object.assign(new Error(message), { code }),
      PlatformError: class extends Error { code: string; constructor(code: string, _status: number, message: string) { super(message); this.code = code; } }
    });
    vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
    const orgId = `credit-race-${process.pid}`;
    await storage.createOrganization({ id: orgId, name: "Synthetic credit test", global: { credits_balance: 100, credits_ledger: [], free_expedite_uses: 20, free_expedite_ledger: [] } });
    ctx.orgId = orgId;
    await Promise.all(Array.from({ length: 8 }, () => vm.runInContext("applyCreditDelta(orgId,{amount:-7,reason:'order_submitted'},'synthetic@example.test')", ctx)));
    const data = (await storage.readGlobal(orgId)).data;
    assert.equal(data.credits_balance, 44);
    assert.equal((data.credits_ledger as unknown[]).length, 8);
    await Promise.all(Array.from({ length: 8 }, () => vm.runInContext("applyFreeExpediteDelta(orgId,{amount:-1},'synthetic@example.test')", ctx)));
    const expedited = (await storage.readGlobal(orgId)).data;
    assert.equal(expedited.free_expedite_uses, 12);
    assert.equal((expedited.free_expedite_ledger as unknown[]).length, 8);

    // Exercise the actual portal ordering callback with only its provider-backed
    // project creation transport replaced. The real debit happens before it.
    const queueStart = source.indexOf("async function portalQueueProject("), queueEnd = source.indexOf("async function portalRefundInstant(", queueStart);
    Object.assign(ctx, {
      cleanText: (value: unknown) => String(value ?? "").trim(),
      isReportExpediteKey: () => false, parseBooleanField: () => false,
      normalizeReportRequestPins: () => [], portalPinLimitForType: () => 0,
      firstMeasureReportCharge: () => ({ amount: 7, gross_amount: 7, free_expedite_discount: 0, free_expedite_applied: false }),
      normalizedPortalQueuePayload: () => ({}), stripeMaybeAutoTopup: async () => null,
      env: { firstMeasureInternalApiSecret: "" }, actor: { email: "synthetic@example.test" }
    });
    vm.runInContext(ts.transpileModule(source.slice(queueStart, queueEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
    const limitedId = `${orgId}-limited`;
    await storage.createOrganization({ id: limitedId, name: "Synthetic limited-credit organization", global: { credits_balance: 7, credits_ledger: [] } });
    ctx.orgId = limitedId;
    let created = 0;
    ctx.app = { inject: async () => { created++; return { statusCode: 201, body: JSON.stringify({ ok: true, folder: `synthetic-${created}` }) }; } };
    const orders = await Promise.allSettled(Array.from({ length: 8 }, () => vm.runInContext("portalQueueProject(app,orgId,actor,{address:'Synthetic order'})", ctx)));
    assert.equal(orders.filter(result => result.status === "fulfilled" && result.value.success).length, 1);
    assert.equal(created, 1, "insufficient concurrent orders must never reach project creation");
    const charged = (await storage.readGlobal(limitedId)).data;
    assert.equal(charged.credits_balance, 0);
    assert.equal((charged.credits_ledger as unknown[]).length, 1);

    const failedId = `${orgId}-failed`;
    await storage.createOrganization({ id: failedId, name: "Synthetic failed orders", global: { credits_balance: 100, credits_ledger: [] } });
    ctx.orgId = failedId;
    ctx.app = { inject: async () => ({ statusCode: 500, body: JSON.stringify({ ok: false, error: "synthetic failure" }) }) };
    const failed = await Promise.all(Array.from({ length: 8 }, () => vm.runInContext("portalQueueProject(app,orgId,actor,{address:'Synthetic failed order'})", ctx)));
    assert.ok(failed.every(result => !result.success));
    const refunded = (await storage.readGlobal(failedId)).data;
    assert.equal(refunded.credits_balance, 100, "known failed order responses are compensated exactly once per debit");
    assert.equal((refunded.credits_ledger as unknown[]).length, 16);

    // Credits from internal adjustments/public API/portal all share the same
    // transactional global record. Do not exercise actual payment providers.
    const mixedId = `${orgId}-mixed`;
    await storage.createOrganization({ id: mixedId, name: "Synthetic mixed billing", global: { credits_balance: 100, credits_ledger: [] } });
    const contexts = [ctx];
    for (const file of ["../internal/api.ts", "../public-firstmeasure/billing.ts"]) {
      const otherSource = await readFile(new URL(file, import.meta.url), "utf8");
      const a = otherSource.indexOf("async function applyCreditDelta("), b = otherSource.indexOf("\n}\n", a) + 2;
      const otherCtx = vm.createContext({ ...storage, asObject: (x: unknown) => x || {},
        cleanText: (x: unknown) => String(x ?? "").trim(), numberValue: (x: unknown) => Number(x) || 0,
        numericValue: (x: unknown) => Number(x) || 0, moneyAmount: (x: unknown) => Math.round(Number(x) * 100) / 100,
        clearOrganizationSummaryCache: () => {}, clearStatsCreditRevenueCache: () => {}
      });
      vm.runInContext(ts.transpileModule(otherSource.slice(a, b), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, otherCtx);
      contexts.push(otherCtx);
    }
    contexts.forEach(context => { context.orgId = mixedId; });
    await Promise.all(Array.from({ length: 18 }, (_, i) => vm.runInContext("applyCreditDelta(orgId,{amount:-1},'synthetic@example.test')", contexts[i % 3]!)));
    const mixed = (await storage.readGlobal(mixedId)).data;
    assert.equal(mixed.credits_balance, 82);
    assert.equal((mixed.credits_ledger as unknown[]).length, 18);

    // Replayed paid Stripe events must not become duplicate deposits now that
    // all ledger mutations are correctly retained. No Stripe API is contacted.
    ctx.orgId = mixedId;
    await Promise.all(Array.from({ length: 8 }, () => vm.runInContext("applyCreditDelta(orgId,{amount:100,reason:'stripe_checkout_paid',meta:{session_id:'cs_test_synthetic_replay'}},'synthetic@example.test')", ctx)));
    const checkout = (await storage.readGlobal(mixedId)).data;
    assert.equal(checkout.credits_balance, 182);
    assert.equal((checkout.credits_ledger as unknown[]).length, 19);
    await Promise.all(Array.from({ length: 8 }, (_, i) => vm.runInContext("applyCreditDelta(orgId,{amount:50,reason:'stripe_auto_topup',meta:{payment_intent_id:'pi_synthetic_replay'}},'synthetic@example.test')", contexts[i % 2 === 0 ? 0 : 2]!)));
    const topup = (await storage.readGlobal(mixedId)).data;
    assert.equal(topup.credits_balance, 232);
    assert.equal((topup.credits_ledger as unknown[]).length, 20);
  } finally { await database.closePostgresPools(); await rm(root, { recursive: true, force: true }).catch(() => {}); }
});
