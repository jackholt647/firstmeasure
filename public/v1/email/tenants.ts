import { createHash } from "node:crypto";

import { getCommunicationsDatabase } from "../messaging/communications_storage.js";
import { env } from "../src/config/env.js";

function clean(value: unknown) { return String(value ?? "").trim(); }
function nowIso() { return new Date().toISOString(); }

async function ensureTable() {
  const db = getCommunicationsDatabase();
  (await db.exec(`CREATE TABLE IF NOT EXISTS email_tenants (
    organization_id TEXT PRIMARY KEY,
    tenant_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    provider TEXT NOT NULL DEFAULT 'cloudflare_email',
    identity_domains_json TEXT NOT NULL DEFAULT '[]',
    last_error TEXT NOT NULL DEFAULT '',
    provisioned_at TEXT NOT NULL,
    paused_at TEXT,
    updated_at TEXT NOT NULL
  )`));
  // Preserve application-level pause state from installations that used SES.
  const legacy = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ses_tenants'").get());
  if (legacy) (await db.exec(`INSERT OR IGNORE INTO email_tenants
    (organization_id, tenant_name, status, provider, identity_domains_json, last_error, provisioned_at, paused_at, updated_at)
    SELECT organization_id, tenant_name, status, 'cloudflare_email', resources_json, last_error,
      COALESCE(provisioned_at, updated_at), paused_at, updated_at FROM ses_tenants`));
}

export function emailTenantName(organizationId: string) {
  const normalized = clean(organizationId).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const digest = createHash("sha256").update(clean(organizationId)).digest("hex").slice(0, 12);
  return `fm_${(normalized || "organization").slice(0, 47)}_${digest}`.slice(0, 64);
}

export async function readEmailTenant(organizationId: string) {
  (await ensureTable());
  return (await getCommunicationsDatabase().prepare("SELECT * FROM email_tenants WHERE organization_id = ?").get(clean(organizationId))) as Record<string, unknown> | undefined;
}

export async function ensureEmailTenant(input: { organizationId: string; identityDomains?: string[] }) {
  const organizationId = clean(input.organizationId);
  if (!organizationId) throw new Error("email_tenant_organization_required");
  (await ensureTable());
  const current = (await readEmailTenant(organizationId));
  const existing = (() => { try { const value = JSON.parse(clean(current?.identity_domains_json) || "[]"); return Array.isArray(value) ? value.map(clean) : []; } catch { return []; } })();
  const domains = [...new Set([...existing, ...(input.identityDomains ?? [])].map((domain) => clean(domain).toLowerCase()).filter(Boolean))];
  const now = nowIso();
  (await getCommunicationsDatabase().prepare(`INSERT INTO email_tenants
      (organization_id, tenant_name, status, provider, identity_domains_json, last_error, provisioned_at, paused_at, updated_at)
    VALUES (?, ?, 'active', 'cloudflare_email', ?, '', ?, NULL, ?)
    ON CONFLICT(organization_id) DO UPDATE SET identity_domains_json=excluded.identity_domains_json, provider='cloudflare_email', updated_at=excluded.updated_at`)
    .run(organizationId, emailTenantName(organizationId), JSON.stringify(domains), now, now));
  return (await readEmailTenant(organizationId))!;
}

export async function pauseEmailTenant(organizationId: string, reason: string) {
  const tenant = (await readEmailTenant(organizationId));
  if (!tenant) throw new Error("email_tenant_not_provisioned");
  const now = nowIso();
  (await getCommunicationsDatabase().prepare("UPDATE email_tenants SET status='paused', last_error=?, paused_at=?, updated_at=? WHERE organization_id=?")
    .run(clean(reason).slice(0, 1000), now, now, clean(organizationId)));
  return (await readEmailTenant(organizationId))!;
}

export async function resumeEmailTenant(organizationId: string) {
  const tenant = (await readEmailTenant(organizationId));
  if (!tenant) throw new Error("email_tenant_not_provisioned");
  const now = nowIso();
  (await getCommunicationsDatabase().prepare("UPDATE email_tenants SET status='active', last_error='', paused_at=NULL, updated_at=? WHERE organization_id=?")
    .run(now, clean(organizationId)));
  return (await readEmailTenant(organizationId))!;
}

export async function requireActiveEmailTenant(organizationId: string) {
  const tenant = (await readEmailTenant(organizationId)) || await ensureEmailTenant({ organizationId, identityDomains: [env.firstmateMailDomain] });
  if (clean(tenant.status) !== "active") throw new Error("email_tenant_sending_paused");
  return tenant;
}
