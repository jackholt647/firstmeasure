import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("PostgreSQL signing receipts, package state and outbox commit atomically under concurrent writers", { skip: !process.env.TEST_POSTGRES_URL }, async t => {
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: process.env.TEST_POSTGRES_URL, POSTGRES_POOL_MAX: "8", POSTGRES_AUTO_MIGRATE: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local" });
  const store = await import("../documents/signing/store.js");
  t.after(async () => { await store.closeSigningStore(); await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); });
  const id = randomUUID(), org = `signing_${id}`;
  const pkg: import("../documents/signing/model.js").SigningPackage = { id, organization_id: org, document_id: id, snapshot_id: id, status: "open", fields: {}, signers: [], receipts: {}, created_at: new Date().toISOString(), expires_at: "2099-01-01", content: {}, content_hash: "retained", source_hash: "source", review_pdf: "", final_pdf: "", final_pdf_hash: "", challenges: {}, disclosure: { version: "1", text: "consent", hash: "disclosure" } };
  await store.savePackage(pkg);
  await Promise.all(Array.from({ length: 8 }, (_, n) => store.withSigningLock(org, id, async () => {
    const next = (await store.readPackage(id))!;
    const receipt = { id: `${id}_${n}`, field: `field_${n}`, signer_id: String(n), content_hash: "retained", signed_at: new Date().toISOString(), value: {}, evidence: {}, request_hash: String(n) };
    next.receipts[receipt.field] = receipt;
    await store.signingStore().prepare("INSERT INTO document_signing_receipts(id,package_id,field_key,value_json) VALUES(?,?,?,?)").run(receipt.id,id,receipt.field,JSON.stringify(receipt));
    await store.savePackage(next);
    await store.queueSigningEvent(next,"document.signature.accepted",receipt.field,{});
  })));
  assert.equal(Object.keys((await store.readPackage(id))!.receipts).length, 8);
  assert.equal((await store.signingStore().prepare("SELECT id FROM document_signing_outbox WHERE package_id=?").all(id)).length, 8);
  await assert.rejects(store.withSigningLock(org,id,async () => {
    const next = (await store.readPackage(id))!; next.status = "completed"; await store.savePackage(next);
    await store.queueSigningEvent(next,"document.signed","",{}); throw new Error("crash before commit");
  }), /crash before commit/);
  assert.equal((await store.readPackage(id))!.status, "open");
  assert.equal((await store.signingStore().prepare("SELECT id FROM document_signing_outbox WHERE package_id=? AND event_type=?").all(id,"document.signed")).length, 0);
  await assert.rejects(store.signingStore().prepare("INSERT INTO document_signing_receipts(id,package_id,field_key,value_json) VALUES(?,?,?,?)").run(`${id}_replacement`,id,"field_0","{}"));
});
