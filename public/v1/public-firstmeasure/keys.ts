import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyRequest } from "fastify";

import { readGlobal, readOrganization } from "../platform/storage.js";
import { forbidden, notFound, unauthorized } from "../platform/errors.js";
import { publicFirstMeasureApiKeySecret, publicFirstMeasureKeyRoot } from "./key_material.js";
import {
  deletePublicFirstMeasureApiKeySecret,
  storePublicFirstMeasureApiKeySecret
} from "./key_secret_vault.js";
import { asObject, cleanText, normalizeId } from "./util.js";
import { withPublicFirstMeasureLock } from "./locks.js";

export const PUBLIC_FIRSTMEASURE_KEY_SCOPES = [
  "firstmeasure:reports:create",
  "firstmeasure:reports:read",
  "firstmeasure:pdfs:read",
  "firstmeasure:pdfs:write",
  "firstmeasure:measurements:read",
  "firstmeasure:files:read",
  "firstmeasure:billing:read"
] as const;

export type PublicFirstMeasureScope = (typeof PUBLIC_FIRSTMEASURE_KEY_SCOPES)[number];

export type PublicFirstMeasureApiKeyRecord = {
  schema_version: 1;
  key_id: string;
  org_id: string;
  name: string;
  mode: "test" | "live";
  status: "active" | "revoked";
  scopes: PublicFirstMeasureScope[];
  secret_hash: string;
  key_prefix: string;
  last4: string;
  created_at: string;
  created_by: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  metadata: Record<string, unknown>;
};

export type PublicFirstMeasureAuthContext = {
  orgId: string;
  keyId: string;
  keyName: string;
  mode: "test" | "live";
  scopes: PublicFirstMeasureScope[];
  actor: {
    id: string;
    email: string;
    name: string;
    organization_id: string;
    roles: string[];
  };
};

const DEFAULT_SCOPES: PublicFirstMeasureScope[] = [
  "firstmeasure:reports:create",
  "firstmeasure:reports:read",
  "firstmeasure:pdfs:read",
  "firstmeasure:pdfs:write",
  "firstmeasure:measurements:read",
  "firstmeasure:files:read",
  "firstmeasure:billing:read"
];

function keyPath(keyId: string) {
  return path.join(publicFirstMeasureKeyRoot(), `${normalizeKeyId(keyId)}.json`);
}

function normalizeKeyId(value: unknown) {
  const text = cleanText(value);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(text)) {
    throw unauthorized("invalid_api_key", "The API key is invalid.");
  }
  return text;
}

function hashSecret(keyId: string, secret: string) {
  return `hmac_sha256:${createHmac("sha256", publicFirstMeasureApiKeySecret()).update(`${keyId}.${secret}`).digest("hex")}`;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2));
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export function parsePublicFirstMeasureApiKey(value: string) {
  const parts = cleanText(value).split("_");
  if (parts.length < 4 || parts[0] !== "fmk") return null;
  const mode = parts[1];
  const keyId = parts[2];
  const secret = parts.slice(3).join("_");
  if ((mode !== "test" && mode !== "live") || !keyId || !/^[A-Za-z0-9-]{8,64}$/.test(keyId) || !/^[A-Za-z0-9_-]{24,}$/.test(secret)) return null;
  return {
    mode,
    keyId,
    secret
  };
}

export async function readPublicFirstMeasureApiKey(keyId: string) {
  const raw = await readFile(keyPath(keyId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw unauthorized("invalid_api_key", "The API key is invalid.");
    throw error;
  });
  return JSON.parse(raw) as PublicFirstMeasureApiKeyRecord;
}

export async function listPublicFirstMeasureApiKeys(orgId?: string) {
  await mkdir(publicFirstMeasureKeyRoot(), { recursive: true });
  const entries = await readdir(publicFirstMeasureKeyRoot(), { withFileTypes: true });
  const records: PublicFirstMeasureApiKeyRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(path.join(publicFirstMeasureKeyRoot(), entry.name), "utf8")) as PublicFirstMeasureApiKeyRecord;
      if (!orgId || record.org_id === orgId) records.push(record);
    } catch {
      // Ignore unreadable key records so one damaged record does not hide the rest.
    }
  }
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createPublicFirstMeasureApiKey(input: {
  orgId: string;
  name?: string;
  mode?: "test" | "live";
  createdBy?: string | null;
  expiresAt?: string | null;
  scopes?: PublicFirstMeasureScope[];
  requireBilling?: boolean;
  metadata?: Record<string, unknown>;
}) {
  const orgId = normalizeId(input.orgId, "organization_id");
  const mode = input.mode ?? "live";
  await assertOrganizationIsActive(orgId);
  if (mode === "live" && input.requireBilling !== false) {
    await assertOrganizationCanUsePublicFirstMeasureApi(orgId);
  }

  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const fullKey = `fmk_${mode}_${keyId}_${secret}`;
  const now = new Date().toISOString();
  const record: PublicFirstMeasureApiKeyRecord = {
    schema_version: 1,
    key_id: keyId,
    org_id: orgId,
    name: cleanText(input.name) || "FirstMeasure API key",
    mode,
    status: "active",
    scopes: input.scopes?.length ? input.scopes : DEFAULT_SCOPES,
    secret_hash: hashSecret(keyId, secret),
    key_prefix: `fmk_${mode}_${keyId}`,
    last4: fullKey.slice(-4),
    created_at: now,
    created_by: cleanText(input.createdBy) || null,
    expires_at: cleanText(input.expiresAt) || null,
    last_used_at: null,
    revoked_at: null,
    metadata: asObject(input.metadata)
  };
  await storePublicFirstMeasureApiKeySecret(keyId, fullKey);
  try {
    await writeJsonAtomic(keyPath(keyId), record);
  } catch (error) {
    await deletePublicFirstMeasureApiKeySecret(keyId).catch(() => undefined);
    throw error;
  }
  return { key: fullKey, record };
}

export async function revokePublicFirstMeasureApiKey(keyId: string) {
  const normalizedKeyId = normalizeKeyId(keyId);
  return withPublicFirstMeasureLock(`key:${normalizedKeyId}`, async () => {
    return withPublicFirstMeasureLock(`key-delivery:${normalizedKeyId}`, async () => {
      const record = await readPublicFirstMeasureApiKey(normalizedKeyId);
      const next: PublicFirstMeasureApiKeyRecord = {
        ...record,
        status: "revoked",
        revoked_at: record.revoked_at ?? new Date().toISOString()
      };
      await writeJsonAtomic(keyPath(normalizedKeyId), next);
      await deletePublicFirstMeasureApiKeySecret(normalizedKeyId);
      return next;
    });
  });
}

export async function authenticatePublicFirstMeasureRequest(request: FastifyRequest): Promise<PublicFirstMeasureAuthContext> {
  const header = cleanText(request.headers.authorization);
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const parsed = parsePublicFirstMeasureApiKey(token);
  if (!parsed) throw unauthorized("missing_api_key", "A valid Bearer API key is required.");

  const record = await withPublicFirstMeasureLock(`key:${parsed.keyId}`, async () => {
    const current = await readPublicFirstMeasureApiKey(parsed.keyId);
    if (current.status !== "active") throw forbidden("api_key_revoked", "This API key has been revoked.");
    const expiresAt = cleanText(current.expires_at);
    const expiresTime = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isFinite(expiresTime) && expiresTime <= Date.now()) {
      throw forbidden("api_key_expired", "This API key has expired.");
    }
    if (current.mode !== parsed.mode) throw unauthorized("invalid_api_key", "The API key is invalid.");
    const expected = Buffer.from(current.secret_hash);
    const actual = Buffer.from(hashSecret(parsed.keyId, parsed.secret));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw unauthorized("invalid_api_key", "The API key is invalid.");
    }

    const lastUsedTime = Date.parse(cleanText(current.last_used_at));
    if (!Number.isFinite(lastUsedTime) || Date.now() - lastUsedTime >= 60_000) {
      const updated = { ...current, last_used_at: new Date().toISOString() };
      await writeJsonAtomic(keyPath(current.key_id), updated);
      return updated;
    }
    return current;
  });

  await assertOrganizationIsActive(record.org_id);
  if (record.mode === "live") await assertOrganizationCanUsePublicFirstMeasureApi(record.org_id);
  return {
    orgId: record.org_id,
    keyId: record.key_id,
    keyName: record.name,
    mode: record.mode,
    scopes: record.scopes,
    actor: {
      id: `api_key:${record.key_id}`,
      email: `api+${record.key_id.toLowerCase()}@firstmeasure.internal`,
      name: record.name,
      organization_id: record.org_id,
      roles: ["api"]
    }
  };
}

export function requirePublicFirstMeasureScope(ctx: PublicFirstMeasureAuthContext, scope: PublicFirstMeasureScope) {
  if (!ctx.scopes.includes(scope)) {
    throw forbidden("scope_required", `This API key does not include '${scope}'.`);
  }
}

export async function assertOrganizationIsActive(orgId: string) {
  const organization = await readOrganization(orgId).catch((error: unknown) => {
    throw error instanceof Error ? notFound("organization_not_found", "The API key organization was not found.") : error;
  });
  const status = cleanText(asObject(organization).status || "active").toLowerCase();
  if (["disabled", "inactive", "deleted", "suspended"].includes(status)) {
    throw forbidden("organization_inactive", "The API key organization is not active.");
  }
}

export async function assertOrganizationCanUsePublicFirstMeasureApi(orgId: string) {
  await assertOrganizationIsActive(orgId);
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const billing = asObject(data.billing);
  const stripe = asObject(billing.stripe);
  const credits = Number(data.credits_balance ?? 0);
  const hasPaymentMethod = stripe.has_payment_method === true && cleanText(stripe.payment_method_id);
  if (!hasPaymentMethod && !(Number.isFinite(credits) && credits > 0)) {
    throw forbidden("billing_required", "This organization needs credits or a saved payment method before API keys can be used.");
  }
}
