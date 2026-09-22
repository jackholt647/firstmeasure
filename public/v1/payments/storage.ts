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
import { emitWorkEvent } from "../work/engine.js";
import { listPlanRecords } from "../work/storage.js";
import { assertExpenseTargetKeys, projectExpenseSummary } from "./expenses.js";
import { recurringMoneySummary } from "../platform/recurrence.js";
import {
  inferPaymentKind,
  normalizeScheduleRows,
  resolveScheduleItems,
  type ResolvedScheduleItem
} from "./schedule_terms.js";

export const PAYMENT_SCHEDULE_COLLECTION = "payment_schedules";
export const PAYMENT_OBLIGATION_COLLECTION = "payment_obligations";
export const PAYMENT_TRANSACTION_COLLECTION = "payment_transactions";
export const PAYMENT_ALLOCATION_COLLECTION = "payment_allocations";
export const PAYMENT_INTENT_COLLECTION = "payment_intents";
export const PAYMENT_PAYABLE_COLLECTION = "payment_payables";
export const PAYMENT_DISBURSEMENT_COLLECTION = "payment_disbursements";
export const PAYMENT_LEDGER_COLLECTION = "payment_ledger_events";
export const PAYMENT_EVENT_COLLECTION = "payment_events";
export const PAYMENT_INVOICE_COLLECTION = "payment_invoices";

const PAYMENT_SCHEMA_VERSION = 1;

type ScheduleItem = ResolvedScheduleItem;

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
  const explicitRows = normalizeScheduleRows(payment.schedule ? payment : { items: asArray(payment.items || payment.payment_schedule) });
  if (explicitRows.length) {
    // Legacy convention: the first row without a stated due rule is due on
    // signature. Preserve it before resolving against the proposal total.
    const rows = explicitRows.map((row, index) => {
      const stated = cleanText(asObject(asArray(payment.schedule || payment.items || payment.payment_schedule)[index]).due_rule
        || asObject(asArray(payment.schedule || payment.items || payment.payment_schedule)[index]).dueRule);
      if (index === 0 && !stated && row.due_rule === "manual") return { ...row, due_rule: "on_signature" as const };
      return row;
    });
    return resolveScheduleItems(rows, {
      total_cents: proposalTotalCents(content, signature, []),
      signed_at: signedAt
    });
  }

  const deposit = numberCents(signature.depositAmount);
  const financed = numberCents(signature.financedAmount);
  const rawCompletion = numberCents(signature.completionAmount);
  const total = proposalTotalCents(content, signature, []);
  const completion = rawCompletion > 0 ? rawCompletion : Math.max(0, total - deposit - financed);
  const items: ScheduleItem[] = [];
  if (deposit > 0) {
    items.push({
      label: cleanText(signature.depositLabel || "Deposit"), amount_cents: deposit, payment_kind: "deposit",
      due_rule: "on_signature", due_at: signedAt, grace_days: 1,
      recognition: { node_id: "", hook: "onCompleted" }, amount_expression: "", metadata: {}
    });
  }
  if (completion > 0) {
    items.push({
      label: cleanText(signature.completionLabel || "Final Payment"), amount_cents: completion, payment_kind: "final",
      due_rule: "project_completion", due_at: "", grace_days: 1,
      recognition: { node_id: "", hook: "onCompleted" }, amount_expression: "", metadata: {}
    });
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

export async function recordPaymentEvent(orgId: string, type: string, payload: JsonObject = {}, ctx?: PlatformAuthContext | null) {
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

export async function patchProjectFinancialRefs(orgId: string, projectId: string) {
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

export type EnsureScheduleSource = {
  type: string;
  id: string;
  snapshot_id?: string;
  event_key?: string;
};

export type EnsureScheduleInput = {
  project_id: string;
  branch_id?: string;
  title?: string;
  contact_ref?: JsonObject;
  source: EnsureScheduleSource;
  items: ScheduleItem[];
  total_cents?: number;
  /**
   * replace — schedules from the same source id with a different snapshot are
   * superseded (re-signing a proposal). append — the schedule adds to the
   * project's receivables without touching prior schedules (change orders).
   */
  mode?: "replace" | "append";
  event_type?: string;
};

/**
 * Source-agnostic receivables minting. Everything that turns "signed terms"
 * into payment schedules + obligations funnels through here: legacy proposal
 * snapshots, document-engine proposals, and change orders. Idempotent per
 * (source.id, source.snapshot_id) — replays only re-run payment allocation.
 */
export async function ensureReceivablesFromSchedule(orgId: string, input: EnsureScheduleInput) {
  await requireMoneyFlag(orgId);
  const projectId = cleanText(input.project_id);
  if (!projectId) throw badRequest("missing_project_id", "A payment schedule requires a project id.");
  const sourceType = cleanText(input.source.type) || "manual";
  const sourceId = cleanText(input.source.id);
  if (!sourceId) throw badRequest("missing_schedule_source", "A payment schedule requires a source id.");
  const snapshotId = cleanText(input.source.snapshot_id);
  const mode = input.mode === "append" ? "append" : "replace";
  const items = input.items.filter((item) => item.amount_cents > 0 || cleanText(item.amount_expression));
  const sourceKey = cleanText(input.source.event_key) || `${sourceType}_signed:${sourceId}:${snapshotId}`;
  const scheduleDocs = (await listDocuments(orgId, PAYMENT_SCHEDULE_COLLECTION)).map(documentView);
  const now = nowIso();
  if (mode === "replace") {
    for (const schedule of scheduleDocs) {
      const source = asObject(schedule.source);
      const sameSource = cleanText(source.id) === sourceId;
      const sameSnapshot = cleanText(source.snapshot_id) === snapshotId;
      if (!sameSource || sameSnapshot || ["superseded", "void", "archived"].includes(cleanText(schedule.status))) continue;
      await upsertDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, {
        id: cleanText(schedule.id),
        data: {
          ...schedule,
          status: "superseded",
          superseded_by_snapshot_id: snapshotId,
          updated_at: now
        },
        metadata: { kind: "payment_schedule", project_id: projectId, source_id: sourceId, source_snapshot_id: cleanText(source.snapshot_id), status: "superseded" }
      }, { replace: true });
    }
  }
  const existing = scheduleDocs
    .find((schedule) => cleanText(asObject(schedule.source).id) === sourceId && cleanText(asObject(schedule.source).snapshot_id) === snapshotId);
  if (existing) {
    const obligations = (await listProjectObligations(orgId, projectId, { skipFlag: true }))
      .filter((item) => cleanText(item.schedule_id) === cleanText(existing.id));
    const replayedAllocations = await allocateUnappliedProjectPayments(orgId, projectId, obligations, {
      mode: "signed_source_replay",
      event_key: `signed_source_replay:${snapshotId || sourceId}`
    });
    return {
      schedule: existing,
      obligations: await Promise.all(obligations.map((item) => readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, cleanText(item.id)).then(documentView))),
      replayed_allocations: replayedAllocations,
      created: false
    };
  }

  const scheduleId = `payment_schedule_${stableSourceId(`${sourceId}_${snapshotId}`)}`;
  const contactRef = asObject(input.contact_ref);
  const scheduleData = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id: scheduleId,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || "default") || "default",
    project_id: projectId,
    contact_ref: contactRef,
    source: { type: sourceType, id: sourceId, snapshot_id: snapshotId, event_key: sourceKey },
    title: cleanText(input.title) || "Payment schedule",
    total_cents: Math.max(0, Math.round(Number(input.total_cents || 0))) || items.reduce((sum, item) => sum + item.amount_cents, 0),
    currency: "USD",
    status: "active",
    schedule_mode: mode,
    items: items.map((item, index) => ({ ...item, sequence: index + 1 })),
    created_at: now,
    updated_at: now
  };
  const legacyProposalMeta = sourceType === "proposal" ? { proposal_id: sourceId, proposal_snapshot_id: snapshotId } : {};
  const scheduleDoc = await upsertDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, {
    id: scheduleId,
    data: scheduleData,
    metadata: { kind: "payment_schedule", project_id: projectId, source_type: sourceType, source_id: sourceId, source_snapshot_id: snapshotId, source_key: sourceKey, ...legacyProposalMeta }
  }, { replace: true });

  const obligations = [];
  for (const [index, item] of items.entries()) {
    const obligationId = `payment_obligation_${stableSourceId(`${sourceId}_${snapshotId}_${index + 1}`)}`;
    const obligationData = {
      schema_version: PAYMENT_SCHEMA_VERSION,
      id: obligationId,
      organization_id: orgId,
      branch_id: cleanText(scheduleData.branch_id),
      project_id: projectId,
      contact_ref: contactRef,
      source: { type: sourceType, id: sourceId, snapshot_id: snapshotId },
      schedule_id: scheduleId,
      label: item.label,
      sequence: index + 1,
      direction: "inbound",
      kind: cleanText(item.payment_kind) || inferPaymentKind({}, item.label),
      amount_cents: item.amount_cents,
      currency: "USD",
      due_rule: item.due_rule,
      due_at: item.due_at,
      grace_days: item.grace_days,
      ...(cleanText(item.recognition?.node_id) ? { recognition: { node_id: cleanText(item.recognition.node_id), hook: cleanText(item.recognition.hook) || "onCompleted" } } : {}),
      ...(cleanText(item.amount_expression) ? { amount_expression: cleanText(item.amount_expression) } : {}),
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
      metadata: { kind: "payment_obligation", project_id: projectId, schedule_id: scheduleId, source_id: sourceId, ...legacyProposalMeta }
    }, { replace: true });
    obligations.push(documentView(doc));
  }
  await recordPaymentEvent(orgId, cleanText(input.event_type) || "payment_schedule.created_from_signed_source", {
    project_id: projectId,
    source_type: sourceType,
    source_id: sourceId,
    snapshot_id: snapshotId,
    schedule_id: scheduleId,
    schedule_mode: mode,
    ...(sourceType === "proposal" ? { proposal_id: sourceId } : {}),
    ...(sourceType === "document" ? { document_id: sourceId } : {})
  });
  const replayedAllocations = await allocateUnappliedProjectPayments(orgId, projectId, obligations, {
    mode: "signed_source_replay",
    event_key: `signed_source_replay:${snapshotId || sourceId}`
  });
  await patchProjectFinancialRefs(orgId, projectId);
  return {
    schedule: documentView(scheduleDoc),
    obligations: await Promise.all(obligations.map((item) => readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, cleanText(item.id)).then(documentView))),
    replayed_allocations: replayedAllocations,
    created: true
  };
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
  const { content, signature } = proposalPaymentContent(snapshot);
  return ensureReceivablesFromSchedule(orgId, {
    project_id: projectId,
    branch_id: cleanText(snapshot.branch_id || proposal.branch_id || project.branch_id || "default") || "default",
    title: cleanText(snapshot.title || proposal.title || "Proposal"),
    contact_ref: contactFromProposal(snapshot, proposal, project),
    source: { type: "proposal", id: proposalId, snapshot_id: snapshotId, event_key: `proposal_signed:${proposalId}:${snapshotId}` },
    items,
    total_cents: proposalTotalCents(content, signature, items),
    mode: "replace",
    event_type: "payment_schedule.created_from_signed_proposal"
  });
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

export async function saveObligation(orgId: string, obligation: JsonObject): Promise<JsonObject> {
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

async function activePaymentAllocations(orgId: string, paymentId: string) {
  return (await listDocuments(orgId, PAYMENT_ALLOCATION_COLLECTION)).map(documentView)
    .filter((allocation) => cleanText(allocation.payment_id) === paymentId)
    .filter((allocation) => !["void", "reversed"].includes(cleanText(allocation.status).toLowerCase()));
}

function paymentAvailableCents(payment: JsonObject) {
  const amount = Math.max(0, Math.round(Number(payment.amount_cents || 0)));
  const refunded = Math.max(0, Math.round(Number(payment.refunded_cents || 0)));
  return Math.max(0, amount - refunded);
}

async function autoAllocatePayment(orgId: string, payment: JsonObject, mode = "auto_next_due", obligationId = "", allowedObligationIds?: Set<string>) {
  const priorAllocations = await activePaymentAllocations(orgId, cleanText(payment.id));
  const alreadyAllocated = priorAllocations.reduce((sum, allocation) => sum + Math.max(0, Math.round(Number(allocation.amount_cents || 0))), 0);
  let remaining = Math.max(0, paymentAvailableCents(payment) - alreadyAllocated);
  const allocations: JsonObject[] = [];
  if (cleanText(payment.direction) !== "inbound" || !["settled", "partially_refunded"].includes(cleanText(payment.status))) return allocations;
  let obligations = (await listProjectObligations(orgId, cleanText(payment.project_id), { skipFlag: true }))
    .filter((item) => cleanText(item.direction) === "inbound")
    .filter((item) => deriveObligationStatus(item) !== "paid" && deriveObligationStatus(item) !== "void")
    .filter((item) => !allowedObligationIds || allowedObligationIds.has(cleanText(item.id)));
  const targetObligationId = cleanText(obligationId);
  if (targetObligationId) {
    const target = obligations.find((item) => cleanText(item.id) === targetObligationId);
    if (!target) throw badRequest("payment_obligation_not_open", "The selected payment is not open for this project.");
    obligations = [
      target,
      ...obligations.filter((item) => cleanText(item.id) !== targetObligationId && cleanText(item.schedule_id) === cleanText(target.schedule_id)),
      ...obligations.filter((item) => cleanText(item.id) !== targetObligationId && cleanText(item.schedule_id) !== cleanText(target.schedule_id))
    ];
  }
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

function obligationPaymentKind(obligation: JsonObject) {
  // Obligations minted through ensureReceivablesFromSchedule carry a typed
  // kind; the label/due-rule sniff below only classifies pre-existing data.
  const typed = cleanText(obligation.kind).toLowerCase();
  if (["deposit", "progress", "final", "change_order"].includes(typed)) return typed;
  const label = cleanText(obligation.label || obligation.title || obligation.kind).toLowerCase();
  const dueRule = cleanText(obligation.due_rule).toLowerCase();
  if (label.includes("deposit") || dueRule === "on_signature") return "deposit";
  if (label.includes("final") || label.includes("completion") || dueRule === "project_completion") return "final";
  if (label.includes("progress")) return "progress";
  return "customer";
}

async function allocatedPaymentContext(orgId: string, payment: JsonObject, allocations: JsonObject[]) {
  const obligations: JsonObject[] = [];
  for (const allocation of allocations) {
    const obligation = documentView(await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, cleanText(allocation.obligation_id)).catch(() => ({})));
    if (cleanText(obligation.id)) obligations.push(obligation);
  }
  const completedKinds = obligations
    .filter((obligation) => deriveObligationStatus(obligation) === "paid")
    .map(obligationPaymentKind);
  const allocatedKinds = obligations.map(obligationPaymentKind);
  const explicitKind = cleanText(payment.kind).toLowerCase();
  const paymentKind = completedKinds.includes("deposit") ? "deposit"
    : completedKinds.includes("final") ? "final"
      : completedKinds.includes("progress") ? "progress"
        : completedKinds.includes("change_order") ? "change_order"
          : allocatedKinds.includes("deposit") ? "deposit_partial"
            : allocatedKinds.includes("final") ? "final_partial"
              : allocatedKinds.includes("progress") ? "progress_partial"
                : allocatedKinds.includes("change_order") ? "change_order_partial"
                  : explicitKind.includes("deposit") ? "deposit"
                    : explicitKind.includes("final") ? "final"
                      : explicitKind.includes("progress") ? "progress"
                        : "customer";
  const proposalId = cleanText(asObject(obligations[0]?.source).id || asObject(payment.metadata).proposal_id);
  return { obligations, paymentKind, proposalId };
}

async function emitInboundPaymentReceived(orgId: string, payment: JsonObject, allocations: JsonObject[], ctx?: PlatformAuthContext | null, eventKey = "") {
  const projectId = cleanText(payment.project_id);
  if (!projectId || cleanText(payment.direction) !== "inbound" || !["settled", "partially_refunded"].includes(cleanText(payment.status))) return;
  const allocationContext = await allocatedPaymentContext(orgId, payment, allocations);
  const suffix = cleanText(eventKey) ? `:${stableSourceId(eventKey)}` : "";
  const amount = Math.max(0, Math.round(Number(payment.amount_cents || 0)));
  const paymentPayload = {
    payment_id: cleanText(payment.id),
    payment_kind: allocationContext.paymentKind,
    kind: cleanText(payment.kind),
    amount_cents: amount,
    allocated_cents: allocations.reduce((sum, allocation) => sum + Math.max(0, Math.round(Number(allocation.amount_cents || 0))), 0),
    obligation_ids: allocationContext.obligations.map((obligation) => cleanText(obligation.id)).filter(Boolean),
    payment
  };
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(payment.branch_id || "default") || "default",
    project_id: projectId,
    type: "payment.received",
    idempotency_key: `payment.received:${cleanText(payment.id)}${suffix}`,
    payload: paymentPayload
  });
  if (allocationContext.proposalId) {
    const proposalPlans = (await listPlanRecords(orgId, { project_id: projectId }))
      .filter((plan) => cleanText(plan.source_type) === "signed_proposal_scope"
        && cleanText(plan.source_id) === allocationContext.proposalId
        && !["completed", "canceled"].includes(cleanText(plan.status)));
    for (const plan of proposalPlans) {
      await emitWorkEvent({
        organization_id: orgId,
        branch_id: cleanText(payment.branch_id || "default") || "default",
        project_id: projectId,
        plan_id: cleanText(plan.id),
        type: "proposal.payment.received",
        idempotency_key: `proposal.payment.received:${cleanText(payment.id)}:${cleanText(plan.id)}${suffix}`,
        payload: { ...paymentPayload, proposal_id: allocationContext.proposalId }
      });
    }
  }
  // Post-deposit resource/commission reconciliation is a scope-template
  // binding (scopes.reconcileProjectResources.v1 on the deposit node), not a
  // payments special-case.
  await recordPaymentEvent(orgId, eventKey ? "payment.automatically_applied" : "payment.received", {
    project_id: projectId,
    payment_id: cleanText(payment.id),
    payment_kind: allocationContext.paymentKind,
    allocation_count: allocations.length,
    allocated_cents: paymentPayload.allocated_cents,
    event_key: cleanText(eventKey)
  }, ctx);
}

async function allocateUnappliedProjectPayments(orgId: string, projectId: string, obligations: JsonObject[], options: JsonObject = {}) {
  const allowedIds = new Set(obligations.map((obligation) => cleanText(obligation.id)).filter(Boolean));
  if (!allowedIds.size) return [];
  const payments = (await listProjectPayments(orgId, projectId, { skipFlag: true }))
    .filter((payment) => cleanText(payment.direction) === "inbound")
    .filter((payment) => ["settled", "partially_refunded"].includes(cleanText(payment.status)))
    .sort((a, b) => cleanText(a.received_at || a.created_at).localeCompare(cleanText(b.received_at || b.created_at)));
  const replayed: JsonObject[] = [];
  for (const payment of payments) {
    const allocations = await autoAllocatePayment(orgId, payment, cleanText(options.mode || "signed_proposal_replay"), "", allowedIds);
    if (!allocations.length) continue;
    replayed.push(...allocations);
    await emitInboundPaymentReceived(orgId, payment, allocations, null, cleanText(options.event_key || "signed_proposal_replay"));
  }
  return replayed;
}

function signedProposalLike(value: JsonObject) {
  const delivery = asObject(value.delivery);
  return cleanText(value.status).toLowerCase() === "signed"
    || cleanText(delivery.state || delivery.status).toLowerCase() === "signed"
    || !!cleanText(delivery.signed_at || value.signed_at || value.customer_signed_at);
}

async function ensureSignedProposalReceivablesForProject(orgId: string, projectId: string) {
  const [proposalDocs, snapshotDocs] = await Promise.all([
    listDocuments(orgId, "proposals"),
    listDocuments(orgId, "proposal_snapshots")
  ]);
  const proposals = proposalDocs.map(documentView).filter((proposal) => cleanText(proposal.project_id) === projectId);
  const proposalById = new Map(proposals.map((proposal) => [cleanText(proposal.id), proposal]));
  const signedSnapshots = snapshotDocs.map(documentView)
    .filter((snapshot) => cleanText(snapshot.project_id) === projectId && signedProposalLike(snapshot))
    .filter((snapshot) => {
      const proposal = proposalById.get(cleanText(snapshot.proposal_id));
      const currentSnapshotId = cleanText(asObject(proposal?.delivery).current_snapshot_id);
      return !currentSnapshotId || currentSnapshotId === cleanText(snapshot.id);
    })
    .sort((a, b) => cleanText(a.signed_at || asObject(a.delivery).signed_at || a.updated_at).localeCompare(cleanText(b.signed_at || asObject(b.delivery).signed_at || b.updated_at)));
  for (const snapshot of signedSnapshots) {
    const proposalId = cleanText(snapshot.proposal_id);
    if (!proposalId) continue;
    await ensureReceivablesForSignedProposal(orgId, proposalId, cleanText(snapshot.id), { source: "payment_capture_reconciliation" });
  }
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
  const obligationId = cleanText(input.obligation_id);
  if (direction === "inbound" && status === "settled" && projectId && input.allocate !== false) {
    await ensureSignedProposalReceivablesForProject(orgId, projectId);
  }
  if (obligationId) {
    const obligation = documentView(await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, obligationId).catch(() => ({})));
    const open = Math.max(0, Math.round(Number(obligation.amount_cents || 0)) - Math.round(Number(obligation.allocated_cents || 0)));
    if (!cleanText(obligation.id) || cleanText(obligation.project_id) !== projectId || ["paid", "void"].includes(deriveObligationStatus(obligation)) || open <= 0) {
      throw badRequest("payment_obligation_not_open", "The selected payment is not open for this project.");
    }
  }
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
    // Acquiring-provider projections (additive; absent for offline payments).
    ...(cleanText(input.provider) ? { provider: cleanText(input.provider) } : {}),
    ...(Number.isFinite(Number(input.fee_cents)) ? { fee_cents: Math.round(Number(input.fee_cents)) } : {}),
    ...(Number.isFinite(Number(input.merchant_amount_cents)) ? { merchant_amount_cents: Math.round(Number(input.merchant_amount_cents)) } : {}),
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
  const allocations = input.allocate === false ? [] : await autoAllocatePayment(orgId, payment, cleanText(input.allocation_mode || "auto_next_due"), obligationId);
  await recordLedger(orgId, payment, direction === "inbound" ? "payment.settled" : "payment.created", direction === "inbound"
    ? [{ account: "cash", debit_cents: amount, credit_cents: 0 }, { account: "accounts_receivable", debit_cents: 0, credit_cents: amount }]
    : [{ account: "accounts_payable", debit_cents: amount, credit_cents: 0 }, { account: "cash", debit_cents: 0, credit_cents: amount }]);
  await recordPaymentEvent(orgId, "payment.created", { project_id: projectId, payment_id: id, amount_cents: amount }, ctx);
  if (direction === "inbound" && status === "settled" && projectId) {
    await emitInboundPaymentReceived(orgId, payment, allocations, ctx);
  }
  await patchProjectFinancialRefs(orgId, projectId);
  return { payment, allocations };
}

export async function readPayment(orgId: string, paymentId: string) {
  await requireMoneyFlag(orgId);
  return documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId));
}

// ---------------------------------------------------------------------------
// Cleared-payment reconciliation. A recorded settlement is what we BELIEVE
// happened; cleared_at is confirmation against the bank. The financials cash
// model already prefers cleared_at over its clearing-hours estimate
// (financials/read_model paymentClearedDate → confidence "actual"), so
// reconciling here makes the org cash-flow view honest with no extra wiring.
// ---------------------------------------------------------------------------

const RECONCILABLE_STATUSES = ["settled", "partially_refunded", "refunded"];

async function savePaymentReconciliation(orgId: string, payment: JsonObject, patch: JsonObject) {
  const data: JsonObject = { ...payment, ...patch, updated_at: nowIso() };
  const doc = await upsertDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, {
    id: cleanText(payment.id),
    data,
    metadata: {
      kind: "payment_transaction",
      project_id: cleanText(payment.project_id),
      direction: cleanText(payment.direction),
      payment_kind: cleanText(payment.kind),
      status: cleanText(payment.status),
      reconciled: cleanText(data.cleared_at) ? "cleared" : "open"
    }
  }, { replace: true });
  return documentView(doc);
}

/**
 * Additive provider-side projection onto an existing payment_transactions
 * record: fee capture, provider ids, payout membership. Used by the Forward
 * webhook handlers, which run without an authenticated context — mirrors the
 * skipFlag convention (events only arrive for orgs that are processing).
 */
export async function patchPaymentProviderFields(orgId: string, paymentId: string, patch: JsonObject) {
  const payment = documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId));
  const data: JsonObject = {
    ...payment,
    ...patch,
    ...(patch.processor !== undefined ? { processor: { ...asObject(payment.processor), ...asObject(patch.processor) } } : {}),
    ...(patch.metadata !== undefined ? { metadata: { ...asObject(payment.metadata), ...asObject(patch.metadata) } } : {}),
    updated_at: nowIso()
  };
  const doc = await upsertDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, {
    id: cleanText(payment.id),
    data,
    metadata: {
      kind: "payment_transaction",
      project_id: cleanText(data.project_id),
      direction: cleanText(data.direction),
      payment_kind: cleanText(data.kind),
      status: cleanText(data.status)
    }
  }, { replace: true });
  return documentView(doc);
}

export async function setPaymentCleared(orgId: string, paymentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const payment = documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId));
  if (!RECONCILABLE_STATUSES.includes(cleanText(payment.status))) {
    throw badRequest("payment_not_reconcilable", "Only settled payments can be marked cleared.");
  }
  const clearedAt = cleanText(input.cleared_at) || nowIso();
  if (!Number.isFinite(Date.parse(clearedAt))) throw badRequest("invalid_cleared_at", "Choose a valid cleared date.");
  const updated = await savePaymentReconciliation(orgId, payment, {
    cleared_at: clearedAt,
    reconciliation: {
      state: "cleared",
      cleared_at: clearedAt,
      cleared_by_user_id: ctx.userId,
      note: cleanText(input.note),
      reconciled_at: nowIso()
    }
  });
  await recordPaymentEvent(orgId, "payment.cleared", {
    project_id: cleanText(payment.project_id),
    payment_id: cleanText(payment.id),
    direction: cleanText(payment.direction),
    amount_cents: Math.max(0, Math.round(Number(payment.amount_cents || 0))),
    cleared_at: clearedAt
  }, ctx);
  return updated;
}

export async function setPaymentUncleared(orgId: string, paymentId: string, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const payment = documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId));
  const updated = await savePaymentReconciliation(orgId, payment, {
    cleared_at: "",
    reconciliation: {
      state: "open",
      uncleared_by_user_id: ctx.userId,
      reconciled_at: nowIso()
    }
  });
  await recordPaymentEvent(orgId, "payment.uncleared", {
    project_id: cleanText(payment.project_id),
    payment_id: cleanText(payment.id)
  }, ctx);
  return updated;
}

/**
 * Reconciliation worklist: every settled movement of real money (customer
 * payments in, refunds and disbursements out) split into uncleared vs cleared.
 */
export async function reconciliationSummary(orgId: string, input: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const projectId = cleanText(input.project_id);
  const [docs, projectDocs] = await Promise.all([
    listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION),
    listDocuments(orgId, "projects").catch(() => [])
  ]);
  const projectTitles = new Map<string, string>(projectDocs.map(documentView)
    .map((project): [string, string] => [cleanText(project.id), cleanText(project.title || project.customer_name || project.address)]));
  const settled = docs.map(documentView)
    .filter((payment) => RECONCILABLE_STATUSES.includes(cleanText(payment.status)))
    .filter((payment) => !projectId || cleanText(payment.project_id) === projectId)
    .map((payment): JsonObject => ({ ...payment, project_title: projectTitles.get(cleanText(payment.project_id)) || "" }))
    .sort((a, b) => cleanText(a.settled_at || a.received_at || a.created_at).localeCompare(cleanText(b.settled_at || b.received_at || b.created_at)));
  const uncleared = settled.filter((payment) => !cleanText(payment.cleared_at));
  const cleared = settled.filter((payment) => !!cleanText(payment.cleared_at));
  const sum = (rows: JsonObject[], direction: string) => rows
    .filter((payment) => cleanText(payment.direction) === direction)
    .reduce((total, payment) => total + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0);
  return {
    uncleared,
    cleared,
    totals: {
      uncleared_count: uncleared.length,
      cleared_count: cleared.length,
      uncleared_inbound_cents: sum(uncleared, "inbound"),
      uncleared_outbound_cents: sum(uncleared, "outbound"),
      cleared_inbound_cents: sum(cleared, "inbound"),
      cleared_outbound_cents: sum(cleared, "outbound")
    }
  };
}

export async function markPaymentObligationDue(orgId: string, obligationId: string, dueAt: string, invoiceId: string, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const obligation = documentView(await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, obligationId));
  if (["paid", "void"].includes(deriveObligationStatus(obligation))) {
    throw badRequest("payment_obligation_not_open", "Paid or void payments cannot be marked due.");
  }
  const timestamp = cleanText(dueAt) || nowIso();
  if (!Number.isFinite(Date.parse(timestamp))) throw badRequest("invalid_due_at", "Choose a valid due date.");
  const updated = await saveObligation(orgId, {
    ...obligation,
    due_at: timestamp,
    due_rule: "invoice",
    metadata: { ...asObject(obligation.metadata), ...(invoiceId ? { invoice_id: invoiceId } : {}) },
    updated_by_user_id: ctx.userId
  });
  await recordPaymentEvent(orgId, "payment_obligation.marked_due", {
    project_id: cleanText(obligation.project_id),
    obligation_id: cleanText(obligation.id),
    invoice_id: cleanText(invoiceId),
    due_at: timestamp
  }, ctx);
  return updated;
}

export async function ensureInvoiceReceivable(orgId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const invoiceId = cleanText(input.invoice_id);
  const projectId = cleanText(input.project_id);
  const amountCents = Math.max(0, Math.round(Number(input.amount_cents || 0)));
  if (!invoiceId || !projectId || amountCents <= 0) throw badRequest("invoice_receivable_invalid", "A valid invoice receivable is required.");
  const stableId = invoiceId.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 150);
  const scheduleId = `payment_schedule_${stableId}`;
  const obligationId = `payment_obligation_${stableId}`;
  const existing = await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, obligationId).catch(() => null);
  if (existing) return { schedule: documentView(await readDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, scheduleId).catch(() => ({}))), obligation: documentView(existing), created: false };
  const now = nowIso();
  const dueAt = cleanText(input.due_at) && Number.isFinite(Date.parse(cleanText(input.due_at))) ? new Date(cleanText(input.due_at)).toISOString() : now;
  const branchId = cleanText(input.branch_id || ctx.branchId || "default") || "default";
  const contactRef = asObject(input.contact_ref);
  const requestedSource = asObject(input.source);
  const source = cleanText(requestedSource.id)
    ? { type: cleanText(requestedSource.type || "proposal") || "proposal", id: cleanText(requestedSource.id), snapshot_id: cleanText(requestedSource.snapshot_id) }
    : { type: "invoice", id: invoiceId };
  const title = cleanText(input.label || input.invoice_number || "Custom invoice") || "Custom invoice";
  const scheduleData = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id: scheduleId,
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    contact_ref: contactRef,
    source,
    title,
    total_cents: amountCents,
    currency: "USD",
    status: "active",
    items: [{ label: title, amount_cents: amountCents, due_rule: "invoice", due_at: dueAt, sequence: 1 }],
    created_at: now,
    updated_at: now
  };
  const scheduleDocument = await upsertDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, {
    id: scheduleId,
    data: scheduleData,
    metadata: { kind: "payment_schedule", project_id: projectId, invoice_id: invoiceId, proposal_id: cleanText(source.id), proposal_snapshot_id: cleanText(source.snapshot_id), source_key: `invoice:${invoiceId}` }
  }, { replace: true });
  const obligationData = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id: obligationId,
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    contact_ref: contactRef,
    source,
    schedule_id: scheduleId,
    label: title,
    sequence: 1,
    direction: "inbound",
    amount_cents: amountCents,
    currency: "USD",
    due_rule: "invoice",
    due_at: dueAt,
    grace_days: 1,
    allocated_cents: 0,
    refunded_cents: 0,
    status: deriveObligationStatus({ amount_cents: amountCents, allocated_cents: 0, due_at: dueAt, grace_days: 1 }),
    metadata: { invoice_id: invoiceId },
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const obligationDocument = await upsertDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, {
    id: obligationId,
    data: obligationData,
    metadata: { kind: "payment_obligation", project_id: projectId, schedule_id: scheduleId, invoice_id: invoiceId, proposal_id: cleanText(source.id), proposal_snapshot_id: cleanText(source.snapshot_id) }
  }, { replace: true });
  await recordPaymentEvent(orgId, "invoice.receivable_created", { project_id: projectId, invoice_id: invoiceId, obligation_id: obligationId, amount_cents: amountCents }, ctx);
  await patchProjectFinancialRefs(orgId, projectId);
  return { schedule: documentView(scheduleDocument), obligation: documentView(obligationDocument), created: true };
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
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(original.branch_id || "default"),
    project_id: cleanText(original.project_id),
    type: "payment.refunded",
    idempotency_key: `payment.refunded:${cleanText(refund.id)}`,
    payload: { payment_id: paymentId, refund_id: cleanText(refund.id), amount_cents: amount }
  });
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
  const includeVoid = input.include_void === true || cleanText(input.include_void) === "1";
  const docs = await listDocuments(orgId, PAYMENT_PAYABLE_COLLECTION);
  return docs.map(documentView)
    .filter((item) => !projectId || cleanText(item.project_id) === projectId)
    .filter((item) => includeVoid || cleanText(item.status) !== "void")
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

export async function createPayable(orgId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const amount = Math.max(0, moneyCents(input));
  if (amount <= 0) throw badRequest("invalid_payable_amount", "Payable amount must be greater than zero.");
  const now = nowIso();
  const projectId = cleanText(input.project_id);
  const expenseTargetKeys = projectId && asArray(input.expense_target_keys).length
    ? await assertExpenseTargetKeys(orgId, projectId, input.expense_target_keys)
    : [];
  const id = cleanText(input.id) || generatedId("payment_payable");
  const explicitPayee = asObject(input.payee_ref);
  const legacyConnection = asObject(input.vendor_ref);
  const legacyGroup = asObject(input.crew_ref);
  const payeeSource = Object.keys(explicitPayee).length ? explicitPayee : (Object.keys(legacyConnection).length ? legacyConnection : legacyGroup);
  const payeeRef = Object.keys(payeeSource).length ? {
    ...payeeSource,
    kind: cleanText(payeeSource.kind || payeeSource.type || (Object.keys(legacyConnection).length ? "organization_connection" : "resource_group")),
    id: cleanText(payeeSource.id || payeeSource.resource_id || payeeSource.connection_id || payeeSource.group_id),
    name: cleanText(payeeSource.name || payeeSource.label)
  } : {};
  const data = {
    schema_version: PAYMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || ctx.branchId || "default") || "default",
    project_id: projectId,
    kind: cleanText(input.kind || "other"),
    source: asObject(input.source),
    payee_ref: payeeRef,
    expense_target_keys: expenseTargetKeys,
    // Transitional projections for existing money views. New code writes and
    // resolves the typed payee_ref above.
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
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: data.branch_id,
    ...(projectId ? { project_id: projectId } : {}),
    type: "expense.recorded",
    idempotency_key: `expense.recorded:payable:${id}`,
    payload: {
      payable_id: id,
      kind: "payable",
      payable_kind: data.kind,
      payee_name: cleanText(asObject(data.payee_ref).name),
      amount_cents: amount
    },
    context: { actor_user_id: ctx.userId }
  });
  return documentView(doc);
}

export async function voidPayable(orgId: string, payableId: string, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const payable = documentView(await readDocument(orgId, PAYMENT_PAYABLE_COLLECTION, payableId));
  if (cleanText(payable.status) === "void") return payable;
  if (Math.max(0, Math.round(Number(payable.paid_cents || 0))) > 0) {
    throw badRequest("paid_expense_cannot_be_removed", "Paid expenses cannot be removed from the project ledger.");
  }
  const now = nowIso();
  const projectId = cleanText(payable.project_id);
  const doc = await upsertDocument(orgId, PAYMENT_PAYABLE_COLLECTION, {
    id: payableId,
    data: { ...payable, status: "void", voided_by_user_id: ctx.userId, voided_at: now, updated_by_user_id: ctx.userId, updated_at: now },
    metadata: { kind: "payment_payable", project_id: projectId, payable_kind: cleanText(payable.kind), status: "void" }
  }, { replace: true });
  await recordPaymentEvent(orgId, "payment_payable.voided", { project_id: projectId, payable_id: payableId, amount_cents: Math.max(0, Math.round(Number(payable.amount_cents || 0))) }, ctx);
  await patchProjectFinancialRefs(orgId, projectId);
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
  if (!cleanText(asObject(input.metadata).reimbursement_request_id)) {
    await import("./reimbursements.js").then(({ syncPaidReimbursementPayables }) => syncPaidReimbursementPayables(orgId, payableIds, ctx));
  }
  return { disbursement: documentView(doc), payment };
}

async function materialTotals(orgId: string, projectId: string) {
  const [listDocs, orderDocs] = await Promise.all([
    listDocuments(orgId, "material_lists"),
    listDocuments(orgId, "material_orders")
  ]);
  const lists = listDocs.map(documentView).filter((list) => cleanText(list.project_id) === projectId
    && cleanText(list.status) !== "archived"
    && !["labor", "equipment"].includes(cleanText(list.resource_type).toLowerCase()));
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
  const [schedules, obligations, payments, payables, materials, expenseSummary, recurring, invoiceDocs] = await Promise.all([
    listProjectPaymentSchedules(orgId, projectId, { skipFlag: true }),
    listProjectObligations(orgId, projectId, { skipFlag: true }),
    listProjectPayments(orgId, projectId, { skipFlag: true }),
    listPayables(orgId, { project_id: projectId }).catch(() => []),
    materialTotals(orgId, projectId),
    projectExpenseSummary(orgId, projectId),
    recurringMoneySummary(orgId, projectId),
    listDocuments(orgId, PAYMENT_INVOICE_COLLECTION).catch(() => [])
  ]);
  const obligationById = new Map(obligations.map((item) => [cleanText(item.id), item]));
  const productionHolds = invoiceDocs.map(documentView)
    .filter((invoice) => cleanText(invoice.project_id) === projectId)
    .filter((invoice) => cleanText(invoice.status) !== "void" && asObject(invoice.production_hold).enabled === true)
    .map((invoice) => {
      const linked = asArray(invoice.obligation_ids).map(cleanText).map((id) => obligationById.get(id)).filter(Boolean).map((item) => asObject(item));
      const allocated = linked.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.allocated_cents || 0))), 0);
      return {
        invoice_id: cleanText(invoice.id),
        invoice_number: cleanText(invoice.invoice_number),
        balance_due_cents: Math.max(0, Math.round(Number(invoice.total_cents || 0)) - allocated),
        note: cleanText(asObject(invoice.production_hold).note)
      };
    })
    .filter((hold) => hold.balance_due_cents > 0);
  const activeObligations = obligations.filter((item) => cleanText(item.status) !== "void");
  const totalObligations = activeObligations.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.amount_cents || 0))), 0);
  const totalAllocated = activeObligations.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.allocated_cents || 0))), 0);
  const outboundRefunds = payments
    .filter((payment) => cleanText(payment.direction) === "outbound" && cleanText(payment.kind) === "customer_refund")
    .reduce((sum, payment) => sum + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0);
  const inboundCollected = payments
    .filter((payment) => cleanText(payment.direction) === "inbound" && ["settled", "partially_refunded", "refunded"].includes(cleanText(payment.status)))
    .reduce((sum, payment) => sum + Math.max(0, Math.round(Number(payment.amount_cents || 0))), 0) - outboundRefunds;
  const payableProjected = payables.filter((payable) => !asArray(payable.expense_target_keys).length)
    .reduce((sum, payable) => sum + Math.max(0, Math.round(Number(payable.amount_cents || 0))), 0);
  const payablePaid = payables.reduce((sum, payable) => sum + Math.max(0, Math.round(Number(payable.paid_cents || 0))), 0);
  const trackedProjected = Math.max(0, Math.round(Number(asObject(expenseSummary.totals).projected_cents || 0)));
  const trackedActual = Math.max(0, Math.round(Number(asObject(expenseSummary.totals).actual_cents || 0)));
  const trackedCurrentValue = asObject(expenseSummary.totals).current_cents;
  const trackedCurrent = trackedCurrentValue != null && Number.isFinite(Number(trackedCurrentValue))
    ? Math.max(0, Math.round(Number(trackedCurrentValue)))
    : trackedProjected;
  const projectedExpenses = trackedProjected + payableProjected;
  const resourceTotals = asObject(expenseSummary.by_resource);
  const accruedCommissions = Math.max(0, Math.round(Number(asObject(resourceTotals.commission).actual_cents || 0)));
  // Accrued payroll labor (the payroll_labor:accrued system target) counts as
  // incurred cost the moment it accrues — same recognition convention as
  // commissions — so running payroll moves profit_to_date without a manual
  // labor payable.
  const accruedPayrollLabor = Math.max(0, Math.round(Number(asObject(
    asArray(expenseSummary.targets).map(asObject).find((target) => cleanText(target.target_key) === "payroll_labor:accrued") || {}
  ).actual_cents || 0)));
  const expensesToDate = materials.paid_cents + payablePaid + accruedCommissions + accruedPayrollLabor;
  const laborProjection = asObject(resourceTotals.labor);
  const equipmentProjection = asObject(resourceTotals.equipment);
  const laborPaid = payables.filter((payable) => ["crew", "labor", "payroll"].includes(cleanText(payable.kind).toLowerCase()))
    .reduce((sum, payable) => sum + Math.max(0, Math.round(Number(payable.paid_cents || 0))), 0);
  const equipmentPaid = payables.filter((payable) => cleanText(payable.kind).toLowerCase() === "equipment")
    .reduce((sum, payable) => sum + Math.max(0, Math.round(Number(payable.paid_cents || 0))), 0);
  return {
    project: documentView(projectDoc),
    project_total_cents: totalObligations,
    total_collected_cents: inboundCollected,
    total_remaining_cents: Math.max(0, totalObligations - totalAllocated),
    projected_revenue_cents: totalObligations,
    revenue_to_date_cents: inboundCollected,
    projected_expenses_cents: projectedExpenses,
    expenses_to_date_cents: expensesToDate,
    accrued_commissions_cents: accruedCommissions,
    accrued_payroll_labor_cents: accruedPayrollLabor,
    actual_expenses_cents: trackedActual,
    forecast_expenses_cents: trackedCurrent + payableProjected,
    expense_variance_cents: trackedCurrent - trackedProjected,
    projected_profit_cents: totalObligations - projectedExpenses,
    profit_to_date_cents: inboundCollected - expensesToDate,
    forecast_profit_cents: totalObligations - trackedCurrent - payableProjected,
    materials,
    labor: {
      projected_cents: Math.round(Number(laborProjection.projected_cents || 0)),
      paid_cents: laborPaid,
      accrued_cents: accruedPayrollLabor,
      actual_cents: laborPaid + accruedPayrollLabor
    },
    equipment: { projected_cents: Math.round(Number(equipmentProjection.projected_cents || 0)), paid_cents: equipmentPaid },
    expense_summary: expenseSummary,
    recurring,
    schedules,
    obligations,
    payments,
    payables,
    production_holds: productionHolds,
    production_hold_count: productionHolds.length,
    production_hold_balance_cents: productionHolds.reduce((sum, hold) => sum + hold.balance_due_cents, 0)
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
