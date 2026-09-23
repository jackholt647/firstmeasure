import { normalizeMediaTags, type JsonObject } from "./storage.js";
function asObject(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {}; }
function cleanText(value: unknown) { return String(value ?? "").trim(); }

export function isReceiptMedia(mediaValue: unknown) {
  const media = asObject(mediaValue);
  const owner = asObject(media.owner);
  const metadata = asObject(media.metadata);
  return cleanText(owner.slot).toLowerCase() === "receipts"
    || cleanText(metadata.document_type).toLowerCase() === "receipt"
    || cleanText(metadata.source).toLowerCase() === "expense_receipt_upload";
}

export function canReadReceiptMedia(mediaValue: unknown, contextValue: unknown) {
  if (!isReceiptMedia(mediaValue)) return true;
  const media = asObject(mediaValue);
  const owner = asObject(media.owner);
  const metadata = asObject(media.metadata);
  const context = asObject(contextValue);
  const permissions = asObject(context.permissions);
  const userId = cleanText(context.userId);
  if (userId && cleanText(metadata.uploaded_by_user_id) === userId) return true;
  if (permissions["*"] === true || permissions.manage_projects === true || permissions.manage_company_settings === true) return true;
  const projectId = cleanText(metadata.project_id || (cleanText(owner.type) === "project" ? owner.id : ""));
  return !!projectId && permissions.view_projects === true;
}

export function canWriteReceiptMedia(mediaValue: unknown, contextValue: unknown) {
  if (!isReceiptMedia(mediaValue)) return true;
  const media = asObject(mediaValue);
  const metadata = asObject(media.metadata);
  const context = asObject(contextValue);
  const permissions = asObject(context.permissions);
  return (cleanText(context.userId) && cleanText(metadata.uploaded_by_user_id) === cleanText(context.userId))
    || permissions["*"] === true
    || permissions.manage_projects === true
    || permissions.manage_company_settings === true;
}

export function publicMediaMetadata(mediaValue: unknown) {
  const media = asObject(mediaValue);
  if (!isReceiptMedia(media)) return media;
  const metadata = asObject(media.metadata);
  return {
    ...media,
    metadata: {
      title: cleanText(metadata.title),
      document_type: "receipt",
      field: cleanText(metadata.field),
      document_collection: cleanText(metadata.document_collection),
      document_id: cleanText(metadata.document_id),
      source: "expense_receipt_upload",
      receipt_id: cleanText(metadata.receipt_id),
      project_id: cleanText(metadata.project_id),
      uploaded_by_user_id: cleanText(metadata.uploaded_by_user_id),
      uploaded_at: cleanText(metadata.uploaded_at),
      tags: normalizeMediaTags(media.tags || metadata.tags)
    }
  };
}
