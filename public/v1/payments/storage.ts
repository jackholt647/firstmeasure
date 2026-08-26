import { randomBytes } from "node:crypto";

import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import {
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";

export const PAYMENT_SCHEDULE_COLLECTION = "payment_schedules";
export const PAYMENT_OBLIGATION_COLLECTION = "payment_obligations";
export const PAYMENT_TRANSACTION_COLLECTION = "payment_transactions";
export const PAYMENT_ALLOCATION_COLLECTION = "payment_allocations";
export const PAYMENT_INTENT_COLLECTION = "payment_intents";
export const PAYMENT_PAYABLE_COLLECTION = "payment_payables";
export const PAYMENT_DISBURSEMENT_COLLECTION = "payment_disbursements";
export const PAYMENT_LEDGER_COLLECTION = "payment_ledger_events";
export const PAYMENT_EVENT_COLLECTION = "payment_events";

const PAYMENT_SCHEMA_VERSION = 1;

type ScheduleItem = {
  label: string;
  amount_cents: number;
  due_rule: string;
  due_at: string;
  grace_days: number;
  metadata?: JsonObject;
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

function documentData(doc: unknown) {
  return asObject(asObject(doc).data);
}

function documentView(doc: unknown): JsonObject {
  const source = asObject(doc);
  return {
    ...documentData(doc),
    id: cleanText(documentData(doc).id || source.id),
    revision: Number(source.revision || documentData(doc).revision || 0),
    created_at: cleanText(source.created_at || documentData(doc).created_at),
    updated_at: cleanText(source.updated_at || documentData(doc).updated_at)
  };
}

function moneyCents(input: JsonObject, fallback = 0) {
  if (Number.isFinite(Number(input.amount_cents))) return Math.round(Number(input.amount_cents));
  if (Number.isFinite(Number(input.cents))) return Math.round(Number(input.cents));
  if (Number.isFinite(Number(input.amount))) return Math.round(Number(input.amount) * 100);
  return fallback;
}

function numberCents(value: unknown) {
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : 0;
}

function currency(input: JsonObject, fallback = "USD") {
  return cleanText(input.currency || fallback).toUpperCase() || "USD";
}

function stableSourceId(value: unknown) {
  return cleanText(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

async function requireMoneyFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) {
    throw forbidden("app_flag_disabled", "Money is not enabled for this organization.");
  }
}

function primaryContactFromProject(project: JsonObject) {
  const contacts = asArray(project.contacts).map(asObject);
  const customer = asObject(project.customer);
  const primary = contacts.find((contact) => contact.primary === true || cleanText(contact.role).toLowerCase() === "primary") || contacts[0] || {};
  const id = cleanText(primary.id || primary.contact_id || customer.id || customer.contact_id || project.contact_id || project.primary_contact_id);
  return {
    ...(id ? { id, contact_id: id } : {}),
    name: cleanText(primary.name || customer.name || project.customer_name || project.customerName || project.primary_contact_name),
    email: cleanText(primary.email || customer.email || project.customer_email || project.customerEmail || project.primary_contact_email).toLowerCase(),
    phone: cleanText(primary.phone || customer.phone || project.customer_phone || project.customerPhone || project.primary_contact_phone),
    address: cleanText(primary.address || customer.address || project.customer_address || project.primary_contact_address)
  };
}

function contactFromProposal(snapshot: JsonObject, proposal: JsonObject, project: JsonObject) {
  const snapshotContacts = asArray(asObject(snapshot.contact_snapshot).contacts).map(asObject);
  const contacts = snapshotContacts.length ? snapshotContacts : asArray(proposal.contacts).map(asObject);
  const contact = contacts.find((item) => cleanText(item.role).toLowerCase() === "customer") || contacts[0] || {};
  return {
    ...primaryContactFromProject(project),
    ...contact,
    email: cleanText(contact.email || primaryContactFromProject(project).email).toLowerCase()
  };
}

function proposalPaymentContent(snapshot: JsonObject) {
  const content = asObject(snapshot.content);
  const payment = asObject(content.payment);
  const pages = asArray(content.pages).map(asObject);
  const signature = pages.find((page) => cleanText(page.kind).toLowerCase() === "signature") || {};
  return { content, payment, signature, pages };
}

function proposalTotalCents(content: JsonObject, signature: JsonObject, scheduleItems: ScheduleItem[]) {
  const pricing = asObject(content.pricing);
  const pricingTotal = numberCents(pricing.total ?? pricing.totalValue ?? pricing.contract_total);
  if (pricingTotal > 0) return pricingTotal;
  const signatureTotal = numberCents(signature.totalValue ?? signature.total ?? signature.contractAmount);
  if (signatureTotal > 0) return signatureTotal;
  return scheduleItems.reduce((sum, item) => sum + item.amount_cents, 0);
}

function scheduleFromProposalSnapshot(snapshot: JsonObject, signedAt: string): ScheduleItem[] {
  const { content, payment, signature } = proposalPaymentContent(snapshot);
  const explicit = asArray(payment.schedule || payment.items || payment.payment_schedule).map(asObject);
  if (explicit.length) {
    return explicit.map((item, index) => ({
      label: cleanText(item.label || item.name || `Payment ${index + 1}`),
      amount_cents: Math.max(0, moneyCents(item)),
      due_rule: cleanText(item.due_rule || item.dueRule || (index === 0 ? "on_signature" : "manual")) || "manual",
      due_at: cleanText(item.due_at || item.dueAt || (index === 0 ? signedAt : "")),
      grace_days: Number.isFinite(Number(item.grace_days ?? item.graceDays)) ? Math.max(0, Math.round(Number(item.grace_days ?? item.graceDays))) : 1,
      metadata: asObject(item.metadata)
    })).filter((item) => item.amount_cents > 0);
  }

  const deposit = numberCents(signature.depositAmount);
  const financed = numberCents(signature.financedAmount);
  const rawCompletion = numberCents(signature.completionAmount);
  const total = proposalTotalCents(content, signature, []);
  const completion = rawCompletion > 0 ? rawCompletion : Math.max(0, total - deposit - financed);
  const items: ScheduleItem[] = [];
  if (deposit > 0) {
    items.push({ label: cleanText(signature.depositLabel || "Deposit"), amount_cents: deposit, due_rule: "on_signature", due_at: signedAt, grace_days: 1 });
  }
  if (completion > 0) {
    items.push({ label: cleanText(signature.completionLabel || "Final Payment"), amount_cents: completion, due_rule: "project_completion", due_at: "", grace_days: 1 });
  }
  return items;
}

export function deriveObligationStatus(obligation: JsonObject, at = new Date()) {
  const amount = Math.max(0, Math.round(Number(obligation.amount_cents || 0)));
  const allocated = Math.max(0, Math.round(Number(obligation.allocated_cents || 0)));
  if (cleanText(obligation.status) === "void") return "void";
  if (amount > 0 && allocated >= amount) return "paid";
  if (allocated > 0) return "partially_paid";
  const dueAt = Date.parse(cleanText(obligation.due_at));
  if (!Number.isFinite(dueAt)) return "scheduled";
  if (dueAt > at.getTime()) return "scheduled";
  const graceDays = Math.max(0, Math.round(Number(obligation.grace_days ?? 1)));
  if (at.getTime() > dueAt + graceDays * 86_400_000) return "overdue";
  return "due";
}

async function recordPaymentEvent(orgId: string, type: string, payload: JsonObject = {}, ctx?: PlatformAuthContext | null) {
  const now = nowIso();
  const id = generatedId("payment_event");
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    type,
    payload,
    actor_user_id: ctx?.userId || cleanText(payload.actor_user_id),
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_EVENT_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_event", type, project_id: cleanText(payload.project_id) }
  }, { replace: true });
  return documentView(doc);
}

async function recordLedger(orgId: string, transaction: JsonObject, eventType: string, lines: JsonObject[]) {
  const now = nowIso();
  const id = generatedId("payment_ledger");
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    transaction_id: cleanText(transaction.id),
    project_id: cleanText(transaction.project_id),
    event_type: eventType,
    lines,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_LEDGER_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_ledger_event", transaction_id: cleanText(transaction.id), event_type: eventType, project_id: cleanText(transaction.project_id) }
  }, { replace: true });
  return documentView(doc);
}

async function patchProjectFinancialRefs(orgId: string, projectId: string) {
  if (!projectId) return null;
  const [projectDoc, schedules, transactions, obligations] = await Promise.all([
    readDocument(orgId, "projects", projectId).catch(() => null),
    listProjectPaymentSchedules(orgId, projectId, { skipFlag: true }).catch(() => []),
    listProjectPayments(orgId, projectId, { skipFlag: true }).catch(() => []),
    listProjectObligations(orgId, projectId, { skipFlag: true }).catch(() => [])
  ]);
  if (!projectDoc) return null;
  const project = documentData(projectDoc);
  const totalCollected = transactions
    .filter((payment) => cleanText(payment.direction) === "inbound" && ["settled", "partially_refunded"].includes(cleanText(payment.status)))
    .reduce((sum, payment) => sum + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0)
    - transactions
      .filter((payment) => cleanText(payment.direction) === "outbound" && cleanText(payment.kind) === "customer_refund")
      .reduce((sum, payment) => sum + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0);
  const totalDue = obligations.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.amount_cents || 0))), 0);
  const financial = {
    ...asObject(project.financial),
    payment_schedule_ids: schedules.map((item) => cleanText(item.id)).filter(Boolean),
    payment_ids: transactions.map((item) => cleanText(item.id)).filter(Boolean),
    total_collected_cents: totalCollected,
    total_remaining_cents: Math.max(0, totalDue - totalCollected),
    updated_at: nowIso()
  };
  const currentMetadata = asObject(asObject(projectDoc).metadata);
  const updated = await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...project, financial },
    metadata: { ...currentMetadata, kind: cleanText(currentMetadata.kind) || "platform_project", payment_ref_source: "payments_api" }
  }, { replace: true });
  return documentView(updated);
}

export async function ensureReceivablesForSignedProposal(orgId: string, proposalId: string, snapshotId: string, options: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const snapshotDoc = await readDocument(orgId, "proposal_snapshots", snapshotId);
  const snapshot = documentView(snapshotDoc);
  const proposalDoc = await readDocument(orgId, "proposals", proposalId).catch(() => null);
  const proposal = proposalDoc ? documentView(proposalDoc) : {};
  const projectId = cleanText(snapshot.project_id || proposal.project_id);
  if (!projectId) throw badRequest("missing_project_id", "Signed proposal snapshot is missing a project id.");
  const project = documentData(await readDocument(orgId, "projects", projectId));
  const signedAt = cleanText(asObject(snapshot.delivery).signed_at || snapshot.signed_at || options.signed_at) || nowIso();
  const items = scheduleFromProposalSnapshot(snapshot, signedAt);
  const sourceKey = `proposal_signed:${proposalId}:${snapshotId}`;
  const scheduleDocs = (await listDocuments(orgId, PAYMENT_SCHEDULE_COLLECTION)).map(documentView);
  const now = nowIso();
  for (const schedule of scheduleDocs) {
    const source = asObject(schedule.source);
    const sameProposal = cleanText(source.id) === proposalId;
    const sameSnapshot = cleanText(source.snapshot_id) === snapshotId;
    if (!sameProposal || sameSnapshot || ["superseded", "void", "archived"].includes(cleanText(schedule.status))) continue;
    await upsertDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, {
      id: cleanText(schedule.id),
      data: {
        ...schedule,
        status: "superseded",
        superseded_by_snapshot_id: snapshotId,
        updated_at: now
      },
      metadata: { kind: "payment_schedule", project_id: projectId, proposal_id: proposalId, proposal_snapshot_id: cleanText(source.snapshot_id), status: "superseded" }
    }, { replace: true });
  }
  const existing = scheduleDocs
    .find((schedule) => cleanText(asObject(schedule.source).id) === proposalId && cleanText(asObject(schedule.source).snapshot_id) === snapshotId);
  if (existing) {
    return {
      schedule: existing,
      obligations: (await listProjectObligations(orgId, projectId, { skipFlag: true })).filter((item) => cleanText(item.schedule_id) === cleanText(existing.id)),
      created: false
    };
  }

  const scheduleId = `payment_schedule_${stableSourceId(`${proposalId}_${snapshotId}`)}`;
  const contactRef = contactFromProposal(snapshot, proposal, project);
  const { content, signature } = proposalPaymentContent(snapshot);
  const total = proposalTotalCents(content, signature, items);
  const scheduleData = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id: scheduleId,
    organization_id: orgId,
    branch_id: cleanText(snapshot.branch_id || proposal.branch_id || project.branch_id || "default") || "default",
    project_id: projectId,
    contact_ref: contactRef,
    source: { type: "proposal", id: proposalId, snapshot_id: snapshotId, event_key: sourceKey },
    title: cleanText(snapshot.title || proposal.title || "Proposal"),
    total_cents: total || items.reduce((sum, item) => sum + item.amount_cents, 0),
    currency: "USD",
    status: "active",
    items: items.map((item, index) => ({ ...item, sequence: index + 1 })),
    created_at: now,
    updated_at: now
  };
  const scheduleDoc = await upsertDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, {
    id: scheduleId,
    data: scheduleData,
    metadata: { kind: "payment_schedule", project_id: projectId, proposal_id: proposalId, proposal_snapshot_id: snapshotId, source_key: sourceKey }
  }, { replace: true });

  const obligations = [];
  for (const [index, item] of items.entries()) {
    const obligationId = `payment_obligation_${stableSourceId(`${proposalId}_${snapshotId}_${index + 1}`)}`;
    const obligationData = {
      schema_version: PAYMENT_SCHEMA_VERSION,
      id: obligationId,
      organization_id: orgId,
      branch_id: cleanText(scheduleData.branch_id),
      project_id: projectId,
      contact_ref: contactRef,
      source: { type: "proposal", id: proposalId, snapshot_id: snapshotId },
      schedule_id: scheduleId,
      label: item.label,
      sequence: index + 1,
      direction: "inbound",
      amount_cents: item.amount_cents,
      currency: "USD",
      due_rule: item.due_rule,
      due_at: item.due_at,
      grace_days: item.grace_days,
      allocated_cents: 0,
      refunded_cents: 0,
      status: deriveObligationStatus({ ...item, amount_cents: item.amount_cents, allocated_cents: 0 }),
      metadata: asObject(item.metadata),
      created_at: now,
      updated_at: now
    };
    const doc = await upsertDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, {
      id: obligationId,
      data: obligationData,
      metadata: { kind: "payment_obligation", project_id: projectId, schedule_id: scheduleId, proposal_id: proposalId }
    }, { replace: true });
    obligations.push(documentView(doc));
  }
  await recordPaymentEvent(orgId, "payment_schedule.created_from_signed_proposal", { project_id: projectId, proposal_id: proposalId, snapshot_id: snapshotId, schedule_id: scheduleId });
  await patchProjectFinancialRefs(orgId, projectId);
  return { schedule: documentView(scheduleDoc), obligations, created: true };
}

export async function listProjectPaymentSchedules(orgId: string, projectId: string, options: { skipFlag?: boolean } = {}): Promise<JsonObject[]> {
  if (!options.skipFlag) await requireMoneyFlag(orgId);
  const docs = await listDocuments(orgId, PAYMENT_SCHEDULE_COLLECTION);
  return docs.map(documentView)
    .filter((item) => cleanText(item.project_id) === projectId)
    .filter((item) => !["superseded", "void", "archived"].includes(cleanText(item.status)))
    .sort((a, b) => cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

export async function listProjectObligations(orgId: string, projectId: string, options: { skipFlag?: boolean } = {}): Promise<JsonObject[]> {
  if (!options.skipFlag) await requireMoneyFlag(orgId);
  const docs = await listDocuments(orgId, PAYMENT_OBLIGATION_COLLECTION);
  return docs.map(documentView)
    .filter((item) => cleanText(item.project_id) === projectId)
    .map((item): JsonObject => ({ ...item, status: deriveObligationStatus(item) }))
    .sort((a, b) => {
      const aDue = cleanText(a.due_at) || "9999-12-31T23:59:59.999Z";
      const bDue = cleanText(b.due_at) || "9999-12-31T23:59:59.999Z";
      const due = aDue.localeCompare(bDue);
      if (due) return due;
      return Number(a.sequence || 0) - Number(b.sequence || 0);
    });
}

export async function listProjectPayments(orgId: string, projectId: string, options: { skipFlag?: boolean } = {}): Promise<JsonObject[]> {
  if (!options.skipFlag) await requireMoneyFlag(orgId);
  const docs = await listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION);
  return docs.map(documentView)
    .filter((item) => cleanText(item.project_id) === projectId)
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

async function saveObligation(orgId: string, obligation: JsonObject): Promise<JsonObject> {
  const now = nowIso();
  const next: JsonObject = {
    ...obligation,
    allocated_cents: Math.round(Number(obligation.allocated_cents || 0)),
    refunded_cents: Math.round(Number(obligation.refunded_cents || 0)),
    status: deriveObligationStatus(obligation),
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, {
    id: cleanText(next.id),
    data: next,
    metadata: { kind: "payment_obligation", project_id: cleanText(next.project_id), schedule_id: cleanText(next.schedule_id) }
  }, { replace: true });
  return documentView(doc);
}

async function createAllocation(orgId: string, payment: JsonObject, obligation: JsonObject, amountCents: number, mode = "auto_next_due") {
  const now = nowIso();
  const id = generatedId("payment_allocation");
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    payment_id: cleanText(payment.id),
    obligation_id: cleanText(obligation.id),
    project_id: cleanText(obligation.project_id || payment.project_id),
    amount_cents: Math.round(amountCents),
    currency: cleanText(payment.currency || obligation.currency || "USD") || "USD",
    allocation_mode: mode,
    allocated_at: now,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_ALLOCATION_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_allocation", payment_id: cleanText(payment.id), obligation_id: cleanText(obligation.id), project_id: data.project_id }
  }, { replace: true });
  return documentView(doc);
}

async function autoAllocatePayment(orgId: string, payment: JsonObject, mode = "auto_next_due") {
  const amount = Math.max(0, Math.round(Number(payment.amount_cents || 0)));
  let remaining = amount;
  const allocations: JsonObject[] = [];
  if (cleanText(payment.direction) !== "inbound" || !["settled", "partially_refunded"].includes(cleanText(payment.status))) return allocations;
  const obligations = (await listProjectObligations(orgId, cleanText(payment.project_id), { skipFlag: true }))
    .filter((item) => cleanText(item.direction) === "inbound")
    .filter((item) => deriveObligationStatus(item) !== "paid" && deriveObligationStatus(item) !== "void");
  for (const obligation of obligations) {
    if (remaining <= 0) break;
    const open = Math.max(0, Math.round(Number(obligation.amount_cents || 0)) - Math.round(Number(obligation.allocated_cents || 0)));
    if (open <= 0) continue;
    const applied = Math.min(open, remaining);
    allocations.push(await createAllocation(orgId, payment, obligation, applied, mode));
    await saveObligation(orgId, {
      ...obligation,
      allocated_cents: Math.round(Number(obligation.allocated_cents || 0)) + applied
    });
    remaining -= applied;
  }
  return allocations;
}

export async function createPayment(orgId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const amount = Math.max(0, moneyCents(input));
  if (amount <= 0) throw badRequest("invalid_payment_amount", "Payment amount must be greater than zero.");
  const now = nowIso();
  const id = cleanText(input.id) || generatedId("payment");
  const direction = cleanText(input.direction || "inbound") === "outbound" ? "outbound" : "inbound";
  const status = cleanText(input.status || (direction === "inbound" ? "settled" : "pending")) || "settled";
  const projectId = cleanText(input.project_id);
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || ctx.branchId || "default") || "default",
    direction,
    kind: cleanText(input.kind || (direction === "inbound" ? "customer_payment" : "payment_out")),
    status,
    amount_cents: amount,
    currency: currency(input),
    project_id: projectId,
    contact_ref: asObject(input.contact_ref),
    customer_id: cleanText(input.customer_id),
    method: asObject(input.method),
    processor: asObject(input.processor),
    received_at: cleanText(input.received_at) || now,
    settled_at: cleanText(input.settled_at) || (status === "settled" ? now : ""),
    notes: cleanText(input.notes),
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_transaction", project_id: projectId, direction, payment_kind: data.kind, status }
  }, { replace: true });
  const payment = documentView(doc);
  const allocations = input.allocate === false ? [] : await autoAllocatePayment(orgId, payment, cleanText(input.allocation_mode || "auto_next_due"));
  await recordLedger(orgId, payment, direction === "inbound" ? "payment.settled" : "payment.created", direction === "inbound"
    ? [{ account: "cash", debit_cents: amount, credit_cents: 0 }, { account: "accounts_receivable", debit_cents: 0, credit_cents: amount }]
    : [{ account: "accounts_payable", debit_cents: amount, credit_cents: 0 }, { account: "cash", debit_cents: 0, credit_cents: amount }]);
  await recordPaymentEvent(orgId, "payment.created", { project_id: projectId, payment_id: id, amount_cents: amount }, ctx);
  await patchProjectFinancialRefs(orgId, projectId);
  return { payment, allocations };
}

export async function readPayment(orgId: string, paymentId: string) {
  await requireMoneyFlag(orgId);
  return documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId));
}

export async function refundPayment(orgId: string, paymentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const original = documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId));
  if (cleanText(original.direction) !== "inbound") throw badRequest("invalid_refund_payment", "Only inbound payments can be refunded.");
  const amount = Math.max(0, moneyCents(input, Math.round(Number(original.amount_cents || 0))));
  if (amount <= 0) throw badRequest("invalid_refund_amount", "Refund amount must be greater than zero.");
  const refund = (await createPayment(orgId, {
    ...input,
    direction: "outbound",
    kind: "customer_refund",
    status: "settled",
    project_id: cleanText(original.project_id),
    contact_ref: asObject(original.contact_ref),
    amount_cents: amount,
    currency: cleanText(input.currency || original.currency || "USD"),
    metadata: { ...asObject(input.metadata), related_payment_id: paymentId, refund_reason: cleanText(input.reason) }
  }, ctx)).payment;

  let remaining = amount;
  const allocations = (await listDocuments(orgId, PAYMENT_ALLOCATION_COLLECTION)).map(documentView)
    .filter((allocation) => cleanText(allocation.payment_id) === paymentId && Number(allocation.amount_cents || 0) > 0);
  for (const allocation of allocations) {
    if (remaining <= 0) break;
    const obligation = documentView(await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, cleanText(allocation.obligation_id)));
    const reversed = Math.min(remaining, Math.max(0, Math.round(Number(allocation.amount_cents || 0))));
    await createAllocation(orgId, refund, obligation, -reversed, "refund");
    await saveObligation(orgId, {
      ...obligation,
      allocated_cents: Math.max(0, Math.round(Number(obligation.allocated_cents || 0)) - reversed),
      refunded_cents: Math.round(Number(obligation.refunded_cents || 0)) + reversed
    });
    remaining -= reversed;
  }

  const totalRefunded = (await listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION)).map(documentView)
    .filter((payment) => cleanText(payment.kind) === "customer_refund" && cleanText(asObject(payment.metadata).related_payment_id) === paymentId)
    .reduce((sum, payment) => sum + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0);
  const nextStatus = totalRefunded >= Math.round(Number(original.amount_cents || 0)) ? "refunded" : "partially_refunded";
  await upsertDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, {
    id: paymentId,
    data: { ...original, status: nextStatus, refunded_cents: totalRefunded, updated_by_user_id: ctx.userId, updated_at: nowIso() },
    metadata: { kind: "payment_transaction", project_id: cleanText(original.project_id), direction: "inbound", payment_kind: cleanText(original.kind), status: nextStatus }
  }, { replace: true });
  await recordLedger(orgId, refund, "payment.refunded", [{ account: "sales_returns", debit_cents: amount, credit_cents: 0 }, { account: "cash", debit_cents: 0, credit_cents: amount }]);
  await recordPaymentEvent(orgId, "payment.refunded", { project_id: cleanText(original.project_id), payment_id: paymentId, refund_id: cleanText(refund.id), amount_cents: amount }, ctx);
  await patchProjectFinancialRefs(orgId, cleanText(original.project_id));
  return { payment: await readPayment(orgId, paymentId), refund };
}

export async function reallocatePayment(orgId: string, paymentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const payment = documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId));
  const prior = (await listDocuments(orgId, PAYMENT_ALLOCATION_COLLECTION)).map(documentView)
    .filter((allocation) => cleanText(allocation.payment_id) === paymentId);
  for (const allocation of prior) {
    const obligation = documentView(await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, cleanText(allocation.obligation_id)).catch(() => ({})));
    if (!cleanText(obligation.id)) continue;
    await saveObligation(orgId, {
      ...obligation,
      allocated_cents: Math.max(0, Math.round(Number(obligation.allocated_cents || 0)) - Math.round(Number(allocation.amount_cents || 0)))
    });
  }
  const allocations = [];
  for (const row of asArray(input.allocations).map(asObject)) {
    const obligation = documentView(await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, cleanText(row.obligation_id)));
    const amount = Math.round(Number(row.amount_cents || 0));
    if (!amount) continue;
    allocations.push(await createAllocation(orgId, payment, obligation, amount, cleanText(input.allocation_mode || "manual")));
    await saveObligation(orgId, {
      ...obligation,
      allocated_cents: Math.round(Number(obligation.allocated_cents || 0)) + amount
    });
  }
  await recordPaymentEvent(orgId, "payment.reallocated", { project_id: cleanText(payment.project_id), payment_id: paymentId, allocation_count: allocations.length }, ctx);
  await patchProjectFinancialRefs(orgId, cleanText(payment.project_id));
  return { payment, allocations };
}

export async function createPaymentIntent(orgId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const amount = Math.max(0, moneyCents(input));
  if (amount <= 0) throw badRequest("invalid_payment_intent_amount", "Payment intent amount must be greater than zero.");
  const now = nowIso();
  const id = cleanText(input.id) || generatedId("payment_intent");
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || ctx.branchId || "default") || "default",
    direction: cleanText(input.direction || "inbound") === "outbound" ? "outbound" : "inbound",
    kind: cleanText(input.kind || "customer_payment"),
    status: "pending",
    amount_cents: amount,
    currency: currency(input),
    project_id: cleanText(input.project_id),
    contact_ref: asObject(input.contact_ref),
    provider: cleanText(input.provider),
    processor: asObject(input.processor),
    expires_at: cleanText(input.expires_at),
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_INTENT_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_intent", project_id: data.project_id, direction: data.direction, status: data.status }
  }, { replace: true });
  await recordPaymentEvent(orgId, "payment_intent.created", { project_id: data.project_id, payment_intent_id: id }, ctx);
  return documentView(doc);
}

export async function cancelPaymentIntent(orgId: string, intentId: string, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const intent = documentView(await readDocument(orgId, PAYMENT_INTENT_COLLECTION, intentId));
  const doc = await upsertDocument(orgId, PAYMENT_INTENT_COLLECTION, {
    id: intentId,
    data: { ...intent, status: "cancelled", updated_by_user_id: ctx.userId, updated_at: nowIso() },
    metadata: { kind: "payment_intent", project_id: cleanText(intent.project_id), direction: cleanText(intent.direction), status: "cancelled" }
  }, { replace: true });
  await recordPaymentEvent(orgId, "payment_intent.cancelled", { project_id: cleanText(intent.project_id), payment_intent_id: intentId }, ctx);
  return documentView(doc);
}

export async function listPayables(orgId: string, input: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const projectId = cleanText(input.project_id);
  const docs = await listDocuments(orgId, PAYMENT_PAYABLE_COLLECTION);
  return docs.map(documentView)
    .filter((item) => !projectId || cleanText(item.project_id) === projectId)
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

export async function createPayable(orgId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const amount = Math.max(0, moneyCents(input));
  if (amount <= 0) throw badRequest("invalid_payable_amount", "Payable amount must be greater than zero.");
  const now = nowIso();
  const id = cleanText(input.id) || generatedId("payment_payable");
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || ctx.branchId || "default") || "default",
    project_id: cleanText(input.project_id),
    kind: cleanText(input.kind || "other"),
    source: asObject(input.source),
    vendor_ref: asObject(input.vendor_ref),
    crew_ref: asObject(input.crew_ref),
    amount_cents: amount,
    paid_cents: 0,
    currency: currency(input),
    due_at: cleanText(input.due_at),
    status: "open",
    notes: cleanText(input.notes),
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_PAYABLE_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_payable", project_id: data.project_id, payable_kind: data.kind, status: data.status }
  }, { replace: true });
  await recordPaymentEvent(orgId, "payment_payable.created", { project_id: data.project_id, payable_id: id, amount_cents: amount }, ctx);
  return documentView(doc);
}

export async function createDisbursement(orgId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const amount = Math.max(0, moneyCents(input));
  if (amount <= 0) throw badRequest("invalid_disbursement_amount", "Disbursement amount must be greater than zero.");
  const payableIds = asArray(input.payable_ids).map(cleanText).filter(Boolean);
  const now = nowIso();
  const id = cleanText(input.id) || generatedId("payment_disbursement");
  const projectId = cleanText(input.project_id);
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || ctx.branchId || "default") || "default",
    direction: "outbound",
    kind: cleanText(input.kind || "disbursement"),
    status: "settled",
    project_id: projectId,
    payable_ids: payableIds,
    amount_cents: amount,
    currency: currency(input),
    method: asObject(input.method),
    processor: asObject(input.processor),
    paid_at: cleanText(input.paid_at) || now,
    notes: cleanText(input.notes),
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_DISBURSEMENT_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_disbursement", project_id: projectId, disbursement_kind: data.kind, status: data.status }
  }, { replace: true });
  let remaining = amount;
  for (const payableId of payableIds) {
    if (remaining <= 0) break;
    const payable = documentView(await readDocument(orgId, PAYMENT_PAYABLE_COLLECTION, payableId));
    const open = Math.max(0, Math.round(Number(payable.amount_cents || 0)) - Math.round(Number(payable.paid_cents || 0)));
    const paid = Math.min(open, remaining);
    const paidCents = Math.round(Number(payable.paid_cents || 0)) + paid;
    const status = paidCents >= Math.round(Number(payable.amount_cents || 0)) ? "paid" : "partially_paid";
    await upsertDocument(orgId, PAYMENT_PAYABLE_COLLECTION, {
      id: payableId,
      data: { ...payable, paid_cents: paidCents, status, updated_by_user_id: ctx.userId, updated_at: nowIso() },
      metadata: { kind: "payment_payable", project_id: cleanText(payable.project_id), payable_kind: cleanText(payable.kind), status }
    }, { replace: true });
    remaining -= paid;
  }
  const payment = (await createPayment(orgId, {
    direction: "outbound",
    kind: cleanText(input.kind || "disbursement"),
    status: "settled",
    project_id: projectId,
    amount_cents: amount,
    currency: data.currency,
    method: data.method,
    processor: data.processor,
    metadata: { disbursement_id: id, payable_ids: payableIds }
  }, ctx)).payment;
  await recordPaymentEvent(orgId, "payment_disbursement.created", { project_id: projectId, disbursement_id: id, payment_id: cleanText(payment.id), amount_cents: amount }, ctx);
  await patchProjectFinancialRefs(orgId, projectId);
  return { disbursement: documentView(doc), payment };
}

async function materialTotals(orgId: string, projectId: string) {
  const [listDocs, orderDocs] = await Promise.all([
    listDocuments(orgId, "material_lists").catch(() => []),
    listDocuments(orgId, "material_orders").catch(() => [])
  ]);
  const lists = listDocs.map(documentView).filter((list) => cleanText(list.project_id) === projectId && cleanText(list.status) !== "archived");
  const orders = orderDocs.map(documentView).filter((order) => cleanText(order.project_id) === projectId);
  const sumItems = (key: string) => lists.reduce((total, list) => total + asArray(list.current_items).map(asObject).reduce((sum, item) => {
    const value = Number(item[key]);
    return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0);
  }, 0), 0);
  const paidOrders = orders.reduce((total, order) => {
    const paidPrice = moneyCents(asObject(order.paid_price));
    const paidTotal = Math.round(Number(asObject(order.totals).paid_total || 0) * 100);
    return total + Math.max(paidPrice, paidTotal, 0);
  }, 0);
  return {
    projected_cents: sumItems("projected_total"),
    quoted_cents: sumItems("quoted_total"),
    paid_cents: Math.max(sumItems("paid_total"), paidOrders)
  };
}

export async function projectMoneySummary(orgId: string, projectId: string) {
  await requireMoneyFlag(orgId);
  const projectDoc = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!projectDoc) throw notFound("project_not_found", "Project was not found.");
  const [schedules, obligations, payments, payables, materials] = await Promise.all([
    listProjectPaymentSchedules(orgId, projectId, { skipFlag: true }),
    listProjectObligations(orgId, projectId, { skipFlag: true }),
    listProjectPayments(orgId, projectId, { skipFlag: true }),
    listPayables(orgId, { project_id: projectId }).catch(() => []),
    materialTotals(orgId, projectId)
  ]);
  const totalObligations = obligations.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.amount_cents || 0))), 0);
  const totalAllocated = obligations.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.allocated_cents || 0))), 0);
  const outboundRefunds = payments
    .filter((payment) => cleanText(payment.direction) === "outbound" && cleanText(payment.kind) === "customer_refund")
    .reduce((sum, payment) => sum + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0);
  const inboundCollected = payments
    .filter((payment) => cleanText(payment.direction) === "inbound" && ["settled", "partially_refunded", "refunded"].includes(cleanText(payment.status)))
    .reduce((sum, payment) => sum + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0) - outboundRefunds;
  const payableProjected = payables.reduce((sum, payable) => sum + Math.max(0, Math.round(Number(payable.amount_cents || 0))), 0);
  const payablePaid = payables.reduce((sum, payable) => sum + Math.max(0, Math.round(Number(payable.paid_cents || 0))), 0);
  const projectedExpenses = materials.projected_cents + payableProjected;
  const expensesToDate = materials.paid_cents + payablePaid;
  return {
    project: documentView(projectDoc),
    project_total_cents: totalObligations,
    total_collected_cents: inboundCollected,
    total_remaining_cents: Math.max(0, totalObligations - totalAllocated),
    projected_revenue_cents: totalObligations,
    revenue_to_date_cents: inboundCollected,
    projected_expenses_cents: projectedExpenses,
    expenses_to_date_cents: expensesToDate,
    projected_profit_cents: totalObligations - projectedExpenses,
    profit_to_date_cents: inboundCollected - expensesToDate,
    materials,
    labor: { projected_cents: 0, paid_cents: 0, placeholder: true },
    schedules,
    obligations,
    payments,
    payables
  };
}

export async function listLedger(orgId: string, input: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const projectId = cleanText(input.project_id);
  const docs = await listDocuments(orgId, PAYMENT_LEDGER_COLLECTION);
  return docs.map(documentView)
    .filter((item) => !projectId || cleanText(item.project_id) === projectId)
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

export async function listPaymentEvents(orgId: string, input: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const projectId = cleanText(input.project_id);
  const docs = await listDocuments(orgId, PAYMENT_EVENT_COLLECTION);
  return docs.map(documentView)
    .filter((item) => !projectId || cleanText(asObject(item.payload).project_id) === projectId)
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}
