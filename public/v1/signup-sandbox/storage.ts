import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { deleteIdentity, deleteIdentitySessions, deleteOrganization, mutatePlatformConfiguration, readPlatformConfiguration, writeJsonAtomic } from "../platform/storage.js";
import { readFile } from "node:fs/promises";

export type JsonObject = Record<string, unknown>;

const SANDBOX_SCHEMA_VERSION = 1;

function sandboxRoot() {
  if (process.env.SIGNUP_SANDBOX_STORAGE_ROOT) return process.env.SIGNUP_SANDBOX_STORAGE_ROOT;
  // The deployed service cannot write to its immutable release directory.
  // Keep sandbox documents beside the platform's configured writable storage.
  return path.join(path.dirname(env.platformStorageRoot), "signup-sandbox");
}

function collectionRoot(collection: "workflows" | "pages" | "test_orgs") {
  return path.join(sandboxRoot(), collection);
}

function collectionConfigName(collection: "workflows" | "pages" | "test_orgs") {
  return `signup_sandbox_${collection}`;
}

function storedDocuments(config: JsonObject | null): Record<string, JsonObject> {
  const value = config?.documents;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonObject> : {};
}

export function sanitizeSandboxId(value: unknown, label: string) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(id)) {
    throw sandboxError(400, "invalid_id", `A valid ${label} is required.`);
  }
  return id;
}

export function generateSandboxId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function sandboxError(statusCode: number, code: string, message: string) {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function nowIso() {
  return new Date().toISOString();
}

async function ensureSandboxStorage() {
  await mkdir(collectionRoot("workflows"), { recursive: true });
  await mkdir(collectionRoot("pages"), { recursive: true });
  await mkdir(collectionRoot("test_orgs"), { recursive: true });
}

function documentPath(collection: "workflows" | "pages" | "test_orgs", id: string) {
  return path.join(collectionRoot(collection), `${sanitizeSandboxId(id, "document id")}.json`);
}

async function readJson(filePath: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as JsonObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listCollection(collection: "workflows" | "pages" | "test_orgs") {
  if (isFirstMeasurePostgresEnabled()) {
    const config = await readPlatformConfiguration(collectionConfigName(collection));
    return Object.values(storedDocuments(config)).sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  }
  await ensureSandboxStorage();
  const entries = await readdir(collectionRoot(collection));
  const documents: JsonObject[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const doc = await readJson(path.join(collectionRoot(collection), entry));
    if (doc) documents.push(doc);
  }
  return documents.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

async function saveDocument(collection: "workflows" | "pages" | "test_orgs", doc: JsonObject) {
  if (isFirstMeasurePostgresEnabled()) {
    const id = sanitizeSandboxId(doc.id, "document id");
    await mutatePlatformConfiguration(collectionConfigName(collection), (current) => ({
      documents: { ...storedDocuments(current), [id]: doc }
    }));
    return doc;
  }
  await ensureSandboxStorage();
  await writeJsonAtomic(documentPath(collection, String(doc.id)), doc);
  return doc;
}

async function deleteDocument(collection: "workflows" | "pages" | "test_orgs", id: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const cleanId = sanitizeSandboxId(id, "document id");
    await mutatePlatformConfiguration(collectionConfigName(collection), (current) => {
      const documents = { ...storedDocuments(current) };
      delete documents[cleanId];
      return { documents };
    });
    return;
  }
  await rm(documentPath(collection, id), { force: true });
}

async function readDocument(collection: "workflows" | "pages" | "test_orgs", id: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const config = await readPlatformConfiguration(collectionConfigName(collection));
    return storedDocuments(config)[sanitizeSandboxId(id, "document id")] ?? null;
  }
  return readJson(documentPath(collection, id));
}

export const sandboxStore = {
  schemaVersion: SANDBOX_SCHEMA_VERSION,
  listWorkflows: () => listCollection("workflows"),
  listPages: () => listCollection("pages"),
  listTestOrgs: () => listCollection("test_orgs"),
  readWorkflow: (id: string) => readDocument("workflows", id),
  readPage: (id: string) => readDocument("pages", id),
  readTestOrg: (id: string) => readDocument("test_orgs", id),
  saveWorkflow: (doc: JsonObject) => saveDocument("workflows", doc),
  savePage: (doc: JsonObject) => saveDocument("pages", doc),
  saveTestOrg: (doc: JsonObject) => saveDocument("test_orgs", doc),
  deleteWorkflow: (id: string) => deleteDocument("workflows", id),
  deletePage: (id: string) => deleteDocument("pages", id),
  deleteTestOrg: (id: string) => deleteDocument("test_orgs", id)
};

// ---- Platform storage cleanup for deleted test orgs ------------------------
// The platform module keeps these paths private, so the sandbox mirrors the
// same layout (organizations/<id>, identities/<id>.json, auth_index/email/<sha>,
// sessions/<sha>.json) strictly for best-effort deletion of sandbox-created data.

import { createHash } from "node:crypto";

function platformRoot() {
  return env.platformStorageRoot;
}

export async function removePlatformOrgData(input: { orgId: string; identityId: string; email: string }) {
  const orgId = sanitizeSandboxId(input.orgId, "organization id");
  const identityId = sanitizeSandboxId(input.identityId, "identity id");
  if (isFirstMeasurePostgresEnabled()) {
    await deleteIdentitySessions(identityId);
    await deleteOrganization(orgId);
    await deleteIdentity(identityId);
    return;
  }
  await rm(path.join(platformRoot(), "organizations", orgId), { recursive: true, force: true });
  await rm(path.join(platformRoot(), "identities", `${identityId}.json`), { force: true });
  const emailHash = createHash("sha256").update(String(input.email).trim().toLowerCase()).digest("hex");
  await rm(path.join(platformRoot(), "auth_index", "email", `${emailHash}.json`), { force: true });
  // Best-effort: drop any sessions that still point at the deleted org.
  try {
    const sessionsDir = path.join(platformRoot(), "sessions");
    for (const entry of await readdir(sessionsDir)) {
      if (!entry.endsWith(".json")) continue;
      const session = await readJson(path.join(sessionsDir, entry));
      if (session && (session.organization_id === orgId || session.identity_id === identityId)) {
        await rm(path.join(sessionsDir, entry), { force: true });
      }
    }
  } catch {
    // Session cleanup must never block test-org deletion.
  }
}
