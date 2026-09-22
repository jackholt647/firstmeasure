import type { PlatformAuthContext } from "../platform/auth.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { transitionWorkNode } from "../work/service.js";
import { assignedProjectIdsForUser } from "../workforce/assignment_scope.js";
import { recordPayrollLedgerEntries } from "../payroll/service.js";
import { readPayrollLedgerEntry, voidPayrollLedgerEntry } from "../payroll/storage.js";
import { createDisbursement, createPayable, listPayables } from "./storage.js";
import { readReceipt, saveReceiptRecord } from "./expenses.js";
import { receiptView } from "./receipts.js";

const cleanText = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
const cents = (value: unknown) => Math.max(0, Math.round(Number(value || 0)));
const nowIso = () => new Date().toISOString();

function canManage(ctx: PlatformAuthContext) {
  const permissions = asObject(ctx.permissions);
  return permissions["*"] === true || permissions.manage_projects === true || permissions.manage_payroll === true
    || permissions.manage_company_settings === true || ["owner", "admin", "super_admin"].includes(cleanText(ctx.role).toLowerCase());
}

function canRequest(ctx: PlatformAuthContext) {
  const permissions = asObject(ctx.permissions);
  return permissions["crew.reimbursements.request"] === true || (permissions["crew.reimbursements.request"] !== false && permissions["*"] === true);
}

async function requireFeature(orgId: string) {
  if (!await isCapabilityEnabled(orgId, "crew.reimbursements")) {
    throw forbidden("reimbursements_disabled", "Employee reimbursement requests are not enabled for this organization.");
  }
}

async function saveRequest(orgId: string, receipt: JsonObject, request: JsonObject, ctx: PlatformAuthContext) {
  const at = nowIso();
  return await saveReceiptRecord(orgId, {
    ...receipt,
    reimbursement_request: request,
    updated_by_user_id: ctx.userId,
    updated_at: at
  }, Number(receipt.revision || 0));
}

async function notifyOffice(orgId: string, receipt: JsonObject, request: JsonObject, ctx: PlatformAuthContext) {
  const receiptId = cleanText(receipt.id);
  const requester = cleanText(asObject(request.requested_by).name || asObject(receipt.uploaded_by).name || "A crew member");
  const amount = cents(request.amount_cents);
  const attempt = Math.max(1, cents(request.attempt || 1));
  const title = `Reimbursement requested by ${requester}`;
  const { createCanonicalActionItem, createPlatformNotification } = await import("../platform/api.js");
  const action = await createCanonicalActionItem(orgId, {
    id: `reimbursement_request_${receiptId}_${attempt}`,
    kind: "review_reimbursement",
    title,
    body: `${requester} requested ${(amount / 100).toFixed(2)} USD for ${cleanText(receipt.title || asObject(receipt.file).file_name || "an uploaded receipt")}.`,
    project_ids: cleanText(request.project_id) ? [cleanText(request.project_id)] : [],
    assigned_role_ids: ["owner", "admin", "manager", "super_admin"],
    source: "crew_reimbursement",
    frontend_action: { tab: "receipts", reimbursement: receiptId },
    payload: { receipt_id: receiptId, reimbursement_request_id: cleanText(request.id), amount_cents: amount }
  }, ctx);
  await createPlatformNotification(orgId, {
    id: `notification_reimbursement_${receiptId}_${attempt}`,
    title,
    body: `Review the uploaded receipt and approve, reject, or request clarification.`,
    kind: "reimbursement_requested",
    project_id: cleanText(request.project_id),
    target_role_ids: ["owner", "admin", "manager", "super_admin"],
    push: true,
    passive: false,
    source: "crew_reimbursement",
    context: { receipt_id: receiptId, reimbursement_request_id: cleanText(request.id) }
  });
  return cleanText(action.id);
}

async function notifyRequester(orgId: string, receipt: JsonObject, request: JsonObject, title: string, body: string) {
  const userId = cleanText(asObject(request.requested_by).user_id || asObject(receipt.uploaded_by).user_id);
  if (!userId) return;
  const { createPlatformNotification } = await import("../platform/api.js");
  await createPlatformNotification(orgId, {
    id: `notification_reimbursement_${cleanText(receipt.id)}_${cleanText(request.status)}`,
    title, body, kind: "reimbursement_status", target_user_ids: [userId], push: true, passive: false,
    source: "crew_reimbursement", context: { receipt_id: cleanText(receipt.id), reimbursement_request_id: cleanText(request.id) }
  });
}

export async function submitReimbursementRequest(orgId: string, receiptId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireFeature(orgId);
  if (!canRequest(ctx)) throw forbidden("crew_permission_denied", "This user cannot request reimbursements.", { permission: "crew.reimbursements.request" });
  const receipt = await readReceipt(orgId, receiptId);
  if (cleanText(asObject(receipt.uploaded_by).user_id) !== ctx.userId) throw forbidden("receipt_forbidden", "Only the receipt uploader can request reimbursement.");
  const existing = asObject(receipt.reimbursement_request);
  if (existing.id && !["rejected", "canceled", "needs_clarification"].includes(cleanText(existing.status))) throw conflict("reimbursement_request_exists", "This receipt already has an active reimbursement request.");
  const fundingSource = cleanText(input.funding_source || "personal");
  if (!["personal", "company_card"].includes(fundingSource)) throw badRequest("invalid_funding_source", "Funding source must be personal or company_card.");
  let projectId = cleanText(input.project_id);
  if (projectId) {
    const assigned = await assignedProjectIdsForUser(orgId, ctx.userId);
    if (!assigned.has(projectId)) throw forbidden("crew_project_forbidden", "This reimbursement can only be attached to an assigned project.");
    await readDocument(orgId, "projects", projectId);
  }
  const effective = asObject(receiptView(receipt).effective);
  const amount = cents(input.amount_cents || effective.total_cents);
  if (fundingSource === "personal" && amount <= 0) throw badRequest("reimbursement_amount_required", "A reimbursement amount is required.");
  const at = nowIso();
  let request: JsonObject = {
    id: `reimbursement_request_${receiptId}`,
    status: fundingSource === "company_card" ? "not_required" : "submitted",
    funding_source: fundingSource,
    amount_cents: fundingSource === "company_card" ? 0 : amount,
    currency: cleanText(effective.currency || "USD") || "USD",
    project_id: projectId,
    note: cleanText(input.note),
    requested_by: { user_id: ctx.userId, name: cleanText(asObject(receipt.uploaded_by).name) },
    requested_at: at,
    updated_at: at
  };
  request.attempt = Math.max(1, cents(existing.attempt || 0) + 1);
  if (fundingSource === "personal") request.action_item_id = await notifyOffice(orgId, receipt, request, ctx);
  const saved = await saveRequest(orgId, receipt, request, ctx);
  return { receipt: receiptView(saved), reimbursement_request: request };
}

export async function listReimbursementRequests(orgId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireFeature(orgId);
  if (!canManage(ctx) && !canRequest(ctx)) throw forbidden("crew_permission_denied", "This user cannot view reimbursement requests.", { permission: "crew.reimbursements.request" });
  const docs = await import("../platform/storage.js").then(({ listDocuments }) => listDocuments(orgId, "payment_receipts"));
  let rows: JsonObject[] = docs.map((doc): JsonObject => ({ ...asObject(doc.data), revision: doc.revision }))
    .filter((receipt) => cleanText(asObject(receipt.reimbursement_request).id));
  if (!canManage(ctx)) rows = rows.filter((receipt) => cleanText(asObject(asObject(receipt.reimbursement_request).requested_by).user_id) === ctx.userId);
  const status = cleanText(input.status);
  if (status) rows = rows.filter((receipt) => cleanText(asObject(receipt.reimbursement_request).status) === status);
  const payables = canManage(ctx) ? await listPayables(orgId, { include_void: true }) : [];
  return rows.map((receipt) => {
    const request = asObject(receipt.reimbursement_request);
    const payable = payables.find((item) => cleanText(item.id) === cleanText(request.payable_id));
    const settled = cleanText(payable?.status) === "paid";
    return { receipt: receiptView(receipt), reimbursement_request: { ...request, ...(settled ? { status: "paid", paid_at: cleanText(payable?.updated_at) } : {}), ...(payable ? { payable } : {}) } };
  }).sort((a, b) => cleanText(asObject(b.reimbursement_request).requested_at).localeCompare(cleanText(asObject(a.reimbursement_request).requested_at)));
}

export async function syncPaidReimbursementPayables(orgId: string, payableIds: string[], ctx: PlatformAuthContext) {
  if (!payableIds.length) return;
  const docs = await import("../platform/storage.js").then(({ listDocuments }) => listDocuments(orgId, "payment_receipts"));
  for (const doc of docs) {
    const receipt: JsonObject = { ...asObject(doc.data), revision: doc.revision };
    const request = asObject(receipt.reimbursement_request);
    if (!payableIds.includes(cleanText(request.payable_id)) || cleanText(request.status) === "paid") continue;
    const next = { ...request, status: "paid", payroll_status: cleanText(request.payment_timing) === "next_payroll" ? "paid" : "off_cycle_paid", paid_by_user_id: ctx.userId, paid_at: nowIso(), updated_at: nowIso() };
    const saved = await saveRequest(orgId, receipt, next, ctx);
    await notifyRequester(orgId, saved, next, "Reimbursement paid", "The reimbursement has been marked paid.");
  }
}

async function completeTodo(orgId: string, request: JsonObject, ctx: PlatformAuthContext, reason: string) {
  const nodeId = cleanText(request.action_item_id);
  if (!nodeId) return;
  await transitionWorkNode(orgId, nodeId, "completed", { actor_user_id: ctx.userId, reason }).catch(() => null);
}

export async function actOnReimbursementRequest(orgId: string, receiptId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireFeature(orgId);
  if (!canManage(ctx)) throw forbidden("reimbursement_manage_forbidden", "Managing reimbursements requires project or payroll management access.");
  const receipt = await readReceipt(orgId, receiptId);
  const current = asObject(receipt.reimbursement_request);
  if (!current.id) throw notFound("reimbursement_request_not_found", "This receipt has no reimbursement request.");
  const action = cleanText(input.action);
  if (action === "reject" || action === "needs_clarification") {
    const status = action === "reject" ? "rejected" : "needs_clarification";
    const request = { ...current, status, review_note: cleanText(input.note), reviewed_by_user_id: ctx.userId, reviewed_at: nowIso(), updated_at: nowIso() };
    const saved = await saveRequest(orgId, receipt, request, ctx);
    await completeTodo(orgId, request, ctx, status);
    await notifyRequester(orgId, saved, request, status === "rejected" ? "Reimbursement declined" : "Receipt needs clarification", cleanText(input.note) || "Open the receipt in Crew for details.");
    return { receipt: receiptView(saved), reimbursement_request: request };
  }
  if (action !== "approve" && action !== "mark_paid") throw badRequest("invalid_reimbursement_action", "Action must be approve, reject, needs_clarification, or mark_paid.");
  let request = { ...current };
  if (action === "approve") {
    if (!["submitted", "needs_clarification"].includes(cleanText(current.status))) throw conflict("reimbursement_not_reviewable", "This reimbursement is not awaiting approval.");
    const projectId = cleanText(input.project_id || current.project_id || receipt.project_id);
    const amount = cents(input.amount_cents || current.amount_cents);
    if (amount <= 0) throw badRequest("reimbursement_amount_required", "A reimbursement amount is required before approval.");
    if (projectId) await readDocument(orgId, "projects", projectId);
    const timing = cleanText(input.payment_timing || "next_payroll");
    if (!["next_payroll", "off_cycle"].includes(timing)) throw badRequest("invalid_reimbursement_timing", "Payment timing must be next_payroll or off_cycle.");
    const payableId = `payment_payable_reimbursement_${receiptId}`;
    let payable = (await listPayables(orgId, { include_void: true })).find((item) => cleanText(item.id) === payableId);
    if (!payable) payable = await createPayable(orgId, {
      id: payableId, project_id: projectId, kind: "reimbursement", amount_cents: amount,
      payee_ref: { kind: "organization_user", id: cleanText(asObject(current.requested_by).user_id), name: cleanText(asObject(current.requested_by).name) },
      source: { type: "receipt", id: receiptId }, notes: cleanText(current.note) || `Reimbursement for ${cleanText(receipt.title || asObject(receipt.file).file_name || receiptId)}`,
      metadata: { receipt_id: receiptId, reimbursement_request_id: cleanText(current.id) }
    }, ctx);
    let payrollEntryId = "";
    let payrollStatus = timing === "off_cycle" ? "off_cycle" : "queued";
    if (timing === "next_payroll") {
      const entry = (await recordPayrollLedgerEntries(orgId, [{
          id: `pay_entry_reimbursement_${receiptId}`,
          payee: { type: "organization_user", id: cleanText(asObject(current.requested_by).user_id), name: cleanText(asObject(current.requested_by).name), worker_type: "employee" },
          schedule_id: cleanText(input.schedule_id), kind: "reimbursement", subgroup: "reimbursement", state: "accrued", amount_cents: amount,
          currency: cleanText(current.currency || "USD"), project_id: projectId, completed_at: nowIso(), eligible_at: nowIso(),
          source_event_id: cleanText(current.id), source_trigger_id: receiptId, description: `Expense reimbursement: ${cleanText(receipt.title || asObject(receipt.file).file_name || receiptId)}`,
          metadata: { receipt_id: receiptId, reimbursement_request_id: cleanText(current.id), payable_id: payableId, payment_timing: timing }
        } as never]))[0];
      payrollEntryId = cleanText(entry?.id);
      payrollStatus = cleanText(entry?.schedule_id) ? "queued" : "schedule_required";
    }
    request = { ...current, status: "approved", project_id: projectId, amount_cents: amount, payment_timing: timing, payable_id: payableId, payroll_entry_id: payrollEntryId, payroll_status: payrollStatus, approved_by_user_id: ctx.userId, approved_at: nowIso(), updated_at: nowIso() };
    const saved = await saveRequest(orgId, receipt, request, ctx);
    await completeTodo(orgId, request, ctx, "approved");
    await notifyRequester(orgId, saved, request, "Reimbursement approved", timing === "next_payroll" ? "Your reimbursement is queued with payroll." : "Your reimbursement is approved for an off-cycle payment.");
    return { receipt: receiptView(saved), reimbursement_request: { ...request, payable } };
  }
  const payableId = cleanText(current.payable_id);
  if (!payableId) throw badRequest("reimbursement_payable_required", "Approve this reimbursement before marking it paid.");
  const payable = (await listPayables(orgId, { include_void: true })).find((item) => cleanText(item.id) === payableId);
  if (!payable) throw notFound("reimbursement_payable_not_found", "The reimbursement payable was not found.");
  if (cleanText(payable.status) !== "paid") await createDisbursement(orgId, {
    id: `payment_disbursement_reimbursement_${receiptId}`, project_id: cleanText(payable.project_id), payable_ids: [payableId],
    amount_cents: Math.max(0, cents(payable.amount_cents) - cents(payable.paid_cents)), kind: "reimbursement", method: { type: "manual", label: "Off-cycle reimbursement" },
    notes: cleanText(input.note), metadata: { receipt_id: receiptId, reimbursement_request_id: cleanText(current.id) }
  }, ctx);
  if (cleanText(current.payroll_entry_id)) {
    try { const entry = (await readPayrollLedgerEntry(orgId, cleanText(current.payroll_entry_id))); if (!Number(entry.applied_cents || 0)) (await voidPayrollLedgerEntry(orgId, cleanText(current.payroll_entry_id), { reimbursement_paid_off_cycle: true })); } catch {}
  }
  request = { ...current, status: "paid", payroll_status: cleanText(current.payment_timing) === "next_payroll" ? "paid" : "off_cycle_paid", paid_by_user_id: ctx.userId, paid_at: nowIso(), updated_at: nowIso() };
  const saved = await saveRequest(orgId, receipt, request, ctx);
  await notifyRequester(orgId, saved, request, "Reimbursement paid", "The reimbursement has been marked paid.");
  return { receipt: receiptView(saved), reimbursement_request: request };
}

export async function syncPaidPayrollReimbursements(orgId: string, batch: JsonObject, ctx: PlatformAuthContext) {
  for (const itemValue of Array.isArray(batch.items) ? batch.items : []) {
    const item = asObject(itemValue);
    if (cleanText(item.status) !== "paid") continue;
    for (const entryValue of Array.isArray(item.entries) ? item.entries : []) {
      const entry = asObject(entryValue);
      if (cleanText(entry.kind) !== "reimbursement") continue;
      const metadata = asObject(entry.metadata);
      const receiptId = cleanText(metadata.receipt_id);
      if (!receiptId) continue;
      const receipt = await readReceipt(orgId, receiptId).catch(() => null);
      if (!receipt) continue;
      const request = asObject(receipt.reimbursement_request);
      if (cleanText(request.status) === "paid") continue;
      await actOnReimbursementRequest(orgId, receiptId, { action: "mark_paid", note: `Paid with payroll batch ${cleanText(batch.id)}` }, ctx);
    }
  }
}
