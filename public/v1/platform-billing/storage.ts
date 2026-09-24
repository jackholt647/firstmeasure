import path from "node:path";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";

let store: SqlStore | undefined;
export function billingStore() {
  return store ??= openSqlStore({ id: "platform-billing", schemaVersion: 2, filename: path.resolve(env.platformStorageRoot, "platform-billing.sqlite"), initialize: async db => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS platform_billing_records (
        organization_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY (organization_id, kind, id)
      );
      CREATE TABLE IF NOT EXISTS platform_billing_usage (
        organization_id TEXT NOT NULL, meter TEXT NOT NULL, event_key TEXT NOT NULL,
        quantity TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, meter, event_key)
      );
      CREATE INDEX IF NOT EXISTS platform_billing_usage_period ON platform_billing_usage(organization_id,meter,occurred_at);
      CREATE TABLE IF NOT EXISTS platform_billing_sms_reservations (
        organization_id TEXT NOT NULL, delivery_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
        PRIMARY KEY (organization_id,delivery_id)
      );
      CREATE INDEX IF NOT EXISTS platform_billing_sms_period ON platform_billing_sms_reservations(organization_id,occurred_at);
    `);
  }});
}
export async function records<T>(org: string, kind: string): Promise<T[]> {
  return (await billingStore().prepare("SELECT document FROM platform_billing_records WHERE organization_id=? AND kind=? ORDER BY id").all(org,kind)).map(row => JSON.parse(String(row.document)));
}
export async function record<T>(org: string, kind: string, id: string): Promise<T | null> {
  const row = await billingStore().prepare("SELECT document FROM platform_billing_records WHERE organization_id=? AND kind=? AND id=?").get(org,kind,id);
  return row ? JSON.parse(String(row.document)) : null;
}
export async function put(org: string, kind: string, id: string, value: unknown) {
  await billingStore().prepare(`INSERT INTO platform_billing_records(organization_id,kind,id,document) VALUES(?,?,?,?)
    ON CONFLICT(organization_id,kind,id) DO UPDATE SET document=excluded.document`).run(org,kind,id,JSON.stringify(value));
}
export async function closeBillingStore() { await store?.close(); store = undefined; }
