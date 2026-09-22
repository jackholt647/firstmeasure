import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { badRequest, notFound } from "../platform/errors.js";
import { getCommunicationsDatabase, withCommunicationsTransaction } from "./communications_storage.js";

export type JsonObject = Record<string, unknown>;

export type MessagingOrganization = JsonObject & {
  schema_version: number;
  id: string;
  external_organization_id: string;
  provider: "telnyx";
  status: string;
  default_sms_compliance_profile_id: string;
  created_at: string;
  updated_at: string;
  metadata: JsonObject;
};

export type SmsComplianceProfile = JsonObject & {
  schema_version: number;
  id: string;
  messaging_organization_id: string;
  external_organization_id: string;
  provider: "telnyx";
  status: string;
  brand_status: string;
  campaign_status: string;
  brand: JsonObject;
  campaign: JsonObject;
  provider_refs: JsonObject;
  validation: JsonObject;
  events: JsonObject[];
  created_at: string;
  updated_at: string;
};

function storageRoot() {
  return path.resolve(process.cwd(), env.messagingStorageRoot);
}

function orgsRoot() {
  return path.join(storageRoot(), "organizations");
}

function sanitizeId(value: unknown, label = "id") {
  const cleaned = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) throw badRequest(`invalid_${label}`, `${label} must contain at least one letter or number.`);
  return cleaned;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function messagingOrgId(externalOrganizationId: string) {
  return `msg_org_${createHash("sha256").update(externalOrganizationId).digest("hex").slice(0, 16)}`;
}

function orgDir(messagingOrgIdValue: string) {
  return path.join(orgsRoot(), sanitizeId(messagingOrgIdValue, "messaging_organization_id"));
}

function orgPath(messagingOrgIdValue: string) {
  return path.join(orgDir(messagingOrgIdValue), "organization.json");
}

function profileDir(messagingOrgIdValue: string) {
  return path.join(orgDir(messagingOrgIdValue), "sms_compliance_profiles");
}

function profilePath(messagingOrgIdValue: string, profileId: string) {
  return path.join(profileDir(messagingOrgIdValue), `${sanitizeId(profileId, "sms_compliance_profile_id")}.json`);
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, content);
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) throw error;
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw notFound("messaging_record_not_found", "The requested messaging record was not found.");
    }
    throw error;
  }
}

export async function ensureMessagingStorage() {
  await mkdir(orgsRoot(), { recursive: true });
  getCommunicationsDatabase();
}

function parseStored<T>(value: unknown): T {
  return transformSensitiveFields(JSON.parse(String(value || "{}")), decryptSensitive) as T;
}

function encryptionKey() {
  return env.messagingEncryptionKey ? createHash("sha256").update(env.messagingEncryptionKey).digest() : null;
}

function encryptSensitive(value: unknown) {
  const plaintext = cleanText(value);
  const key = encryptionKey();
  if (!plaintext || !key || plaintext.startsWith("enc:v1:")) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSensitive(value: unknown) {
  const encoded = cleanText(value);
  if (!encoded.startsWith("enc:v1:")) return encoded;
  const key = encryptionKey();
  if (!key) throw new Error("MESSAGING_ENCRYPTION_KEY is required to read encrypted messaging compliance data.");
  const [, , ivValue, tagValue, dataValue] = encoded.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue || "", "base64"));
  decipher.setAuthTag(Buffer.from(tagValue || "", "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataValue || "", "base64")), decipher.final()]).toString("utf8");
}

function profileForPersistence(profile: SmsComplianceProfile) {
  return transformSensitiveFields(JSON.parse(JSON.stringify(profile)), encryptSensitive) as SmsComplianceProfile;
}

function transformSensitiveFields(value: unknown, transform: (value: unknown) => string): unknown {
  if (Array.isArray(value)) return value.map((entry) => transformSensitiveFields(entry, transform));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, entry]) => [
    key,
    ["ein", "tax_id", "taxId"].includes(key) ? transform(entry) : transformSensitiveFields(entry, transform)
  ]));
}

function organizationFromRow(row: unknown) {
  const value = asObject(row);
  return parseStored<MessagingOrganization>(value.data_json);
}

function profileFromRow(row: unknown) {
  const value = asObject(row);
  return parseStored<SmsComplianceProfile>(value.data_json);
}

async function persistOrganization(organization: MessagingOrganization) {
  (await getCommunicationsDatabase().prepare(`INSERT INTO messaging_organizations (
    id, external_organization_id, data_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    external_organization_id = excluded.external_organization_id,
    data_json = excluded.data_json,
    updated_at = excluded.updated_at`)
    .run(organization.id, organization.external_organization_id, JSON.stringify(organization), organization.created_at, organization.updated_at));
}

async function persistProfile(profile: SmsComplianceProfile) {
  const stored = profileForPersistence(profile);
  (await getCommunicationsDatabase().prepare(`INSERT INTO sms_compliance_profiles (
    id, messaging_organization_id, external_organization_id, data_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    messaging_organization_id = excluded.messaging_organization_id,
    external_organization_id = excluded.external_organization_id,
    data_json = excluded.data_json,
    updated_at = excluded.updated_at`)
    .run(profile.id, profile.messaging_organization_id, profile.external_organization_id, JSON.stringify(stored), profile.created_at, profile.updated_at));
}

export async function ensureMessagingOrganization(externalOrganizationIdValue: string) {
  return (await getCommunicationsDatabase().transaction(async () => {
  await ensureMessagingStorage();
  const externalOrganizationId = sanitizeId(externalOrganizationIdValue, "organization_id");
  const id = messagingOrgId(externalOrganizationId);
  const row = (await getCommunicationsDatabase().prepare("SELECT data_json FROM messaging_organizations WHERE id = ?").get(id));
  if (row) return organizationFromRow(row);
  const filePath = orgPath(id);
  if (await pathExists(filePath)) {
    const legacy = await readJson<MessagingOrganization>(filePath);
    (await persistOrganization(legacy));
    return legacy;
  }
  const now = nowIso();
  const organization: MessagingOrganization = {
    schema_version: 1,
    id,
    external_organization_id: externalOrganizationId,
    provider: "telnyx",
    status: "active",
    default_sms_compliance_profile_id: "",
    created_at: now,
    updated_at: now,
    metadata: {}
  };
  (await persistOrganization(organization));
  return organization;

  }));
}

export async function saveMessagingOrganization(organization: MessagingOrganization) {
  const next = { ...organization, updated_at: nowIso() };
  (await persistOrganization(next));
  return next;
}

export async function setDefaultSmsComplianceProfile(profile: SmsComplianceProfile) {
  return (await withCommunicationsTransaction(async () => {
    const row = (await getCommunicationsDatabase().prepare("SELECT data_json FROM messaging_organizations WHERE id = ?").get(profile.messaging_organization_id));
    if (!row) throw notFound("messaging_organization_not_found", "The messaging organization was not found.");
    const organization = organizationFromRow(row);
    const next = { ...organization, default_sms_compliance_profile_id: profile.id, updated_at: nowIso() };
    (await persistOrganization(next));
    return next;
  }));
}

export async function listSmsComplianceProfiles(messagingOrganizationId: string) {
  await ensureMessagingStorage();
  let rows = (await getCommunicationsDatabase().prepare("SELECT data_json FROM sms_compliance_profiles WHERE messaging_organization_id = ? ORDER BY updated_at DESC").all(messagingOrganizationId));
  if (!rows.length) {
    const root = profileDir(messagingOrganizationId);
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try { (await persistProfile(await readJson<SmsComplianceProfile>(path.join(root, entry.name)))); } catch { /* Ignore incomplete legacy files. */ }
    }
    rows = (await getCommunicationsDatabase().prepare("SELECT data_json FROM sms_compliance_profiles WHERE messaging_organization_id = ? ORDER BY updated_at DESC").all(messagingOrganizationId));
  }
  const profiles = rows.map(profileFromRow);
  return profiles.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function readSmsComplianceProfile(messagingOrganizationId: string, profileId: string) {
  await ensureMessagingStorage();
  const row = (await getCommunicationsDatabase().prepare("SELECT data_json FROM sms_compliance_profiles WHERE messaging_organization_id = ? AND id = ?")
    .get(messagingOrganizationId, sanitizeId(profileId, "sms_compliance_profile_id")));
  if (row) return profileFromRow(row);
  const legacyPath = profilePath(messagingOrganizationId, profileId);
  if (await pathExists(legacyPath)) {
    const legacy = await readJson<SmsComplianceProfile>(legacyPath);
    (await persistProfile(legacy));
    return legacy;
  }
  throw notFound("messaging_record_not_found", "The requested messaging record was not found.");
}

export async function findSmsComplianceProfileByProviderReference(reference: string, providerReferenceKeys: readonly string[] = []) {
  const target = cleanText(reference);
  if (!target) return null;
  await ensureMessagingStorage();
  const rows = (await getCommunicationsDatabase().prepare("SELECT data_json FROM sms_compliance_profiles").all());
  for (const row of rows) {
    const profile = profileFromRow(row);
    const references = asObject(profile.provider_refs);
    const matchesProviderReference = providerReferenceKeys.length
      ? providerReferenceKeys.some((key) => cleanText(references[key]) === target)
      : Object.values(references).some((value) => cleanText(value) === target);
    if (matchesProviderReference) return profile;
    if (!providerReferenceKeys.length && cleanText(asObject(profile.campaign).selectedNumber) === target) return profile;
  }
  return null;
}

export async function createSmsComplianceProfile(messagingOrganization: MessagingOrganization, input: JsonObject = {}) {
  const now = nowIso();
  const profileId = sanitizeId(input.id || `sms_profile_${randomBytes(8).toString("hex")}`, "sms_compliance_profile_id");
  const profile: SmsComplianceProfile = {
    schema_version: 1,
    id: profileId,
    messaging_organization_id: messagingOrganization.id,
    external_organization_id: messagingOrganization.external_organization_id,
    provider: "telnyx",
    status: "draft",
    brand_status: "draft",
    campaign_status: "draft",
    autoresponse_state: {
      status: "pending",
      desired_hash: "",
      applied_hash: "",
      messaging_profile_id: "",
      config_ids: {}
    },
    brand: asObject(input.brand),
    campaign: asObject(input.campaign),
    provider_refs: asObject(input.provider_refs),
    validation: {},
    events: [{
      type: "profile_created",
      at: now,
      actor: asObject(input.actor),
      source: "messaging_api"
    }],
    created_at: now,
    updated_at: now
  };
  (await withCommunicationsTransaction(async () => {
    (await persistProfile(profile));
    if (!messagingOrganization.default_sms_compliance_profile_id) {
      const nextOrganization = { ...messagingOrganization, default_sms_compliance_profile_id: profile.id, updated_at: now };
      (await persistOrganization(nextOrganization));
    }
  }));
  return profile;
}

export async function updateSmsComplianceProfile(profile: SmsComplianceProfile, patch: JsonObject = {}) {
  const row = (await getCommunicationsDatabase().prepare("SELECT data_json FROM sms_compliance_profiles WHERE messaging_organization_id = ? AND id = ?")
    .get(profile.messaging_organization_id, profile.id));
  const current = row ? profileFromRow(row) : profile;
  const next: SmsComplianceProfile = {
    ...current,
    ...asObject(patch),
    brand: Object.prototype.hasOwnProperty.call(patch, "brand") ? asObject(patch.brand) : current.brand,
    campaign: Object.prototype.hasOwnProperty.call(patch, "campaign") ? asObject(patch.campaign) : current.campaign,
    provider_refs: {
      ...asObject(current.provider_refs),
      ...asObject(patch.provider_refs)
    },
    validation: Object.prototype.hasOwnProperty.call(patch, "validation") ? asObject(patch.validation) : current.validation,
    events: Array.isArray(patch.events) ? patch.events.map(asObject) : current.events,
    updated_at: nowIso()
  };
  (await persistProfile(next));
  return next;
}

export async function appendSmsComplianceEvent(profile: SmsComplianceProfile, event: JsonObject, patch: JsonObject = {}) {
  return (await withCommunicationsTransaction(async () => {
    const row = (await getCommunicationsDatabase().prepare("SELECT data_json FROM sms_compliance_profiles WHERE messaging_organization_id = ? AND id = ?")
      .get(profile.messaging_organization_id, profile.id));
    const current = row ? profileFromRow(row) : profile;
    const events = [...current.events, { ...event, at: String(event.at || nowIso()) }];
    const now = nowIso();
    const next: SmsComplianceProfile = {
      ...current,
      ...asObject(patch),
      brand: Object.prototype.hasOwnProperty.call(patch, "brand") ? asObject(patch.brand) : current.brand,
      campaign: Object.prototype.hasOwnProperty.call(patch, "campaign") ? asObject(patch.campaign) : current.campaign,
      provider_refs: { ...asObject(current.provider_refs), ...asObject(patch.provider_refs) },
      validation: Object.prototype.hasOwnProperty.call(patch, "validation") ? asObject(patch.validation) : current.validation,
      events,
      updated_at: now
    };
    (await persistProfile(next));
    return next;
  }));
}

/**
 * Commits a provider operation, its profile reference/state, and any local
 * metering side effects in one shared transaction. A provider may already
 * have accepted a chargeable request when this runs, so exposing a succeeded
 * operation before its profile reference is durable would allow a retry to
 * create a second resource.
 */
export async function commitSmsComplianceProviderSuccess(
  profile: SmsComplianceProfile,
  input: {
    operation_id: string;
    provider_id: string;
    operation_response: JsonObject;
    event: JsonObject;
    patch: JsonObject;
    side_effect?: (saved: SmsComplianceProfile) => void | Promise<void>;
  }
) {
  return (await withCommunicationsTransaction(async () => {
    const db = getCommunicationsDatabase();
    const operation = (await db.prepare(`SELECT * FROM messaging_provider_operations
      WHERE id = ? AND organization_id = ? AND compliance_profile_id = ? LIMIT 1`)
      .get(input.operation_id, profile.external_organization_id, profile.id)) as Record<string, unknown> | undefined;
    if (!operation) throw new Error("The provider operation no longer belongs to this SMS compliance profile.");
    const operationStatus = String(operation.status || "").trim();
    if (!["pending", "outcome_unknown", "succeeded"].includes(operationStatus)) {
      throw new Error(`The provider operation cannot be committed from status ${operationStatus || "unknown"}.`);
    }
    const existingProviderId = String(operation.provider_id || "").trim();
    if (operationStatus === "succeeded" && existingProviderId && existingProviderId !== input.provider_id) {
      throw new Error("The provider operation is already committed to a different provider resource.");
    }

    const row = (await db.prepare("SELECT data_json FROM sms_compliance_profiles WHERE messaging_organization_id = ? AND id = ?")
      .get(profile.messaging_organization_id, profile.id));
    const current = row ? profileFromRow(row) : profile;
    const patch = asObject(input.patch);
    const event = asObject(input.event);
    const now = nowIso();
    const next: SmsComplianceProfile = {
      ...current,
      ...patch,
      brand: Object.prototype.hasOwnProperty.call(patch, "brand") ? asObject(patch.brand) : current.brand,
      campaign: Object.prototype.hasOwnProperty.call(patch, "campaign") ? asObject(patch.campaign) : current.campaign,
      provider_refs: { ...asObject(current.provider_refs), ...asObject(patch.provider_refs) },
      validation: Object.prototype.hasOwnProperty.call(patch, "validation") ? asObject(patch.validation) : current.validation,
      events: [...current.events, { ...event, at: String(event.at || now) }],
      updated_at: now
    };

    (await db.prepare(`UPDATE messaging_provider_operations SET status = 'succeeded', provider_id = ?,
      response_json = ?, error_json = '{}', updated_at = ? WHERE id = ?`)
      .run(input.provider_id, JSON.stringify(input.operation_response || {}), now, input.operation_id));
    (await persistProfile(next));
    await input.side_effect?.(next);
    return next;
  }));
}

export type SmsComplianceAtomicMutation<T> = {
  event?: JsonObject;
  patch?: JsonObject;
  result: T;
};

/**
 * Reloads and mutates a compliance profile within the shared storage transaction.
 * Reducers may await SQL operations in this store, but must not call providers.
 */
export async function mutateSmsComplianceProfileAtomically<T>(
  profile: SmsComplianceProfile,
  reducer: (current: SmsComplianceProfile) => SmsComplianceAtomicMutation<T> | Promise<SmsComplianceAtomicMutation<T>>
) {
  return (await withCommunicationsTransaction(async () => {
    const row = (await getCommunicationsDatabase().prepare("SELECT data_json FROM sms_compliance_profiles WHERE messaging_organization_id = ? AND id = ?")
      .get(profile.messaging_organization_id, profile.id));
    const current = row ? profileFromRow(row) : profile;
    const mutation = await reducer(current);
    if (!mutation.event) return { profile: current, result: mutation.result };

    const patch = asObject(mutation.patch);
    const event = asObject(mutation.event);
    const events = [...current.events, { ...event, at: String(event.at || nowIso()) }];
    const next: SmsComplianceProfile = {
      ...current,
      ...patch,
      brand: Object.prototype.hasOwnProperty.call(patch, "brand") ? asObject(patch.brand) : current.brand,
      campaign: Object.prototype.hasOwnProperty.call(patch, "campaign") ? asObject(patch.campaign) : current.campaign,
      provider_refs: { ...asObject(current.provider_refs), ...asObject(patch.provider_refs) },
      validation: Object.prototype.hasOwnProperty.call(patch, "validation") ? asObject(patch.validation) : current.validation,
      events,
      updated_at: nowIso()
    };
    (await persistProfile(next));
    return { profile: next, result: mutation.result };
  }));
}

export function publicMessagingOrganization(organization: MessagingOrganization) {
  return { ...organization };
}

export function publicSmsComplianceProfile(profile: SmsComplianceProfile) {
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as JsonObject).map(([key, entry]) => [
      key,
      ["ein", "tax_id", "taxId"].includes(key) ? (cleanText(entry) ? `***${cleanText(entry).replace(/\D/g, "").slice(-4)}` : "") : redact(entry)
    ]));
  };
  return { ...profile, brand: redact(profile.brand) as JsonObject, events: redact(profile.events) as JsonObject[] };
}
