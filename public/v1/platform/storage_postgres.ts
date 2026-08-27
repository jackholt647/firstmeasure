import { createHash, randomBytes } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import { env } from "../src/config/env.js";
import { bootstrapPostgresApplicationUser, queryPostgres, withPostgresClient, withPostgresTransaction } from "../src/database/postgres.js";
import { getSharedObject, putSharedObject } from "../src/storage/project_artifacts.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { formatIdentityPhone, identifierLooksLikeEmail, normalizeIdentityPhone } from "./identity_phone.js";

export type JsonObject = Record<string, unknown>;

const SCHEMA_VERSION = 1;
const COLLECTIONS = [
  "users", "projects", "customers", "branch", "notifications", "action_items", "activity",
  "customer_portals", "onboarding_events", "proposals", "proposal_snapshots", "proposal_events",
  "material_lists", "material_list_versions", "material_orders", "material_deliveries", "material_events",
  "payment_schedules", "payment_obligations", "payment_transactions", "payment_allocations", "payment_intents",
  "payment_payables", "payment_disbursements", "payment_ledger_events", "payment_events"
] as const;

type PlatformCollection = typeof COLLECTIONS[number];
type DbExecutor = Pick<PoolClient, "query">;
type DocumentRow = QueryResultRow & { document: JsonObject };
type MediaVariant = JsonObject & {
  path: string;
  content_type: string;
  file_name: string;
  size_bytes: number;
  width?: number | null;
  height?: number | null;
};
type MediaUploadOptions = {
  id?: string;
  ownerType?: string;
  ownerId?: string;
  slot?: string;
  collection?: string;
  scope?: string;
  fileName?: string;
  contentType?: string;
  bytes: Buffer;
  replaceSlot?: boolean;
  thumbnails?: unknown;
  compression?: unknown;
  markup?: unknown;
  metadata?: JsonObject;
};

let schemaPromise: Promise<void> | null = null;

function nowIso() { return new Date().toISOString(); }
function hashId(value: string) { return createHash("sha256").update(value).digest("hex"); }
function generateId(prefix: string) { return `${prefix}_${randomBytes(8).toString("hex")}`; }
function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}
function sanitizeId(value: unknown, label = "id") {
  const cleaned = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) throw badRequest(`invalid_${label}`, `${label} must contain at least one letter or number.`);
  return cleaned;
}
function normalizeEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("invalid_email", "A valid email address is required.");
  return email;
}
function assertCollection(value: string): PlatformCollection {
  if ((COLLECTIONS as readonly string[]).includes(value)) return value as PlatformCollection;
  throw badRequest("invalid_collection", "Collection must be one of the registered platform collections.");
}
function generatedDocumentPrefix(collection: PlatformCollection) {
  const singular: Partial<Record<PlatformCollection, string>> = {
    users: "user", projects: "project", customers: "customer", branch: "branch", notifications: "notification",
    action_items: "action_item", activity: "activity", customer_portals: "customer_portal", onboarding_events: "onboarding_event",
    proposals: "proposal", proposal_snapshots: "proposal_snapshot", proposal_events: "proposal_event", material_lists: "material_list",
    material_list_versions: "material_version", material_orders: "material_order", material_deliveries: "material_delivery",
    material_events: "material_event", payment_schedules: "payment_schedule", payment_obligations: "payment_obligation",
    payment_transactions: "payment", payment_allocations: "payment_allocation", payment_intents: "payment_intent",
    payment_payables: "payment_payable", payment_disbursements: "payment_disbursement", payment_ledger_events: "payment_ledger",
    payment_events: "payment_event"
  };
  return singular[collection] ?? "doc";
}
function postgresErrorCode(error: unknown) { return String((error as { code?: string })?.code ?? ""); }

export async function ensurePostgresPlatformStorage() {
  schemaPromise ??= (async () => {
    await bootstrapPostgresApplicationUser();
    await withPostgresClient(async (client) => {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", ["firstmeasure-platform-schema-v1"]);
      try {
        await client.query(`
        CREATE TABLE IF NOT EXISTS platform_identities (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          phone_normalized TEXT NOT NULL DEFAULT '',
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        DROP INDEX IF EXISTS platform_identities_phone_unique;
        CREATE INDEX IF NOT EXISTS platform_identities_phone_idx
          ON platform_identities(phone_normalized) WHERE phone_normalized <> '';
        CREATE TABLE IF NOT EXISTS platform_sessions (
          id_hash TEXT PRIMARY KEY,
          identity_id TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS platform_sessions_identity_idx ON platform_sessions(identity_id);
        CREATE INDEX IF NOT EXISTS platform_sessions_expiry_idx ON platform_sessions(expires_at);
        CREATE TABLE IF NOT EXISTS platform_registration_locks (
          lock_key TEXT PRIMARY KEY,
          owner_token TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS platform_organizations (
          id TEXT PRIMARY KEY,
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS platform_documents (
          organization_id TEXT NOT NULL,
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (organization_id, collection, id)
        );
        CREATE INDEX IF NOT EXISTS platform_documents_list_idx
          ON platform_documents(organization_id, collection, updated_at DESC);
        CREATE TABLE IF NOT EXISTS platform_branch_modules (
          organization_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          id TEXT NOT NULL,
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (organization_id, branch_id, id)
        );
        CREATE TABLE IF NOT EXISTS platform_media (
          organization_id TEXT NOT NULL,
          id TEXT NOT NULL,
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (organization_id, id)
        );
        CREATE INDEX IF NOT EXISTS platform_media_list_idx ON platform_media(organization_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS platform_media_markup (
          organization_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          id TEXT NOT NULL,
          document JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (organization_id, media_id, id)
        );
        `);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["firstmeasure-platform-schema-v1"]).catch(() => undefined);
      }
    });
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;
}

async function documentByQuery(executor: DbExecutor, sql: string, values: unknown[], code = "not_found", message = "The requested platform record was not found.") {
  const result = await executor.query<DocumentRow>(sql, values);
  if (!result.rows[0]) throw notFound(code, message);
  return asObject(result.rows[0].document);
}

export async function withIdentityRegistrationLock<T>(emailValue: string, operation: () => Promise<T>): Promise<T> {
  await ensurePostgresPlatformStorage();
  const email = normalizeEmail(emailValue);
  const lockKey = `platform-registration:${email}`;
  const ownerToken = randomBytes(16).toString("hex");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const claimed = await queryPostgres(`
      INSERT INTO platform_registration_locks(lock_key, owner_token, expires_at)
      VALUES($1, $2, now() + interval '60 seconds')
      ON CONFLICT(lock_key) DO UPDATE SET
        owner_token = EXCLUDED.owner_token,
        expires_at = EXCLUDED.expires_at
      WHERE platform_registration_locks.expires_at <= now()
      RETURNING lock_key
    `, [lockKey, ownerToken]);
    if (claimed.rowCount === 1) {
      try {
        return await operation();
      } finally {
        await queryPostgres(
          "DELETE FROM platform_registration_locks WHERE lock_key = $1 AND owner_token = $2",
          [lockKey, ownerToken]
        ).catch(() => undefined);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
  }
  throw conflict("registration_in_progress", "Account registration is already in progress. Please try again.");
}

export async function createAuthSession(input: JsonObject = {}) {
  await ensurePostgresPlatformStorage();
  const now = nowIso();
  const sessionId = randomBytes(32).toString("base64url");
  const ttlSeconds = Math.max(60, Number(input.ttl_seconds ?? env.platformSessionTtlSeconds));
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const session = {
    schema_version: SCHEMA_VERSION, id_hash: hashId(sessionId), identity_id: sanitizeId(input.identity_id, "identity_id"),
    organization_id: sanitizeId(input.organization_id, "organization_id"), user_id: sanitizeId(input.user_id, "user_id"),
    role: String(input.role || "member"), permissions_snapshot: asObject(input.permissions_snapshot),
    branch_id: String(input.branch_id || "default"), csrf_token: String(input.csrf_token || randomBytes(24).toString("base64url")),
    created_at: now, updated_at: now, last_seen_at: now, expires_at: expiresAt, revoked_at: null, metadata: asObject(input.metadata)
  };
  await queryPostgres("INSERT INTO platform_sessions(id_hash, identity_id, expires_at, document) VALUES ($1, $2, $3, $4::jsonb)",
    [session.id_hash, session.identity_id, expiresAt, JSON.stringify(session)]);
  return { sessionId, session };
}

export async function readAuthSession(sessionId: string) {
  await ensurePostgresPlatformStorage();
  const idHash = hashId(sessionId);
  const result = await queryPostgres<DocumentRow>("SELECT document FROM platform_sessions WHERE id_hash = $1", [idHash]);
  const session = result.rows[0] ? asObject(result.rows[0].document) : null;
  if (!session) throw notFound("not_found", "The requested platform record was not found.");
  if (session.revoked_at) throw notFound("session_revoked", "The platform session has been revoked.");
  const expiresAt = Date.parse(String(session.expires_at || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await queryPostgres("DELETE FROM platform_sessions WHERE id_hash = $1", [idHash]);
    throw notFound("session_expired", "The platform session has expired.");
  }
  return session;
}

export async function touchAuthSession(sessionId: string) {
  await ensurePostgresPlatformStorage();
  const idHash = hashId(sessionId);
  return withPostgresTransaction(async (client) => {
    const current = await documentByQuery(client, "SELECT document FROM platform_sessions WHERE id_hash = $1 FOR UPDATE", [idHash]);
    if (current.revoked_at) throw notFound("session_revoked", "The platform session has been revoked.");
    if (Date.parse(String(current.expires_at || "")) <= Date.now()) {
      await client.query("DELETE FROM platform_sessions WHERE id_hash = $1", [idHash]);
      throw notFound("session_expired", "The platform session has expired.");
    }
    const now = nowIso();
    const next = { ...current, updated_at: now, last_seen_at: now };
    await client.query("UPDATE platform_sessions SET document = $2::jsonb, updated_at = now() WHERE id_hash = $1", [idHash, JSON.stringify(next)]);
    return next;
  });
}

export async function deleteAuthSession(sessionId: string) {
  await ensurePostgresPlatformStorage();
  await queryPostgres("DELETE FROM platform_sessions WHERE id_hash = $1", [hashId(sessionId)]);
}
export async function deleteIdentitySessions(identityId: string) {
  await ensurePostgresPlatformStorage();
  const result = await queryPostgres("DELETE FROM platform_sessions WHERE identity_id = $1", [sanitizeId(identityId, "identity_id")]);
  return result.rowCount ?? 0;
}

export async function createIdentity(input: JsonObject = {}) {
  await ensurePostgresPlatformStorage();
  const email = normalizeEmail(input.email);
  const id = input.id ? sanitizeId(input.id, "identity_id") : `identity_${hashId(email).slice(0, 16)}`;
  const requestedPhone = String(input.phone ?? "").trim();
  const phoneNormalized = requestedPhone ? normalizeIdentityPhone(requestedPhone) : "";
  if (requestedPhone && !phoneNormalized) throw badRequest("invalid_phone_number", "A valid mobile phone number is required.");
  const now = nowIso();
  const identity = {
    schema_version: SCHEMA_VERSION, id, email, email_normalized: email, password_hash: String(input.password_hash ?? ""),
    password_algo: String(input.password_algo ?? "php-password-hash"), name: String(input.name ?? ""),
    phone: formatIdentityPhone(requestedPhone), phone_normalized: phoneNormalized, status: String(input.status ?? "active"),
    memberships: Array.isArray(input.memberships) ? input.memberships : [], metadata: asObject(input.metadata), revision: 1,
    created_at: String(input.created_at ?? now), updated_at: now, last_login_at: input.last_login_at ? String(input.last_login_at) : null
  };
  try {
    await withPostgresTransaction(async (client) => {
      if (phoneNormalized) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`platform-phone:${phoneNormalized}`]);
        const duplicate = await client.query<{ exists:boolean }>("SELECT EXISTS(SELECT 1 FROM platform_identities WHERE phone_normalized=$1) AS exists", [phoneNormalized]);
        if (duplicate.rows[0]?.exists) throw conflict("identity_phone_exists", "That phone number is already connected to an account.");
      }
      await client.query("INSERT INTO platform_identities(id, email, phone_normalized, document) VALUES ($1, $2, $3, $4::jsonb)",
        [id, email, phoneNormalized, JSON.stringify(identity)]);
    });
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      const constraint = String((error as { constraint?: string }).constraint ?? "");
      if (constraint.includes("email")) throw conflict("identity_email_exists", `Identity for '${email}' already exists.`);
      throw conflict("identity_exists", `Identity '${id}' already exists.`);
    }
    throw error;
  }
  return identity;
}

export async function readIdentity(identityId: string) {
  await ensurePostgresPlatformStorage();
  return documentByQuery({ query: queryPostgres } as DbExecutor, "SELECT document FROM platform_identities WHERE id = $1", [sanitizeId(identityId, "identity_id")]);
}
export async function findIdentityByEmail(emailValue: string) {
  await ensurePostgresPlatformStorage();
  return documentByQuery({ query: queryPostgres } as DbExecutor, "SELECT document FROM platform_identities WHERE email = $1", [normalizeEmail(emailValue)]);
}
export async function identityEmailExists(emailValue: string) {
  await ensurePostgresPlatformStorage();
  const result = await queryPostgres<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM platform_identities WHERE email = $1) AS exists", [normalizeEmail(emailValue)]);
  return result.rows[0]?.exists === true;
}
export async function deleteIdentity(identityId: string) {
  await ensurePostgresPlatformStorage();
  await queryPostgres("DELETE FROM platform_identities WHERE id = $1", [sanitizeId(identityId, "identity_id")]);
}
export async function listIdentitiesByPhone(phoneValue: string) {
  await ensurePostgresPlatformStorage();
  const phone = normalizeIdentityPhone(phoneValue);
  if (!phone) throw badRequest("invalid_phone_number", "A valid mobile phone number is required.");
  const result = await queryPostgres<DocumentRow>("SELECT document FROM platform_identities WHERE phone_normalized = $1 ORDER BY id", [phone]);
  return result.rows.map((row) => asObject(row.document));
}
export async function findIdentityByPhone(phoneValue: string) {
  const matches = await listIdentitiesByPhone(phoneValue);
  if (!matches.length) throw notFound("identity_phone_not_found", "No account was found for that phone number.");
  if (matches.length > 1) throw conflict("identity_phone_ambiguous", "This phone number is connected to multiple accounts. Sign in with email or contact support.");
  return matches[0] as JsonObject;
}
export async function findIdentityByIdentifier(identifierValue: string) {
  const identifier = String(identifierValue || "").trim();
  if (!identifier) throw badRequest("missing_login_identifier", "Enter an email address or phone number.");
  return identifierLooksLikeEmail(identifier) ? findIdentityByEmail(identifier) : findIdentityByPhone(identifier);
}

export async function patchIdentity(identityId: string, patch: JsonObject) {
  await ensurePostgresPlatformStorage();
  const id = sanitizeId(identityId, "identity_id");
  return withPostgresTransaction(async (client) => {
    const current = await documentByQuery(client, "SELECT document FROM platform_identities WHERE id = $1 FOR UPDATE", [id]);
    const expected = Number(patch.expected_revision ?? 0);
    if (expected && expected !== Number(current.revision ?? 0)) throw conflict("revision_conflict", "Identity revision does not match.");
    const currentEmail = normalizeEmail(current.email);
    const email = Object.prototype.hasOwnProperty.call(patch, "email") ? normalizeEmail(patch.email) : currentEmail;
    const phonePatched = Object.prototype.hasOwnProperty.call(patch, "phone");
    const rawPhone = phonePatched ? String(patch.phone ?? "").trim() : String(current.phone ?? "");
    const phoneNormalized = rawPhone ? normalizeIdentityPhone(rawPhone) : "";
    if (rawPhone && !phoneNormalized) throw badRequest("invalid_phone_number", "A valid mobile phone number is required.");
    if (phonePatched && phoneNormalized && phoneNormalized !== String(current.phone_normalized ?? "")) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`platform-phone:${phoneNormalized}`]);
      const duplicate = await client.query<{ exists:boolean }>("SELECT EXISTS(SELECT 1 FROM platform_identities WHERE phone_normalized=$1 AND id<>$2) AS exists", [phoneNormalized, id]);
      if (duplicate.rows[0]?.exists) throw conflict("identity_phone_exists", "That phone number is already connected to an account.");
    }
    const next: JsonObject = {
      ...current, ...asObject(patch), id: current.id, email, email_normalized: email,
      ...(phonePatched ? { phone: formatIdentityPhone(rawPhone), phone_normalized: phoneNormalized } : {}),
      schema_version: current.schema_version ?? SCHEMA_VERSION,
      metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) },
      revision: Number(current.revision ?? 0) + 1, updated_at: nowIso()
    };
    delete next.expected_revision;
    try {
      await client.query("UPDATE platform_identities SET email = $2, phone_normalized = $3, document = $4::jsonb, updated_at = now() WHERE id = $1",
        [id, email, String(next.phone_normalized ?? ""), JSON.stringify(next)]);
    } catch (error) {
      if (postgresErrorCode(error) === "23505") {
        throw conflict("identity_email_exists", `Identity for '${email}' already exists.`);
      }
      throw error;
    }
    return next;
  });
}

export async function listIdentityMemberships(identityId: string) {
  const identity = await readIdentity(identityId);
  const memberships = [];
  for (const entry of Array.isArray(identity.memberships) ? identity.memberships : []) {
    const membership = asObject(entry);
    const orgId = String(membership.organization_id ?? "");
    const userId = String(membership.user_id ?? "");
    if (!orgId || !userId) continue;
    try { memberships.push({ organization: await readOrganization(orgId), user: await readDocument(orgId, "users", userId) }); }
    catch { /* stale memberships must not block login */ }
  }
  return memberships;
}
export async function addIdentityMembership(identityId: string, orgId: string, userId: string, role = "member") {
  await ensurePostgresPlatformStorage();
  const id = sanitizeId(identityId, "identity_id");
  return withPostgresTransaction(async (client) => {
    const identity = await documentByQuery(client, "SELECT document FROM platform_identities WHERE id = $1 FOR UPDATE", [id]);
    const memberships = Array.isArray(identity.memberships) ? [...identity.memberships] : [];
    const organizationId = sanitizeId(orgId, "organization_id");
    const normalizedUserId = sanitizeId(userId, "user_id");
    if (!memberships.some((entry) => {
      const item = asObject(entry);
      return item.organization_id === organizationId && item.user_id === normalizedUserId;
    })) memberships.push({ organization_id: organizationId, user_id: normalizedUserId, role, status: "active", added_at: nowIso() });
    const next = { ...identity, memberships, revision: Number(identity.revision ?? 0) + 1, updated_at: nowIso() };
    await client.query("UPDATE platform_identities SET document = $2::jsonb, updated_at = now() WHERE id = $1", [id, JSON.stringify(next)]);
    return next;
  });
}

export async function createOrganization(input: JsonObject = {}) {
  await ensurePostgresPlatformStorage();
  const id = input.id ? sanitizeId(input.id, "organization_id") : generateId("org");
  const now = nowIso();
  const organization = { schema_version: SCHEMA_VERSION, id, name: String(input.name ?? "Untitled Organization"), status: String(input.status ?? "active"), metadata: asObject(input.metadata), revision: 1, created_at: now, updated_at: now };
  const global = { schema_version: SCHEMA_VERSION, id: "global", organization_id: id, collection: "global", data: asObject(input.global), metadata: {}, revision: 1, created_at: now, updated_at: now };
  try {
    await withPostgresTransaction(async (client) => {
      await client.query("INSERT INTO platform_organizations(id, document) VALUES ($1, $2::jsonb)", [id, JSON.stringify(organization)]);
      await client.query("INSERT INTO platform_documents(organization_id, collection, id, document) VALUES ($1, 'global', 'global', $2::jsonb)", [id, JSON.stringify(global)]);
    });
  } catch (error) {
    if (postgresErrorCode(error) === "23505") throw conflict("organization_exists", `Organization '${id}' already exists.`);
    throw error;
  }
  return organization;
}
export async function deleteOrganization(orgId: string) {
  await ensurePostgresPlatformStorage();
  const id = sanitizeId(orgId, "organization_id");
  await withPostgresTransaction(async (client) => {
    await client.query("DELETE FROM platform_media_markup WHERE organization_id = $1", [id]);
    await client.query("DELETE FROM platform_media WHERE organization_id = $1", [id]);
    await client.query("DELETE FROM platform_branch_modules WHERE organization_id = $1", [id]);
    await client.query("DELETE FROM platform_documents WHERE organization_id = $1", [id]);
    await client.query("DELETE FROM platform_organizations WHERE id = $1", [id]);
  });
}
export async function listOrganizations() {
  await ensurePostgresPlatformStorage();
  const result = await queryPostgres<DocumentRow>("SELECT document FROM platform_organizations ORDER BY lower(COALESCE(document->>'name', document->>'id'))", []);
  return result.rows.map((row) => asObject(row.document));
}
export async function readOrganization(orgId: string) {
  await ensurePostgresPlatformStorage();
  return documentByQuery({ query: queryPostgres } as DbExecutor, "SELECT document FROM platform_organizations WHERE id = $1", [sanitizeId(orgId, "organization_id")]);
}
export async function patchOrganization(orgId: string, patch: JsonObject) {
  await ensurePostgresPlatformStorage();
  const id = sanitizeId(orgId, "organization_id");
  return withPostgresTransaction(async (client) => {
    const current = await documentByQuery(client, "SELECT document FROM platform_organizations WHERE id = $1 FOR UPDATE", [id]);
    const expected = Number(patch.expected_revision ?? 0);
    if (expected && expected !== Number(current.revision ?? 0)) throw conflict("revision_conflict", "Organization revision does not match.");
    const next: JsonObject = { ...current, ...asObject(patch), id: current.id, schema_version: current.schema_version ?? SCHEMA_VERSION, metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) }, revision: Number(current.revision ?? 0) + 1, updated_at: nowIso() };
    delete next.expected_revision;
    await client.query("UPDATE platform_organizations SET document = $2::jsonb, updated_at = now() WHERE id = $1", [id, JSON.stringify(next)]);
    return next;
  });
}

async function ensureOrg(executor: DbExecutor, orgId: string) {
  const id = sanitizeId(orgId, "organization_id");
  const result = await executor.query("SELECT 1 FROM platform_organizations WHERE id = $1", [id]);
  if (!result.rowCount) throw notFound("not_found", "The requested platform record was not found.");
  return id;
}
export async function listDocuments(orgId: string, collectionValue: string) {
  await ensurePostgresPlatformStorage();
  const collection = assertCollection(collectionValue);
  const id = await ensureOrg({ query: queryPostgres } as DbExecutor, orgId);
  const result = await queryPostgres<DocumentRow>("SELECT document FROM platform_documents WHERE organization_id = $1 AND collection = $2 ORDER BY updated_at DESC", [id, collection]);
  return result.rows.map((row) => asObject(row.document));
}
export async function readDocument(orgId: string, collectionValue: string, documentId: string) {
  await ensurePostgresPlatformStorage();
  const collection = assertCollection(collectionValue);
  const id = await ensureOrg({ query: queryPostgres } as DbExecutor, orgId);
  return documentByQuery({ query: queryPostgres } as DbExecutor, "SELECT document FROM platform_documents WHERE organization_id = $1 AND collection = $2 AND id = $3", [id, collection, sanitizeId(documentId, "document_id")]);
}
export async function upsertDocument(orgId: string, collectionValue: string, input: JsonObject = {}, options: { replace?: boolean } = {}) {
  await ensurePostgresPlatformStorage();
  const collection = assertCollection(collectionValue);
  const organizationId = sanitizeId(orgId, "organization_id");
  const id = input.id ? sanitizeId(input.id, "document_id") : generateId(generatedDocumentPrefix(collection));
  return withPostgresTransaction(async (client) => {
    await ensureOrg(client, organizationId);
    const result = await client.query<DocumentRow>("SELECT document FROM platform_documents WHERE organization_id = $1 AND collection = $2 AND id = $3 FOR UPDATE", [organizationId, collection, id]);
    const current = result.rows[0] ? asObject(result.rows[0].document) : null;
    const expected = Number(input.expected_revision ?? 0);
    if (current && expected && expected !== Number(current.revision ?? 0)) throw conflict("revision_conflict", "Document revision does not match.");
    const now = nowIso();
    const data = asObject(input.data); const metadata = asObject(input.metadata);
    const next = current ? { ...current, data: options.replace ? data : { ...asObject(current.data), ...data }, metadata: options.replace ? metadata : { ...asObject(current.metadata), ...metadata }, revision: Number(current.revision ?? 0) + 1, updated_at: now }
      : { schema_version: SCHEMA_VERSION, id, organization_id: organizationId, collection, data, metadata, revision: 1, created_at: now, updated_at: now };
    await client.query(`INSERT INTO platform_documents(organization_id, collection, id, document, updated_at) VALUES ($1,$2,$3,$4::jsonb,now())
      ON CONFLICT (organization_id, collection, id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`, [organizationId, collection, id, JSON.stringify(next)]);
    return next;
  });
}
export async function deleteDocument(orgId: string, collectionValue: string, documentId: string) {
  await ensurePostgresPlatformStorage();
  const collection = assertCollection(collectionValue); const organizationId = sanitizeId(orgId, "organization_id"); const id = sanitizeId(documentId, "document_id");
  return withPostgresTransaction(async (client) => {
    await ensureOrg(client, organizationId);
    const existing = await documentByQuery(client, "SELECT document FROM platform_documents WHERE organization_id = $1 AND collection = $2 AND id = $3 FOR UPDATE", [organizationId, collection, id]);
    await client.query("DELETE FROM platform_documents WHERE organization_id = $1 AND collection = $2 AND id = $3", [organizationId, collection, id]);
    return existing;
  });
}
export async function readGlobal(orgId: string) {
  await ensurePostgresPlatformStorage();
  const organizationId = sanitizeId(orgId, "organization_id");
  return withPostgresTransaction(async (client) => {
    await ensureOrg(client, organizationId);
    const found = await client.query<DocumentRow>("SELECT document FROM platform_documents WHERE organization_id = $1 AND collection = 'global' AND id = 'global' FOR UPDATE", [organizationId]);
    if (found.rows[0]) return asObject(found.rows[0].document);
    const now = nowIso();
    const doc = { schema_version: SCHEMA_VERSION, id: "global", organization_id: organizationId, collection: "global", data: {}, metadata: {}, revision: 1, created_at: now, updated_at: now };
    await client.query("INSERT INTO platform_documents(organization_id, collection, id, document) VALUES ($1,'global','global',$2::jsonb)", [organizationId, JSON.stringify(doc)]);
    return doc;
  });
}
export async function saveGlobal(orgId: string, input: JsonObject = {}, options: { replace?: boolean } = {}) {
  await ensurePostgresPlatformStorage(); const organizationId = sanitizeId(orgId, "organization_id");
  return withPostgresTransaction(async (client) => {
    await ensureOrg(client, organizationId);
    let result = await client.query<DocumentRow>("SELECT document FROM platform_documents WHERE organization_id = $1 AND collection = 'global' AND id = 'global' FOR UPDATE", [organizationId]);
    if (!result.rows[0]) {
      const now = nowIso(); const seed = { schema_version: SCHEMA_VERSION, id: "global", organization_id: organizationId, collection: "global", data: {}, metadata: {}, revision: 1, created_at: now, updated_at: now };
      await client.query("INSERT INTO platform_documents(organization_id,collection,id,document) VALUES ($1,'global','global',$2::jsonb)", [organizationId, JSON.stringify(seed)]);
      result = { ...result, rows: [{ document: seed }], rowCount: 1 };
    }
    const current = asObject(result.rows[0]?.document); const expected = Number(input.expected_revision ?? 0);
    if (expected && expected !== Number(current.revision ?? 0)) throw conflict("revision_conflict", "Global revision does not match.");
    const next = { ...current, data: options.replace ? asObject(input.data) : { ...asObject(current.data), ...asObject(input.data) }, metadata: options.replace ? asObject(input.metadata) : { ...asObject(current.metadata), ...asObject(input.metadata) }, revision: Number(current.revision ?? 0) + 1, updated_at: nowIso() };
    await client.query("UPDATE platform_documents SET document = $2::jsonb, updated_at = now() WHERE organization_id = $1 AND collection = 'global' AND id = 'global'", [organizationId, JSON.stringify(next)]);
    return next;
  });
}

function deriveBranchModuleSummary(moduleId: string, data: JsonObject) {
  if (moduleId === "pricebook") return { item_count: Array.isArray(data.items) ? data.items.length : 0, category_count: new Set((Array.isArray(data.items) ? data.items : []).map((item) => asObject(item).category).filter(Boolean)).size };
  if (moduleId === "presentation_style") return { default_theme: String(data.default_theme || "margin"), marketing_page_count: Array.isArray(data.marketing_pages) ? data.marketing_pages.length : 0 };
  return {};
}
export async function listBranchModules(orgId: string, branchId: string) {
  await ensurePostgresPlatformStorage(); const organizationId = await ensureOrg({ query: queryPostgres } as DbExecutor, orgId); const normalizedBranchId = sanitizeId(branchId || "default", "branch_id");
  const result = await queryPostgres<DocumentRow>("SELECT document FROM platform_branch_modules WHERE organization_id=$1 AND branch_id=$2 ORDER BY id", [organizationId, normalizedBranchId]);
  return result.rows.map((row) => asObject(row.document));
}
export async function readBranchModule(orgId: string, branchId: string, moduleId: string) {
  await ensurePostgresPlatformStorage(); const organizationId = await ensureOrg({ query: queryPostgres } as DbExecutor, orgId);
  return documentByQuery({ query: queryPostgres } as DbExecutor, "SELECT document FROM platform_branch_modules WHERE organization_id=$1 AND branch_id=$2 AND id=$3", [organizationId, sanitizeId(branchId || "default", "branch_id"), sanitizeId(moduleId, "module_id")]);
}
export async function saveBranchModule(orgId: string, branchId: string, moduleId: string, input: JsonObject = {}, options: { replace?: boolean } = {}) {
  await ensurePostgresPlatformStorage(); const organizationId = sanitizeId(orgId, "organization_id"); const normalizedBranchId = sanitizeId(branchId || "default", "branch_id"); const id = sanitizeId(moduleId, "module_id");
  const next = await withPostgresTransaction(async (client) => {
    await ensureOrg(client, organizationId);
    const result = await client.query<DocumentRow>("SELECT document FROM platform_branch_modules WHERE organization_id=$1 AND branch_id=$2 AND id=$3 FOR UPDATE", [organizationId, normalizedBranchId, id]);
    const current = result.rows[0] ? asObject(result.rows[0].document) : null; const expected = Number(input.expected_revision ?? 0);
    if (current && expected && expected !== Number(current.revision ?? 0)) throw conflict("revision_conflict", "Branch module revision does not match.");
    const now = nowIso(); const inputData = asObject(input.data); const inputMetadata = asObject(input.metadata);
    const doc: JsonObject = current ? { ...current, data: options.replace ? inputData : { ...asObject(current.data), ...inputData }, metadata: options.replace ? inputMetadata : { ...asObject(current.metadata), ...inputMetadata }, revision: Number(current.revision ?? 0) + 1, updated_at: now }
      : { schema_version: SCHEMA_VERSION, id, organization_id: organizationId, branch_id: normalizedBranchId, module: id, data: inputData, metadata: inputMetadata, revision: 1, created_at: now, updated_at: now };
    doc.metadata = { ...asObject(doc.metadata), kind: "branch_module", summary: { ...deriveBranchModuleSummary(id, asObject(doc.data)), ...asObject(asObject(doc.metadata).summary) } };
    await client.query(`INSERT INTO platform_branch_modules(organization_id,branch_id,id,document) VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT (organization_id,branch_id,id) DO UPDATE SET document=EXCLUDED.document,updated_at=now()`, [organizationId, normalizedBranchId, id, JSON.stringify(doc)]);
    return doc;
  });
  let branch: JsonObject | null = null; try { branch = await readDocument(organizationId, "branch", normalizedBranchId); } catch { branch = null; }
  const branchData = asObject(branch?.data); const modules = asObject(branchData.modules);
  modules[id] = { module_id: id, document: `branch_data/${normalizedBranchId}/${id}.json`, revision: next.revision, updated_at: next.updated_at, summary: asObject(next.metadata).summary || {} };
  await upsertDocument(organizationId, "branch", { id: normalizedBranchId, data: { name: String(branchData.name || (normalizedBranchId === "default" ? "Default Branch" : normalizedBranchId)), ...branchData, modules }, metadata: { ...asObject(branch?.metadata), kind: "branch" } }, { replace: !!branch });
  return next;
}

function sanitizeFileName(value: unknown, fallback = "upload") { const raw = String(value ?? "").trim().replace(/\\/g, "/").split("/").pop() || fallback; return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || fallback; }
function extensionForMedia(contentType: string, fileName = "") { const ext = fileName.split(".").pop()?.toLowerCase() ?? ""; if (/^[a-z0-9]{2,6}$/.test(ext) && fileName.includes(".")) return ext; return ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "application/pdf": "pdf", "video/mp4": "mp4", "video/webm": "webm" } as Record<string,string>)[contentType] || "bin"; }
function mediaKind(contentType: string) { return contentType.startsWith("image/") ? "image" : contentType.startsWith("video/") ? "video" : contentType === "application/pdf" ? "pdf" : "file"; }
function objectKey(orgId: string, mediaId: string, relativePath: string) { return `platform/organizations/${sanitizeId(orgId,"organization_id")}/media/${sanitizeId(mediaId,"media_id")}/${relativePath}`; }
function numberInRange(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback; }
function formatChoice(value: unknown, fallback: "webp"|"jpeg"|"png") { const normalized = String(value ?? "").toLowerCase(); return (["webp","jpeg","png"] as const).includes(normalized as never) ? normalized as "webp"|"jpeg"|"png" : fallback; }
function imageContentType(format: string) { return format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp"; }
function imageExt(format: string) { return format === "jpeg" ? "jpg" : format === "png" ? "png" : "webp"; }

export async function readMediaMetadata(orgId: string, mediaId: string) {
  await ensurePostgresPlatformStorage(); const organizationId = await ensureOrg({ query: queryPostgres } as DbExecutor, orgId);
  return documentByQuery({ query: queryPostgres } as DbExecutor, "SELECT document FROM platform_media WHERE organization_id=$1 AND id=$2", [organizationId, sanitizeId(mediaId,"media_id")]);
}
export async function storeMediaUpload(orgId: string, input: MediaUploadOptions) {
  await ensurePostgresPlatformStorage(); const organizationId = await ensureOrg({ query: queryPostgres } as DbExecutor, orgId);
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length) throw badRequest("empty_media_upload", "The uploaded media file is empty.");
  const ownerType = sanitizeId(input.ownerType || "organization", "owner_type"); const ownerId = sanitizeId(input.ownerId || organizationId,"owner_id"); const slot = sanitizeId(input.slot || "media","slot");
  const mediaId = input.id ? sanitizeId(input.id,"media_id") : input.replaceSlot ? sanitizeId(`${ownerType}_${ownerId}_${slot}`,"media_id") : generateId("media");
  const fileName = sanitizeFileName(input.fileName); const contentType = String(input.contentType || "application/octet-stream").toLowerCase(); const ext = extensionForMedia(contentType,fileName);
  const originalVariant: MediaVariant = { path:`original/original.${ext}`, content_type:contentType, file_name:fileName, size_bytes:input.bytes.length };
  const variants: Record<string, MediaVariant> = { original: originalVariant };
  await putSharedObject(objectKey(organizationId, mediaId, originalVariant.path), input.bytes, contentType);
  const warnings: string[] = []; let width: number|null = null; let height: number|null = null;
  const thumbInput = input.thumbnails === false ? { enabled:false } : asObject(input.thumbnails); const compressionInput = input.compression === false ? {enabled:false} : asObject(input.compression);
  const sizes = [...new Set((Array.isArray(thumbInput.sizes) ? thumbInput.sizes : [160,320,640]).map((v)=>numberInRange(v,0,32,2400)).filter(Boolean))].sort((a,b)=>a-b);
  const settings = { thumbnails:{ enabled:thumbInput.enabled!==false, sizes:sizes.length?sizes:[160,320,640], quality:numberInRange(thumbInput.quality,78,35,95), format:formatChoice(thumbInput.format,"webp"), largeOnly:thumbInput.large_only!==false&&thumbInput.largeOnly!==false, largeThreshold:numberInRange(thumbInput.large_threshold??thumbInput.largeThreshold,1024,128,8000)}, compression:{ enabled:compressionInput.enabled!==false, maxWidth:numberInRange(compressionInput.max_width??compressionInput.maxWidth,2400,320,12000), quality:numberInRange(compressionInput.quality,82,35,98), format:formatChoice(compressionInput.format,"webp"), variant:String(compressionInput.variant||"").trim()?sanitizeId(compressionInput.variant,"variant"):"" } };
  if (mediaKind(contentType)==="image" && !["image/svg+xml","image/gif"].includes(contentType)) try {
    const sharp = (await import("sharp")).default; const info = await sharp(input.bytes,{failOn:"none"}).metadata(); width=info.width??null; height=info.height??null; originalVariant.width=width; originalVariant.height=height; const largest=Math.max(width||0,height||0);
    const render = async (variant:string, maxWidth:number, maxHeight:number|undefined, format:"webp"|"jpeg"|"png", quality:number) => { let pipeline=sharp(input.bytes,{failOn:"none"}).rotate().resize({width:maxWidth,height:maxHeight,fit:"inside",withoutEnlargement:true}); pipeline=format==="jpeg"?pipeline.jpeg({quality,mozjpeg:true}):format==="png"?pipeline.png({compressionLevel:9}):pipeline.webp({quality}); const generated=await pipeline.toBuffer({resolveWithObject:true}); const name=`${variant}.${imageExt(format)}`; const relative=`renditions/${name}`; await putSharedObject(objectKey(organizationId,mediaId,relative),generated.data,imageContentType(format)); variants[variant]={path:relative,content_type:imageContentType(format),file_name:name,size_bytes:generated.data.length,width:generated.info.width??null,height:generated.info.height??null}; };
    if(settings.compression.enabled&&largest>settings.compression.maxWidth) await render(settings.compression.variant||`display_${settings.compression.maxWidth}`,settings.compression.maxWidth,undefined,settings.compression.format,settings.compression.quality);
    if(settings.thumbnails.enabled&&(!settings.thumbnails.largeOnly||largest>=settings.thumbnails.largeThreshold)) for(const size of settings.thumbnails.sizes) await render(`thumb_${size}`,size,size,settings.thumbnails.format,settings.thumbnails.quality);
  } catch(error) { warnings.push(error instanceof Error?error.message:"Image processing failed."); }
  const markup = await writeInitialMarkup(organizationId,mediaId,input.markup); const now=nowIso();
  const metadata: JsonObject = { schema_version:SCHEMA_VERSION,id:mediaId,organization_id:organizationId,scope:String(input.scope||input.collection||ownerType),collection:String(input.collection||""),owner:{type:ownerType,id:ownerId,slot},kind:mediaKind(contentType),content_type:contentType,file_name:fileName,size_bytes:input.bytes.length,width,height,variants,renditions:Object.entries(variants).filter(([key])=>key!=="original").map(([variant,value])=>({variant,...value})),markup,processing:{thumbnails:settings.thumbnails,compression:settings.compression,warnings},metadata:asObject(input.metadata),created_at:now,updated_at:now };
  await queryPostgres(`INSERT INTO platform_media(organization_id,id,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(organization_id,id) DO UPDATE SET document=EXCLUDED.document,updated_at=now()`,[organizationId,mediaId,JSON.stringify(metadata)]);
  return metadata;
}
async function writeInitialMarkup(orgId:string,mediaId:string,input:unknown) { const markup=asObject(input); const layers=[]; for(const raw of Array.isArray(markup.layers)?markup.layers:[]) { const layer=asObject(raw); const id=sanitizeId(layer.id||layer.layer_id||`layer_${layers.length+1}`,"markup_layer_id"); const saved=await writeMarkup(orgId,mediaId,id,asObject(layer.data??layer.markup??layer),{name:String(layer.name||id),source:String(layer.source||"upload")}); layers.push({id,path:`markup/${id}.json`,revision:saved.revision,updated_at:saved.updated_at,name:String(layer.name||id),source:String(layer.source||"upload")}); } return {layers,current_layer_id:String(markup.current_layer_id||markup.currentLayerId||asObject(layers[0]).id||"")||null}; }
async function writeMarkupWithClient(client: DbExecutor, orgId:string,mediaId:string,layerId:string,data:JsonObject,metadata:JsonObject) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`platform-media-markup:${orgId}:${mediaId}:${layerId}`]);
  const now=nowIso();
  const found=await client.query<DocumentRow>("SELECT document FROM platform_media_markup WHERE organization_id=$1 AND media_id=$2 AND id=$3 FOR UPDATE",[orgId,mediaId,layerId]);
  const current=found.rows[0]?asObject(found.rows[0].document):null;
  const layer={schema_version:SCHEMA_VERSION,id:layerId,media_id:mediaId,organization_id:orgId,data:asObject(data),metadata:{...asObject(current?.metadata),...asObject(metadata)},revision:Number(current?.revision??0)+1,created_at:String(current?.created_at||now),updated_at:now};
  await client.query(`INSERT INTO platform_media_markup(organization_id,media_id,id,document) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(organization_id,media_id,id) DO UPDATE SET document=EXCLUDED.document,updated_at=now()`,[orgId,mediaId,layerId,JSON.stringify(layer)]);
  return layer;
}
async function writeMarkup(orgId:string,mediaId:string,layerId:string,data:JsonObject,metadata:JsonObject) {
  await ensurePostgresPlatformStorage();
  return withPostgresTransaction((client) => writeMarkupWithClient(client, orgId, mediaId, layerId, data, metadata));
}
export async function readMediaMarkupLayer(orgId:string,mediaId:string,layerId:string) { await readMediaMetadata(orgId,mediaId); return documentByQuery({query:queryPostgres} as DbExecutor,"SELECT document FROM platform_media_markup WHERE organization_id=$1 AND media_id=$2 AND id=$3",[sanitizeId(orgId,"organization_id"),sanitizeId(mediaId,"media_id"),sanitizeId(layerId,"markup_layer_id")]); }
export async function saveMediaMarkupLayer(orgId:string,mediaId:string,layerId:string,data:JsonObject={},metadata:JsonObject={}) {
  await ensurePostgresPlatformStorage();
  const organizationId=sanitizeId(orgId,"organization_id"), normalizedMediaId=sanitizeId(mediaId,"media_id"), id=sanitizeId(layerId,"markup_layer_id");
  return withPostgresTransaction(async (client) => {
    const found = await client.query<DocumentRow>("SELECT document FROM platform_media WHERE organization_id=$1 AND id=$2 FOR UPDATE", [organizationId, normalizedMediaId]);
    if (!found.rows[0]) throw notFound("not_found", "The requested platform record was not found.");
    const media=asObject(found.rows[0].document);
    const layer=await writeMarkupWithClient(client,organizationId,normalizedMediaId,id,data,metadata);
    const markup=asObject(media.markup); const layers=Array.isArray(markup.layers)?markup.layers.map(asObject):[];
    const reference={id,path:`markup/${id}.json`,revision:layer.revision,updated_at:layer.updated_at,...asObject(metadata)};
    const index=layers.findIndex((entry)=>String(entry.id||entry.layer_id)===id); if(index>=0) layers[index]={...layers[index],...reference}; else layers.push(reference);
    const next={...media,markup:{...markup,layers,current_layer_id:markup.current_layer_id||id},updated_at:nowIso()};
    await client.query("UPDATE platform_media SET document=$3::jsonb,updated_at=now() WHERE organization_id=$1 AND id=$2",[organizationId,normalizedMediaId,JSON.stringify(next)]);
    return {media:next,layer};
  });
}
export async function listMedia(orgId:string) { await ensurePostgresPlatformStorage(); const organizationId=await ensureOrg({query:queryPostgres} as DbExecutor,orgId); const result=await queryPostgres<DocumentRow>("SELECT document FROM platform_media WHERE organization_id=$1 ORDER BY updated_at DESC",[organizationId]); return result.rows.map((row)=>asObject(row.document)); }
export async function mediaStorageUsage(orgId:string) { const media=await listMedia(orgId); const used=media.reduce<number>((total,item)=>{const values=Object.values(asObject(item.variants)); const variants=values.reduce<number>((sum,value)=>sum+Math.max(0,Number(asObject(value).size_bytes||0)),0); return total+(variants||Math.max(0,Number(item.size_bytes||0)));},0); return {organization_id:sanitizeId(orgId,"organization_id"),used_bytes:used,media_count:media.length,updated_at:nowIso()}; }
export async function readMediaFile(orgId:string,mediaId:string,variantValue="original") { const metadata=await readMediaMetadata(orgId,mediaId); const variant=sanitizeId(variantValue||"original","variant"); const entry=asObject(asObject(metadata.variants)[variant]); const relative=String(entry.path||""); if(!relative||relative.includes("..")||relative.startsWith("/")) throw notFound("media_variant_not_found","The requested media variant was not found."); const bytes=await getSharedObject(objectKey(orgId,mediaId,relative)); if(!bytes) throw notFound("media_variant_not_found","The requested media variant was not found."); return {metadata,variant,contentType:String(entry.content_type||metadata.content_type||"application/octet-stream"),fileName:String(entry.file_name||metadata.file_name||mediaId),bytes}; }
