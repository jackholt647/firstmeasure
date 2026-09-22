import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";
import { initializeChatSchema } from "../chat/storage.js";
import { initializeCommsSchema } from "../comms/storage.js";
import { initializeCustomerCallsSchema } from "../comms/calls/storage.js";

import { notFound } from "../platform/errors.js";
import { env } from "../src/config/env.js";

export type CommunicationsJson = Record<string, unknown>;

let database: SqlStore | null = null;
let databasePath = "";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): CommunicationsJson {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as CommunicationsJson) } : {};
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function nowIso() {
  return new Date().toISOString();
}

function scopedCallerId(prefix: string, organizationId: string, value: unknown) {
  const requested = cleanText(value);
  if (!requested) return `${prefix}_${randomUUID().replace(/-/g, "")}`;
  const org = createHash("sha256").update(organizationId).digest("hex").slice(0, 12);
  const safe = requested.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 180);
  return `${prefix}_${org}_${safe}`;
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.messagingStorageRoot, "communications.sqlite");
}

export async function verifyCommunicationsDatabaseWritable() {
  const db = getCommunicationsDatabase();
  await db.transaction(async () => {
    await db.prepare(`INSERT INTO messaging_storage_health (id, checked_at) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at`).run(nowIso());
  });
  const checkpoint = db.isPostgres ? {} : asObject(await db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get());
  return { databasePath: db.isPostgres ? "postgres" : resolvedDatabasePath(), checkpoint };
}

export async function closeCommunicationsDatabase() {
  await database?.close(); database = null; databasePath = "";
}

export function getCommunicationsDatabase(): SqlStore {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  if (database) throw new Error("Close communications storage before changing its directory.");
  database = openSqlStore({ id: "communications", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS messaging_organizations (
      id TEXT PRIMARY KEY,
      external_organization_id TEXT NOT NULL UNIQUE,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messaging_storage_health (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_compliance_profiles (
      id TEXT PRIMARY KEY,
      messaging_organization_id TEXT NOT NULL REFERENCES messaging_organizations(id) ON DELETE CASCADE,
      external_organization_id TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sms_compliance_profiles_org_idx
      ON sms_compliance_profiles(messaging_organization_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messaging_provider_operations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      compliance_profile_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      request_hash TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL DEFAULT '{}',
      error_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (organization_id, compliance_profile_id, operation_type)
    );

    CREATE TABLE IF NOT EXISTS messaging_phone_number_ownership (
      phone_number TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      compliance_profile_id TEXT NOT NULL,
      messaging_profile_id TEXT NOT NULL,
      provider_phone_number_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messaging_phone_number_org_idx
      ON messaging_phone_number_ownership(organization_id, status);

    CREATE TABLE IF NOT EXISTS communication_sender_identities (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      channel TEXT NOT NULL,
      provider TEXT NOT NULL,
      address TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      reply_to TEXT NOT NULL DEFAULT '',
      provider_profile_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      is_default INTEGER NOT NULL DEFAULT 0,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, id)
    );
    CREATE INDEX IF NOT EXISTS communication_sender_default_idx
      ON communication_sender_identities(organization_id, branch_id, channel, is_default, status);
    CREATE UNIQUE INDEX IF NOT EXISTS communication_sender_email_address_unique_idx
      ON communication_sender_identities(address) WHERE channel = 'email' AND provider = 'ses';

    CREATE TABLE IF NOT EXISTS communication_conversations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'open',
      channel_strategy TEXT NOT NULL DEFAULT 'omnichannel',
      subject TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      contact_id TEXT NOT NULL DEFAULT '',
      participants_json TEXT NOT NULL DEFAULT '[]',
      context_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_message_at TEXT,
      created_by_user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS communication_conversations_org_idx
      ON communication_conversations(organization_id, status, last_message_at DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS communication_conversations_project_idx
      ON communication_conversations(organization_id, project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS communication_conversations_contact_idx
      ON communication_conversations(organization_id, contact_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS communication_messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT REFERENCES communication_conversations(id) ON DELETE SET NULL,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'customer_care',
      status TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      text_body TEXT NOT NULL DEFAULT '',
      html_body TEXT NOT NULL DEFAULT '',
      sender_json TEXT NOT NULL DEFAULT '{}',
      recipients_json TEXT NOT NULL DEFAULT '[]',
      project_id TEXT NOT NULL DEFAULT '',
      contact_id TEXT NOT NULL DEFAULT '',
      proposal_id TEXT NOT NULL DEFAULT '',
      work_plan_id TEXT NOT NULL DEFAULT '',
      work_node_id TEXT NOT NULL DEFAULT '',
      context_json TEXT NOT NULL DEFAULT '{}',
      source_json TEXT NOT NULL DEFAULT '{}',
      tags_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT,
      scheduled_for TEXT,
      queued_at TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      failed_at TEXT,
      created_by_user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS communication_messages_idempotency_uq
      ON communication_messages(organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
    CREATE INDEX IF NOT EXISTS communication_messages_org_idx
      ON communication_messages(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS communication_messages_conversation_idx
      ON communication_messages(organization_id, conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS communication_messages_project_idx
      ON communication_messages(organization_id, project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS communication_deliveries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES communication_messages(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      recipient_json TEXT NOT NULL DEFAULT '{}',
      provider TEXT NOT NULL,
      transport_mode TEXT NOT NULL,
      provider_message_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      response_json TEXT NOT NULL DEFAULT '{}',
      error_json TEXT NOT NULL DEFAULT '{}',
      queued_at TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      failed_at TEXT,
      next_attempt_at TEXT,
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_until TEXT,
      provider_status_at TEXT,
      last_reconciled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS communication_deliveries_message_idx
      ON communication_deliveries(organization_id, message_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS communication_deliveries_status_idx
      ON communication_deliveries(organization_id, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS communication_deliveries_provider_message_uq
      ON communication_deliveries(provider, provider_message_id)
      WHERE provider_message_id <> '';

    CREATE TABLE IF NOT EXISTS communication_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES communication_messages(id) ON DELETE CASCADE,
      delivery_id TEXT REFERENCES communication_deliveries(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS communication_events_message_idx
      ON communication_events(organization_id, message_id, occurred_at ASC);

    CREATE TABLE IF NOT EXISTS communication_webhook_events (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      provider_object_id TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      processed_at TEXT,
      processing_error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      processing_started_at TEXT,
      processor_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, event_id)
    );
    CREATE INDEX IF NOT EXISTS communication_webhook_pending_idx
      ON communication_webhook_events(provider, processed_at, created_at);

    CREATE TABLE IF NOT EXISTS communication_sms_consents (
      organization_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      status TEXT NOT NULL,
      consent_id TEXT NOT NULL DEFAULT '',
      contact_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      opted_in_at TEXT,
      opted_out_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, phone_number)
    );
    CREATE INDEX IF NOT EXISTS communication_sms_consents_status_idx
      ON communication_sms_consents(organization_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS communication_sms_consent_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      status TEXT NOT NULL,
      consent_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      event_key TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS communication_sms_consent_events_phone_idx
      ON communication_sms_consent_events(organization_id, phone_number, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS communication_usage_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      delivery_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL,
      provider_message_id TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL,
      segments INTEGER NOT NULL DEFAULT 0,
      amount TEXT NOT NULL DEFAULT '0',
      currency TEXT NOT NULL DEFAULT 'USD',
      event_key TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS communication_usage_org_idx
      ON communication_usage_events(organization_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS communication_billing_commitments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      billing_interval TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider, resource_type, resource_id)
    );
    CREATE INDEX IF NOT EXISTS communication_billing_commitments_org_idx
      ON communication_billing_commitments(organization_id, status, starts_at DESC);
  `));

  await ensureSqlColumn(db, "communication_deliveries", "next_attempt_at", "TEXT");
  await ensureSqlColumn(db, "communication_deliveries", "lease_owner", "TEXT NOT NULL DEFAULT ''");
  await ensureSqlColumn(db, "communication_deliveries", "lease_until", "TEXT");
  await ensureSqlColumn(db, "communication_deliveries", "provider_status_at", "TEXT");
  await ensureSqlColumn(db, "communication_deliveries", "last_reconciled_at", "TEXT");
  await ensureSqlColumn(db, "communication_webhook_events", "attempts", "INTEGER NOT NULL DEFAULT 0");
  await ensureSqlColumn(db, "communication_webhook_events", "next_attempt_at", "TEXT");
  await ensureSqlColumn(db, "communication_webhook_events", "processing_started_at", "TEXT");
  await ensureSqlColumn(db, "communication_webhook_events", "processor_id", "TEXT NOT NULL DEFAULT ''");
  await initializeChatSchema(db);
  await initializeCommsSchema(db);
  await initializeCustomerCallsSchema(db);
}

function rowObject(row: unknown) {
  return asObject(row);
}

export function senderIdentityFromRow(row: unknown): CommunicationsJson {
  const value = rowObject(row);
  return {
    ...value,
    is_default: Number(value.is_default || 0) === 1,
    capabilities: parseJson(value.capabilities_json),
    metadata: parseJson(value.metadata_json)
  };
}

export function conversationFromRow(row: unknown): CommunicationsJson {
  const value = rowObject(row);
  return {
    ...value,
    participants: parseJson(value.participants_json, []),
    context: parseJson(value.context_json),
    metadata: parseJson(value.metadata_json)
  };
}

export function messageFromRow(row: unknown): CommunicationsJson {
  const value = rowObject(row);
  return {
    ...value,
    sender: parseJson(value.sender_json),
    recipients: parseJson(value.recipients_json, []),
    context: parseJson(value.context_json),
    source: parseJson(value.source_json),
    tags: parseJson(value.tags_json, []),
    metadata: parseJson(value.metadata_json)
  };
}

export function deliveryFromRow(row: unknown): CommunicationsJson {
  const value = rowObject(row);
  return {
    ...value,
    attempts: Number(value.attempts || 0),
    recipient: parseJson(value.recipient_json),
    response: parseJson(value.response_json),
    error: parseJson(value.error_json)
  };
}

export function communicationEventFromRow(row: unknown): CommunicationsJson {
  const value = rowObject(row);
  return { ...value, payload: parseJson(value.payload_json) };
}

export async function upsertSenderIdentity(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const organizationId = cleanText(input.organization_id);
  const id = cleanText(input.id) || `sender_${randomUUID().replace(/-/g, "")}`;
  (await db.prepare(`INSERT INTO communication_sender_identities (
    id, organization_id, branch_id, channel, provider, address, display_name, reply_to,
    provider_profile_id, status, is_default, capabilities_json, metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(organization_id, id) DO UPDATE SET
    branch_id = excluded.branch_id, channel = excluded.channel, provider = excluded.provider,
    address = excluded.address, display_name = excluded.display_name, reply_to = excluded.reply_to,
    provider_profile_id = excluded.provider_profile_id, status = excluded.status,
    is_default = excluded.is_default, capabilities_json = excluded.capabilities_json,
    metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .run(
      id, organizationId, cleanText(input.branch_id || "default") || "default", cleanText(input.channel),
      cleanText(input.provider), cleanText(input.address), cleanText(input.display_name), cleanText(input.reply_to),
      cleanText(input.provider_profile_id), cleanText(input.status || "active") || "active", input.is_default === true ? 1 : 0,
      json(input.capabilities), json(input.metadata), cleanText(input.created_at || now), now
    ));
  // Clear the previous default only after the insert succeeds. This keeps a
  // unique-address collision from leaving an organization without a default.
  if (input.is_default === true) {
    (await db.prepare("UPDATE communication_sender_identities SET is_default = 0, updated_at = ? WHERE organization_id = ? AND branch_id = ? AND channel = ? AND id <> ?")
      .run(now, organizationId, cleanText(input.branch_id || "default") || "default", cleanText(input.channel), id));
  }
  return (await readSenderIdentity(organizationId, id));

  }));
}

export async function readSenderIdentity(organizationId: string, identityId: string) {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM communication_sender_identities WHERE organization_id = ? AND id = ?")
    .get(organizationId, identityId));
  if (!row) throw notFound("sender_identity_not_found", "This communications sender identity was not found.");
  return senderIdentityFromRow(row);
}

export async function listSenderIdentities(organizationId: string, branchId = "", channel = "") {
  const conditions = ["organization_id = ?"];
  const params: SQLInputValue[] = [organizationId];
  if (branchId) { conditions.push("branch_id = ?"); params.push(branchId); }
  if (channel) { conditions.push("channel = ?"); params.push(channel); }
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_sender_identities WHERE ${conditions.join(" AND ")} ORDER BY is_default DESC, created_at ASC`)
    .all(...params)).map(senderIdentityFromRow);
}

export async function createConversationRecord(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const organizationId = cleanText(input.organization_id);
  const id = scopedCallerId("conversation", organizationId, input.id);
  const context = asObject(input.context);
  (await db.prepare(`INSERT INTO communication_conversations (
    id, organization_id, branch_id, status, channel_strategy, subject, project_id, contact_id,
    participants_json, context_json, metadata_json, created_by_user_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, organizationId, cleanText(input.branch_id || "default") || "default",
      cleanText(input.status || "open") || "open", cleanText(input.channel_strategy || "omnichannel") || "omnichannel",
      cleanText(input.subject), cleanText(context.project_id), cleanText(context.contact_id), json(input.participants),
      json(context), json(input.metadata), cleanText(input.created_by_user_id), now, now
    ));
  return (await readConversationRecord(organizationId, id));

  }));
}

export async function readConversationRecord(organizationId: string, conversationId: string) {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM communication_conversations WHERE organization_id = ? AND id = ?")
    .get(organizationId, conversationId));
  if (!row) throw notFound("conversation_not_found", "This conversation was not found.");
  return conversationFromRow(row);
}

export async function listConversationRecords(organizationId: string, options: CommunicationsJson = {}) {
  const conditions = ["organization_id = ?"];
  const params: SQLInputValue[] = [organizationId];
  for (const [column, value] of [["status", options.status], ["project_id", options.project_id], ["contact_id", options.contact_id]] as const) {
    const text = cleanText(value);
    if (text) { conditions.push(`${column} = ?`); params.push(text); }
  }
  const limit = Math.max(1, Math.min(250, Number(options.limit || 50)));
  params.push(limit);
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_conversations WHERE ${conditions.join(" AND ")} ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT ?`)
    .all(...params)).map(conversationFromRow);
}

export async function createMessageRecord(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const organizationId = cleanText(input.organization_id);
  const idempotencyKey = cleanText(input.idempotency_key);
  if (idempotencyKey) {
    const existing = (await db.prepare("SELECT * FROM communication_messages WHERE organization_id = ? AND idempotency_key = ?")
      .get(organizationId, idempotencyKey));
    if (existing) return { message: messageFromRow(existing), created: false };
  }
  const id = scopedCallerId("message", organizationId, input.id);
  if (cleanText(input.conversation_id)) await readConversationRecord(organizationId, cleanText(input.conversation_id));
  const context = asObject(input.context);
  const scheduledFor = cleanText(input.scheduled_for);
  const status = scheduledFor && Date.parse(scheduledFor) > Date.now() ? "scheduled" : cleanText(input.status || "queued") || "queued";
  const inserted = (await db.prepare(`INSERT INTO communication_messages (
    id, organization_id, branch_id, conversation_id, direction, channel, purpose, status,
    subject, text_body, html_body, sender_json, recipients_json, project_id, contact_id,
    proposal_id, work_plan_id, work_node_id, context_json, source_json, tags_json, metadata_json,
    idempotency_key, scheduled_for, queued_at, created_by_user_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(
      id, organizationId, cleanText(input.branch_id || "default") || "default", cleanText(input.conversation_id) || null,
      cleanText(input.direction || "outbound") || "outbound", cleanText(input.channel), cleanText(input.purpose || "customer_care") || "customer_care",
      status, cleanText(input.subject), cleanText(input.text_body), cleanText(input.html_body), json(input.sender), json(input.recipients),
      cleanText(context.project_id), cleanText(context.contact_id), cleanText(context.proposal_id), cleanText(context.work_plan_id),
      cleanText(context.work_node_id), json(context), json(input.source), json(input.tags || []), json(input.metadata),
      idempotencyKey || null, scheduledFor || null, status === "queued" ? now : null, cleanText(input.created_by_user_id), now, now
    ));
  if (!inserted.changes && idempotencyKey) {
    const existing = (await db.prepare("SELECT * FROM communication_messages WHERE organization_id = ? AND idempotency_key = ?").get(organizationId, idempotencyKey));
    if (existing) return { message: messageFromRow(existing), created: false };
  }
  if (!inserted.changes) {
    const existing = (await db.prepare("SELECT * FROM communication_messages WHERE id = ?").get(id));
    if (existing) return { message: messageFromRow(existing), created: false };
  }
  return { message: (await readMessageRecord(organizationId, id)), created: true };

  }));
}

export async function readMessageRecord(organizationId: string, messageId: string) {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM communication_messages WHERE organization_id = ? AND id = ?")
    .get(organizationId, messageId));
  if (!row) throw notFound("message_not_found", "This communication was not found.");
  return messageFromRow(row);
}

export async function listMessageRecords(organizationId: string, options: CommunicationsJson = {}) {
  const conditions = ["organization_id = ?"];
  const params: SQLInputValue[] = [organizationId];
  for (const [column, value] of [
    ["channel", options.channel], ["status", options.status], ["direction", options.direction],
    ["conversation_id", options.conversation_id], ["project_id", options.project_id], ["contact_id", options.contact_id], ["branch_id",options.branch_id]
  ] as const) {
    const text = cleanText(value);
    if (text) { conditions.push(`${column} = ?`); params.push(text); }
  }
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  params.push(limit);
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_messages WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...params)).map(messageFromRow);
}

export async function updateMessageRecord(organizationId: string, messageId: string, patch: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const current = (await readMessageRecord(organizationId, messageId));
  const now = nowIso();
  const status = cleanText(patch.status || current.status);
  (await getCommunicationsDatabase().prepare(`UPDATE communication_messages SET
    status = ?, sent_at = ?, delivered_at = ?, failed_at = ?, metadata_json = ?, updated_at = ?
    WHERE organization_id = ? AND id = ?`)
    .run(
      status,
      Object.prototype.hasOwnProperty.call(patch, "sent_at") ? cleanText(patch.sent_at) || null : cleanText(current.sent_at) || null,
      Object.prototype.hasOwnProperty.call(patch, "delivered_at") ? cleanText(patch.delivered_at) || null : cleanText(current.delivered_at) || null,
      Object.prototype.hasOwnProperty.call(patch, "failed_at") ? cleanText(patch.failed_at) || null : cleanText(current.failed_at) || null,
      json(Object.prototype.hasOwnProperty.call(patch, "metadata") ? patch.metadata : current.metadata), now, organizationId, messageId
    ));
  return (await readMessageRecord(organizationId, messageId));

  }));
}

export async function touchConversationForMessage(organizationId: string, conversationId: string, happenedAt: string) {
  if (!conversationId) return;
  (await getCommunicationsDatabase().prepare("UPDATE communication_conversations SET last_message_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
    .run(happenedAt, happenedAt, organizationId, conversationId));
}

export async function createDeliveryRecord(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `delivery_${randomUUID().replace(/-/g, "")}`;
  (await db.prepare(`INSERT INTO communication_deliveries (
    id, organization_id, message_id, channel, recipient_address, recipient_json, provider,
    transport_mode, provider_message_id, status, attempts, response_json, error_json,
    queued_at, sent_at, delivered_at, failed_at, next_attempt_at, lease_owner, lease_until,
    provider_status_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, cleanText(input.organization_id), cleanText(input.message_id), cleanText(input.channel), cleanText(input.recipient_address),
      json(input.recipient), cleanText(input.provider), cleanText(input.transport_mode), cleanText(input.provider_message_id),
      cleanText(input.status || "queued") || "queued", Number(input.attempts || 0), json(input.response), json(input.error),
      cleanText(input.queued_at || now), cleanText(input.sent_at) || null, cleanText(input.delivered_at) || null,
      cleanText(input.failed_at) || null, cleanText(input.next_attempt_at) || null, cleanText(input.lease_owner),
      cleanText(input.lease_until) || null, cleanText(input.provider_status_at) || null, now, now
    ));
  return (await readDeliveryRecord(cleanText(input.organization_id), id));

  }));
}

export async function readDeliveryRecord(organizationId: string, deliveryId: string) {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM communication_deliveries WHERE organization_id = ? AND id = ?")
    .get(organizationId, deliveryId));
  if (!row) throw notFound("delivery_not_found", "This communication delivery was not found.");
  return deliveryFromRow(row);
}

export async function listDeliveryRecords(organizationId: string, messageId: string) {
  return (await getCommunicationsDatabase().prepare("SELECT * FROM communication_deliveries WHERE organization_id = ? AND message_id = ? ORDER BY created_at ASC")
    .all(organizationId, messageId)).map(deliveryFromRow);
}

export async function countSmsDeliveriesSince(organizationId: string, since: string, recipientAddress = "") {
  const value = recipientAddress
    ? asObject((await getCommunicationsDatabase().prepare(`SELECT COUNT(*) AS count FROM communication_deliveries
        WHERE organization_id = ? AND channel = 'sms' AND recipient_address = ? AND created_at >= ?`).get(organizationId, recipientAddress, since)))
    : asObject((await getCommunicationsDatabase().prepare(`SELECT COUNT(*) AS count FROM communication_deliveries
        WHERE organization_id = ? AND channel = 'sms' AND created_at >= ?`).get(organizationId, since)));
  return Number(value.count || 0);
}

export async function countEmailDeliveriesSince(organizationId: string, since: string) {
  const value = asObject((await getCommunicationsDatabase().prepare(`SELECT COUNT(*) AS count FROM communication_deliveries
    WHERE organization_id = ? AND channel = 'email' AND transport_mode IN ('test', 'live') AND created_at >= ?`).get(organizationId, since)));
  return Number(value.count || 0);
}

export async function updateDeliveryRecord(organizationId: string, deliveryId: string, patch: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const current = (await readDeliveryRecord(organizationId, deliveryId));
  const now = nowIso();
  (await getCommunicationsDatabase().prepare(`UPDATE communication_deliveries SET
    status = ?, attempts = ?, response_json = ?, error_json = ?, provider_message_id = ?,
    sent_at = ?, delivered_at = ?, failed_at = ?, next_attempt_at = ?, lease_owner = ?,
    lease_until = ?, provider_status_at = ?, last_reconciled_at = ?, updated_at = ?
    WHERE organization_id = ? AND id = ?`)
    .run(
      cleanText(patch.status || current.status), Number(patch.attempts ?? current.attempts ?? 0),
      json(Object.prototype.hasOwnProperty.call(patch, "response") ? patch.response : current.response),
      json(Object.prototype.hasOwnProperty.call(patch, "error") ? patch.error : current.error),
      cleanText(patch.provider_message_id || current.provider_message_id),
      Object.prototype.hasOwnProperty.call(patch, "sent_at") ? cleanText(patch.sent_at) || null : cleanText(current.sent_at) || null,
      Object.prototype.hasOwnProperty.call(patch, "delivered_at") ? cleanText(patch.delivered_at) || null : cleanText(current.delivered_at) || null,
      Object.prototype.hasOwnProperty.call(patch, "failed_at") ? cleanText(patch.failed_at) || null : cleanText(current.failed_at) || null,
      Object.prototype.hasOwnProperty.call(patch, "next_attempt_at") ? cleanText(patch.next_attempt_at) || null : cleanText(current.next_attempt_at) || null,
      Object.prototype.hasOwnProperty.call(patch, "lease_owner") ? cleanText(patch.lease_owner) : cleanText(current.lease_owner),
      Object.prototype.hasOwnProperty.call(patch, "lease_until") ? cleanText(patch.lease_until) || null : cleanText(current.lease_until) || null,
      Object.prototype.hasOwnProperty.call(patch, "provider_status_at") ? cleanText(patch.provider_status_at) || null : cleanText(current.provider_status_at) || null,
      Object.prototype.hasOwnProperty.call(patch, "last_reconciled_at") ? cleanText(patch.last_reconciled_at) || null : cleanText(current.last_reconciled_at) || null,
      now, organizationId, deliveryId
    ));
  return (await readDeliveryRecord(organizationId, deliveryId));

  }));
}

export async function findSenderIdentityByAddress(address: string, providerProfileId = "") {
  const db = getCommunicationsDatabase();
  const row = providerProfileId
    ? (await db.prepare("SELECT * FROM communication_sender_identities WHERE channel = 'sms' AND address = ? AND provider_profile_id = ? AND status = 'active' LIMIT 1").get(address, providerProfileId))
    : (await db.prepare("SELECT * FROM communication_sender_identities WHERE channel = 'sms' AND address = ? AND status = 'active' LIMIT 1").get(address));
  return row ? senderIdentityFromRow(row) : null;
}

export async function claimPhoneNumberOwnership(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const phoneNumber = cleanText(input.phone_number);
  const organizationId = cleanText(input.organization_id);
  const result = (await db.prepare(`INSERT INTO messaging_phone_number_ownership (
    phone_number, organization_id, compliance_profile_id, messaging_profile_id, provider_phone_number_id, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(phone_number) DO UPDATE SET
    compliance_profile_id = excluded.compliance_profile_id,
    messaging_profile_id = excluded.messaging_profile_id,
    provider_phone_number_id = CASE
      WHEN excluded.provider_phone_number_id <> '' THEN excluded.provider_phone_number_id
      ELSE messaging_phone_number_ownership.provider_phone_number_id
    END,
    status = excluded.status,
    updated_at = excluded.updated_at
  WHERE messaging_phone_number_ownership.organization_id = excluded.organization_id`)
    .run(phoneNumber, organizationId, cleanText(input.compliance_profile_id), cleanText(input.messaging_profile_id), cleanText(input.provider_phone_number_id), cleanText(input.status || "pending"), now, now));
  const owner = asObject((await db.prepare("SELECT * FROM messaging_phone_number_ownership WHERE phone_number = ?").get(phoneNumber)));
  return { claimed: result.changes === 1 && cleanText(owner.organization_id) === organizationId, owner };

  }));
}

export async function findPhoneNumberOwner(phoneNumber: string) {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM messaging_phone_number_ownership WHERE phone_number = ? LIMIT 1").get(phoneNumber));
  return row ? asObject(row) : null;
}

export async function releasePhoneNumberOwnership(phoneNumber: string, organizationId: string, force = false) {
  const sql = force
    ? "DELETE FROM messaging_phone_number_ownership WHERE phone_number = ? AND organization_id = ?"
    : "DELETE FROM messaging_phone_number_ownership WHERE phone_number = ? AND organization_id = ? AND status = 'pending'";
  (await getCommunicationsDatabase().prepare(sql).run(phoneNumber, organizationId));
}

export async function beginProviderOperation(input: CommunicationsJson) {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  // Provider operations may span several Telnyx requests (for example service
  // deactivation), so the recovery window intentionally exceeds both one
  // request timeout and the longest normal multi-request path. Once this
  // window expires we cannot know whether the provider accepted the request;
  // callers must reconcile instead of issuing the operation again blindly.
  const staleAfterMs = Math.max(10 * 60_000, env.telnyxRequestTimeoutMs * 12);
  return (await withCommunicationsTransaction(async () => {
    const expectedProfileUpdatedAt = cleanText(input.profile_updated_at);
    if (expectedProfileUpdatedAt) {
      const profileRow = asObject((await db.prepare(`SELECT updated_at FROM sms_compliance_profiles
        WHERE id = ? AND external_organization_id = ? LIMIT 1`)
        .get(cleanText(input.compliance_profile_id), cleanText(input.organization_id))));
      const currentProfileUpdatedAt = cleanText(profileRow.updated_at);
      if (!currentProfileUpdatedAt || currentProfileUpdatedAt !== expectedProfileUpdatedAt) {
        return {
          state: "profile_changed",
          operation: {
            organization_id: cleanText(input.organization_id),
            compliance_profile_id: cleanText(input.compliance_profile_id),
            operation_type: cleanText(input.operation_type),
            expected_profile_updated_at: expectedProfileUpdatedAt,
            current_profile_updated_at: currentProfileUpdatedAt
          }
        };
      }
    }
    const exclusivePrefixes = Array.isArray(input.exclusive_operation_prefixes)
      ? input.exclusive_operation_prefixes.map(cleanText).filter(Boolean)
      : [];
    if (exclusivePrefixes.length) {
      const clauses = exclusivePrefixes.map(() => "(operation_type = ? OR operation_type LIKE ?)").join(" OR ");
      const params = exclusivePrefixes.flatMap((prefix) => [prefix, `${prefix}_%`]);
      const competing = (await db.prepare(`SELECT * FROM messaging_provider_operations
        WHERE organization_id = ? AND compliance_profile_id = ? AND operation_type <> ?
          AND status IN ('pending', 'outcome_unknown') AND (${clauses})
        ORDER BY updated_at DESC LIMIT 1`)
        .get(cleanText(input.organization_id), cleanText(input.compliance_profile_id), cleanText(input.operation_type), ...params));
      if (competing) return { state: "conflict", operation: asObject(competing) };
    }
    const existing = (await db.prepare(`SELECT * FROM messaging_provider_operations
      WHERE organization_id = ? AND compliance_profile_id = ? AND operation_type = ?`)
      .get(cleanText(input.organization_id), cleanText(input.compliance_profile_id), cleanText(input.operation_type)));
    if (existing) {
      const value = asObject(existing);
      if (cleanText(value.status) === "pending") {
        const updatedAt = Date.parse(cleanText(value.updated_at));
        if (!Number.isFinite(updatedAt) || updatedAt <= Date.now() - staleAfterMs) {
          const error = {
            code: "provider_operation_lease_expired",
            message: "The provider operation was interrupted before its outcome was recorded.",
            recovery: "reconcile_provider_state",
            stale_after_ms: staleAfterMs
          };
          (await db.prepare(`UPDATE messaging_provider_operations SET status = 'outcome_unknown', error_json = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
            .run(json(error), now, cleanText(value.id)));
          const recovered: CommunicationsJson = { ...value, status: "outcome_unknown", error_json: json(error), updated_at: now };
          if (cleanText(value.request_hash) !== cleanText(input.request_hash)) {
            return { state: "conflict", recovered_stale: true, operation: recovered };
          }
          return { state: "outcome_unknown", recovered_stale: true, operation: recovered };
        }
      }
      if (cleanText(value.request_hash) !== cleanText(input.request_hash)) {
        if (cleanText(value.status) !== "failed") return { state: "conflict", operation: value };
        (await db.prepare(`UPDATE messaging_provider_operations SET status = 'pending', attempts = attempts + 1,
          request_hash = ?, provider_id = '', response_json = '{}', error_json = '{}', updated_at = ? WHERE id = ?`)
          .run(cleanText(input.request_hash), now, cleanText(value.id)));
        return { state: "created", operation: { ...value, status: "pending", request_hash: cleanText(input.request_hash), provider_id: "", attempts: Number(value.attempts || 1) + 1, updated_at: now } };
      }
      if (cleanText(value.status) === "pending") {
        return { state: "pending", operation: value };
      }
      if (["outcome_unknown", "succeeded"].includes(cleanText(value.status))) return { state: cleanText(value.status), operation: value };
      (await db.prepare(`UPDATE messaging_provider_operations SET status = 'pending', attempts = attempts + 1,
        error_json = '{}', updated_at = ? WHERE id = ?`).run(now, cleanText(value.id)));
      return { state: "created", operation: { ...value, status: "pending", attempts: Number(value.attempts || 1) + 1, updated_at: now } };
    }
    const operation = {
      id: `provider_operation_${randomUUID().replace(/-/g, "")}`,
      organization_id: cleanText(input.organization_id),
      compliance_profile_id: cleanText(input.compliance_profile_id),
      operation_type: cleanText(input.operation_type),
      status: "pending",
      attempts: 1,
      request_hash: cleanText(input.request_hash),
      created_at: now,
      updated_at: now
    };
    (await db.prepare(`INSERT INTO messaging_provider_operations (
      id, organization_id, compliance_profile_id, operation_type, status, attempts, request_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(operation.id, operation.organization_id, operation.compliance_profile_id, operation.operation_type, operation.status, operation.attempts, operation.request_hash, now, now));
    return { state: "created", operation };
  }));
}

export async function findProviderOperation(organizationId: string, complianceProfileId: string, operationType: string) {
  const row = (await getCommunicationsDatabase().prepare(`SELECT * FROM messaging_provider_operations
    WHERE organization_id = ? AND compliance_profile_id = ? AND operation_type = ? LIMIT 1`)
    .get(cleanText(organizationId), cleanText(complianceProfileId), cleanText(operationType)));
  return row ? asObject(row) : null;
}

export async function findUnresolvedProviderOperationByPrefix(organizationId: string, complianceProfileId: string, operationTypePrefix: string) {
  const row = (await getCommunicationsDatabase().prepare(`SELECT * FROM messaging_provider_operations
    WHERE organization_id = ? AND compliance_profile_id = ?
      AND (operation_type = ? OR operation_type LIKE ?)
      AND status IN ('pending', 'outcome_unknown')
    ORDER BY updated_at DESC LIMIT 1`)
    .get(cleanText(organizationId), cleanText(complianceProfileId), cleanText(operationTypePrefix), `${cleanText(operationTypePrefix)}_%`));
  return row ? asObject(row) : null;
}

export async function markProviderOperationFailed(organizationId: string, complianceProfileId: string, operationType: string, error: CommunicationsJson) {
  (await getCommunicationsDatabase().prepare(`UPDATE messaging_provider_operations SET status = 'failed', error_json = ?, updated_at = ?
    WHERE organization_id = ? AND compliance_profile_id = ? AND operation_type = ? AND status = 'pending'`)
    .run(json(error), nowIso(), organizationId, complianceProfileId, operationType));
}

export async function resetProviderOperationForRetry(organizationId: string, complianceProfileId: string, operationType: string, error: CommunicationsJson) {
  (await getCommunicationsDatabase().prepare(`UPDATE messaging_provider_operations SET status = 'failed', error_json = ?, updated_at = ?
    WHERE organization_id = ? AND compliance_profile_id = ? AND operation_type = ?`)
    .run(json(error), nowIso(), organizationId, complianceProfileId, operationType));
}

export async function finishProviderOperation(operationId: string, patch: CommunicationsJson) {
  (await getCommunicationsDatabase().prepare(`UPDATE messaging_provider_operations SET
    status = ?, provider_id = ?, response_json = ?, error_json = ?, updated_at = ? WHERE id = ?`)
    .run(cleanText(patch.status), cleanText(patch.provider_id), json(patch.response), json(patch.error), nowIso(), operationId));
}

export async function updateProviderOperationContext(operationId: string, response: CommunicationsJson) {
  (await getCommunicationsDatabase().prepare(`UPDATE messaging_provider_operations SET response_json = ?, updated_at = ?
    WHERE id = ? AND status IN ('pending', 'outcome_unknown')`)
    .run(json(response), nowIso(), operationId));
}

export async function findDeliveryByProviderMessageId(provider: string, providerMessageId: string) {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM communication_deliveries WHERE provider = ? AND provider_message_id = ? LIMIT 1")
    .get(provider, providerMessageId));
  return row ? deliveryFromRow(row) : null;
}

export async function findDeliveryById(deliveryId: string) {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM communication_deliveries WHERE id = ? LIMIT 1").get(deliveryId));
  return row ? deliveryFromRow(row) : null;
}

export async function suppressPendingSmsDeliveries(organizationId: string, phoneNumber: string, occurredAt: string) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const rows = (await db.prepare(`SELECT * FROM communication_deliveries
    WHERE organization_id = ? AND channel = 'sms' AND recipient_address = ?
      AND status IN ('queued', 'retry_pending', 'scheduled')`).all(organizationId, phoneNumber));
  for (const row of rows) {
    const delivery = deliveryFromRow(row);
    const cancelProviderSchedule = cleanText(delivery.status) === "scheduled" && Boolean(cleanText(delivery.provider_message_id));
    (await db.prepare(`UPDATE communication_deliveries SET status = ?, failed_at = ?, next_attempt_at = NULL,
      lease_owner = '', lease_until = NULL, error_json = ?, updated_at = ? WHERE id = ?`)
      .run(cancelProviderSchedule ? "cancel_pending" : "failed", cancelProviderSchedule ? null : occurredAt, json({ code: "recipient_opted_out", message: "Recipient opted out before scheduled delivery." }), occurredAt, cleanText(delivery.id)));
  }
  return rows.map(deliveryFromRow);

  }));
}

export async function claimNextSmsCancellation(workerId: string) {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + 30_000).toISOString();
  return (await withCommunicationsTransaction(async () => {
    const row = (await db.prepare(`SELECT * FROM communication_deliveries
      WHERE channel = 'sms' AND transport_mode = 'live' AND status = 'cancel_pending'
        AND provider_message_id <> '' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY updated_at ASC LIMIT 1`).get(now, now));
    if (!row) return null;
    const delivery = deliveryFromRow(row);
    const claimed = (await db.prepare(`UPDATE communication_deliveries SET status = 'cancelling', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'cancel_pending' AND (lease_until IS NULL OR lease_until < ?)`)
      .run(workerId, leaseUntil, now, cleanText(delivery.id), now));
    return claimed.changes ? (await readDeliveryRecord(cleanText(delivery.organization_id), cleanText(delivery.id))) : null;
  }));
}

export async function findSmsConversationRecord(organizationId: string, remotePhoneNumber: string) {
  const row = (await getCommunicationsDatabase().prepare(`SELECT c.*
    FROM communication_conversations c
    WHERE c.organization_id = ? AND c.status = 'open' AND EXISTS (SELECT 1 FROM ${getCommunicationsDatabase().isPostgres ? 'jsonb_array_elements(c.participants_json::jsonb)' : 'json_each(c.participants_json)'} participant WHERE ${getCommunicationsDatabase().isPostgres ? "participant.value->>'address'" : "json_extract(participant.value, '$.address')"} = ?)
    ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC LIMIT 1`)
    .get(organizationId, remotePhoneNumber));
  return row ? conversationFromRow(row) : null;
}

export async function claimNextSmsDelivery(workerId: string, maxAttempts: number) {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + 30_000).toISOString();
  return (await withCommunicationsTransaction(async () => {
    const row = (await db.prepare(`SELECT * FROM communication_deliveries
      WHERE channel = 'sms' AND transport_mode = 'live'
        AND status IN ('queued', 'scheduled', 'retry_pending')
        AND provider_message_id = ''
        AND attempts < ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY COALESCE(next_attempt_at, queued_at, created_at) ASC LIMIT 1`)
      .get(maxAttempts, now, now));
    if (!row) return null;
    const delivery = deliveryFromRow(row);
    const claimed = (await db.prepare(`UPDATE communication_deliveries SET
      status = 'submitting', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'scheduled', 'retry_pending') AND (lease_until IS NULL OR lease_until < ?)`)
      .run(workerId, leaseUntil, now, cleanText(delivery.id), now));
    return claimed.changes ? (await readDeliveryRecord(cleanText(delivery.organization_id), cleanText(delivery.id))) : null;
  }));
}

export async function recoverExpiredSmsDeliveryLeases() {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  return (await withCommunicationsTransaction(async () => {
    const rows = (await db.prepare(`SELECT * FROM communication_deliveries
      WHERE channel = 'sms' AND transport_mode = 'live' AND lease_until IS NOT NULL AND lease_until < ?
        AND status IN ('submitting', 'cancelling')`).all(now)).map(deliveryFromRow);
    for (const delivery of rows) {
      const wasCancelling = cleanText(delivery.status) === "cancelling";
      (await db.prepare(`UPDATE communication_deliveries SET status = ?, failed_at = ?, next_attempt_at = ?,
        lease_owner = '', lease_until = NULL, error_json = ?, updated_at = ? WHERE id = ?`)
        .run(
          wasCancelling ? "cancel_pending" : "submission_unknown",
          wasCancelling ? null : now,
          wasCancelling ? now : null,
          json(wasCancelling
            ? { code: "cancellation_worker_interrupted", message: "Cancellation will be retried after an interrupted worker lease." }
            : { code: "submission_outcome_unknown", message: "The worker stopped while submitting. Automatic resend is disabled to prevent a duplicate SMS." }),
          now,
          cleanText(delivery.id)
        ));
    }
    return rows;
  }));
}

export async function listSmsDeliveriesForReconciliation(limit = 25) {
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_deliveries
    WHERE channel = 'sms' AND transport_mode = 'live' AND provider_message_id <> ''
      AND status IN ('queued', 'sent', 'scheduled')
      AND COALESCE(last_reconciled_at, updated_at) <= ?
    ORDER BY COALESCE(last_reconciled_at, updated_at) ASC LIMIT ?`).all(cutoff, Math.max(1, Math.min(100, limit)))).map(deliveryFromRow);
}

export async function createWebhookInboxEvent(input: CommunicationsJson) {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const result = (await db.prepare(`INSERT INTO communication_webhook_events (
    provider, event_id, event_type, provider_object_id, payload_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(cleanText(input.provider), cleanText(input.event_id), cleanText(input.event_type), cleanText(input.provider_object_id), json(input.payload), cleanText(input.occurred_at || now), now));
  return { created: result.changes === 1 };
}

export async function markWebhookInboxEventProcessed(provider: string, eventId: string, error = "") {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const message = cleanText(error);
  if (!message) {
    (await db.prepare("UPDATE communication_webhook_events SET processed_at = ?, processing_error = '', next_attempt_at = NULL, processing_started_at = NULL, processor_id = '' WHERE provider = ? AND event_id = ?")
      .run(nowIso(), provider, eventId));
    return;
  }
  const row = asObject((await db.prepare("SELECT attempts FROM communication_webhook_events WHERE provider = ? AND event_id = ?").get(provider, eventId)));
  const attempts = Number(row.attempts || 0) + 1;
  const delayMs = Math.min(60 * 60_000, 5_000 * (2 ** Math.min(8, attempts - 1)));
  (await db.prepare("UPDATE communication_webhook_events SET processed_at = NULL, processing_error = ?, attempts = ?, next_attempt_at = ?, processing_started_at = NULL, processor_id = '' WHERE provider = ? AND event_id = ?")
    .run(message, attempts, new Date(Date.now() + delayMs).toISOString(), provider, eventId));

  }));
}

export async function listPendingWebhookInboxEvents(provider: string, limit = 25) {
  const now = nowIso();
  const staleLease = new Date(Date.now() - 60_000).toISOString();
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_webhook_events
    WHERE provider = ? AND processed_at IS NULL AND attempts < 20
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND (processing_started_at IS NULL OR processing_started_at <= ?)
    ORDER BY COALESCE(next_attempt_at, created_at) ASC LIMIT ?`)
    .all(provider, now, staleLease, Math.max(1, Math.min(100, limit)))).map((row) => {
      const value = asObject(row);
      return { ...value, payload: parseJson(value.payload_json) };
    });
}

export async function claimWebhookInboxEvent(provider: string, eventId: string, processorId: string) {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const staleLease = new Date(Date.now() - 60_000).toISOString();
  const result = (await db.prepare(`UPDATE communication_webhook_events SET processing_started_at = ?, processor_id = ?
    WHERE provider = ? AND event_id = ? AND processed_at IS NULL AND attempts < 20
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      AND (processing_started_at IS NULL OR processing_started_at <= ?)`)
    .run(now, processorId, provider, eventId, now, staleLease));
  if (!result.changes) return null;
  const value = asObject((await db.prepare("SELECT * FROM communication_webhook_events WHERE provider = ? AND event_id = ?").get(provider, eventId)));
  return { ...value, payload: parseJson(value.payload_json) };
}

export async function listWebhookInboxEventsForObject(provider: string, providerObjectId: string) {
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_webhook_events
    WHERE provider = ? AND provider_object_id = ? AND processing_error <> '' ORDER BY occurred_at ASC`)
    .all(provider, providerObjectId)).map((row) => {
      const value = asObject(row);
      return { ...value, payload: parseJson(value.payload_json) };
    });
}

export async function webhookInboxStats(provider: string) {
  const value = asObject((await getCommunicationsDatabase().prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN processing_error <> '' THEN 1 ELSE 0 END) AS orphaned
    FROM communication_webhook_events WHERE provider = ?`).get(provider)));
  return { total: Number(value.total || 0), orphaned: Number(value.orphaned || 0) };
}

export async function upsertSmsConsent(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const requestedAt = Date.parse(cleanText(input.occurred_at));
  const now = Number.isFinite(requestedAt) ? new Date(requestedAt).toISOString() : nowIso();
  const status = cleanText(input.status);
  const organizationId = cleanText(input.organization_id);
  const phoneNumber = cleanText(input.phone_number);
  const evidence = asObject(input.evidence);
  const eventKey = cleanText(input.event_key || evidence.provider_event_id || `${cleanText(input.source)}:${cleanText(input.consent_id)}:${now}:${status}`);
  return (await withCommunicationsTransaction(async () => {
    const eventId = `consent_event_${randomUUID().replace(/-/g, "")}`;
    const inserted = (await db.prepare(`INSERT INTO communication_sms_consent_events (
      id, organization_id, phone_number, status, consent_id, source, evidence_json, event_key, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(eventId, organizationId, phoneNumber, status, cleanText(input.consent_id), cleanText(input.source), json(evidence), eventKey, now, now));
    if (!inserted.changes) return (await readSmsConsent(organizationId, phoneNumber));
    (await db.prepare(`INSERT INTO communication_sms_consents (
      organization_id, phone_number, status, consent_id, contact_id, source, evidence_json,
      opted_in_at, opted_out_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, phone_number) DO UPDATE SET
      status = excluded.status,
      consent_id = CASE WHEN excluded.consent_id <> '' THEN excluded.consent_id ELSE communication_sms_consents.consent_id END,
      contact_id = CASE WHEN excluded.contact_id <> '' THEN excluded.contact_id ELSE communication_sms_consents.contact_id END,
      source = excluded.source,
      evidence_json = excluded.evidence_json,
      opted_in_at = CASE WHEN excluded.status = 'opted_in' THEN excluded.updated_at ELSE communication_sms_consents.opted_in_at END,
      opted_out_at = CASE WHEN excluded.status = 'opted_out' THEN excluded.updated_at ELSE communication_sms_consents.opted_out_at END,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > communication_sms_consents.updated_at
      OR (excluded.updated_at = communication_sms_consents.updated_at AND excluded.status = 'opted_out' AND communication_sms_consents.status <> 'opted_out')`)
      .run(
        organizationId, phoneNumber, status, cleanText(input.consent_id), cleanText(input.contact_id),
        cleanText(input.source), json(evidence), status === "opted_in" ? now : null, status === "opted_out" ? now : null, now, now
      ));
    return (await readSmsConsent(organizationId, phoneNumber));
  }));

  }));
}

export async function listSmsConsentEvents(organizationId: string, phoneNumber = "", limitValue: unknown = 100) {
  const limit = Math.max(1, Math.min(1000, Number(limitValue || 100)));
  const rows = phoneNumber
    ? (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_sms_consent_events
        WHERE organization_id = ? AND phone_number = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?`).all(organizationId, phoneNumber, limit))
    : (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_sms_consent_events
        WHERE organization_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?`).all(organizationId, limit));
  return rows.map((row) => {
    const value = asObject(row);
    return { ...value, evidence: parseJson(value.evidence_json) };
  });
}

export async function readSmsConsent(organizationId: string, phoneNumber: string): Promise<CommunicationsJson | null> {
  const row = (await getCommunicationsDatabase().prepare("SELECT * FROM communication_sms_consents WHERE organization_id = ? AND phone_number = ?")
    .get(organizationId, phoneNumber));
  if (!row) return null;
  const value = asObject(row);
  return { ...value, evidence: parseJson(value.evidence_json) };
}

export async function listSmsConsents(organizationId: string, status = "", limitValue: unknown = 100): Promise<CommunicationsJson[]> {
  const limit = Math.max(1, Math.min(500, Number(limitValue || 100)));
  const rows = status
    ? (await getCommunicationsDatabase().prepare("SELECT * FROM communication_sms_consents WHERE organization_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?").all(organizationId, status, limit))
    : (await getCommunicationsDatabase().prepare("SELECT * FROM communication_sms_consents WHERE organization_id = ? ORDER BY updated_at DESC LIMIT ?").all(organizationId, limit));
  return rows.map((row) => {
    const value = asObject(row);
    return { ...value, evidence: parseJson(value.evidence_json) };
  });
}

export async function createUsageEvent(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `usage_${randomUUID().replace(/-/g, "")}`;
  const result = (await db.prepare(`INSERT INTO communication_usage_events (
    id, organization_id, message_id, delivery_id, provider, provider_message_id, direction,
    segments, amount, currency, event_key, occurred_at, metadata_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(
      id, cleanText(input.organization_id), cleanText(input.message_id), cleanText(input.delivery_id), cleanText(input.provider),
      cleanText(input.provider_message_id), cleanText(input.direction), Math.max(0, Number(input.segments || 0)),
      cleanText(input.amount || "0") || "0", cleanText(input.currency || "USD") || "USD", cleanText(input.event_key),
      cleanText(input.occurred_at || now), json(input.metadata), now
    ));
  return { created: result.changes === 1 };

  }));
}

export async function upsertBillingCommitment(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `billing_commitment_${randomUUID().replace(/-/g, "")}`;
  (await db.prepare(`INSERT INTO communication_billing_commitments (
    id, organization_id, provider, resource_type, resource_id, amount, currency, billing_interval,
    status, starts_at, ends_at, metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider, resource_type, resource_id) DO UPDATE SET
    amount = excluded.amount, currency = excluded.currency, billing_interval = excluded.billing_interval,
    status = excluded.status, ends_at = excluded.ends_at, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`)
    .run(
      id, cleanText(input.organization_id), cleanText(input.provider), cleanText(input.resource_type), cleanText(input.resource_id),
      cleanText(input.amount || "0"), cleanText(input.currency || "USD"), cleanText(input.billing_interval),
      cleanText(input.status || "active"), cleanText(input.starts_at || now), cleanText(input.ends_at) || null,
      json(input.metadata), now, now
    ));

  }));
}

export async function listBillingCommitments(organizationId: string) {
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_billing_commitments
    WHERE organization_id = ? ORDER BY starts_at DESC`).all(organizationId)).map((row) => {
      const value = asObject(row);
      return { ...value, metadata: parseJson(value.metadata_json) };
    });
}

export async function endBillingCommitment(provider: string, resourceType: string, resourceId: string, endedAt = nowIso()) {
  (await getCommunicationsDatabase().prepare(`UPDATE communication_billing_commitments
    SET status = 'ended', ends_at = ?, updated_at = ? WHERE provider = ? AND resource_type = ? AND resource_id = ?`)
    .run(endedAt, nowIso(), provider, resourceType, resourceId));
}

export async function findBillingCommitment(provider: string, resourceType: string, resourceId: string) {
  const row = (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_billing_commitments
    WHERE provider = ? AND resource_type = ? AND resource_id = ?`).get(provider, resourceType, resourceId));
  if (!row) return null;
  const value = asObject(row);
  return { ...value, metadata: parseJson(value.metadata_json) };
}

export async function suspendOrganizationSmsDeliveries(organizationId: string, reason = "sms_service_deactivated") {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  return (await withCommunicationsTransaction(async () => {
    const rows = (await db.prepare(`SELECT * FROM communication_deliveries
      WHERE organization_id = ? AND channel = 'sms' AND status IN ('queued', 'retry_pending', 'scheduled')`).all(organizationId)).map(deliveryFromRow);
    for (const delivery of rows) {
      const cancelProviderSchedule = cleanText(delivery.status) === "scheduled" && Boolean(cleanText(delivery.provider_message_id));
      const message = reason === "sms_service_deactivated"
        ? "SMS service was deactivated before delivery."
        : "SMS delivery was suspended because the organization's provider compliance state is not send-ready.";
      (await db.prepare(`UPDATE communication_deliveries SET status = ?, failed_at = ?, next_attempt_at = NULL,
        lease_owner = '', lease_until = NULL, error_json = ?, updated_at = ? WHERE id = ?`)
        .run(cancelProviderSchedule ? "cancel_pending" : "failed", cancelProviderSchedule ? null : now, json({ code: reason, message }), now, cleanText(delivery.id)));
    }
    return rows;
  }));
}

export async function listUsageEvents(organizationId: string, options: CommunicationsJson = {}): Promise<CommunicationsJson[]> {
  const conditions = ["organization_id = ?"];
  const params: SQLInputValue[] = [organizationId];
  const from = cleanText(options.from);
  const to = cleanText(options.to);
  if (from) { conditions.push("occurred_at >= ?"); params.push(from); }
  if (to) { conditions.push("occurred_at <= ?"); params.push(to); }
  if (cleanText(options.direction)) { conditions.push("direction = ?"); params.push(cleanText(options.direction)); }
  if (cleanText(options.provider)) { conditions.push("provider = ?"); params.push(cleanText(options.provider)); }
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 500)));
  params.push(limit);
  return (await getCommunicationsDatabase().prepare(`SELECT * FROM communication_usage_events WHERE ${conditions.join(" AND ")} ORDER BY occurred_at DESC LIMIT ?`)
    .all(...params)).map((row) => {
      const value = asObject(row);
      return { ...value, segments: Number(value.segments || 0), metadata: parseJson(value.metadata_json) };
    });
}

export async function listUsageSummaryRows(organizationId: string, options: CommunicationsJson = {}): Promise<CommunicationsJson[]> {
  const conditions = ["organization_id = ?"];
  const params: SQLInputValue[] = [organizationId];
  const from = cleanText(options.from);
  const to = cleanText(options.to);
  if (from) { conditions.push("occurred_at >= ?"); params.push(from); }
  if (to) { conditions.push("occurred_at <= ?"); params.push(to); }
  if (cleanText(options.direction)) { conditions.push("direction = ?"); params.push(cleanText(options.direction)); }
  if (cleanText(options.provider)) { conditions.push("provider = ?"); params.push(cleanText(options.provider)); }
  return (await getCommunicationsDatabase().prepare(`SELECT direction, currency, amount, segments FROM communication_usage_events
    WHERE ${conditions.join(" AND ")}`).all(...params)).map((row) => {
      const value = asObject(row);
      return { direction: cleanText(value.direction), currency: cleanText(value.currency), amount: cleanText(value.amount), segments: Number(value.segments || 0) };
    });
}

export async function createCommunicationEvent(input: CommunicationsJson) {
  return (await getCommunicationsDatabase().transaction(async () => {
  const db = getCommunicationsDatabase();
  const now = nowIso();
  const id = cleanText(input.id) || `communication_event_${randomUUID().replace(/-/g, "")}`;
  (await db.prepare(`INSERT INTO communication_events (
    id, organization_id, message_id, delivery_id, type, provider, payload_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, cleanText(input.organization_id), cleanText(input.message_id), cleanText(input.delivery_id) || null,
      cleanText(input.type), cleanText(input.provider), json(input.payload), cleanText(input.occurred_at || now), now
    ));
  return communicationEventFromRow((await db.prepare("SELECT * FROM communication_events WHERE id = ?").get(id)));

  }));
}

export async function listCommunicationEvents(organizationId: string, messageId: string) {
  return (await getCommunicationsDatabase().prepare("SELECT * FROM communication_events WHERE organization_id = ? AND message_id = ? ORDER BY occurred_at ASC, created_at ASC")
    .all(organizationId, messageId)).map(communicationEventFromRow);
}

export async function withCommunicationsTransaction<T>(callback: () => T | Promise<T>): Promise<T> {
  return (await getCommunicationsDatabase().transaction(callback));
}
