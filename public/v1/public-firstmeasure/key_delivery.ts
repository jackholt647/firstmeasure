import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PlatformError, conflict, notFound } from "../platform/errors.js";
import { readPublicFirstMeasureApiKey } from "./keys.js";
import { publicFirstMeasureApiKeySecret, publicFirstMeasureKeyRoot } from "./key_material.js";
import { readPublicFirstMeasureApiKeySecret } from "./key_secret_vault.js";
import { withPublicFirstMeasureLock } from "./locks.js";
import { cleanText } from "./util.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { listSharedDocuments, readSharedDocument, replaceSharedDocument } from "../src/database/shared_documents.js";

export const DEFAULT_PUBLIC_FIRSTMEASURE_DELIVERY_TTL_HOURS = 72;
export const MAX_PUBLIC_FIRSTMEASURE_DELIVERY_TTL_HOURS = 24 * 7;

type PublicFirstMeasureKeyDeliveryRecord = {
  schema_version: 1;
  delivery_id: string;
  key_id: string;
  org_id: string;
  token_hash: string;
  created_at: string;
  created_by: string | null;
  expires_at: string;
  consumed_at: string | null;
  superseded_at: string | null;
};

function deliveryRoot() {
  return path.join(publicFirstMeasureKeyRoot(), ".deliveries");
}

function normalizeDeliveryId(value: string) {
  const deliveryId = cleanText(value);
  if (!/^[a-f0-9]{20}$/.test(deliveryId)) {
    throw notFound("key_delivery_unavailable", "This API key delivery link is invalid, expired, or already used.");
  }
  return deliveryId;
}

function deliveryPath(deliveryId: string) {
  return path.join(deliveryRoot(), `${normalizeDeliveryId(deliveryId)}.json`);
}

function deliveryTokenHash(deliveryId: string, secret: string) {
  return `hmac_sha256:${createHmac("sha256", publicFirstMeasureApiKeySecret())
    .update(`firstmeasure-key-delivery-v1:${deliveryId}.${secret}`)
    .digest("hex")}`;
}

function parseDeliveryToken(value: unknown) {
  const parts = cleanText(value).split("_");
  const secret = parts.slice(2).join("_");
  if (parts.length < 3 || parts[0] !== "fmd" || !/^[a-f0-9]{20}$/.test(parts[1] || "") || !/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
    throw notFound("key_delivery_unavailable", "This API key delivery link is invalid, expired, or already used.");
  }
  return { deliveryId: parts[1] as string, secret };
}

function safeHashEquals(left: string, right: string) {
  const expected = Buffer.from(left);
  const actual = Buffer.from(right);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readDeliveryRecord(deliveryId: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const record = await readSharedDocument<PublicFirstMeasureKeyDeliveryRecord>({ namespace: "public_firstmeasure", collection: "key_deliveries", id: normalizeDeliveryId(deliveryId) });
    if (!record) throw notFound("key_delivery_unavailable", "This API key delivery link is invalid, expired, or already used.");
    return record;
  }
  const raw = await readFile(deliveryPath(deliveryId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw notFound("key_delivery_unavailable", "This API key delivery link is invalid, expired, or already used.");
    throw error;
  });
  return JSON.parse(raw) as PublicFirstMeasureKeyDeliveryRecord;
}

async function listDeliveryRecords() {
  if (isFirstMeasurePostgresEnabled()) {
    return listSharedDocuments<PublicFirstMeasureKeyDeliveryRecord>({ namespace: "public_firstmeasure", collection: "key_deliveries" });
  }
  await mkdir(deliveryRoot(), { recursive: true });
  const entries = await readdir(deliveryRoot(), { withFileTypes: true });
  const records: PublicFirstMeasureKeyDeliveryRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await readFile(path.join(deliveryRoot(), entry.name), "utf8")) as PublicFirstMeasureKeyDeliveryRecord);
    } catch {
      // A damaged delivery record must not hide or block unrelated links.
    }
  }
  return records;
}

async function saveDeliveryRecord(record: PublicFirstMeasureKeyDeliveryRecord) {
  if (isFirstMeasurePostgresEnabled()) {
    await replaceSharedDocument({ namespace: "public_firstmeasure", collection: "key_deliveries", id: record.delivery_id }, record);
  } else {
    await writeJsonAtomic(deliveryPath(record.delivery_id), record);
  }
}

function normalizeTtlHours(value: unknown) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return DEFAULT_PUBLIC_FIRSTMEASURE_DELIVERY_TTL_HOURS;
  return Math.max(1, Math.min(MAX_PUBLIC_FIRSTMEASURE_DELIVERY_TTL_HOURS, parsed));
}

function deliveryUnavailable(statusCode = 410) {
  return new PlatformError(
    "key_delivery_unavailable",
    statusCode,
    "This API key delivery link is invalid, expired, or already used."
  );
}

export async function createPublicFirstMeasureKeyDelivery(input: {
  keyId: string;
  createdBy?: string | null;
  ttlHours?: unknown;
}) {
  const keyId = cleanText(input.keyId);
  return withPublicFirstMeasureLock(`key-delivery:${keyId}`, async () => {
    const keyRecord = await readPublicFirstMeasureApiKey(keyId);
    const expiresTime = Date.parse(cleanText(keyRecord.expires_at));
    if (keyRecord.status !== "active" || (Number.isFinite(expiresTime) && expiresTime <= Date.now())) {
      throw conflict("api_key_not_active", "Only an active, unexpired API key can receive a delivery link.");
    }

    const fullKey = await readPublicFirstMeasureApiKeySecret(keyId);
    if (!fullKey) {
      throw conflict(
        "api_key_secret_unavailable",
        "This key predates secure delivery links. Re-roll it once to create a shareable link."
      );
    }

    const now = new Date();
    const records = await listDeliveryRecords();
    await Promise.all(records
      .filter((record) => record.key_id === keyId && !record.consumed_at && !record.superseded_at)
      .map(async (record) => {
        const next = { ...record, superseded_at: now.toISOString() };
        await saveDeliveryRecord(next);
      }));

    const deliveryId = randomBytes(10).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const token = `fmd_${deliveryId}_${secret}`;
    const ttlHours = normalizeTtlHours(input.ttlHours);
    const record: PublicFirstMeasureKeyDeliveryRecord = {
      schema_version: 1,
      delivery_id: deliveryId,
      key_id: keyRecord.key_id,
      org_id: keyRecord.org_id,
      token_hash: deliveryTokenHash(deliveryId, secret),
      created_at: now.toISOString(),
      created_by: cleanText(input.createdBy) || null,
      expires_at: new Date(now.getTime() + ttlHours * 60 * 60_000).toISOString(),
      consumed_at: null,
      superseded_at: null
    };
    await saveDeliveryRecord(record);
    return {
      token,
      delivery: {
        delivery_id: record.delivery_id,
        key_id: record.key_id,
        key_prefix: keyRecord.key_prefix,
        key_name: keyRecord.name,
        mode: keyRecord.mode,
        created_at: record.created_at,
        expires_at: record.expires_at
      }
    };
  });
}

export async function revealPublicFirstMeasureKeyDelivery(tokenValue: unknown) {
  const token = parseDeliveryToken(tokenValue);
  const initialRecord = await readDeliveryRecord(token.deliveryId);
  return withPublicFirstMeasureLock(`key-delivery:${initialRecord.key_id}`, async () => {
    const record = await readDeliveryRecord(token.deliveryId);
    const actualHash = deliveryTokenHash(token.deliveryId, token.secret);
    if (!safeHashEquals(record.token_hash, actualHash)) throw deliveryUnavailable(404);
    if (record.consumed_at || record.superseded_at || Date.parse(record.expires_at) <= Date.now()) {
      throw deliveryUnavailable();
    }

    const keyRecord = await readPublicFirstMeasureApiKey(record.key_id).catch(() => null);
    const keyExpiresTime = Date.parse(cleanText(keyRecord?.expires_at));
    if (!keyRecord || keyRecord.status !== "active" || (Number.isFinite(keyExpiresTime) && keyExpiresTime <= Date.now())) {
      throw deliveryUnavailable();
    }
    const fullKey = await readPublicFirstMeasureApiKeySecret(record.key_id).catch(() => "");
    if (!fullKey) throw deliveryUnavailable();

    const next = { ...record, consumed_at: new Date().toISOString() };
    await saveDeliveryRecord(next);
    return {
      key: fullKey,
      key_id: keyRecord.key_id,
      key_prefix: keyRecord.key_prefix,
      key_name: keyRecord.name,
      mode: keyRecord.mode,
      key_expires_at: keyRecord.expires_at,
      revealed_at: next.consumed_at
    };
  });
}
