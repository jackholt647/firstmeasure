import { normalizeMediaTags, type JsonObject } from "./storage.js";
import type { PlatformAuthContext } from "./auth.js";
import { hasResourcePermission } from "../workforce/department-access.js";
import { branchScope, canSeeBranches } from "../workforce/branch-scope.js";
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

/**
 * A photo with nothing to file it under yet (taken from the Feed camera): owned by the organization, in the photos
 * slot, naming no project. Pairing it with a project is projects/media-assignment.ts.
 */
export function isUnassignedPhoto(mediaValue: unknown) {
  const media = asObject(mediaValue), owner = asObject(media.owner);
  return cleanText(owner.type) === "organization" && cleanText(owner.slot) === "photos" && !cleanText(asObject(media.metadata).project_id);
}

/** The branch an unpaired photo was taken in: the uploader's branch, recorded by the upload route. */
export function mediaBranchId(mediaValue: unknown) {
  return cleanText(asObject(asObject(mediaValue).metadata).branch_id) || "default";
}

/**
 * Who may see (and so rename, tag or mark up) an unpaired photo: whoever took it, and anyone with `view_media` whose
 * branches include the photo's branch. A photo marked as a receipt also needs what receipts need.
 */
export function canSeeUnassignedPhoto(contextValue: unknown, mediaValue: unknown) {
  const media = asObject(mediaValue), metadata = asObject(media.metadata);
  const context = asObject(contextValue) as unknown as PlatformAuthContext;
  if (!isUnassignedPhoto(media)) return false;
  if (media.deleted_at || media.trashed_at || media.in_trash || metadata.deleted_at || metadata.trashed_at || metadata.in_trash) return false;
  if (cleanText(media.organization_id) && cleanText(context.orgId) && cleanText(media.organization_id) !== cleanText(context.orgId)) return false;
  const uploader = cleanText(metadata.uploaded_by_user_id);
  if (uploader && uploader === cleanText(context.userId)) return true;
  const permissions = asObject(context.permissions);
  if (isReceiptMedia(media) && !(permissions["*"] === true || permissions.manage_projects === true || permissions.manage_company_settings === true)) return false;
  const branchId = mediaBranchId(media);
  const departmentIds = Array.isArray(metadata.department_ids) ? metadata.department_ids.map(cleanText).filter(Boolean) : [];
  return hasResourcePermission(context, "view_media", { branch_id: branchId, department_ids: departmentIds }) && canSeeBranches(branchScope(context), [branchId]);
}

export function canReadReceiptMedia(mediaValue: unknown, contextValue: unknown) {
  if (isUnassignedPhoto(mediaValue)) return canSeeUnassignedPhoto(contextValue, mediaValue);
  if (cleanText(asObject(asObject(mediaValue).owner).type)==="contact") {
    const permissions=asObject(asObject(contextValue).permissions);
    return permissions["*"]===true || permissions.view_contacts===true;
  }
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
  if (isUnassignedPhoto(mediaValue)) return canSeeUnassignedPhoto(contextValue, mediaValue);
  if (cleanText(asObject(asObject(mediaValue).owner).type)==="contact") {
    const permissions=asObject(asObject(contextValue).permissions);
    return permissions["*"]===true || permissions.manage_projects===true;
  }
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
