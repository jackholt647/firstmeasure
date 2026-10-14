import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The worst failure a payment can have: the processor took the money and we
// have no record of it. Once a charge succeeds it is written down before any
// bookkeeping, and a bookkeeping failure never reports the payment as failed.

test("a charge the ledger then refuses is still on the books and still reported as paid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "charge-safety-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  for (const key of ["PLATFORM", "CHANNELS", "CRM", "DOCUMENTS", "FIRSTMEASURE", "PRICEBOOK", "MESSAGING", "INTERNAL", "CALLS"]) process.env[`${key}_STORAGE_ROOT`] = path.join(root, key);
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "FIRSTMEASURE", "index.sqlite");
  const { recordProviderChargedPayment } = await import("../payments/intake.js");
  const { PAYMENT_TRANSACTION_COLLECTION } = await import("../payments/storage.js");
  const { createOrganization, readDocument } = await import("../platform/storage.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { closePlatformFixtureStores } = await import("./helpers/platform-fixture.js");
  try {
    // An organization whose Money app is off: the full payment record is refused.
    const organization = await createOrganization({ id: "org_charge_safety", name: "Charge safety" } as never);
    const orgId = String((organization as { id?: unknown }).id || "org_charge_safety");
    const charged: string[] = [];
    const provider = {
      provider: "forward",
      createPaymentIntent: async (input: { reference_id: string }) => ({ id: `pi_${input.reference_id}` }),
      createPayment: async (intentId: string) => { charged.push(intentId); return { id: "pay_Taken-123", status: "succeeded", auth_code: "A1", raw: { fee: 87 } }; },
      getPaymentMethod: async () => null
    };
    const result = await recordProviderChargedPayment(orgId, provider as never, {
      amount_cents: 250000,
      payment_method_id: "pm_card",
      method: "card",
      project_id: "project_roof",
      apply_surcharge: false,
      contact_ref: { name: "Phil Testaroo", email: "phil@example.test" },
      payment: { kind: "customer_payment", currency: "USD", obligation_id: "obl_deposit", metadata: { document_id: "doc_1", document_output_id: "doc_1:deposit_payment", source: "document_engine" } }
    } as never, { userId: "document_public", branchId: "default" } as never) as Record<string, any>;

    assert.equal(charged.length, 1, "the card was charged exactly once");
    // The caller hears that the payment went through, because it did.
    assert.equal(result.needs_review, true);
    assert.equal(result.payment.amount_cents, 250000);
    assert.equal(result.payment.id, "payment_provider_pay_taken-123");
    // And it is on the books, with everything known about it, where unmatched settlements are worked.
    const stored = (await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, "payment_provider_pay_taken-123")) as Record<string, any>;
    const record = stored.data;
    assert.equal(record.kind, "provider_payment");
    assert.equal(record.amount_cents, 250000);
    assert.equal(record.fee_cents, 87);
    assert.equal(record.project_id, "project_roof");
    assert.equal(record.contact_ref.email, "phil@example.test");
    assert.equal(record.processor.provider_payment_id, "pay_Taken-123");
    assert.equal(record.processor.auth_code, "A1");
    assert.equal(record.metadata.provider_unmatched, true);
    assert.equal(record.metadata.needs_review, true);
    assert.equal(record.metadata.document_output_id, "doc_1:deposit_payment", "what it was for is kept");
    assert.equal(record.metadata.intended_obligation_id, "obl_deposit");
    assert.ok(record.metadata.record_error, "why the full record failed is kept");
  } finally {
    await closePlatformFixtureStores().catch(() => undefined);
    await closeSqlStoresForTests().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});
