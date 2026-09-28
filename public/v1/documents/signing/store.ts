import path from "node:path";
import { env } from "../../src/config/env.js";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../../platform/sql_store.js";
import type { SigningPackage } from "./model.js";
import { tokenHash } from "./model.js";

let store: SqlStore | undefined, filename = "";
export function signingStore(): SqlStore {
  const next = path.resolve(process.cwd(), env.platformStorageRoot, "document-signing.sqlite");
  if (store && filename === next) return store;
  filename = next;
  store = openSqlStore({ id: "document_signing", filename, schemaVersion: 2, initialize: async db => {
    await db.exec(`CREATE TABLE IF NOT EXISTS document_signing_packages (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, document_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
      status TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS document_signing_document ON document_signing_packages(organization_id,document_id);
      CREATE TABLE IF NOT EXISTS document_signing_invitations (
      token_hash TEXT PRIMARY KEY, package_id TEXT NOT NULL, signer_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_signing_outbox (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, package_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS document_signing_receipts (
      id TEXT PRIMARY KEY, package_id TEXT NOT NULL, field_key TEXT NOT NULL, value_json TEXT NOT NULL,
      UNIQUE(package_id,field_key));`);
    await ensureSqlColumn(db,"document_signing_packages","expires_at","TEXT NOT NULL DEFAULT ''");
    await ensureSqlColumn(db,"document_signing_outbox","attempted_at","TEXT NOT NULL DEFAULT ''");
    await ensureSqlColumn(db,"document_signing_outbox","attempts","INTEGER NOT NULL DEFAULT 0");
    await ensureSqlColumn(db,"document_signing_outbox","last_error","TEXT NOT NULL DEFAULT ''");
    await db.exec("CREATE INDEX IF NOT EXISTS document_signing_expiry ON document_signing_packages(status,expires_at); CREATE INDEX IF NOT EXISTS document_signing_pending ON document_signing_outbox(delivered,attempted_at);");
    for (const row of await db.prepare("SELECT id,value_json FROM document_signing_packages WHERE expires_at=''").all()) {
      const pkg = JSON.parse(String(row.value_json));
      await db.prepare("UPDATE document_signing_packages SET expires_at=? WHERE id=?").run(String(pkg.expires_at || ""),String(row.id));
    }
  } });
  return store;
}
export function withSigningLock<T>(orgId: string, documentId: string, fn: () => Promise<T>) {
  return signingStore().transaction(fn, `${orgId}:${documentId}`);
}
export async function readPackage(id: string): Promise<SigningPackage | null> {
  const row = await signingStore().prepare("SELECT value_json FROM document_signing_packages WHERE id=?").get(id);
  return row ? JSON.parse(String(row.value_json)) : null;
}
export async function packageForSnapshot(orgId: string, snapshotId: string): Promise<SigningPackage | null> {
  const row = await signingStore().prepare("SELECT value_json FROM document_signing_packages WHERE organization_id=? AND snapshot_id=? ORDER BY updated_at DESC LIMIT 1").get(orgId, snapshotId);
  return row ? JSON.parse(String(row.value_json)) : null;
}
export async function packagesForDocument(orgId: string, documentId: string): Promise<SigningPackage[]> {
  return (await signingStore().prepare("SELECT value_json FROM document_signing_packages WHERE organization_id=? AND document_id=?").all(orgId, documentId)).map(r => JSON.parse(String(r.value_json)));
}
export async function savePackage(pkg: SigningPackage) {
  await signingStore().prepare(`INSERT INTO document_signing_packages(id,organization_id,document_id,snapshot_id,status,value_json,updated_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value_json=excluded.value_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at`)
    .run(pkg.id, pkg.organization_id, pkg.document_id, pkg.snapshot_id, pkg.status, JSON.stringify(pkg), new Date().toISOString(),pkg.expires_at);
}
export async function addInvitation(raw: string, packageId: string, signerId: string) {
  await signingStore().prepare("INSERT INTO document_signing_invitations(token_hash,package_id,signer_id) VALUES(?,?,?)").run(tokenHash(raw), packageId, signerId);
}
export async function resolveSigningInvitation(raw: string) {
  const row = await signingStore().prepare("SELECT package_id,signer_id FROM document_signing_invitations WHERE token_hash=?").get(tokenHash(raw));
  if (!row) return null;
  const pkg = await readPackage(String(row.package_id));
  return pkg ? { pkg, signerId: String(row.signer_id) } : null;
}
export async function queueSigningEvent(pkg: SigningPackage, type: string, suffix: string, payload: Record<string, unknown>) {
  const id = `${pkg.id}:${type}:${suffix}`;
  await signingStore().prepare("INSERT INTO document_signing_outbox(id,organization_id,package_id,event_type,payload_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
    .run(id, pkg.organization_id, pkg.id, type, JSON.stringify(payload));
}
export async function closeSigningStore() { await store?.close(); store = undefined; filename = ""; }
