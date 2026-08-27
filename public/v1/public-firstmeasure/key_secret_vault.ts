import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { publicFirstMeasureApiKeySecret, publicFirstMeasureKeyRoot } from "./key_material.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { deleteSharedDocument, readSharedDocument, replaceSharedDocument } from "../src/database/shared_documents.js";

type SecretVaultRecord = {
  schema_version: 1;
  algorithm: "aes-256-gcm";
  key_id: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
  created_at: string;
};

function normalizeKeyId(value: string) {
  const keyId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(keyId)) throw new Error("Invalid API key id.");
  return keyId;
}

function vaultRoot() {
  return path.join(publicFirstMeasureKeyRoot(), ".secret-vault");
}

function vaultPath(keyId: string) {
  return path.join(vaultRoot(), `${normalizeKeyId(keyId)}.json`);
}

function encryptionKey() {
  return createHash("sha256")
    .update(`firstmeasure-api-key-delivery-v1:${publicFirstMeasureApiKeySecret()}`)
    .digest();
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function storePublicFirstMeasureApiKeySecret(keyId: string, fullKey: string) {
  const normalizedKeyId = normalizeKeyId(keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(fullKey, "utf8"), cipher.final()]);
  const record: SecretVaultRecord = {
    schema_version: 1,
    algorithm: "aes-256-gcm",
    key_id: normalizedKeyId,
    iv: iv.toString("base64url"),
    auth_tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    created_at: new Date().toISOString()
  };
  if (isFirstMeasurePostgresEnabled()) {
    await replaceSharedDocument({ namespace: "public_firstmeasure", collection: "key_secrets", id: normalizedKeyId }, record);
  } else {
    await writeJsonAtomic(vaultPath(normalizedKeyId), record);
  }
}

export async function readPublicFirstMeasureApiKeySecret(keyId: string) {
  const normalizedKeyId = normalizeKeyId(keyId);
  const record = isFirstMeasurePostgresEnabled()
    ? await readSharedDocument<SecretVaultRecord>({ namespace: "public_firstmeasure", collection: "key_secrets", id: normalizedKeyId })
    : await readFile(vaultPath(normalizedKeyId), "utf8").then((raw) => JSON.parse(raw) as SecretVaultRecord).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
  if (!record) return "";
  if (record.schema_version !== 1 || record.algorithm !== "aes-256-gcm" || record.key_id !== normalizedKeyId) {
    throw new Error("API key delivery vault record is invalid.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(record.auth_tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export async function hasPublicFirstMeasureApiKeySecret(keyId: string) {
  return Boolean(await readPublicFirstMeasureApiKeySecret(keyId).catch(() => ""));
}

export async function deletePublicFirstMeasureApiKeySecret(keyId: string) {
  if (isFirstMeasurePostgresEnabled()) {
    await deleteSharedDocument({ namespace: "public_firstmeasure", collection: "key_secrets", id: normalizeKeyId(keyId) });
    return;
  }
  await rm(vaultPath(keyId), { force: true });
}
