import { z } from "zod";

import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  listDocuments,
  listOrganizations,
  readDocument,
  readMediaFile,
  readMediaMetadata,
  storeMediaUpload,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { readInternalUser } from "../internal/storage.js";
import { getMerchantConfig } from "./merchant_config.js";
import { getPaymentProvider } from "./providers/index.js";
import { disputeIsOpen, PAYMENT_DISPUTE_COLLECTION, resolveTransactionsByProviderPaymentIds } from "./payouts.js";
import { PAYMENT_TRANSACTION_COLLECTION, recordPaymentEvent } from "./storage.js";

/**
 * Disputes (chargebacks), GP-76.
 *
 * `payment_disputes` holds one record per processor dispute, projected from
 * Forward's dispute object. Two paths fill it: `v2.dispute.*` webhooks and a
 * pull of `GET /disputes` (`syncDisputesFromProvider`), so the list is whole
 * even when a webhook never arrived.
 *
 * Forward's dispute API is read-only: nothing can accept, contest or upload
 * evidence through it. The organization writes its response here (a decision,
 * a rebuttal, the evidence the card networks ask for and files), submits it,
 * and FirstMate staff file it in Forward's portal and mark it filed. The
 * response lives on the dispute record (`response`) and survives every
 * projection.
 */

export const DISPUTE_EVIDENCE_SLOT = "dispute_evidence";
const MAX_EVIDENCE_FILES = 20;
const SYNC_MIN_INTERVAL_MS = 30_000;
const SYNC_MAX_PAGES = 40;
const SYNC_PAGE_SIZE = 50;
const RESPONSE_STATUSES = ["draft", "submitted", "returned", "filed"] as const;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function nowIso() {
  return new Date().toISOString();
}

function documentView(doc: unknown): JsonObject {
  const source = asObject(doc);
  const data = asObject(source.data);
  return {
    ...data,
    id: cleanText(data.id || source.id),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

function stableDocId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

export function disputeDocId(providerDisputeId: string) {
  return `payment_dispute_${stableDocId(providerDisputeId)}`;
}

async function requireMoneyFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) {
    throw forbidden("app_flag_disabled", "Money is not enabled for this organization.");
  }
}

/** The fields a processor dispute object gives, in our names. Missing fields keep what was stored. */
function projectProviderDispute(raw: JsonObject, existing: JsonObject) {
  const meta = asObject(raw.reference_meta);
  const keep = (value: unknown, key: string) => cleanText(value) || cleanText(existing[key]);
  const notes = asArray(raw.notes).map(asObject).map((note) => ({
    id: cleanText(note.id),
    message: cleanText(note.message),
    created_at: cleanText(note.created_at),
    user_id: cleanText(note.user_id)
  }));
  const attachments = asArray(raw.attachments).map(asObject).map((file) => ({
    id: cleanText(file.id),
    description: cleanText(file.description),
    file_id: cleanText(file.file_id),
    created_at: cleanText(file.created_at)
  }));
  const reasonCode = raw.reason_disputed_code ?? existing.reason_code;
  return {
    provider_payment_intent_id: keep(raw.payment_intent_id, "provider_payment_intent_id"),
    provider_account_id: keep(raw.account_id, "provider_account_id"),
    amount_cents: cents(raw.amount ?? raw.amount_disputed ?? raw.amount_cents ?? existing.amount_cents),
    currency: (cleanText(raw.currency) || cleanText(existing.currency) || "USD").toUpperCase(),
    reason: keep(raw.reason_disputed || raw.reason, "reason"),
    reason_code: reasonCode === undefined || reasonCode === null || cleanText(reasonCode) === "" ? "" : cleanText(reasonCode),
    respond_by: keep(raw.response_due_date || raw.respond_by || raw.evidence_due_by, "respond_by"),
    original_respond_by: keep(raw.original_response_due_date, "original_respond_by"),
    dispute_date: keep(raw.dispute_date, "dispute_date"),
    received_date: keep(raw.dispute_received_date, "received_date"),
    closed_date: keep(raw.closed_date, "closed_date"),
    disposition_date: keep(raw.disposition_date, "disposition_date"),
    filed_response: keep(raw.dispute_response, "filed_response"),
    provider_notes: Array.isArray(raw.notes) ? notes : asArray(existing.provider_notes),
    provider_attachments: Array.isArray(raw.attachments) ? attachments : asArray(existing.provider_attachments),
    card_last4: keep(meta.card_last_four, "card_last4"),
    authorization_code: keep(meta.authorization_code, "authorization_code"),
    transaction_date: keep(meta.transaction_date, "transaction_date"),
    transaction_amount_cents: meta.transaction_amount !== undefined ? cents(meta.transaction_amount) : cents(existing.transaction_amount_cents),
    retrieval_reference: keep(meta.retrieval_reference, "retrieval_reference"),
    settlement_status: keep(raw.settlement_status, "settlement_status"),
    provider_created_at: keep(raw.created_at, "provider_created_at"),
    provider_updated_at: keep(raw.updated_at, "provider_updated_at")
  };
}

/**
 * Writes one processor dispute into `payment_disputes`, linking it to our
 * payment (and so its project) and keeping the organization's response.
 */
async function saveProviderDispute(orgId: string, raw: JsonObject, options: { status: string; eventType?: string; event?: JsonObject; source: string }) {
  const providerDisputeId = cleanText(raw.id);
  if (!providerDisputeId) return null;
  const disputeId = disputeDocId(providerDisputeId);
  const existing = documentView(await readDocument(orgId, PAYMENT_DISPUTE_COLLECTION, disputeId).catch(() => null));
  const now = nowIso();

  const providerPaymentId = cleanText(raw.payment_id || raw.payment || existing.provider_payment_id);
  let transactionId = cleanText(existing.transaction_id);
  if (!transactionId) {
    const userFields = asObject(raw.user_fields);
    transactionId = cleanText(userFields.payment_id || raw.reference_id);
    if (!transactionId && providerPaymentId) {
      const matched = await resolveTransactionsByProviderPaymentIds(orgId, [providerPaymentId]);
      transactionId = cleanText(matched[0]?.id);
    }
  }
  const transaction = transactionId
    ? documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, transactionId).catch(() => null))
    : {};

  const data: JsonObject = {
    ...existing,
    ...projectProviderDispute(raw, existing),
    id: disputeId,
    organization_id: orgId,
    provider: cleanText(raw.provider || existing.provider || "forward"),
    provider_dispute_id: providerDisputeId,
    provider_payment_id: providerPaymentId,
    transaction_id: cleanText(transaction.id) || transactionId,
    project_id: cleanText(transaction.project_id || existing.project_id),
    status: options.status,
    opened_at: cleanText(existing.opened_at) || cleanText(raw.opened_at || raw.created_at) || now,
    last_source: options.source,
    ...(options.eventType ? { last_event_type: options.eventType, last_event: options.event || {} } : {}),
    last_synced_at: options.source === "sync" ? now : cleanText(existing.last_synced_at),
    created_at: cleanText(existing.created_at) || now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_DISPUTE_COLLECTION, {
    id: disputeId,
    data,
    metadata: {
      kind: "payment_dispute",
      provider: cleanText(data.provider),
      status: options.status,
      provider_dispute_id: providerDisputeId,
      transaction_id: cleanText(data.transaction_id),
      response_status: cleanText(asObject(data.response).status)
    }
  }, { replace: true });
  return documentView(doc);
}

/** Projects a v2.dispute.* event into the payment_disputes collection. */
export async function upsertDisputeFromEvent(orgId: string, eventType: string, event: JsonObject) {
  const data = asObject(event.data);
  if (!cleanText(data.id)) return null;
  const existing = documentView(await readDocument(orgId, PAYMENT_DISPUTE_COLLECTION, disputeDocId(cleanText(data.id))).catch(() => null));
  const suffixStatus = cleanText(eventType.split(".").pop());
  const status = cleanText(data.status).toLowerCase()
    || (suffixStatus === "updated" ? cleanText(existing.status) || "created" : suffixStatus) || "created";
  return saveProviderDispute(orgId, data, { status, eventType, event, source: "webhook" });
}

const lastSyncAt = new Map<string, number>();

/**
 * Pulls every dispute the processor has for this organization's merchant
 * account (newest first, 50 a page) into `payment_disputes`. At most once per
 * 30 seconds per organization unless forced; a processor error is reported,
 * never thrown, so the stored list still shows.
 */
export async function syncDisputesFromProvider(orgId: string, options: { force?: boolean } = {}) {
  await requireMoneyFlag(orgId);
  const last = lastSyncAt.get(orgId) || 0;
  if (!options.force && Date.now() - last < SYNC_MIN_INTERVAL_MS) return { ok: true, skipped: true, synced: 0 };
  const provider = await getPaymentProvider(orgId).catch(() => null);
  if (!provider) return { ok: true, available: false, synced: 0 };
  lastSyncAt.set(orgId, Date.now());
  const accountId = cleanText((await getMerchantConfig(orgId).catch(() => null))?.forward?.account_id);
  const seen = new Set<string>();
  let synced = 0;
  let cursor = "";
  try {
    for (let page = 0; page < SYNC_MAX_PAGES; page += 1) {
      const disputes = await provider.listDisputes({ limit: SYNC_PAGE_SIZE, ...(cursor ? { starting_after: cursor } : {}) });
      let added = 0;
      for (const dispute of disputes) {
        const raw = asObject(dispute.raw);
        const id = cleanText(dispute.id || raw.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        added += 1;
        // The partner key can see every merchant; keep only this account's.
        if (accountId && cleanText(raw.account_id) && cleanText(raw.account_id) !== accountId) continue;
        await saveProviderDispute(orgId, { ...raw, id }, {
          status: cleanText(raw.status).toLowerCase() || "new",
          source: "sync"
        });
        synced += 1;
      }
      if (disputes.length < SYNC_PAGE_SIZE || !added) break;
      cursor = cleanText(disputes[disputes.length - 1]?.id);
    }
  } catch (error) {
    lastSyncAt.set(orgId, 0);
    return { ok: false, synced, error: cleanText((error as Error)?.message) || "The processor could not be reached." };
  }
  return { ok: true, synced, synced_at: nowIso() };
}

export async function listDisputes(orgId: string, input: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const status = cleanText(input.status).toLowerCase();
  return (await listDocuments(orgId, PAYMENT_DISPUTE_COLLECTION)).map(documentView)
    .filter((dispute) => !status || cleanText(dispute.status).toLowerCase() === status)
    .map(disputeSummary)
    .sort((a, b) => cleanText(b.opened_at || b.created_at).localeCompare(cleanText(a.opened_at || a.created_at)));
}

/** A dispute without its raw processor event (the list never needs it). */
function disputeSummary(dispute: JsonObject): JsonObject {
  const { last_event: _event, ...rest } = dispute;
  return { ...rest, open: disputeIsOpen(dispute) };
}

async function readDispute(orgId: string, disputeId: string) {
  const doc = await readDocument(orgId, PAYMENT_DISPUTE_COLLECTION, cleanText(disputeId)).catch(() => null);
  if (!doc) throw notFound("dispute_not_found", "This dispute was not found.");
  return documentView(doc);
}

/** The dispute, the payment it is about and that payment's project and customer. */
export async function getDisputeDetail(orgId: string, disputeId: string, options: { skipFlag?: boolean } = {}) {
  if (!options.skipFlag) await requireMoneyFlag(orgId);
  const dispute = await readDispute(orgId, disputeId);
  const transactionId = cleanText(dispute.transaction_id);
  const transaction = transactionId
    ? documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, transactionId).catch(() => null))
    : {};
  const projectId = cleanText(dispute.project_id || transaction.project_id);
  const project = projectId ? documentView(await readDocument(orgId, "projects", projectId).catch(() => null)) : {};
  const contact = asObject(transaction.contact_ref);
  const method = asObject(transaction.method);
  return {
    dispute: disputeSummary(dispute),
    payment: cleanText(transaction.id) ? {
      id: cleanText(transaction.id),
      amount_cents: cents(transaction.amount_cents),
      currency: cleanText(transaction.currency) || "USD",
      status: cleanText(transaction.status),
      received_at: cleanText(transaction.received_at || transaction.created_at),
      method: cleanText(method.type || method.kind || method.label),
      invoice_id: cleanText(asObject(transaction.metadata).invoice_id),
      payer_name: cleanText(contact.name || contact.display_name)
    } : null,
    project: cleanText(project.id) ? {
      id: cleanText(project.id),
      title: cleanText(project.title || project.customer_name || project.address),
      address: cleanText(project.address),
      customer_name: cleanText(project.customer_name || project.customerName)
    } : null
  };
}

const evidenceValue = z.string().max(20_000);
export const disputeResponseSchema = z.object({
  action: z.enum(["save", "submit", "reopen"]).default("save"),
  decision: z.enum(["contest", "accept"]).optional(),
  category: z.string().trim().max(60).optional(),
  summary: z.string().max(20_000).optional(),
  evidence: z.record(z.string().max(80), evidenceValue).optional(),
  attachments: z.array(z.object({
    media_id: z.string().trim().min(1).max(200),
    label: z.string().trim().max(200).optional()
  })).max(MAX_EVIDENCE_FILES).optional()
});

export const disputeStaffActionSchema = z.object({
  action: z.enum(["filed", "return"]),
  note: z.string().trim().max(4000).optional()
});

function responseView(value: unknown) {
  const response = asObject(value);
  const status = cleanText(response.status);
  return {
    ...response,
    status: (RESPONSE_STATUSES as readonly string[]).includes(status) ? status : "",
    evidence: asObject(response.evidence),
    attachments: asArray(response.attachments).map(asObject),
    history: asArray(response.history).map(asObject)
  };
}

async function writeResponse(orgId: string, dispute: JsonObject, response: JsonObject) {
  const data: JsonObject = { ...dispute, response, updated_at: nowIso() };
  delete data.open;
  const doc = await upsertDocument(orgId, PAYMENT_DISPUTE_COLLECTION, {
    id: cleanText(dispute.id),
    data,
    metadata: {
      kind: "payment_dispute",
      provider: cleanText(dispute.provider),
      status: cleanText(dispute.status),
      provider_dispute_id: cleanText(dispute.provider_dispute_id),
      transaction_id: cleanText(dispute.transaction_id),
      response_status: cleanText(response.status)
    }
  }, { replace: true });
  return disputeSummary(documentView(doc));
}

/** Evidence files must be this organization's uploads in the dispute evidence slot. */
async function checkedAttachments(orgId: string, input: Array<{ media_id: string; label?: string }>) {
  const files: JsonObject[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const mediaId = cleanText(entry.media_id);
    if (seen.has(mediaId)) continue;
    seen.add(mediaId);
    const media = asObject(await readMediaMetadata(orgId, mediaId).catch(() => null));
    const owner = asObject(media.owner);
    if (!cleanText(media.id) || cleanText(media.slot || owner.slot) !== DISPUTE_EVIDENCE_SLOT) {
      throw badRequest("dispute_evidence_invalid", "Attach files uploaded for this dispute.");
    }
    files.push({
      media_id: mediaId,
      file_name: cleanText(media.file_name) || mediaId,
      content_type: cleanText(media.content_type),
      size_bytes: cents(media.size_bytes),
      label: cleanText(entry.label)
    });
  }
  return files;
}

function actorOf(ctx: PlatformAuthContext) {
  const identity = asObject(ctx.identity);
  return {
    id: cleanText(ctx.userId),
    name: cleanText(identity.name || identity.display_name || identity.email),
    email: cleanText(identity.email).toLowerCase()
  };
}

/**
 * Saves, submits or reopens the organization's response. A submitted
 * response waits for FirstMate staff; one they filed can no longer change.
 */
export async function saveDisputeResponse(orgId: string, disputeId: string, input: z.infer<typeof disputeResponseSchema>, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const dispute = await readDispute(orgId, disputeId);
  const current = responseView(dispute.response);
  const actor = actorOf(ctx);
  const now = nowIso();
  if (current.status === "filed") throw conflict("dispute_response_filed", "This response was already filed with the processor.");
  if (input.action === "reopen") {
    if (current.status !== "submitted" && current.status !== "returned") return { dispute: disputeSummary(dispute) };
    const response = { ...current, status: "draft", history: [...current.history, { at: now, action: "reopened", by: actor.name || actor.email }] };
    await recordPaymentEvent(orgId, "dispute.response_reopened", { dispute_id: cleanText(dispute.id) }, ctx);
    return { dispute: await writeResponse(orgId, dispute, response) };
  }
  if (current.status === "submitted") throw conflict("dispute_response_submitted", "This response is with FirstMate. Edit it to change it.");
  const next: JsonObject = {
    ...current,
    status: current.status === "returned" ? "returned" : "draft",
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    ...(input.category !== undefined ? { category: cleanText(input.category) } : {}),
    ...(input.summary !== undefined ? { summary: input.summary.trim() } : {}),
    ...(input.evidence !== undefined ? {
      evidence: Object.fromEntries(Object.entries(input.evidence).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value))
    } : {}),
    ...(input.attachments !== undefined ? { attachments: await checkedAttachments(orgId, input.attachments) } : {}),
    updated_at: now,
    updated_by: actor.name || actor.email
  };
  if (input.action === "submit") {
    if (!disputeIsOpen(dispute)) throw conflict("dispute_closed", "This dispute is closed and no longer takes a response.");
    const decision = cleanText(next.decision);
    if (decision !== "contest" && decision !== "accept") throw badRequest("dispute_decision_required", "Choose whether to fight or accept this dispute.");
    if (decision === "contest" && cleanText(next.summary).length < 20) {
      throw badRequest("dispute_summary_required", "Explain why the charge is valid (at least a sentence).");
    }
    next.status = "submitted";
    next.submitted_at = now;
    next.submitted_by = actor.name || actor.email;
    next.submitted_by_email = actor.email;
    next.history = [...asArray(next.history), { at: now, action: "submitted", by: actor.name || actor.email }];
  }
  await recordPaymentEvent(orgId, input.action === "submit" ? "dispute.response_submitted" : "dispute.response_saved", {
    dispute_id: cleanText(dispute.id),
    provider_dispute_id: cleanText(dispute.provider_dispute_id),
    decision: cleanText(next.decision)
  }, ctx);
  return { dispute: await writeResponse(orgId, dispute, next) };
}

export const DISPUTE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const EVIDENCE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
};

export const disputeEvidenceUploadSchema = z.object({
  file_name: z.string().trim().min(1).max(240),
  content_type: z.string().trim().max(120),
  data_base64: z.string().min(1)
});

/** Stores one evidence file for a dispute (the response names it when saved). */
export async function uploadDisputeEvidence(orgId: string, disputeId: string, input: z.infer<typeof disputeEvidenceUploadSchema>, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const dispute = await readDispute(orgId, disputeId);
  if (responseView(dispute.response).status === "filed") throw conflict("dispute_response_filed", "This response was already filed with the processor.");
  const contentType = cleanText(input.content_type).toLowerCase().split(";")[0] || "";
  if (!EVIDENCE_TYPES[contentType]) throw badRequest("dispute_evidence_type", "Attach a PDF, an image, a Word document or a text file.");
  const base64 = input.data_base64.replace(/^data:[^,]*,/, "");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw badRequest("dispute_evidence_empty", "This file is empty.");
  if (bytes.length > DISPUTE_EVIDENCE_MAX_BYTES) throw badRequest("dispute_evidence_too_large", "Each file can be up to 10 MB.");
  const media = await storeMediaUpload(orgId, {
    ownerType: "organization",
    ownerId: orgId,
    slot: DISPUTE_EVIDENCE_SLOT,
    scope: "payments",
    fileName: cleanText(input.file_name).replace(/[\r\n"\\/]+/g, "_"),
    contentType,
    bytes,
    metadata: { dispute_id: cleanText(dispute.id), uploaded_by_user_id: cleanText(ctx.userId) }
  });
  const stored = asObject(media);
  return {
    media_id: cleanText(stored.id),
    file_name: cleanText(stored.file_name),
    content_type: cleanText(stored.content_type) || contentType,
    size_bytes: cents(stored.size_bytes) || bytes.length
  };
}

/** An evidence file attached to this dispute's response, for download. */
export async function readDisputeEvidenceFile(orgId: string, disputeId: string, mediaId: string) {
  const dispute = await readDispute(orgId, disputeId);
  const attached = responseView(dispute.response).attachments.some((file) => cleanText(file.media_id) === cleanText(mediaId));
  if (!attached) throw notFound("dispute_evidence_not_found", "This file is not attached to the dispute.");
  return readMediaFile(orgId, cleanText(mediaId));
}

/** Platform administrators: full internal admins, as for session replay. */
export async function isPlatformAdministrator(ctx: PlatformAuthContext) {
  const email = cleanText(asObject(ctx.identity).email).toLowerCase();
  const user = email ? await readInternalUser(email).catch(() => null) : null;
  if (!user || user.disabled || user.status !== "active") return false;
  const permissions = asObject(user.permissions);
  return ["admin", "system_admin"].includes(cleanText(user.role).toLowerCase())
    || user.is_admin === true || permissions.is_admin_legacy === true || permissions.platform_admin === true;
}

export async function requirePlatformAdministrator(ctx: PlatformAuthContext) {
  if (!(await isPlatformAdministrator(ctx))) throw forbidden("platform_admin_required", "Only FirstMate staff can file dispute responses.");
}

/**
 * Every organization's dispute responses waiting for (or filed by) FirstMate
 * staff, oldest submission first. Scans each organization's disputes
 * (docs/optimization-backlog.md, "Dispute filing queue scans organizations").
 */
export async function listDisputeFilingQueue(input: { status?: string } = {}) {
  const wanted = cleanText(input.status) || "submitted";
  const rows: JsonObject[] = [];
  for (const organization of await listOrganizations()) {
    const org = asObject(organization);
    const orgId = cleanText(org.id);
    if (!orgId) continue;
    const disputes = await listDocuments(orgId, PAYMENT_DISPUTE_COLLECTION).catch(() => [] as unknown[]);
    for (const dispute of disputes.map(documentView)) {
      const response = responseView(dispute.response);
      if (!response.status || response.status === "draft") continue;
      if (wanted !== "all" && response.status !== wanted) continue;
      rows.push({ ...disputeSummary(dispute), organization_id: orgId, organization_name: cleanText(org.name) || orgId });
    }
  }
  return rows.sort((a, b) => cleanText(asObject(a.response).submitted_at).localeCompare(cleanText(asObject(b.response).submitted_at)));
}

/** Staff mark a submitted response filed in the processor's portal, or send it back with a note. */
export async function staffActOnDisputeResponse(orgId: string, disputeId: string, input: z.infer<typeof disputeStaffActionSchema>, ctx: PlatformAuthContext) {
  const dispute = await readDispute(orgId, disputeId);
  const current = responseView(dispute.response);
  if (current.status !== "submitted") throw conflict("dispute_response_not_submitted", "Only a submitted response can be filed or sent back.");
  const actor = actorOf(ctx);
  const now = nowIso();
  const note = cleanText(input.note);
  const next: JsonObject = input.action === "filed"
    ? { ...current, status: "filed", filed_at: now, filed_by: actor.name || actor.email, ...(note ? { staff_note: note } : {}) }
    : { ...current, status: "returned", returned_at: now, returned_by: actor.name || actor.email, staff_note: note };
  next.history = [...current.history, { at: now, action: input.action === "filed" ? "filed" : "returned", by: actor.name || actor.email, ...(note ? { note } : {}) }];
  await recordPaymentEvent(orgId, input.action === "filed" ? "dispute.response_filed" : "dispute.response_returned", {
    dispute_id: cleanText(dispute.id),
    staff_email: actor.email
  }, ctx);
  return { dispute: await writeResponse(orgId, dispute, next) };
}
