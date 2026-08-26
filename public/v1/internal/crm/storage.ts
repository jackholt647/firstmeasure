import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../../src/config/env.js";
import { badRequest, notFound } from "../../platform/errors.js";

export type JsonObject = Record<string, unknown>;

export const CRM_COLLECTIONS = [
  "leads",
  "lead_lists",
  "pipeline",
  "sequences",
  "communications",
  "settings",
  "territories",
  "imports",
  "commissions",
  "referral_partners",
  "referral_rewards",
  "call_scripts",
  "sample_reports"
] as const;

export type CrmCollection = typeof CRM_COLLECTIONS[number];

const CRM_SCHEMA_VERSION = 1;

export type CrmDocument = JsonObject & {
  schema_version: number;
  id: string;
  scope: "global" | "organization";
  organization_id: string | null;
  collection: CrmCollection;
  data: JsonObject;
  metadata: JsonObject;
  revision: number;
  created_at: string;
  updated_at: string;
};

function storageRoot() {
  return path.resolve(process.cwd(), process.env.CRM_STORAGE_ROOT ?? env.crmStorageRoot);
}

function globalRoot() {
  return path.join(storageRoot(), "global");
}

function orgRoot(orgId: string) {
  return path.join(storageRoot(), "organizations", sanitizeId(orgId, "organization_id"));
}

function collectionRoot(scope: "global" | "organization", collection: CrmCollection, orgId?: string) {
  return scope === "global"
    ? path.join(globalRoot(), collection)
    : path.join(orgRoot(orgId || ""), collection);
}

function documentPath(scope: "global" | "organization", collection: CrmCollection, documentId: string, orgId?: string) {
  return path.join(collectionRoot(scope, collection, orgId), `${sanitizeId(documentId, "document_id")}.json`);
}

function sanitizeId(value: unknown, label = "id") {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned) throw badRequest(`invalid_${label}`, `${label} must contain at least one letter or number.`);
  return cleaned;
}

function generateId(collection: CrmCollection) {
  const prefix = collection.endsWith("s") ? collection.slice(0, -1) : collection;
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function assertCollection(value: string): CrmCollection {
  const normalized = sanitizeId(value, "collection");
  if (CRM_COLLECTIONS.includes(normalized as CrmCollection)) return normalized as CrmCollection;
  throw badRequest("invalid_crm_collection", `CRM collection must be one of ${CRM_COLLECTIONS.join(", ")}.`);
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) throw error;
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw notFound("crm_document_not_found", "The requested CRM record was not found.");
    }
    throw error;
  }
}

export async function ensureCrmStorage() {
  await mkdir(globalRoot(), { recursive: true });
  await mkdir(path.join(storageRoot(), "organizations"), { recursive: true });
  for (const collection of CRM_COLLECTIONS) {
    await mkdir(collectionRoot("global", collection), { recursive: true });
  }
}

export async function listCrmDocuments(scope: "global" | "organization", collectionValue: string, orgId?: string) {
  await ensureCrmStorage();
  const collection = assertCollection(collectionValue);
  const root = collectionRoot(scope, collection, orgId);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const documents: CrmDocument[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      documents.push(await readJsonFile<CrmDocument>(path.join(root, entry.name)));
    } catch {
      // Incomplete draft records should not break list endpoints.
    }
  }
  return documents.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function readCrmDocument(scope: "global" | "organization", collectionValue: string, documentId: string, orgId?: string) {
  await ensureCrmStorage();
  const collection = assertCollection(collectionValue);
  return await readJsonFile<CrmDocument>(documentPath(scope, collection, documentId, orgId));
}

export async function upsertCrmDocument(
  scope: "global" | "organization",
  collectionValue: string,
  input: JsonObject = {},
  options: { replace?: boolean; orgId?: string } = {}
) {
  await ensureCrmStorage();
  const collection = assertCollection(collectionValue);
  const id = input.id ? sanitizeId(input.id, "document_id") : generateId(collection);
  const filePath = documentPath(scope, collection, id, options.orgId);
  const exists = await pathExists(filePath);
  const now = nowIso();
  const data = asObject(input.data ?? input);
  delete data.id;
  delete data.metadata;
  delete data.expected_revision;
  const metadata = asObject(input.metadata);
  const expectedRevision = Number(input.expected_revision ?? 0);

  const current = exists ? await readJsonFile<CrmDocument>(filePath) : null;
  if (current && expectedRevision && expectedRevision !== Number(current.revision ?? 0)) {
    throw badRequest("crm_revision_conflict", "CRM record revision does not match.");
  }

  const document: CrmDocument = current
    ? {
        ...current,
        data: options.replace ? data : { ...asObject(current.data), ...data },
        metadata: options.replace ? metadata : { ...asObject(current.metadata), ...metadata },
        revision: Number(current.revision ?? 0) + 1,
        updated_at: now
      }
    : {
        schema_version: CRM_SCHEMA_VERSION,
        id,
        scope,
        organization_id: scope === "organization" ? sanitizeId(options.orgId, "organization_id") : null,
        collection,
        data,
        metadata,
        revision: 1,
        created_at: now,
        updated_at: now
      };

  await writeJsonAtomic(filePath, document);
  return document;
}

export async function deleteCrmDocument(scope: "global" | "organization", collectionValue: string, documentId: string, orgId?: string) {
  const existing = await readCrmDocument(scope, collectionValue, documentId, orgId);
  await rm(documentPath(scope, assertCollection(collectionValue), documentId, orgId), { force: true });
  return existing;
}
