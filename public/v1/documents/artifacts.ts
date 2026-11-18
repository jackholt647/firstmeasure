import type { PlatformAuthContext } from "../platform/auth.js";
import type { JsonObject } from "../platform/storage.js";
import {
  createDocumentInstance,
  createSnapshot,
  generateDocumentPdf,
  issueDocument,
  patchDocumentInstance
} from "./service.js";
import { readDocumentInstance, readDocumentTemplate, readDocumentTemplateVersion, readDocumentThemeVersion, saveDocumentInstance } from "./storage.js";
import { ensureDefaultDocumentAssets, ensureLibraryTemplate } from "./library-copies.js";
import { FMDocModel } from "./schemas.js";

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
  /**
   * A style for the document (a theme id), with its page regions re-fitted to the style's margins as choosing a style
   * in the editor does. A later write keeps a style someone chose on the document themselves.
   */
  themeId?: string | null;
};

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Gives a written artifact the style asked for, unless someone has since chosen another for it. */
async function styleArtifact(orgId: string, document: JsonObject, themeId: string, ctx: PlatformAuthContext) {
  const current = cleanText(asObject(document.theme_ref).theme_id);
  if (!themeId || current === themeId) return document;
  const templateRef = asObject(document.template_ref);
  const template = cleanText(templateRef.template_id)
    ? asObject(asObject(await readDocumentTemplateVersion(orgId, cleanText(templateRef.template_id)).catch(() => null)).definition)
    : {};
  // Styled by us before (or never styled): the template's own style or the one given last time.
  const given = cleanText(asObject(document.metadata).artifact_theme_id) || cleanText(asObject(template.theme_ref).theme_id);
  if (current && current !== given) return document;
  const theme = asObject(asObject(await readDocumentThemeVersion(orgId, themeId).catch(() => null)).definition);
  if (!Object.keys(theme).length) return document;
  const fit = FMDocModel.pageSetupOverrides(template, theme);
  // A region re-fitted again replaces its last fit rather than piling up.
  const refits = new Set(fit.map((op) => `${cleanText(op.op)}:${cleanText(op.node_id)}:${cleanText(op.prop)}`));
  const kept = asArray(document.overrides).map(asObject).filter((op) => !refits.has(`${cleanText(op.op)}:${cleanText(op.node_id)}:${cleanText(op.prop)}`));
  return patchDocumentInstance(orgId, cleanText(document.id), {
    theme_ref: { theme_id: themeId },
    ...(fit.length || kept.length !== asArray(document.overrides).length ? { overrides: [...kept, ...fit] } : {}),
    metadata: { artifact_theme_id: themeId }
  }, ctx);
}

/** The template's current version, its library copy made or brought up to date first (as before a new document); 0 when it has none. */
async function currentTemplateVersion(orgId: string, templateId: string) {
  await ensureDefaultDocumentAssets(orgId).catch(() => null);
  await ensureLibraryTemplate(orgId, templateId).catch(() => null);
  const template = await readDocumentTemplate(orgId, templateId).catch(() => null);
  return template && cleanText(template.status) !== "archived" ? Number(template.current_version || 0) : 0;
}

/** Creates or updates the instance in place and issues it, with no snapshot or PDF (work orders open in the editor). */
export async function prepareTemplatedArtifact(input: TemplatedArtifactInput) {
  const ctx = systemContext(input.orgId, input.actorUserId, input.branchId);
  const stableId = cleanText(input.documentId);
  let document = stableId ? await readDocumentInstance(input.orgId, stableId).catch(() => null) : null;

  if (document) {
    // Written again, it moves to its template's current version, as a new one would start from (FM-612: a layout fix
    // reaches checklists and invoices already written). Only a draft switches versions.
    const templateId = cleanText(input.templateId);
    const pinned = asObject(document.template_ref);
    const latest = templateId && cleanText(pinned.template_id) === templateId ? await currentTemplateVersion(input.orgId, templateId) : 0;
    const repin = latest > 0 && Number(pinned.version || 0) !== latest;
    // Reset status to "issued" (a draft to re-pin) before patching so account-backed
    // params re-derive when an artifact is re-rendered or re-published.
    const resetTo = repin ? "draft" : "issued";
    if (repin ? cleanText(document.status) !== "draft" : !["", "draft", "issued"].includes(cleanText(document.status))) {
      document = await saveDocumentInstance(input.orgId, cleanText(document.id), {
        ...document,
        status: resetTo,
        updated_by_user_id: ctx.userId,
        updated_at: new Date().toISOString()
      });
    }
    document = await patchDocumentInstance(input.orgId, cleanText(document.id), {
      title: input.title,
      params: input.params,
      metadata: input.metadata || {},
      ...(repin ? { template_ref: { template_id: templateId, version: latest } } : templateId ? { template_id: templateId } : {})
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

  if (cleanText(input.themeId)) document = await styleArtifact(input.orgId, document, cleanText(input.themeId), ctx);

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
