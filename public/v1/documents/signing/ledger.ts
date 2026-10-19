import { digest } from "./model.js";
import { signingStore } from "./store.js";
import { requestTimestamp, timestampAuthorities, verifyTimestampToken } from "./timestamp.js";

/**
 * The signing ledger: one append-only hash chain across every organization.
 * Each accepted signature, executed copy and seal adds an entry whose hash
 * covers the entry before it, so changing or removing a past entry breaks
 * every hash after it. Anchors timestamp the chain's head with an outside
 * authority, so even rewriting the whole chain is detectable up to the last
 * anchor: rewriting history means forging that authority's signature.
 */
export const GENESIS = "0".repeat(64);
export type LedgerKind = "receipt" | "executed" | "sealed" | "anchor";
export type LedgerEntry = { seq: number; organization_id: string; package_id: string; kind: LedgerKind; subject_hash: string; payload: Record<string, unknown>; created_at: string; prev_hash: string; entry_hash: string };

const entryHash = (e: Omit<LedgerEntry, "entry_hash">) => digest({ seq: e.seq, organization_id: e.organization_id, package_id: e.package_id, kind: e.kind, subject_hash: e.subject_hash, payload: e.payload, created_at: e.created_at, prev_hash: e.prev_hash });
const row = (r: Record<string, unknown>): LedgerEntry => ({ seq: Number(r.seq), organization_id: String(r.organization_id), package_id: String(r.package_id), kind: String(r.kind) as LedgerKind, subject_hash: String(r.subject_hash), payload: JSON.parse(String(r.payload_json)), created_at: String(r.created_at), prev_hash: String(r.prev_hash), entry_hash: String(r.entry_hash) });

/** Appends inside the caller's transaction when there is one; the ledger lock orders writers. */
export function appendLedger(entry: { organization_id: string; package_id: string; kind: LedgerKind; subject_hash: string; payload?: Record<string, unknown> }) {
  return signingStore().transaction(async db => {
    const last = await db.prepare("SELECT seq,entry_hash FROM document_signing_ledger ORDER BY seq DESC LIMIT 1").get();
    const base = { seq: last ? Number(last.seq) + 1 : 1, organization_id: entry.organization_id, package_id: entry.package_id, kind: entry.kind, subject_hash: entry.subject_hash, payload: entry.payload || {}, created_at: new Date().toISOString(), prev_hash: last ? String(last.entry_hash) : GENESIS };
    const full: LedgerEntry = { ...base, entry_hash: entryHash(base) };
    await db.prepare("INSERT INTO document_signing_ledger(seq,organization_id,package_id,kind,subject_hash,payload_json,created_at,prev_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(full.seq, full.organization_id, full.package_id, full.kind, full.subject_hash, JSON.stringify(full.payload), full.created_at, full.prev_hash, full.entry_hash);
    return full;
  }, "ledger");
}

export async function ledgerEntriesForPackage(packageId: string) {
  return (await signingStore().prepare("SELECT * FROM document_signing_ledger WHERE package_id=? ORDER BY seq").all(packageId)).map(row);
}
export async function ledgerEntryForSubject(subjectHash: string) {
  const found = await signingStore().prepare("SELECT * FROM document_signing_ledger WHERE subject_hash=? ORDER BY seq LIMIT 1").get(subjectHash);
  return found ? row(found) : null;
}

export type LedgerCheck = { ok: boolean; from: number; to: number; anchor: { seq: number; time: string; authority: string } | null; problem?: string };
/**
 * Verifies the chain from just before `fromSeq` to the first anchor that
 * covers it (or to the head when none does yet), including that anchor's
 * timestamp. Bounded by the anchor interval, never a walk of the whole ledger.
 */
export async function verifyLedgerFrom(fromSeq: number): Promise<LedgerCheck> {
  const start = Math.max(1, fromSeq - 1);
  // An anchor timestamps the head when it was requested, which can trail the anchor's own seq.
  const anchor = (await signingStore().prepare("SELECT * FROM document_signing_ledger WHERE kind='anchor' AND seq>? ORDER BY seq LIMIT 5").all(fromSeq)).map(row).find(a => Number(a.payload.anchored_seq) >= fromSeq) || null;
  const to = anchor ? anchor.seq : Number((await signingStore().prepare("SELECT MAX(seq) AS seq FROM document_signing_ledger").get())?.seq || 0);
  const rows = (await signingStore().prepare("SELECT * FROM document_signing_ledger WHERE seq>=? AND seq<=? ORDER BY seq").all(start, to)).map(row);
  const fail = (problem: string): LedgerCheck => ({ ok: false, from: start, to, anchor: null, problem });
  if (start === 1 && rows[0] && rows[0].prev_hash !== GENESIS) return fail("The ledger does not start at its genesis.");
  for (const [i, entry] of rows.entries()) {
    if (entry.seq !== start + i) return fail(`Ledger entry ${start + i} is missing.`);
    if (entryHash(entry) !== entry.entry_hash) return fail(`Ledger entry ${entry.seq} was altered.`);
    if (i > 0 && entry.prev_hash !== rows[i - 1]!.entry_hash) return fail(`Ledger entry ${entry.seq} does not follow entry ${entry.seq - 1}.`);
  }
  if (!anchor) return { ok: true, from: start, to, anchor: null };
  const anchored = rows.find(r => r.seq === Number(anchor.payload.anchored_seq));
  if (!anchored || anchored.entry_hash !== anchor.subject_hash) return fail(`Anchor ${anchor.seq} does not match the entry it timestamps.`);
  try {
    const stamp = verifyTimestampToken(Buffer.from(String(anchor.payload.token), "base64"), Buffer.from(anchor.subject_hash, "hex"));
    return { ok: true, from: start, to, anchor: { seq: anchor.seq, time: stamp.time, authority: stamp.signer } };
  } catch (error) {
    return fail(`Anchor ${anchor.seq} has an invalid timestamp.`);
  }
}

/** Timestamps the head when it has moved and the last anchor is older than the interval. */
export async function anchorLedger(now = Date.now()) {
  if (!timestampAuthorities().length) return null;
  const interval = Number(process.env.DOCUMENT_LEDGER_ANCHOR_SECONDS || 3600) * 1000;
  const head = await signingStore().prepare("SELECT * FROM document_signing_ledger ORDER BY seq DESC LIMIT 1").get();
  if (!head || String(head.kind) === "anchor") return null;
  const last = await signingStore().prepare("SELECT created_at FROM document_signing_ledger WHERE kind='anchor' ORDER BY seq DESC LIMIT 1").get();
  if (last && now - Date.parse(String(last.created_at)) < interval) return null;
  const target = row(head);
  const stamp = await requestTimestamp(Buffer.from(target.entry_hash, "hex"));
  return appendLedger({ organization_id: "", package_id: "", kind: "anchor", subject_hash: target.entry_hash, payload: { anchored_seq: target.seq, token: stamp.token.toString("base64"), time: stamp.time, authority: stamp.authority } });
}
