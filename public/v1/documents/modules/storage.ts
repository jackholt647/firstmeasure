import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../../platform/storage.js";
import { notFound } from "../../platform/errors.js";
export const MODULES = "document_modules";
export const VERSIONS = "document_module_versions";
export const INSTANCES = "document_module_instances";
export const EXECUTIONS = "document_module_executions";
export function view(record: { id: string; data: JsonObject; revision: number }) { return { ...record.data, id: record.id, revision: record.revision } as JsonObject; }
export async function getRecord(org: string, collection: string, id: string) {
  const record = await readDocument(org, collection, id);
  if (!record) throw notFound("module_not_found", "Document module record not found.");
  return view(record);
}
export async function saveRecord(org: string, collection: string, id: string, data: JsonObject, expectedRevision?: number, createOnly = false) {
  return view(await upsertDocument(org, collection, { id, data, ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }, { replace: true, createOnly }));
}
export async function records(org: string, collection: string) { return (await listDocuments(org, collection)).map(view); }
