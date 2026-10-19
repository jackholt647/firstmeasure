import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { startTestTimestampAuthority } from "./helpers/test-timestamp-authority.js";

let dir = "";
let tsa: Awaited<ReturnType<typeof startTestTimestampAuthority>>;
let seal: typeof import("../documents/signing/seal.js");
let ledger: typeof import("../documents/signing/ledger.js");
let store: typeof import("../documents/signing/store.js");
let ca: typeof import("../documents/signing/seal-ca.js");

async function samplePdf(text = "Roof replacement agreement") {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText(text, { x: 72, y: 700, size: 14, font });
  pdf.addPage([612, 792]).drawText("Signature record", { x: 72, y: 700, size: 12, font });
  return Buffer.from(await pdf.save());
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "firstmate-seal-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_STORAGE_ROOT = path.join(dir, "platform");
  tsa = await startTestTimestampAuthority();
  await writeFile(path.join(dir, "tsa-root.pem"), tsa.rootPem);
  process.env.DOCUMENT_TIMESTAMP_URLS = tsa.url;
  process.env.DOCUMENT_TIMESTAMP_TRUST_FILE = path.join(dir, "tsa-root.pem");
  seal = await import("../documents/signing/seal.js");
  ledger = await import("../documents/signing/ledger.js");
  store = await import("../documents/signing/store.js");
  ca = await import("../documents/signing/seal-ca.js");
});
after(async () => {
  await tsa?.close();
  await store?.closeSigningStore();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test("a sealed agreement verifies, carries an outside timestamp and chains to the development root", async () => {
  const sealed = await seal.sealPdf(await samplePdf(), { reason: "Executed agreement" });
  assert.equal(sealed.provider, "development");
  assert.ok(sealed.timestamp, "the seal is timestamped");
  assert.equal(tsa.requests, 1);
  const check = await seal.verifySealedPdf(sealed.bytes);
  assert.equal(check.sealed, true); assert.equal(check.intact, true); assert.equal(check.trusted, true); assert.equal(check.certified, true);
  assert.equal(check.certificate!.development, true);
  assert.match(check.certificate!.subject, /FirstMate Development Document Seal/);
  assert.equal(check.timestamp!.time, sealed.timestamp!.time);
  // The sealed file still opens and keeps its pages.
  assert.equal((await PDFDocument.load(sealed.bytes)).getPageCount(), 2);
});

test("changing one byte, or appending an update, breaks the seal", async () => {
  const sealed = await seal.sealPdf(await samplePdf(), { reason: "Executed agreement" });
  const text = sealed.bytes.toString("latin1"), at = text.indexOf("Roof replacement") >= 0 ? text.indexOf("Roof replacement") : 200;
  const altered = Buffer.from(sealed.bytes); altered[at] = altered[at]! ^ 0x01;
  assert.equal((await seal.verifySealedPdf(altered)).intact, false);
  const appended = Buffer.concat([sealed.bytes, Buffer.from("\n1 0 obj\n<< >>\nendobj\n")]);
  const result = await seal.verifySealedPdf(appended);
  assert.equal(result.intact, false); assert.match(result.reason!, /changed after it was sealed/);
  assert.equal((await seal.verifySealedPdf(await samplePdf())).sealed, false);
});

test("a seal from someone else's authority is intact but not trusted", async () => {
  const other = ca.createSealAuthority({ organization: "Elsewhere Inc" });
  await writeFile(path.join(dir, "other-key.pem"), other.sealKeyPem);
  await writeFile(path.join(dir, "other-chain.pem"), other.sealCertPem + other.rootCertPem);
  process.env.DOCUMENT_SEAL_KEY_FILE = path.join(dir, "other-key.pem"); process.env.DOCUMENT_SEAL_CHAIN_FILE = path.join(dir, "other-chain.pem");
  try {
    const sealed = await seal.sealPdf(await samplePdf(), { reason: "Elsewhere" });
    assert.equal(sealed.provider, "local");
    delete process.env.DOCUMENT_SEAL_KEY_FILE; delete process.env.DOCUMENT_SEAL_CHAIN_FILE;
    const check = await seal.verifySealedPdf(sealed.bytes);
    assert.equal(check.intact, true); assert.equal(check.trusted, false);
  } finally { delete process.env.DOCUMENT_SEAL_KEY_FILE; delete process.env.DOCUMENT_SEAL_CHAIN_FILE; }
});

test("a configured local authority is used and trusted, so a purchased certificate is a configuration change", async () => {
  const own = ca.createSealAuthority({ organization: "FirstMate" });
  await writeFile(path.join(dir, "own-key.pem"), own.sealKeyPem);
  await writeFile(path.join(dir, "own-chain.pem"), own.sealCertPem + own.rootCertPem);
  await writeFile(path.join(dir, "own-crl.pem"), own.crlPem);
  Object.assign(process.env, { DOCUMENT_SEAL_KEY_FILE: path.join(dir, "own-key.pem"), DOCUMENT_SEAL_CHAIN_FILE: path.join(dir, "own-chain.pem"), DOCUMENT_SEAL_CRL_FILE: path.join(dir, "own-crl.pem") });
  try {
    const sealed = await seal.sealPdf(await samplePdf(), { reason: "Executed agreement" });
    const check = await seal.verifySealedPdf(sealed.bytes);
    assert.equal(check.trusted, true); assert.equal(check.certificate!.development, false);
    assert.match(check.certificate!.subject, /FirstMate Document Seal/);
  } finally { for (const k of ["DOCUMENT_SEAL_KEY_FILE", "DOCUMENT_SEAL_CHAIN_FILE", "DOCUMENT_SEAL_CRL_FILE"]) delete process.env[k]; }
});

test("a failed timestamp authority falls through to the next one", async () => {
  const backup = await startTestTimestampAuthority();
  await writeFile(path.join(dir, "tsa-roots.pem"), tsa.rootPem + backup.rootPem);
  process.env.DOCUMENT_TIMESTAMP_URLS = `${tsa.url},${backup.url}`; process.env.DOCUMENT_TIMESTAMP_TRUST_FILE = path.join(dir, "tsa-roots.pem");
  try {
    tsa.failNext(1);
    const sealed = await seal.sealPdf(await samplePdf(), { reason: "Executed agreement" });
    assert.equal(sealed.timestamp!.authority, backup.url);
    process.env.DOCUMENT_TIMESTAMP_URLS = tsa.url; tsa.failNext(1);
    await assert.rejects(seal.sealPdf(await samplePdf(), { reason: "x" }), /timestamp_failed/);
  } finally {
    process.env.DOCUMENT_TIMESTAMP_URLS = tsa.url; process.env.DOCUMENT_TIMESTAMP_TRUST_FILE = path.join(dir, "tsa-root.pem");
    await backup.close();
  }
});

test("a timestamp from an untrusted authority is refused", async () => {
  const rogue = await startTestTimestampAuthority();
  process.env.DOCUMENT_TIMESTAMP_URLS = rogue.url;
  try { await assert.rejects(seal.sealPdf(await samplePdf(), { reason: "x" }), /certificate_untrusted/); }
  finally { process.env.DOCUMENT_TIMESTAMP_URLS = tsa.url; await rogue.close(); }
});

test("the ledger chains every entry, detects an altered or removed entry, and anchors its head", async () => {
  const first = await ledger.appendLedger({ organization_id: "org_a", package_id: "pkg_1", kind: "receipt", subject_hash: "a".repeat(64), payload: { field: "sig" } });
  await ledger.appendLedger({ organization_id: "org_a", package_id: "pkg_1", kind: "executed", subject_hash: "b".repeat(64) });
  await ledger.appendLedger({ organization_id: "org_b", package_id: "pkg_2", kind: "receipt", subject_hash: "c".repeat(64) });
  assert.equal((await ledger.verifyLedgerFrom(first.seq)).ok, true);

  process.env.DOCUMENT_LEDGER_ANCHOR_SECONDS = "0";
  const anchor = await ledger.anchorLedger();
  assert.ok(anchor); assert.equal(anchor!.kind, "anchor");
  assert.equal(await ledger.anchorLedger(), null, "nothing new to anchor");
  const anchored = await ledger.verifyLedgerFrom(first.seq);
  assert.equal(anchored.ok, true); assert.ok(anchored.anchor?.time);

  const db = store.signingStore();
  await db.prepare("UPDATE document_signing_ledger SET payload_json=? WHERE seq=?").run(JSON.stringify({ field: "forged" }), first.seq);
  const altered = await ledger.verifyLedgerFrom(first.seq);
  assert.equal(altered.ok, false); assert.match(altered.problem!, /altered/);
  await db.prepare("UPDATE document_signing_ledger SET payload_json=? WHERE seq=?").run(JSON.stringify({ field: "sig" }), first.seq);
  assert.equal((await ledger.verifyLedgerFrom(first.seq)).ok, true);

  await assert.rejects(db.prepare("INSERT INTO document_signing_ledger(seq,organization_id,package_id,kind,subject_hash,payload_json,created_at,prev_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(999, "x", "x", "receipt", "d".repeat(64), "{}", new Date().toISOString(), first.entry_hash, "e".repeat(64)), "a second entry cannot follow the same predecessor");
  // Removing an entry breaks the link after it.
  const second = (await ledger.ledgerEntriesForPackage("pkg_1"))[1]!;
  await db.prepare("DELETE FROM document_signing_ledger WHERE seq=?").run(second.seq);
  assert.equal((await ledger.verifyLedgerFrom(first.seq)).ok, false);
});
