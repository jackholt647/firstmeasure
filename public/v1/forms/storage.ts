import { randomBytes } from "node:crypto";

import { PlatformError, notFound } from "../platform/errors.js";
import { deleteDocument, listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";

export const FORMS = "forms";
export const SUBMISSIONS = "form_submissions";

export type StoredRecord = JsonObject & { id: string; revision: number };

const view = (record: { id: string; data: JsonObject; revision: number }) => ({ ...record.data, id: record.id, revision: record.revision }) as StoredRecord;

export async function findRecord(orgId: string, collection: string, id: string): Promise<StoredRecord | null> {
  try {
    const record = await readDocument(orgId, collection, id);
    return record ? view(record) : null;
  } catch (error) {
    if (error instanceof PlatformError && error.statusCode === 404) return null;
    throw error;
  }
}

export async function readFormRecord(orgId: string, formId: string) {
  const record = await findRecord(orgId, FORMS, formId);
  if (!record) throw notFound("form_not_found", "This form was not found.");
  return record;
}

export async function saveRecord(orgId: string, collection: string, id: string, data: JsonObject, options: { expectedRevision?: number; createOnly?: boolean } = {}) {
  return view(await upsertDocument(orgId, collection, { id, data, ...(options.expectedRevision ? { expected_revision: options.expectedRevision } : {}) }, { replace: true, createOnly: options.createOnly }));
}

export async function listRecords(orgId: string, collection: string) {
  return (await listDocuments(orgId, collection)).map(view);
}

export async function removeRecord(orgId: string, collection: string, id: string) {
  await deleteDocument(orgId, collection, id);
}

export const newFormId = () => `form_${randomBytes(9).toString("hex")}`;

/**
 * The embed key names its organization and form so a public request resolves
 * in one read, and carries a secret segment so it can be rotated to revoke
 * every copy of an embed snippet.
 */
export function newPublicKey(orgId: string, formId: string) {
  return `${Buffer.from(orgId).toString("base64url")}.${formId}.${randomBytes(9).toString("base64url")}`;
}

export function parsePublicKey(key: string): { orgId: string; formId: string } | null {
  const [org, formId, secret] = String(key || "").split(".");
  if (!org || !formId || !secret || !/^[A-Za-z0-9_-]+$/.test(org) || !/^[A-Za-z0-9_-]+$/.test(formId)) return null;
  const orgId = Buffer.from(org, "base64url").toString("utf8");
  // The organization id comes from an untrusted key and names a storage location: identifier characters only.
  return /^[A-Za-z0-9_-]{1,160}$/.test(orgId) ? { orgId, formId } : null;
}
