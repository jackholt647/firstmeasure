import { createHash, randomBytes } from "node:crypto";

import { readOrganizationConnection } from "../connections/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  readDocument,
  readMediaFile,
  readMediaMetadata,
  storeMediaUpload,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { emitWorkEvent } from "../work/engine.js";
import { readResourceGroup } from "../workforce/storage.js";
import {
  assertExpenseTargetKeys,
  listProjectReceipts,
  projectExpenseSummary,
  readReceipt,
  receiptSuggestionForProject,
  saveReceiptRecord
} from "./expenses.js";
import {
  extractReceipt,
  inferReceiptContentType,
  receiptFileSupport,
  RECEIPT_EXTRACTION_SCHEMA_VERSION,
  RECEIPT_EXTRACTION_PROMPT_VERSION
} from "./receipt_extraction.js";

export type ReceiptUploadInput = {
  projectId?: string;
  bytes?: Buffer;
  fileName?: string;
  contentType?: string;
  mediaId?: string;
  title?: string;
  totalCents?: number | null;
  purchaseDate?: string;
  purchaseTime?: string;
  purchaseTimezone?: string;
  metadata?: JsonObject;
  uploadLocation?: JsonObject;
  associations?: JsonObject[];
  owner?: JsonObject;
  idempotencyKey?: string;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function generatedId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

function integerCents(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function uniqueText(value: unknown) {
  return [...new Set(asArray(value).map(cleanText).filter(Boolean))];
}

function publicExtraction(value: unknown) {
  const extraction = asObject(value);
  delete extraction.response_id;
  delete extraction.usage;
  delete extraction.latency_ms;
  return extraction;
}

function publicAssociation(value: unknown) {
  const association = asObject(value);
  return {
    kind: cleanText(association.kind),
    id: cleanText(association.id),
    name: cleanText(association.name),
    role: cleanText(association.role),
    verification: asObject(association.verification)
  };
}

function actor(ctx: PlatformAuthContext) {
  const identity = asObject(ctx.identity);
  const user = asObject(ctx.user);
  return {
    user_id: ctx.userId,
    identity_id: ctx.identityId,
    name: cleanText(user.name || identity.name),
    email: cleanText(user.email || identity.email).toLowerCase(),
    role: cleanText(ctx.role)
  };
}

const RECEIPT_ASSOCIATION_KINDS = new Set([
  "project",
  "resource_group",
  "organization_connection",
  "organization_user",
  "inventory",
  "inventory_location",
  "organization"
]);

function canManageProjectReceipts(ctx: PlatformAuthContext) {
  const permissions = asObject(ctx.permissions);
  return permissions["*"] === true || permissions.manage_projects === true || permissions.manage_company_settings === true;
}

const receiptUploadTails = new Map<string, Promise<void>>();
const RECEIPT_PROCESSING_STALE_MS = Math.max(60_000, Number(process.env.RECEIPT_PROCESSING_STALE_MS || 600_000) || 600_000);

async function withReceiptUploadLock<T>(key: string, work: () => Promise<T>) {
  const previous = receiptUploadTails.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  receiptUploadTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (receiptUploadTails.get(key) === tail) receiptUploadTails.delete(key);
  }
}

function receiptUploadFingerprint(orgId: string, projectId: string, ownerValue: unknown, input: ReceiptUploadInput) {
  const owner = asObject(ownerValue);
  const fileSource = Buffer.isBuffer(input.bytes)
    ? `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`
    : `media:${cleanText(input.mediaId)}`;
  return createHash("sha256").update(JSON.stringify({
    organization_id: orgId,
    project_id: projectId,
    owner: { kind: cleanText(owner.kind), id: cleanText(owner.id) },
    file_source: fileSource,
    file_name: cleanText(input.fileName),
    content_type: cleanText(input.contentType).toLowerCase(),
    title: cleanText(input.title),
    total_cents: input.totalCents == null ? null : integerCents(input.totalCents),
    purchase_date: cleanText(input.purchaseDate),
    purchase_time: cleanText(input.purchaseTime),
    purchase_timezone: cleanText(input.purchaseTimezone)
  })).digest("hex");
}

async function assertMediaReuseAllowed(orgId: string, mediaValue: JsonObject, selectedOwnerValue: JsonObject, ctx: PlatformAuthContext) {
  if (canManageProjectReceipts(ctx)) return;
  const media = asObject(mediaValue);
  const mediaOwner = asObject(media.owner);
  const metadata = asObject(media.metadata);
  const selectedOwner = asObject(selectedOwnerValue);
  const ownerType = cleanText(mediaOwner.type).toLowerCase();
  const ownerId = cleanText(mediaOwner.id);
  if (cleanText(metadata.uploaded_by_user_id) === ctx.userId) return;
  if (ownerType === "organization_user" && ownerId === ctx.userId) return;
  if (ownerType === "resource_group"
    && cleanText(selectedOwner.kind) === "resource_group"
    && cleanText(selectedOwner.id) === ownerId) {
    const group = await readResourceGroup(orgId, ownerId);
    const activeGroup = cleanText(group.status || "active").toLowerCase() === "active";
    const activeMember = asArray(group.members).map(asObject).some((member) => (
      cleanText(member.user_id) === ctx.userId && cleanText(member.status || "active").toLowerCase() === "active"
    ));
    if (activeGroup && activeMember) return;
  }
  throw forbidden("receipt_media_reuse_forbidden", "This library file is not available for receipt reuse by this user.");
}

async function receiptAssociations(orgId: string, projectId: string, input: ReceiptUploadInput, ctx: PlatformAuthContext) {
  const normalized: JsonObject[] = [];
  const add = (kindValue: unknown, idValue: unknown, extra: JsonObject = {}) => {
    const kind = cleanText(kindValue).toLowerCase();
    const id = cleanText(idValue);
    if (!kind || !id) return;
    if (!RECEIPT_ASSOCIATION_KINDS.has(kind)) throw badRequest("invalid_receipt_association", `Receipt association kind '${kind}' is not supported.`);
    if (normalized.some((entry) => cleanText(entry.kind) === kind && cleanText(entry.id) === id)) return;
    normalized.push({
      kind,
      id,
      name: cleanText(extra.name || extra.label),
      role: cleanText(extra.role),
      metadata: asObject(extra.metadata)
    });
  };
  if (projectId) add("project", projectId);
  for (const value of asArray(input.associations).map(asObject)) add(value.kind || value.type, value.id, value);
  add("organization_user", ctx.userId, { role: "uploader" });

  for (const association of normalized) {
    const kind = cleanText(association.kind);
    const id = cleanText(association.id);
    if (kind === "project") {
      if (!canManageProjectReceipts(ctx)) {
        throw forbidden("receipt_project_association_forbidden", "Field users may upload receipts for themselves or an active work resource; a project manager must attach them to a project.");
      }
      await readDocument(orgId, "projects", id);
      association.verification = { status: "verified", method: "project_exists" };
    }
    if (kind === "organization_user" && id !== ctx.userId && !canManageProjectReceipts(ctx)) {
      throw badRequest("receipt_association_forbidden", "Users may only upload receipts for their own user association.");
    }
    if (kind === "resource_group") {
      const group = await readResourceGroup(orgId, id);
      const isActiveGroup = cleanText(group.status || "active").toLowerCase() === "active";
      const isMember = asArray(group.members).map(asObject).some((member) => cleanText(member.user_id) === ctx.userId && cleanText(member.status || "active").toLowerCase() === "active");
      if (!isActiveGroup && !canManageProjectReceipts(ctx)) throw forbidden("receipt_association_forbidden", "This work resource is not active.");
      if (!isMember && !canManageProjectReceipts(ctx)) throw badRequest("receipt_association_forbidden", "This user is not an active member of the selected work resource.");
      association.verification = { status: "verified", method: isMember ? "active_membership" : "manager_access" };
    }
    if (kind === "organization_connection") {
      if (!canManageProjectReceipts(ctx)) throw badRequest("receipt_association_forbidden", "Only project managers can associate receipts with an organization connection.");
      (await readOrganizationConnection(orgId, id));
      association.verification = { status: "verified", method: "connection_exists" };
    }
    if (["inventory", "inventory_location"].includes(kind)) {
      if (!canManageProjectReceipts(ctx)) throw badRequest("receipt_association_forbidden", "Inventory receipt associations require project-manager access until inventory permissions are configured.");
      association.verification = { status: "pending", method: "future_inventory_entity" };
    }
    if (kind === "organization") {
      if (id !== orgId) throw badRequest("receipt_association_forbidden", "The receipt organization association is invalid.");
      if (!canManageProjectReceipts(ctx)) throw badRequest("receipt_association_forbidden", "Organization-level receipt associations require project-manager access.");
      association.verification = { status: "verified", method: "session_organization" };
    }
    if (kind === "organization_user") association.verification = { status: "verified", method: id === ctx.userId ? "session_user" : "manager_access" };
  }

  const requestedOwner = asObject(input.owner);
  const ownerKind = cleanText(requestedOwner.kind || requestedOwner.type);
  const ownerId = cleanText(requestedOwner.id);
  const owner = normalized.find((entry) => cleanText(entry.kind) === ownerKind && cleanText(entry.id) === ownerId) || normalized[0] || { kind: "organization_user", id: ctx.userId };
  return { associations: normalized, owner: asObject(owner), projectId: cleanText(normalized.find((entry) => cleanText(entry.kind) === "project")?.id) };
}

function receiptEffective(receipt: JsonObject) {
  const extraction = asObject(receipt.extraction);
  const overrides = asObject(receipt.user_overrides);
  return {
    title: cleanText(overrides.title || extraction.title || asObject(receipt.file).file_name || "Receipt"),
    total_cents: Object.prototype.hasOwnProperty.call(overrides, "total_cents")
      ? integerCents(overrides.total_cents)
      : integerCents(extraction.total_cents),
    currency: cleanText(overrides.currency || extraction.currency || "USD").toUpperCase() || "USD",
    purchase_date: cleanText(overrides.purchase_date || extraction.purchase_date),
    purchase_time: cleanText(overrides.purchase_time || extraction.purchase_time),
    purchase_timezone: cleanText(overrides.purchase_timezone || extraction.purchase_timezone)
  };
}

function receiptApplicationIssue(receipt: JsonObject) {
  const effective = receiptEffective(receipt);
  if (integerCents(effective.total_cents) <= 0) return "total_required";
  if (cleanText(effective.currency).toUpperCase() !== "USD") return "unsupported_currency";
  if (cleanText(asObject(receipt.extraction).amount_direction).toLowerCase() === "credit") return "credit_review_required";
  return "";
}

export function receiptView(receiptValue: JsonObject): JsonObject {
  const receipt = asObject(receiptValue);
  const effective = receiptEffective(receipt);
  const file = asObject(receipt.file);
  const uploadedBy = asObject(receipt.uploaded_by);
  const libraryDocument = asObject(receipt.library_document);
  const attribution = asObject(receipt.attribution);
  const confirmedBy = asObject(attribution.confirmed_by);
  return {
    schema_version: Number(receipt.schema_version || 1),
    id: cleanText(receipt.id),
    organization_id: cleanText(receipt.organization_id),
    branch_id: cleanText(receipt.branch_id),
    project_id: cleanText(receipt.project_id),
    owner: publicAssociation(receipt.owner),
    associations: asArray(receipt.associations).map(publicAssociation),
    status: cleanText(receipt.status),
    file: {
      media_id: cleanText(file.media_id),
      document_id: cleanText(file.document_id),
      file_name: cleanText(file.file_name),
      content_type: cleanText(file.content_type),
      size_bytes: Number(file.size_bytes || 0),
      support: asObject(file.support)
    },
    library_document: {
      id: cleanText(libraryDocument.id),
      document_id: cleanText(libraryDocument.document_id),
      media_id: cleanText(libraryDocument.media_id),
      title: cleanText(libraryDocument.title),
      document_type: cleanText(libraryDocument.document_type),
      content_type: cleanText(libraryDocument.content_type),
      size_bytes: Number(libraryDocument.size_bytes || 0)
    },
    uploaded_by: { user_id: cleanText(uploadedBy.user_id), name: cleanText(uploadedBy.name) },
    uploaded_at: cleanText(receipt.uploaded_at),
    extraction: publicExtraction(receipt.extraction),
    user_overrides: asObject(receipt.user_overrides),
    attribution: {
      target_keys: uniqueText(attribution.target_keys),
      method: cleanText(attribution.method),
      confirmed_at: cleanText(attribution.confirmed_at),
      confirmed_by: { user_id: cleanText(confirmedBy.user_id), name: cleanText(confirmedBy.name) }
    },
    reimbursement_request: asObject(receipt.reimbursement_request),
    duplicate_of_receipt_id: cleanText(receipt.duplicate_of_receipt_id),
    created_at: cleanText(receipt.created_at),
    updated_at: cleanText(receipt.updated_at),
    applied_at: cleanText(receipt.applied_at),
    revision: Number(receipt.revision || 0),
    ...effective,
    effective,
    attributed_target_keys: uniqueText(receipt.attributed_target_keys),
    suggested_target_keys: uniqueText(receipt.suggested_target_keys),
    file_url: cleanText(asObject(receipt.file).media_id)
      ? `/v1/payments/organizations/${encodeURIComponent(cleanText(receipt.organization_id))}/receipts/${encodeURIComponent(cleanText(receipt.id))}/file`
      : ""
  };
}

export function receiptAuditView(receiptValue: JsonObject): JsonObject {
  const receipt = asObject(receiptValue);
  return {
    receipt: receiptView(receipt),
    audit: {
      uploaded_by: asObject(receipt.uploaded_by),
      uploaded_at: cleanText(receipt.uploaded_at),
      upload_location: asObject(receipt.upload_location),
      file: asObject(receipt.file),
      extraction: asObject(receipt.extraction),
      extraction_attempts: asArray(receipt.extraction_attempts).map(asObject),
      metadata: asObject(receipt.metadata),
      idempotency_key: cleanText(receipt.idempotency_key),
      created_by_user_id: cleanText(receipt.created_by_user_id),
      updated_by_user_id: cleanText(receipt.updated_by_user_id),
      created_at: cleanText(receipt.created_at),
      updated_at: cleanText(receipt.updated_at)
    }
  };
}

async function attachReceiptToProjectLibrary(orgId: string, projectId: string, receiptId: string, media: JsonObject, support: ReturnType<typeof receiptFileSupport>) {
  const mediaId = cleanText(media.id || media.media_id);
  const mediaMetadata = asObject(media.metadata);
  const reference = {
    id: mediaId,
    document_id: mediaId,
    media_id: mediaId,
    kind: "media_reference",
    title: cleanText(mediaMetadata.title || media.file_name || "Receipt"),
    label: cleanText(mediaMetadata.title || media.file_name || "Receipt"),
    document_type: "receipt",
    type: "receipt",
    type_label: "Receipt",
    icon: "fa-receipt",
    color: "#b54708",
    source: "expense_receipt_upload",
    file_name: cleanText(media.file_name),
    content_type: cleanText(media.content_type),
    mime_type: cleanText(media.content_type),
    size_bytes: Number(media.size_bytes || 0),
    variant: "original",
    uploaded_at: cleanText(mediaMetadata.uploaded_at || media.created_at),
    updated_at: cleanText(media.updated_at || media.created_at),
    interactive: support.safe_inline_preview,
    metadata: {
      receipt_id: receiptId,
      document_type: "receipt",
      source: "expense_receipt_upload",
      safe_inline_preview: support.safe_inline_preview,
      uploaded_at: cleanText(mediaMetadata.uploaded_at || media.created_at)
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const projectDoc = await readDocument(orgId, "projects", projectId);
    const project = asObject(projectDoc.data);
    const current = asArray(project.documents).map(asObject);
    if (current.some((item) => cleanText(item.media_id || item.id) === mediaId)) return reference;
    try {
      await upsertDocument(orgId, "projects", {
        id: projectId,
        expected_revision: Number(projectDoc.revision || 0),
        data: { ...project, documents: [...current, reference], updated_at: nowIso() },
        metadata: { ...asObject(projectDoc.metadata), source: "expense_receipt_upload" }
      }, { replace: true });
      return reference;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return reference;
}

async function uploadedMedia(orgId: string, owner: JsonObject, receiptId: string, projectId: string, input: ReceiptUploadInput, ctx: PlatformAuthContext) {
  if (input.mediaId) {
    const media = await readMediaMetadata(orgId, input.mediaId);
    await assertMediaReuseAllowed(orgId, media, owner, ctx);
    const original = await readMediaFile(orgId, input.mediaId, "original");
    return { media, bytes: original.bytes, fileName: original.fileName, contentType: original.contentType, existing: true };
  }
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length) throw badRequest("receipt_file_required", "Choose a receipt or invoice file to upload.");
  const fileName = cleanText(input.fileName || "receipt-upload");
  const contentType = inferReceiptContentType(fileName, cleanText(input.contentType || "application/octet-stream"), input.bytes);
  const uploadedAt = nowIso();
  const uploadedBy = actor(ctx);
  const media = await storeMediaUpload(orgId, {
    bytes: input.bytes,
    fileName,
    contentType,
    ownerType: cleanText(owner.kind || "organization_user"),
    ownerId: cleanText(owner.id || ctx.userId),
    slot: "receipts",
    collection: cleanText(owner.kind) === "project" ? "projects" : "receipts",
    scope: "documents",
    replaceSlot: false,
    thumbnails: contentType.startsWith("image/"),
    compression: false,
    metadata: {
      ...asObject(input.metadata),
      title: cleanText(input.title || fileName),
      document_type: "receipt",
      field: "documents",
      document_collection: cleanText(owner.kind) === "project" ? "projects" : "receipts",
      document_id: cleanText(owner.id || ctx.userId),
      source: "expense_receipt_upload",
      receipt_id: receiptId,
      project_id: projectId,
      uploaded_by_user_id: uploadedBy.user_id,
      uploaded_by_email: uploadedBy.email,
      uploaded_by_name: uploadedBy.name,
      uploaded_at: uploadedAt
    }
  });
  return { media, bytes: input.bytes, fileName, contentType, existing: false };
}

type ResolvedReceiptContext = { associations: JsonObject[]; owner: JsonObject; projectId: string };

async function emitReceiptExtractedEvent(orgId: string, receipt: JsonObject, attemptId: string, actorUserId: string) {
  const receiptId = cleanText(receipt.id);
  const projectId = cleanText(receipt.project_id);
  const extraction = asObject(receipt.extraction);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(receipt.branch_id || "default") || "default",
    ...(projectId ? { project_id: projectId } : {}),
    type: "receipt.extracted",
    // Keyed to the extraction attempt so re-extraction emits again.
    idempotency_key: `receipt.extracted:${receiptId}:${attemptId}`,
    payload: {
      receipt_id: receiptId,
      status: cleanText(receipt.status),
      extraction_status: cleanText(extraction.status),
      title: cleanText(extraction.title),
      total_cents: integerCents(extraction.total_cents)
    },
    context: { actor_user_id: actorUserId }
  });
}

export async function createReceiptFromUpload(orgId: string, projectId: string, input: ReceiptUploadInput, ctx: PlatformAuthContext) {
  const receiptContext = await receiptAssociations(orgId, cleanText(projectId), input, ctx);
  const idempotencyKey = cleanText(input.idempotencyKey);
  const execute = () => createReceiptFromUploadResolved(orgId, input, ctx, receiptContext, idempotencyKey);
  if (!idempotencyKey) return await execute();
  const owner = asObject(receiptContext.owner);
  const lockKey = createHash("sha256").update(`${orgId}:${receiptContext.projectId}:${cleanText(owner.kind)}:${cleanText(owner.id)}:${idempotencyKey}`).digest("hex");
  return await withReceiptUploadLock(lockKey, execute);
}

async function createReceiptFromUploadResolved(orgId: string, input: ReceiptUploadInput, ctx: PlatformAuthContext, receiptContext: ResolvedReceiptContext, idempotencyKey: string) {
  const associatedProjectId = receiptContext.projectId;
  const idempotencyFingerprint = idempotencyKey ? receiptUploadFingerprint(orgId, associatedProjectId, receiptContext.owner, input) : "";
  if (idempotencyKey) {
    const existing = (await listProjectReceipts(orgId, associatedProjectId, { include_unscoped: !associatedProjectId, include_void: true })).find((receipt) => cleanText(receipt.idempotency_key) === idempotencyKey && cleanText(asObject(receipt.owner).kind) === cleanText(receiptContext.owner.kind) && cleanText(asObject(receipt.owner).id) === cleanText(receiptContext.owner.id));
    if (existing) {
      const existingFingerprint = cleanText(existing.idempotency_fingerprint);
      if (existingFingerprint && existingFingerprint !== idempotencyFingerprint) {
        throw conflict("receipt_idempotency_key_reused", "This Idempotency-Key was already used for a different receipt upload.");
      }
      const processingAge = Date.now() - Date.parse(cleanText(existing.processing_started_at || existing.updated_at || existing.created_at));
      if (cleanText(existing.status) === "processing" && Number.isFinite(processingAge) && processingAge >= RECEIPT_PROCESSING_STALE_MS) {
        try {
          return { receipt: await reextractReceipt(orgId, cleanText(existing.id), ctx), created: false, recovered: true };
        } catch (error) {
          const latest = await readReceipt(orgId, cleanText(existing.id)).catch(() => null);
          if (latest && cleanText(latest.status) !== "processing") return { receipt: receiptView(latest), created: false, recovered: true };
          throw error;
        }
      }
      return { receipt: receiptView(existing), created: false };
    }
  }
  const receiptId = idempotencyKey
    ? `receipt_${createHash("sha256").update(`${orgId}:${associatedProjectId}:${cleanText(asObject(receiptContext.owner).kind)}:${cleanText(asObject(receiptContext.owner).id)}:${idempotencyKey}`).digest("hex").slice(0, 32)}`
    : generatedId("receipt");
  const uploaded = await uploadedMedia(orgId, receiptContext.owner, receiptId, associatedProjectId, input, ctx);
  const contentType = inferReceiptContentType(uploaded.fileName, uploaded.contentType, uploaded.bytes);
  const support = receiptFileSupport(uploaded.fileName, contentType, uploaded.bytes.length);
  const uploadedMediaValue = asObject(uploaded.media);
  const mediaId = cleanText(uploadedMediaValue.id || uploadedMediaValue.media_id);
  const checksum = createHash("sha256").update(uploaded.bytes).digest("hex");
  const uploadedAt = nowIso();
  const uploadedBy = actor(ctx);
  const duplicate = (await listProjectReceipts(orgId, associatedProjectId, { include_unscoped: !associatedProjectId })).find((receipt) => cleanText(asObject(receipt.file).sha256) === checksum);
  const libraryDocument: JsonObject = associatedProjectId
    ? await attachReceiptToProjectLibrary(orgId, associatedProjectId, receiptId, uploaded.media, support)
    : {};
  const sourceMediaMetadata = asObject(uploadedMediaValue.metadata);
  const baseRecord: JsonObject = {
    schema_version: 1,
    id: receiptId,
    organization_id: orgId,
    branch_id: cleanText(ctx.branchId || "default") || "default",
    project_id: associatedProjectId,
    owner: receiptContext.owner,
    associations: receiptContext.associations,
    status: "processing",
    processing_started_at: uploadedAt,
    file: {
      media_id: mediaId,
      document_id: cleanText(libraryDocument.document_id || mediaId),
      file_name: uploaded.fileName,
      content_type: contentType,
      size_bytes: uploaded.bytes.length,
      sha256: checksum,
      original_uploaded_at: cleanText(sourceMediaMetadata.uploaded_at || uploadedMediaValue.created_at),
      original_uploaded_by_user_id: cleanText(sourceMediaMetadata.uploaded_by_user_id),
      support
    },
    library_document: libraryDocument,
    uploaded_by: uploadedBy,
    uploaded_at: uploadedAt,
    upload_location: asObject(input.uploadLocation),
    duplicate_of_receipt_id: cleanText(duplicate?.id),
    extraction: {},
    extraction_attempts: [],
    user_overrides: {
      ...(cleanText(input.title) ? { title: cleanText(input.title) } : {}),
      ...(input.totalCents != null ? { total_cents: integerCents(input.totalCents) } : {}),
      ...(cleanText(input.purchaseDate) ? { purchase_date: cleanText(input.purchaseDate) } : {}),
      ...(cleanText(input.purchaseTime) ? { purchase_time: cleanText(input.purchaseTime) } : {}),
      ...(cleanText(input.purchaseTimezone) ? { purchase_timezone: cleanText(input.purchaseTimezone) } : {})
    },
    suggested_target_keys: [],
    attributed_target_keys: [],
    metadata: asObject(input.metadata),
    idempotency_key: idempotencyKey,
    idempotency_fingerprint: idempotencyFingerprint,
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: uploadedAt,
    updated_at: uploadedAt
  };
  const processingRecord = await saveReceiptRecord(orgId, baseRecord);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(baseRecord.branch_id || "default") || "default",
    ...(associatedProjectId ? { project_id: associatedProjectId } : {}),
    type: "receipt.uploaded",
    idempotency_key: `receipt.uploaded:${receiptId}`,
    payload: {
      receipt_id: receiptId,
      file_name: uploaded.fileName,
      uploaded_by_user_id: uploadedBy.user_id,
      uploaded_by_name: uploadedBy.name
    },
    context: { actor_user_id: ctx.userId }
  });
  const extraction = await extractReceipt({ bytes: uploaded.bytes, fileName: uploaded.fileName, contentType });
  const effectiveTotal = Object.prototype.hasOwnProperty.call(asObject(baseRecord.user_overrides), "total_cents")
    ? integerCents(asObject(baseRecord.user_overrides).total_cents)
    : integerCents(extraction.total_cents);
  const suggestions = effectiveTotal > 0 && associatedProjectId ? await receiptSuggestionForProject(orgId, associatedProjectId, effectiveTotal) : [];
  const attempt = {
    id: generatedId("receipt_extraction"),
    schema_version: RECEIPT_EXTRACTION_SCHEMA_VERSION,
    prompt_version: RECEIPT_EXTRACTION_PROMPT_VERSION,
    method: cleanText(extraction.method),
    status: cleanText(extraction.status),
    model: cleanText(extraction.model),
    response_id: cleanText(extraction.response_id),
    usage: asObject(extraction.usage),
    latency_ms: Number(extraction.latency_ms || 0),
    warnings: asArray(extraction.warnings),
    result: extraction,
    created_at: nowIso()
  };
  const ready = effectiveTotal > 0;
  const saved = await saveReceiptRecord(orgId, {
    ...baseRecord,
    status: ready ? "ready" : "needs_review",
    extraction,
    extraction_attempts: [attempt],
    suggested_target_keys: suggestions,
    updated_at: nowIso()
  }, Number(processingRecord.revision || 0));
  await emitReceiptExtractedEvent(orgId, saved, cleanText(attempt.id), ctx.userId);
  return { receipt: receiptView(saved), created: true };
}

export async function patchReceipt(orgId: string, receiptId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const current = await readReceipt(orgId, receiptId);
  if (cleanText(current.status) === "void") throw conflict("receipt_voided", "A voided receipt cannot be edited.");
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(current.revision || 0)) throw conflict("receipt_revision_conflict", "Receipt revision does not match.");
  const overrides = asObject(current.user_overrides);
  const nextOverrides: JsonObject = { ...overrides };
  for (const key of ["title", "currency", "purchase_date", "purchase_time", "purchase_timezone"]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) nextOverrides[key] = cleanText(input[key]);
  }
  if (Object.prototype.hasOwnProperty.call(input, "total_cents")) nextOverrides.total_cents = integerCents(input.total_cents);
  const draft = { ...current, user_overrides: nextOverrides };
  const effective = receiptEffective(draft);
  const suggestions = Object.prototype.hasOwnProperty.call(input, "total_cents") && cleanText(current.status) !== "applied"
    ? await receiptSuggestionForProject(orgId, cleanText(current.project_id), integerCents(effective.total_cents))
    : uniqueText(current.suggested_target_keys);
  const applicationIssue = cleanText(current.status) === "applied" ? receiptApplicationIssue(draft) : "";
  const saved = await saveReceiptRecord(orgId, {
    ...draft,
    status: cleanText(current.status) === "applied" && !applicationIssue ? "applied" : (integerCents(effective.total_cents) > 0 && !applicationIssue ? "ready" : "needs_review"),
    ...(applicationIssue ? { application_invalidated_at: nowIso(), application_invalid_reason: applicationIssue } : {}),
    suggested_target_keys: suggestions,
    metadata: Object.prototype.hasOwnProperty.call(input, "metadata") ? { ...asObject(current.metadata), ...asObject(input.metadata) } : asObject(current.metadata),
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  }, Number(current.revision || 0));
  return receiptView(saved);
}

export async function applyReceiptAttribution(orgId: string, receiptId: string, input: JsonObject, ctx: PlatformAuthContext): Promise<JsonObject> {
  let current = await readReceipt(orgId, receiptId);
  if (cleanText(current.status) === "void") throw conflict("receipt_voided", "A voided receipt cannot be applied.");
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(current.revision || 0)) throw conflict("receipt_revision_conflict", "Receipt revision does not match.");
  if (Object.keys(input).some((key) => ["title", "total_cents", "currency", "purchase_date", "purchase_time", "purchase_timezone"].includes(key))) {
    await patchReceipt(orgId, receiptId, input, ctx);
    current = await readReceipt(orgId, receiptId);
  }
  if (!cleanText(current.project_id)) throw badRequest("receipt_project_required", "Associate this receipt with a project before applying it to project expenses.");
  const targetKeys = await assertExpenseTargetKeys(orgId, cleanText(current.project_id), input.target_keys || input.attributed_target_keys);
  if (!targetKeys.length) throw badRequest("receipt_attribution_required", "Select at least one expense list for this receipt.");
  const effective = receiptEffective(current);
  if (integerCents(effective.total_cents) <= 0) throw badRequest("receipt_total_required", "Enter the receipt total before applying it.");
  if (cleanText(effective.currency).toUpperCase() !== "USD") throw badRequest("unsupported_receipt_currency", "Project expense tracking currently requires a USD receipt total.");
  if (cleanText(asObject(current.extraction).amount_direction).toLowerCase() === "credit") throw badRequest("receipt_credit_review_required", "Credit documents require a dedicated credit allocation workflow before they can change project expenses.");
  const expenseSummary = await projectExpenseSummary(orgId, cleanText(current.project_id));
  const targetsByKey = new Map(asArray(expenseSummary.targets).map(asObject).map((target) => [cleanText(target.target_key), target]));
  const targetSnapshots = targetKeys.map((targetKey) => {
    const target = asObject(targetsByKey.get(targetKey));
    return {
      target_key: targetKey,
      title: cleanText(target.title),
      resource_type: cleanText(target.resource_type),
      projected_cents: integerCents(target.projected_cents)
    };
  });
  const appliedAt = nowIso();
  const reimbursement = asObject(input.reimbursement);
  const reimbursementPayee = asObject(reimbursement.payee_ref);
  const saved = await saveReceiptRecord(orgId, {
    ...current,
    status: "applied",
    attributed_target_keys: targetKeys,
    attribution: {
      target_keys: targetKeys,
      method: input.accepted_suggestion === true ? "suggested_confirmed" : "manual",
      confirmed_by: actor(ctx),
      confirmed_at: appliedAt,
      target_snapshots: targetSnapshots,
      metadata: asObject(input.attribution_metadata)
    },
    ...(Object.keys(reimbursementPayee).length ? { reimbursement: { payee_ref: reimbursementPayee, requested_at: appliedAt } } : {}),
    applied_at: appliedAt,
    updated_by_user_id: ctx.userId,
    updated_at: appliedAt
  }, Number(current.revision || 0));

  // Out-of-pocket receipts: applying with a reimbursement payee creates the
  // payable owed to that person (idempotent per receipt). The receipt's
  // attributed actuals track the project cost; the payable tracks the debt —
  // paying it flows through the normal disbursement path.
  let reimbursementPayable: JsonObject | null = null;
  if (Object.keys(reimbursementPayee).length && cleanText(reimbursementPayee.id)) {
    const { createPayable, listPayables } = await import("./storage.js");
    const payableId = `payment_payable_reimbursement_${cleanText(current.id)}`;
    const existing = (await listPayables(orgId, { project_id: cleanText(current.project_id) }))
      .find((payable) => cleanText(payable.id) === payableId);
    if (existing) {
      reimbursementPayable = existing;
    } else {
      const amountCents = Math.max(0, Math.round(Number(reimbursement.amount_cents || 0))) || integerCents(effective.total_cents);
      reimbursementPayable = await createPayable(orgId, {
        id: payableId,
        project_id: cleanText(current.project_id),
        kind: "reimbursement",
        payee_ref: reimbursementPayee,
        amount_cents: amountCents,
        source: { type: "receipt", id: cleanText(current.id) },
        notes: cleanText(reimbursement.note) || `Reimbursement for receipt ${cleanText(current.title) || cleanText(current.id)}`,
        metadata: { receipt_id: cleanText(current.id) }
      }, ctx);
    }
  }
  return { ...receiptView(saved), ...(reimbursementPayable ? { reimbursement_payable: reimbursementPayable } : {}) };
}

export async function reextractReceipt(orgId: string, receiptId: string, ctx: PlatformAuthContext) {
  const current = await readReceipt(orgId, receiptId);
  if (cleanText(current.status) === "void") throw conflict("receipt_voided", "A voided receipt cannot be re-extracted.");
  const file = asObject(current.file);
  const mediaId = cleanText(file.media_id);
  if (!mediaId) throw notFound("receipt_file_not_found", "The original receipt file was not found.");
  const original = await readMediaFile(orgId, mediaId, "original");
  const extraction = await extractReceipt({ bytes: original.bytes, fileName: original.fileName, contentType: original.contentType });
  const attempts = asArray(current.extraction_attempts).map(asObject);
  attempts.push({
    id: generatedId("receipt_extraction"),
    schema_version: RECEIPT_EXTRACTION_SCHEMA_VERSION,
    prompt_version: RECEIPT_EXTRACTION_PROMPT_VERSION,
    method: cleanText(extraction.method),
    status: cleanText(extraction.status),
    model: cleanText(extraction.model),
    response_id: cleanText(extraction.response_id),
    usage: asObject(extraction.usage),
    latency_ms: Number(extraction.latency_ms || 0),
    warnings: asArray(extraction.warnings),
    result: extraction,
    created_by_user_id: ctx.userId,
    created_at: nowIso()
  });
  const draft = { ...current, extraction, extraction_attempts: attempts };
  const effective = receiptEffective(draft);
  const applicationIssue = cleanText(current.status) === "applied" ? receiptApplicationIssue(draft) : "";
  const remainsApplied = cleanText(current.status) === "applied" && !applicationIssue;
  const suggestions = remainsApplied || !cleanText(current.project_id)
    ? uniqueText(current.suggested_target_keys)
    : await receiptSuggestionForProject(orgId, cleanText(current.project_id), integerCents(effective.total_cents));
  const saved = await saveReceiptRecord(orgId, {
    ...draft,
    status: remainsApplied ? "applied" : (integerCents(effective.total_cents) > 0 && !applicationIssue ? "ready" : "needs_review"),
    ...(applicationIssue ? { application_invalidated_at: nowIso(), application_invalid_reason: applicationIssue } : {}),
    suggested_target_keys: suggestions,
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  }, Number(current.revision || 0));
  const lastAttempt = asObject(attempts[attempts.length - 1]);
  await emitReceiptExtractedEvent(orgId, saved, cleanText(lastAttempt.id), ctx.userId);
  return receiptView(saved);
}

/**
 * Associates evidence that was uploaded from the field application with a
 * project after the caller has performed assignment-scoped authorization.
 * Keeping this mutation in the receipt domain preserves the receipt revision,
 * evidence history, project document reference, and attribution suggestions.
 */
export async function associateReceiptWithProject(
  orgId: string,
  receiptId: string,
  projectId: string,
  ctx: PlatformAuthContext,
  metadataValue: JsonObject = {}
) {
  const current = await readReceipt(orgId, receiptId);
  if (cleanText(current.status) === "void") throw conflict("receipt_voided", "A voided receipt cannot be associated with a project.");
  const existingProjectId = cleanText(current.project_id);
  if (existingProjectId && existingProjectId !== projectId) {
    throw conflict("receipt_project_conflict", "This receipt is already associated with another project.");
  }
  await readDocument(orgId, "projects", projectId);
  const associations = asArray(current.associations).map(asObject);
  if (!associations.some((entry) => cleanText(entry.kind) === "project" && cleanText(entry.id) === projectId)) {
    associations.push({
      kind: "project",
      id: projectId,
      role: "material_evidence",
      verification: { status: "verified", method: "assigned_project_access" },
      metadata: asObject(metadataValue)
    });
  }
  let libraryDocument = asObject(current.library_document);
  const mediaId = cleanText(asObject(current.file).media_id);
  if (mediaId && !Object.keys(libraryDocument).length) {
    const media = await readMediaMetadata(orgId, mediaId);
    libraryDocument = await attachReceiptToProjectLibrary(
      orgId,
      projectId,
      receiptId,
      media,
      receiptFileSupport(
        cleanText(asObject(current.file).file_name || media.file_name),
        cleanText(asObject(current.file).content_type || media.content_type),
        Number(asObject(current.file).size_bytes || media.size_bytes || 0)
      )
    );
  }
  const effective = receiptEffective(current);
  const suggestions = integerCents(effective.total_cents) > 0
    ? await receiptSuggestionForProject(orgId, projectId, integerCents(effective.total_cents))
    : uniqueText(current.suggested_target_keys);
  const saved = await saveReceiptRecord(orgId, {
    ...current,
    project_id: projectId,
    associations,
    library_document: libraryDocument,
    suggested_target_keys: suggestions,
    updated_by_user_id: ctx.userId,
    updated_at: nowIso(),
    metadata: {
      ...asObject(current.metadata),
      ...asObject(metadataValue),
      associated_from_field_at: nowIso()
    }
  }, Number(current.revision || 0));
  return receiptView(saved);
}

export async function voidReceipt(orgId: string, receiptId: string, ctx: PlatformAuthContext) {
  const current = await readReceipt(orgId, receiptId);
  if (cleanText(current.status) === "void") return receiptView(current);
  const saved = await saveReceiptRecord(orgId, {
    ...current,
    status: "void",
    voided_at: nowIso(),
    voided_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  }, Number(current.revision || 0));
  return receiptView(saved);
}

export async function readReceiptFile(orgId: string, receiptId: string) {
  const receipt = await readReceipt(orgId, receiptId);
  const mediaId = cleanText(asObject(receipt.file).media_id);
  if (!mediaId) throw notFound("receipt_file_not_found", "The original receipt file was not found.");
  return await readMediaFile(orgId, mediaId, "original");
}
