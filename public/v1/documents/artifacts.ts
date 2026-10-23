import type { PlatformAuthContext } from "../platform/auth.js";
import type { JsonObject } from "../platform/storage.js";
import {
  createDocumentInstance,
  createSnapshot,
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

export type TemplatedArtifactInput = {
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
};

/** Creates or updates the instance in place and issues it, with no snapshot or PDF (work orders open in the editor). */
export async function prepareTemplatedArtifact(input: TemplatedArtifactInput) {
  const ctx = systemContext(input.orgId, input.actorUserId, input.branchId);
  const stableId = cleanText(input.documentId);
  let document = stableId ? await readDocumentInstance(input.orgId, stableId).catch(() => null) : null;

  if (document) {
    // Reset status to "issued" before patching so account-backed params
    // re-derive when an artifact is re-rendered or re-published.
    if (!["", "draft", "issued"].includes(cleanText(document.status))) {
      document = await saveDocumentInstance(input.orgId, cleanText(document.id), {
        ...document,
        status: "issued",
        updated_by_user_id: ctx.userId,
        updated_at: new Date().toISOString()
      });
    }
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
  return { ctx, document: issued.document, documentId: cleanText(issued.document.id) };
}

/**
 * Publish a templated artifact (such as a due invoice) into the document
 * engine and customer portal without launching headless Chromium. Creates or
 * updates the document instance, mints a fresh snapshot + public_token, and
 * marks the instance as sent so it surfaces in the portal's Documents tab.
 */
export async function publishTemplatedArtifact(input: TemplatedArtifactInput) {
  const { ctx, documentId } = await prepareTemplatedArtifact(input);
  const snapshot = await createSnapshot(input.orgId, documentId, { reason: "publish" }, ctx);
  const current = await readDocumentInstance(input.orgId, documentId);
  const now = new Date().toISOString();
  const delivery = asObject(current.delivery);
  const currentStatus = cleanText(current.status);
  const nextStatus = ["viewed", "in_progress", "signed", "completed"].includes(currentStatus) ? currentStatus : "sent";
  const document = await saveDocumentInstance(input.orgId, documentId, {
    ...current,
    status: nextStatus,
    delivery: {
      ...delivery,
      sent_at: cleanText(delivery.sent_at) || now,
      send_count: Math.max(1, Number(delivery.send_count || 0)),
      current_snapshot_id: cleanText(snapshot.id),
      public_token: cleanText(snapshot.public_token),
      include_portal: true
    },
    updated_by_user_id: ctx.userId,
    updated_at: now
  });
  return { document, documentId, snapshot };
}

/**
 * Render a non-editor artifact through the exact same template -> instance ->
 * snapshot -> PDF pipeline used by Documents. Callers may provide a stable id
 * so a business record (invoice/payment/proposal) keeps one editable document
 * instance while every render still receives an immutable snapshot.
 */
export async function renderTemplatedArtifact(input: TemplatedArtifactInput) {
  const { ctx, documentId } = await prepareTemplatedArtifact(input);
  const priorStatus = cleanText((await readDocumentInstance(input.orgId, documentId).catch(() => null))?.status);
  const snapshot = await createSnapshot(input.orgId, documentId, { reason: "pdf" }, ctx);
  const rendered = await generateDocumentPdf(input.orgId, documentId, {
    snapshot_id: cleanText(snapshot.id),
    store: false,
    title: input.title
  }, ctx);
  let document = await readDocumentInstance(input.orgId, documentId);
  if (["sent", "viewed", "in_progress", "signed", "completed"].includes(priorStatus) && cleanText(document.status) !== priorStatus) {
    document = await saveDocumentInstance(input.orgId, documentId, {
      ...document,
      status: priorStatus,
      updated_at: new Date().toISOString()
    });
  }
  return {
    ...rendered,
    document,
    documentId,
    snapshot: rendered.snapshot,
    fileName: cleanText(input.fileName) || rendered.fileName
  };
}
