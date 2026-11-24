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
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { deleteSharedDocument, listSharedDocuments, readSharedDocument, replaceSharedDocument } from "../src/database/shared_documents.js";

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
  if (isFirstMeasurePostgresEnabled()) {
    const record = await readSharedDocument<PublicFirstMeasureApiKeyRecord>({ namespace: "public_firstmeasure", collection: "api_keys", id: normalizeKeyId(keyId) });
    if (!record) throw unauthorized("invalid_api_key", "The API key is invalid.");
    return record;
  }
  const raw = await readFile(keyPath(keyId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw unauthorized("invalid_api_key", "The API key is invalid.");
    throw error;
  });
  return JSON.parse(raw) as PublicFirstMeasureApiKeyRecord;
}

export async function listPublicFirstMeasureApiKeys(orgId?: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const records = await listSharedDocuments<PublicFirstMeasureApiKeyRecord>({ namespace: "public_firstmeasure", collection: "api_keys" });
    return records.filter((record) => !orgId || record.org_id === orgId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
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
    if (isFirstMeasurePostgresEnabled()) {
      await replaceSharedDocument({ namespace: "public_firstmeasure", collection: "api_keys", id: keyId }, record);
    } else {
      await writeJsonAtomic(keyPath(keyId), record);
    }
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
      if (isFirstMeasurePostgresEnabled()) {
        await replaceSharedDocument({ namespace: "public_firstmeasure", collection: "api_keys", id: normalizedKeyId }, next);
      } else {
        await writeJsonAtomic(keyPath(normalizedKeyId), next);
      }
      await deletePublicFirstMeasureApiKeySecret(normalizedKeyId);
      return next;
    });
  });
}

// Share authentication between the commerce pre-handler and route without
// acquiring the API key lock twice. A new request always revalidates the key.
const requestAuthentication = new WeakMap<FastifyRequest, Promise<PublicFirstMeasureAuthContext>>();
export function authenticatePublicFirstMeasureRequest(request: FastifyRequest): Promise<PublicFirstMeasureAuthContext> {
  let pending = requestAuthentication.get(request);
  if (!pending) {
    pending = authenticateRequest(request);
    requestAuthentication.set(request, pending);
  }
  return pending;
}

const EXPECTED_AUTHORIZATION = "Authorization: Bearer fmk_live_...";

function headerText(value: unknown) {
  return cleanText(Array.isArray(value) ? value[0] : value);
}

function unquote(value: string) {
  return value.replace(/^["'`]+|["'`]+$/g, "").trim();
}

/** True when the request carries an API key header, so the key (not a session) names its organization. */
export function presentsPublicFirstMeasureApiKey(request: FastifyRequest) {
  return presentedPublicFirstMeasureApiKey(request).sent;
}

/**
 * The key a caller presented. `Authorization: Bearer <key>` is documented; integration tools
 * (Make, Zapier) often send `Authorization: <key>` or `X-API-Key: <key>` instead, so those are
 * read too (FM-633). A key in the URL is never accepted: URLs are logged.
 */
export function presentedPublicFirstMeasureApiKey(request: FastifyRequest) {
  const authorization = headerText(request.headers.authorization);
  const apiKeyHeader = headerText(request.headers["x-api-key"]);
  let token = unquote(authorization);
  let scheme = "";
  for (let i = 0; i < 2; i += 1) {
    const match = /^(bearer|token|api[-_ ]?key)\s*:?\s*([\s\S]*)$/i.exec(token);
    if (!match) break;
    scheme = match[1] ?? "";
    token = unquote(match[2] ?? "");
  }
  if (!scheme && /^[A-Za-z]+\s+\S/.test(token) && !/^fmk_/i.test(token)) scheme = token.split(/\s+/)[0] ?? "";
  if (apiKeyHeader && !/^fmk_/i.test(token)) {
    token = unquote(apiKeyHeader.replace(/^bearer\s*:?\s*/i, ""));
    scheme = "";
  }
  // A key has no whitespace: whitespace inside one is a copy-paste line break.
  token = token.replace(/\s+/g, "");
  return { token, scheme, sent: Boolean(authorization || apiKeyHeader) };
}

function missingApiKeyError(request: FastifyRequest, presented: ReturnType<typeof presentedPublicFirstMeasureApiKey>) {
  const error = (reason: string, message: string) => unauthorized("missing_api_key", message, { reason, expected: EXPECTED_AUTHORIZATION });
  if (!presented.token) {
    const keyInUrl = Object.entries(asObject(request.query)).some(([name, value]) =>
      /^(api[-_]?key|key|token|access[-_]?token|authorization)$/i.test(name) || /^(bearer\s+)?fmk_/i.test(headerText(value)));
    if (keyInUrl) return error("key_in_url", `API keys are not accepted in the URL. Send the key in a request header: ${EXPECTED_AUTHORIZATION}`);
    if (presented.sent) return error("empty_api_key", `The API key in the request is empty. Send the full API key: ${EXPECTED_AUTHORIZATION}`);
    return error("no_api_key", `No API key was sent. Send the full API key in the Authorization header: ${EXPECTED_AUTHORIZATION}`);
  }
  if (/^fmk_(test|live)_[A-Za-z0-9-]{8,64}_?$/.test(presented.token)) {
    return error("key_prefix_only", "This is only the key's prefix (fmk_<mode>_<key id>). Send the full API key, which continues after the prefix.");
  }
  if (presented.scheme && !/^(bearer|token|api[-_ ]?key)$/i.test(presented.scheme)) {
    return error("unsupported_scheme", `'${presented.scheme}' authorization is not supported. Send the API key as a Bearer token: ${EXPECTED_AUTHORIZATION}`);
  }
  if (!/^fmk_/i.test(presented.token)) {
    return error("not_an_api_key", `This is not a FirstMeasure API key (they start with fmk_test_ or fmk_live_). Send it as: ${EXPECTED_AUTHORIZATION}`);
  }
  return error("malformed_api_key", `The API key is incomplete or has extra characters. Copy the whole key and send it as: ${EXPECTED_AUTHORIZATION}`);
}

async function authenticateRequest(request: FastifyRequest): Promise<PublicFirstMeasureAuthContext> {
  const presented = presentedPublicFirstMeasureApiKey(request);
  const parsed = parsePublicFirstMeasureApiKey(presented.token);
  if (!parsed) throw missingApiKeyError(request, presented);

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
      if (isFirstMeasurePostgresEnabled()) {
        await replaceSharedDocument({ namespace: "public_firstmeasure", collection: "api_keys", id: current.key_id }, updated);
      } else {
        await writeJsonAtomic(keyPath(current.key_id), updated);
      }
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
