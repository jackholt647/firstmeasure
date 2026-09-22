import type { PlatformAuthContext } from "../platform/auth.js";
import type { JsonObject } from "../platform/storage.js";
import {
  createDocumentInstance,
  generateDocumentPdf,
  issueDocument,
  patchDocumentInstance
} from "./service.js";
import { readDocumentInstance, saveDocumentInstance } from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function systemContext(orgId: string, actorUserId = "system_documents", branchId = "default") {
  return {
    orgId,
    branchId: cleanText(branchId) || "default",
    userId: cleanText(actorUserId) || "system_documents",
    identityId: cleanText(actorUserId) || "system_documents",
    permissions: {},
    role: "system"
  } as unknown as PlatformAuthContext;
}

/**
 * Render a non-editor artifact through the exact same template -> instance ->
 * snapshot -> PDF pipeline used by Documents. Callers may provide a stable id
 * so a business record (invoice/payment/proposal) keeps one editable document
 * instance while every render still receives an immutable snapshot.
 */
export async function renderTemplatedArtifact(input: {
  orgId: string;
  documentId?: string;
  documentType: string;
  templateId?: string;
  projectId?: string;
  branchId?: string;
  title: string;
  params: JsonObject;
  outputs?: JsonObject;
  metadata?: JsonObject;
  actorUserId?: string;
  fileName?: string;
}) {
  const ctx = systemContext(input.orgId, input.actorUserId, input.branchId);
  const stableId = cleanText(input.documentId);
  let document = stableId ? await readDocumentInstance(input.orgId, stableId).catch(() => null) : null;

  if (document) {
    document = await patchDocumentInstance(input.orgId, cleanText(document.id), {
      title: input.title,
      params: input.params,
      metadata: input.metadata || {},
      ...(cleanText(input.templateId) ? { template_id: cleanText(input.templateId) } : {})
    }, ctx);
  } else {
    const created = await createDocumentInstance(input.orgId, cleanText(input.projectId), {
      ...(stableId ? { id: stableId } : {}),
      document_type: input.documentType,
      ...(cleanText(input.templateId) ? { template_id: cleanText(input.templateId) } : {}),
      workflow_id: null,
      title: input.title,
      params: input.params,
      metadata: input.metadata || {}
    }, ctx);
    document = created.document;
  }

  if (input.outputs && Object.keys(input.outputs).length) {
    document = await saveDocumentInstance(input.orgId, cleanText(document.id), {
      ...document,
      outputs: { ...asObject(document.outputs), ...input.outputs },
      updated_by_user_id: ctx.userId,
      updated_at: new Date().toISOString()
    });
  }

  const issued = await issueDocument(input.orgId, cleanText(document.id), {}, ctx);
  const rendered = await generateDocumentPdf(input.orgId, cleanText(issued.document.id), {
    store: false,
    title: input.title
  }, ctx);
  return {
    ...rendered,
    document: issued.document,
    documentId: cleanText(issued.document.id),
    snapshot: rendered.snapshot,
    fileName: cleanText(input.fileName) || rendered.fileName
  };
}
