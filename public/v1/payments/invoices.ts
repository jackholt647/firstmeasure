import { randomBytes } from "node:crypto";

import { sendOrganizationTransactionalEmail } from "../email/organization_outbound.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, notFound } from "../platform/errors.js";
import {
  listDocuments,
  readBranchModule,
  readDocument,
  readGlobal,
  readMediaFile,
  readOrganization,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { renderTemplatedArtifact } from "../documents/artifacts.js";
import { emitWorkEvent } from "../work/engine.js";
import {
  deriveObligationStatus,
  ensureInvoiceReceivable,
  listProjectObligations,
  markPaymentObligationDue,
  PAYMENT_INVOICE_COLLECTION,
  PAYMENT_OBLIGATION_COLLECTION,
  PAYMENT_SCHEDULE_COLLECTION,
  recordPaymentEvent,
  saveObligation
} from "./storage.js";

export { PAYMENT_INVOICE_COLLECTION };
const PAYMENT_INVOICE_SCHEMA_VERSION = 2;

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

function generatedId() {
  return `invoice_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

function documentView(document: unknown): JsonObject {
  const source = asObject(document);
  const data = asObject(source.data);
  return {
    ...data,
    id: cleanText(data.id || source.id),
    revision: Number(source.revision || data.revision || 0),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

function isoDate(value: unknown, fallback = "") {
  const text = cleanText(value);
  const date = text ? new Date(text) : null;
  if (date && Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
  return fallback;
}

async function branchModuleData(orgId: string, branchId: string, moduleId: string) {
  const direct = await readBranchModule(orgId, branchId, moduleId).catch(() => null);
  if (direct) return asObject(asObject(direct).data);
  if (branchId !== "default") {
    const fallback = await readBranchModule(orgId, "default", moduleId).catch(() => null);
    if (fallback) return asObject(asObject(fallback).data);
  }
  return {};
}

export async function getInvoicePaymentSettings(orgId: string, branchIdValue = "default") {
  const branchId = cleanText(branchIdValue || "default") || "default";
  const [paymentSettings, presentationStyle] = await Promise.all([
    branchModuleData(orgId, branchId, "payment_settings"),
    branchModuleData(orgId, branchId, "presentation_style")
  ]);
  const proposalDefaults = asObject(presentationStyle.proposal_defaults);
  const configuredPercent = Number(paymentSettings.default_sales_tax_percent);
  const proposalPercent = Number(proposalDefaults.sales_tax_percent);
  const defaultPercent = Number.isFinite(configuredPercent)
    ? configuredPercent
    : (Number.isFinite(proposalPercent) ? proposalPercent : 0);
  const configuredDueDays = Number(paymentSettings.default_due_days);
  return {
    sales_tax_enabled: paymentSettings.sales_tax_enabled !== false,
    default_sales_tax_percent: Math.min(100, Math.max(0, defaultPercent)),
    default_due_days: Number.isFinite(configuredDueDays) ? Math.min(365, Math.max(0, Math.round(configuredDueDays))) : 0,
    // Additive pass-through surcharge flags (provider charge path + intake
    // modal line item). Off by default; "card_only" is the only mode today.
    surcharge_enabled: paymentSettings.surcharge_enabled === true,
    surcharge_mode: cleanText(paymentSettings.surcharge_mode) === "card_only" || !cleanText(paymentSettings.surcharge_mode)
      ? "card_only"
      : cleanText(paymentSettings.surcharge_mode)
  };
}

function dueDateFromTerms(issueDate: string, dueDays: number) {
  const base = Date.parse(`${issueDate}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return issueDate;
  return new Date(base + Math.max(0, Math.round(dueDays)) * 86_400_000).toISOString().slice(0, 10);
}

export async function invoicePaymentSettingsForProject(orgId: string, projectId: string) {
  const projectDocument = await readDocument(orgId, "projects", projectId).catch(() => null);
  const project = asObject(asObject(projectDocument).data);
  return getInvoicePaymentSettings(orgId, cleanText(project.branch_id || "default") || "default");
}

function customerFromProject(project: JsonObject) {
  const contacts = asArray(project.contacts).map(asObject);
  const customer = asObject(project.customer);
  const primary = contacts.find((contact) => contact.primary === true || cleanText(contact.role).toLowerCase() === "primary") || contacts[0] || {};
  const id = cleanText(primary.id || primary.contact_id || customer.id || customer.contact_id || project.contact_id || project.primary_contact_id);
  return {
    ...(id ? { id, contact_id: id } : {}),
    name: cleanText(primary.name || customer.name || project.customer_name || project.primary_contact_name) || "Customer",
    email: cleanText(primary.email || customer.email || project.customer_email || project.primary_contact_email).toLowerCase(),
    phone: cleanText(primary.phone || customer.phone || project.customer_phone || project.primary_contact_phone),
    address: cleanText(primary.address || customer.address || project.customer_address || project.primary_contact_address || project.address)
  };
}

function invoiceNumber(id: string, issueDate: string) {
  const date = issueDate.replace(/-/g, "").slice(2) || new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const suffix = id.replace(/^invoice_/, "").slice(-5).toUpperCase();
  return `INV-${date}-${suffix}`;
}

function obligationOpenCents(obligation: JsonObject) {
  return Math.max(0, Math.round(Number(obligation.amount_cents || 0)) - Math.round(Number(obligation.allocated_cents || 0)));
}

function statusForObligations(obligations: JsonObject[], storedStatus = "draft") {
  if (obligations.length && obligations.every((item) => deriveObligationStatus(item) === "paid")) return "paid";
  if (obligations.some((item) => deriveObligationStatus(item) === "overdue")) return "overdue";
  if (obligations.some((item) => ["due", "partially_paid"].includes(deriveObligationStatus(item)))) return "due";
  return cleanText(storedStatus || "draft") || "draft";
}

async function invoiceObligations(orgId: string, invoice: JsonObject) {
  const ids = new Set(asArray(invoice.obligation_ids).map(cleanText).filter(Boolean));
  if (!ids.size) return [];
  return (await listProjectObligations(orgId, cleanText(invoice.project_id), { skipFlag: true }))
    .filter((obligation) => ids.has(cleanText(obligation.id)));
}

function liveInvoiceViewFrom(invoice: JsonObject, obligations: JsonObject[]): JsonObject {
  const amountPaidCents = obligations.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.allocated_cents || 0))), 0);
  const totalCents = Math.max(0, Math.round(Number(invoice.total_cents || 0)));
  const voided = cleanText(invoice.status) === "void";
  const obligationStatus = voided ? "void" : statusForObligations(obligations, cleanText(invoice.status));
  const actualStatus = !voided && obligationStatus === "paid" && amountPaidCents < totalCents
    ? (cleanText(invoice.status) === "due" ? "due" : "draft")
    : obligationStatus;
  return {
    ...invoice,
    status: actualStatus,
    render_paid_in_full: typeof invoice.render_paid_in_full === "boolean"
      ? invoice.render_paid_in_full
      : actualStatus === "paid",
    amount_paid_cents: amountPaidCents,
    balance_due_cents: voided ? 0 : Math.max(0, totalCents - amountPaidCents),
    obligations: obligations.map((item) => ({
      id: cleanText(item.id),
      label: cleanText(item.label),
      source: asObject(item.source),
      amount_cents: Math.round(Number(item.amount_cents || 0)),
      allocated_cents: Math.round(Number(item.allocated_cents || 0)),
      due_at: cleanText(item.due_at),
      status: deriveObligationStatus(item)
    }))
  };
}

async function liveInvoiceView(orgId: string, invoice: JsonObject): Promise<JsonObject> {
  return liveInvoiceViewFrom(invoice, await invoiceObligations(orgId, invoice));
}

export async function listProjectInvoices(orgId: string, projectId: string) {
  const documents = await listDocuments(orgId, PAYMENT_INVOICE_COLLECTION);
  const invoices = documents.map(documentView).filter((invoice) => cleanText(invoice.project_id) === projectId);
  return Promise.all(invoices.map((invoice) => liveInvoiceView(orgId, invoice)));
}

export async function readInvoice(orgId: string, invoiceId: string): Promise<JsonObject> {
  const document = await readDocument(orgId, PAYMENT_INVOICE_COLLECTION, invoiceId).catch(() => null);
  if (!document) throw notFound("invoice_not_found", "Invoice was not found.");
  return liveInvoiceView(orgId, documentView(document));
}

function obligationViewsById(obligationDocuments: unknown[]) {
  const byId = new Map<string, JsonObject>();
  for (const doc of obligationDocuments) {
    const view = documentView(doc);
    const id = cleanText(view.id);
    if (id) byId.set(id, view);
  }
  return byId;
}

function daysPastDue(invoice: JsonObject, today: string) {
  const due = Date.parse(`${cleanText(invoice.due_date) || today}T00:00:00.000Z`);
  const now = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
  return Math.floor((now - due) / 86_400_000);
}

function agingBucketKey(days: number) {
  if (days <= 0) return "current";
  if (days <= 30) return "days_1_30";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "days_over_90";
}

function organizationInvoiceSummary(invoices: JsonObject[]) {
  const today = nowIso().slice(0, 10);
  const summary = {
    invoice_count: invoices.length,
    outstanding_cents: 0,
    outstanding_count: 0,
    overdue_cents: 0,
    overdue_count: 0,
    draft_cents: 0,
    draft_count: 0,
    paid_cents: 0,
    paid_count: 0,
    production_hold_count: 0,
    production_hold_cents: 0,
    aging: {
      current: { count: 0, cents: 0 },
      days_1_30: { count: 0, cents: 0 },
      days_31_60: { count: 0, cents: 0 },
      days_61_90: { count: 0, cents: 0 },
      days_over_90: { count: 0, cents: 0 }
    }
  };
  for (const invoice of invoices) {
    const status = cleanText(invoice.status);
    const balance = Math.max(0, Math.round(Number(invoice.balance_due_cents || 0)));
    if (status === "void") continue;
    if (asObject(invoice.production_hold).enabled === true && balance > 0) {
      summary.production_hold_count += 1;
      summary.production_hold_cents += balance;
    }
    if (status === "paid") {
      summary.paid_count += 1;
      summary.paid_cents += Math.max(0, Math.round(Number(invoice.total_cents || 0)));
      continue;
    }
    if (status === "draft") {
      summary.draft_count += 1;
      summary.draft_cents += balance;
      continue;
    }
    summary.outstanding_count += 1;
    summary.outstanding_cents += balance;
    const days = daysPastDue(invoice, today);
    if (status === "overdue") {
      summary.overdue_count += 1;
      summary.overdue_cents += balance;
    }
    const bucket = summary.aging[agingBucketKey(days)];
    bucket.count += 1;
    bucket.cents += balance;
  }
  return summary;
}

export async function listOrganizationInvoices(orgId: string, filters: JsonObject = {}) {
  const [invoiceDocuments, obligationDocuments] = await Promise.all([
    listDocuments(orgId, PAYMENT_INVOICE_COLLECTION),
    listDocuments(orgId, PAYMENT_OBLIGATION_COLLECTION)
  ]);
  const obligationById = obligationViewsById(obligationDocuments);
  const projectFilter = cleanText(filters.project_id);
  const statusFilter = new Set(cleanText(filters.status).split(",").map((value) => value.trim()).filter(Boolean));
  const invoices = invoiceDocuments.map(documentView)
    .filter((invoice) => !projectFilter || cleanText(invoice.project_id) === projectFilter)
    .map((invoice) => {
      const linked = asArray(invoice.obligation_ids).map(cleanText)
        .map((id) => obligationById.get(id))
        .filter((item): item is JsonObject => !!item);
      return liveInvoiceViewFrom(invoice, linked);
    })
    .sort((a, b) => (cleanText(b.issue_date) || cleanText(b.created_at)).localeCompare(cleanText(a.issue_date) || cleanText(a.created_at))
      || cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
  const summary = organizationInvoiceSummary(invoices);
  const filtered = statusFilter.size
    ? invoices.filter((invoice) => statusFilter.has(cleanText(invoice.status)))
    : invoices;
  return { invoices: filtered, summary };
}

const OPEN_OBLIGATION_STATUSES = new Set(["scheduled", "due", "overdue", "partially_paid"]);

export async function listUninvoicedObligations(orgId: string) {
  const [invoiceDocuments, obligationDocuments, projectDocuments] = await Promise.all([
    listDocuments(orgId, PAYMENT_INVOICE_COLLECTION),
    listDocuments(orgId, PAYMENT_OBLIGATION_COLLECTION),
    listDocuments(orgId, "projects")
  ]);
  const invoicedObligationIds = new Set<string>();
  for (const doc of invoiceDocuments) {
    const invoice = documentView(doc);
    if (cleanText(invoice.status) === "void") continue;
    for (const id of asArray(invoice.obligation_ids).map(cleanText)) {
      if (id) invoicedObligationIds.add(id);
    }
  }
  const projectById = new Map(projectDocuments.map((doc) => {
    const view = documentView(doc);
    return [cleanText(view.id), view] as const;
  }));
  const groups = new Map<string, JsonObject>();
  for (const doc of obligationDocuments) {
    const obligation = documentView(doc);
    const id = cleanText(obligation.id);
    const projectId = cleanText(obligation.project_id);
    if (!id || !projectId || invoicedObligationIds.has(id)) continue;
    if (cleanText(asObject(obligation.source).type) !== "proposal") continue;
    const status = deriveObligationStatus(obligation);
    if (!OPEN_OBLIGATION_STATUSES.has(status)) continue;
    const openCents = obligationOpenCents(obligation);
    if (openCents <= 0) continue;
    const project = projectById.get(projectId) || {};
    const group = groups.get(projectId) || {
      project_id: projectId,
      project_title: cleanText(project.title) || "Project",
      project_address: cleanText(project.address),
      customer: customerFromProject(asObject(project)),
      obligations: [] as JsonObject[],
      uninvoiced_cents: 0,
      ready_cents: 0
    };
    (group.obligations as JsonObject[]).push({
      id,
      label: cleanText(obligation.label),
      schedule_id: cleanText(obligation.schedule_id),
      source: asObject(obligation.source),
      payment_kind: cleanText(obligation.payment_kind),
      due_rule: cleanText(obligation.due_rule),
      due_at: cleanText(obligation.due_at),
      amount_cents: Math.max(0, Math.round(Number(obligation.amount_cents || 0))),
      allocated_cents: Math.max(0, Math.round(Number(obligation.allocated_cents || 0))),
      open_cents: openCents,
      status
    });
    group.uninvoiced_cents = Number(group.uninvoiced_cents || 0) + openCents;
    if (["due", "overdue", "partially_paid"].includes(status)) {
      group.ready_cents = Number(group.ready_cents || 0) + openCents;
    }
    groups.set(projectId, group);
  }
  const sortKey = (obligation: JsonObject) => cleanText(obligation.due_at) || "9999-12-31";
  const projects: JsonObject[] = Array.from(groups.values()).map((group) => ({
    ...group,
    obligations: asArray(group.obligations).map(asObject).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  }));
  projects.sort((a, b) => {
    const readyDelta = Number(b.ready_cents || 0) - Number(a.ready_cents || 0);
    if (readyDelta) return readyDelta;
    return sortKey(asObject(asArray(a.obligations)[0])).localeCompare(sortKey(asObject(asArray(b.obligations)[0])));
  });
  return projects;
}

export async function quickInvoiceCandidates(orgId: string, projectId: string) {
  const projects = await listUninvoicedObligations(orgId);
  const group = projects.find((item) => cleanText(item.project_id) === projectId);
  return asArray(group?.obligations).map(asObject);
}

export async function createInvoice(orgId: string, projectId: string, input: JsonObject, ctx: PlatformAuthContext): Promise<JsonObject> {
  const projectDocument = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!projectDocument) throw notFound("project_not_found", "Project was not found.");
  const project = asObject(asObject(projectDocument).data);
  const inputLines = asArray(input.line_items).map(asObject);
  const requested = new Set([
    ...asArray(input.obligation_ids).map(cleanText),
    ...inputLines.map((line) => cleanText(line.obligation_id))
  ].filter(Boolean));
  const obligations = (await listProjectObligations(orgId, projectId, { skipFlag: true }))
    .filter((obligation) => requested.has(cleanText(obligation.id)));
  if (requested.size && obligations.length !== requested.size) throw badRequest("invoice_obligations_invalid", "One or more selected payments are not available for this project.");
  if (!requested.size && !inputLines.length) throw badRequest("invoice_line_items_required", "Add at least one payment or custom invoice item.");
  if (obligations.some((obligation) => deriveObligationStatus(obligation) === "void")) {
    throw badRequest("invoice_obligation_void", "Void payments cannot be invoiced.");
  }
  if (obligations.some((obligation) => cleanText(asObject(obligation.source).type) !== "proposal")) {
    throw badRequest("invoice_portal_source_required", "Customer invoices must use a payment from a signed proposal schedule.");
  }
  const fallbackSnapshot = obligations.length ? {} : (await listDocuments(orgId, "proposal_snapshots"))
    .map(documentView)
    .filter((snapshot) => cleanText(snapshot.project_id) === projectId)
    .filter((snapshot) => cleanText(snapshot.status) === "signed" || cleanText(asObject(snapshot.delivery).state) === "signed")
    .sort((a, b) => cleanText(b.updated_at || b.created_at).localeCompare(cleanText(a.updated_at || a.created_at)))[0] || {};
  const now = nowIso();
  const issueDate = isoDate(input.issue_date, now.slice(0, 10));
  const requestedDueDate = isoDate(input.due_date, "");
  const id = generatedId();
  const customer = customerFromProject(project);
  const obligationById = new Map(obligations.map((obligation) => [cleanText(obligation.id), obligation]));
  const paymentLine = (obligation: JsonObject) => {
    const openCents = obligationOpenCents(obligation);
    return {
      type: "payment",
      obligation_id: cleanText(obligation.id),
      description: cleanText(obligation.label || "Project payment"),
      amount_cents: openCents > 0 ? openCents : Math.max(0, Math.round(Number(obligation.amount_cents || 0))),
      currency: cleanText(obligation.currency || "USD") || "USD"
    };
  };
  const lineItems = inputLines.length ? inputLines.map((line) => {
    const obligationId = cleanText(line.obligation_id);
    if (obligationId) {
      const obligation = obligationById.get(obligationId);
      if (!obligation) throw badRequest("invoice_obligations_invalid", "One or more selected payments are not available for this project.");
      return paymentLine(obligation);
    }
    const amountCents = Math.max(0, Math.round(Number(line.amount_cents || 0)));
    if (amountCents <= 0) throw badRequest("invoice_line_item_amount_invalid", "Custom invoice item amounts must be greater than zero.");
    return {
      type: "manual",
      description: cleanText(line.description || "Custom invoice item") || "Custom invoice item",
      amount_cents: amountCents,
      currency: "USD"
    };
  }) : obligations.map(paymentLine);
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.amount_cents, 0);
  if (subtotalCents <= 0) throw badRequest("invoice_zero_balance", "Invoice total must be greater than zero.");
  const branchId = cleanText(obligations[0]?.branch_id || project.branch_id || ctx.branchId || "default") || "default";
  const paymentSettings = await getInvoicePaymentSettings(orgId, branchId);
  const dueDate = requestedDueDate || dueDateFromTerms(issueDate, Number(paymentSettings.default_due_days || 0));
  const requestedTaxPercent = Number(input.tax_percent);
  const taxPercent = paymentSettings.sales_tax_enabled
    ? Math.min(100, Math.max(0, Number.isFinite(requestedTaxPercent) ? requestedTaxPercent : Number(paymentSettings.default_sales_tax_percent || 0)))
    : 0;
  const taxEnabled = paymentSettings.sales_tax_enabled && input.tax_enabled === true;
  const taxCents = taxEnabled ? Math.round(subtotalCents * taxPercent / 100) : 0;
  const totalCents = subtotalCents + taxCents;
  const manualSubtotalCents = lineItems.filter((line) => line.type === "manual").reduce((sum, line) => sum + line.amount_cents, 0);
  const supplementalReceivableCents = manualSubtotalCents + taxCents;
  const proposalSource = obligations.length
    ? asObject(obligations[0]?.source)
    : { id: cleanText(fallbackSnapshot.proposal_id), snapshot_id: cleanText(fallbackSnapshot.id) };
  const data = {
    schema_version: PAYMENT_INVOICE_SCHEMA_VERSION,
    id,
    invoice_number: invoiceNumber(id, issueDate),
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    project_ref: { id: projectId, title: cleanText(project.title), address: cleanText(project.address) },
    proposal_ref: {
      id: cleanText(proposalSource.id),
      snapshot_id: cleanText(proposalSource.snapshot_id),
      title: cleanText(asObject(obligations[0]?.schedule_ref).title || obligations[0]?.schedule_title || fallbackSnapshot.title || project.title || "Project proposal")
    },
    customer,
    obligation_ids: Array.from(requested),
    line_items: lineItems,
    subtotal_cents: subtotalCents,
    tax_enabled: taxEnabled,
    tax_percent: taxEnabled ? taxPercent : 0,
    tax_cents: taxCents,
    total_cents: totalCents,
    supplemental_receivable_cents: supplementalReceivableCents,
    currency: "USD",
    issue_date: issueDate,
    due_date: dueDate,
    status: "draft",
    render_paid_in_full: typeof input.render_paid_in_full === "boolean"
      ? input.render_paid_in_full
      : obligations.length > 0 && supplementalReceivableCents === 0 && obligations.every((obligation) => deriveObligationStatus(obligation) === "paid"),
    notes: cleanText(input.notes),
    email_deliveries: [],
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const document = await upsertDocument(orgId, PAYMENT_INVOICE_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_invoice", project_id: projectId, status: "draft", invoice_number: data.invoice_number }
  }, { replace: true });
  await recordPaymentEvent(orgId, "invoice.created", { project_id: projectId, invoice_id: id, amount_cents: totalCents }, ctx);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    type: "invoice.created",
    idempotency_key: `invoice.created:${id}`,
    payload: {
      invoice_id: id,
      invoice_number: data.invoice_number,
      total_cents: totalCents,
      status: "draft"
    },
    context: { actor_user_id: ctx.userId }
  });
  return liveInvoiceView(orgId, documentView(document));
}

export async function markInvoiceDue(orgId: string, invoiceId: string, input: JsonObject, ctx: PlatformAuthContext): Promise<JsonObject> {
  const invoice = await readInvoice(orgId, invoiceId);
  if (cleanText(invoice.status) === "paid") throw badRequest("invoice_already_paid", "Paid invoices cannot be marked due.");
  const explicit = cleanText(input.due_at);
  const dueAt = explicit && Number.isFinite(Date.parse(explicit))
    ? new Date(explicit).toISOString()
    : nowIso();
  const obligationIds = new Set(asArray(invoice.obligation_ids).map(cleanText).filter(Boolean));
  const supplementalReceivableCents = Math.max(0, Math.round(Number(invoice.supplemental_receivable_cents || 0)));
  if (supplementalReceivableCents > 0) {
    const receivable = await ensureInvoiceReceivable(orgId, {
      invoice_id: invoiceId,
      invoice_number: cleanText(invoice.invoice_number),
      project_id: cleanText(invoice.project_id),
      branch_id: cleanText(invoice.branch_id),
      contact_ref: asObject(invoice.customer),
      source: { type: "proposal", id: cleanText(asObject(invoice.proposal_ref).id), snapshot_id: cleanText(asObject(invoice.proposal_ref).snapshot_id) },
      label: `${cleanText(invoice.invoice_number || "Invoice")} custom items and tax`,
      amount_cents: supplementalReceivableCents,
      due_at: dueAt
    }, ctx);
    obligationIds.add(cleanText(asObject(receivable.obligation).id));
  }
  const currentObligationStatus = new Map(asArray(invoice.obligations).map(asObject).map((obligation) => [cleanText(obligation.id), cleanText(obligation.status)]));
  for (const obligationId of obligationIds) {
    if (["paid", "void"].includes(currentObligationStatus.get(obligationId) || "")) continue;
    await markPaymentObligationDue(orgId, obligationId, dueAt, invoiceId, ctx);
  }
  const now = nowIso();
  const document = await upsertDocument(orgId, PAYMENT_INVOICE_COLLECTION, {
    id: invoiceId,
    data: {
      ...invoice,
      obligation_ids: Array.from(obligationIds),
      status: "due",
      due_date: isoDate(dueAt, cleanText(invoice.due_date)),
      portal_published_at: now,
      updated_by_user_id: ctx.userId,
      updated_at: now
    },
    metadata: { kind: "payment_invoice", project_id: cleanText(invoice.project_id), status: "due", invoice_number: cleanText(invoice.invoice_number) }
  }, { replace: true });
  await recordPaymentEvent(orgId, "invoice.marked_due", { project_id: cleanText(invoice.project_id), invoice_id: invoiceId, due_at: dueAt }, ctx);
  return liveInvoiceView(orgId, documentView(document));
}

export async function voidInvoice(orgId: string, invoiceId: string, input: JsonObject, ctx: PlatformAuthContext): Promise<JsonObject> {
  const invoice = await readInvoice(orgId, invoiceId);
  const status = cleanText(invoice.status);
  if (status === "paid") throw badRequest("invoice_already_paid", "Paid invoices cannot be voided.");
  if (status === "void") return invoice;
  // The supplemental receivable (custom line items + tax) exists only for this
  // invoice, so it is voided with it — unless money has already been allocated.
  const stableId = invoiceId.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 150);
  const supplementalObligationId = `payment_obligation_${stableId}`;
  const supplementalDoc = await readDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, supplementalObligationId).catch(() => null);
  if (supplementalDoc) {
    const supplemental = documentView(supplementalDoc);
    if (Math.round(Number(supplemental.allocated_cents || 0)) <= 0 && deriveObligationStatus(supplemental) !== "void") {
      await saveObligation(orgId, { ...supplemental, status: "void", updated_by_user_id: ctx.userId });
      const scheduleDoc = await readDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, `payment_schedule_${stableId}`).catch(() => null);
      if (scheduleDoc) {
        const schedule = documentView(scheduleDoc);
        await upsertDocument(orgId, PAYMENT_SCHEDULE_COLLECTION, {
          id: cleanText(schedule.id),
          data: { ...schedule, status: "void", updated_at: nowIso() },
          metadata: { kind: "payment_schedule", project_id: cleanText(schedule.project_id), invoice_id: invoiceId, source_key: `invoice:${invoiceId}` }
        }, { replace: true });
      }
    }
  }
  const now = nowIso();
  const document = await upsertDocument(orgId, PAYMENT_INVOICE_COLLECTION, {
    id: invoiceId,
    data: {
      ...invoice,
      status: "void",
      voided_at: now,
      void_reason: cleanText(input.reason),
      updated_by_user_id: ctx.userId,
      updated_at: now
    },
    metadata: { kind: "payment_invoice", project_id: cleanText(invoice.project_id), status: "void", invoice_number: cleanText(invoice.invoice_number) }
  }, { replace: true });
  await recordPaymentEvent(orgId, "invoice.voided", { project_id: cleanText(invoice.project_id), invoice_id: invoiceId, reason: cleanText(input.reason) }, ctx);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(invoice.branch_id || "default") || "default",
    project_id: cleanText(invoice.project_id),
    type: "invoice.voided",
    idempotency_key: `invoice.voided:${invoiceId}`,
    payload: { invoice_id: invoiceId, invoice_number: cleanText(invoice.invoice_number), reason: cleanText(input.reason) },
    context: { actor_user_id: ctx.userId }
  });
  return liveInvoiceView(orgId, documentView(document));
}

export async function setInvoiceProductionHold(orgId: string, invoiceId: string, input: JsonObject, ctx: PlatformAuthContext): Promise<JsonObject> {
  const invoice = await readInvoice(orgId, invoiceId);
  if (cleanText(invoice.status) === "void") throw badRequest("invoice_voided", "Void invoices cannot hold production.");
  const enabled = input.enabled === true;
  const now = nowIso();
  const document = await upsertDocument(orgId, PAYMENT_INVOICE_COLLECTION, {
    id: invoiceId,
    data: {
      ...invoice,
      production_hold: enabled
        ? { enabled: true, note: cleanText(input.note), set_by_user_id: ctx.userId, set_at: now }
        : { enabled: false },
      updated_by_user_id: ctx.userId,
      updated_at: now
    },
    metadata: { kind: "payment_invoice", project_id: cleanText(invoice.project_id), status: cleanText(invoice.status), invoice_number: cleanText(invoice.invoice_number) }
  }, { replace: true });
  await recordPaymentEvent(orgId, enabled ? "invoice.production_hold_set" : "invoice.production_hold_cleared", {
    project_id: cleanText(invoice.project_id), invoice_id: invoiceId, note: cleanText(input.note)
  }, ctx);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: cleanText(invoice.branch_id || "default") || "default",
    project_id: cleanText(invoice.project_id),
    type: "invoice.production_hold_changed",
    idempotency_key: `invoice.production_hold:${invoiceId}:${now}`,
    payload: { invoice_id: invoiceId, invoice_number: cleanText(invoice.invoice_number), enabled, note: cleanText(input.note) },
    context: { actor_user_id: ctx.userId }
  });
  return liveInvoiceView(orgId, documentView(document));
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.round(Number(value || 0)) / 100);
}

function safeHex(value: unknown, fallback: string) {
  const text = cleanText(value);
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function hexRgbCss(hex: string) {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#d93025";
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)].join(",");
}

function mediaIdFromValue(value: unknown) {
  const source = asObject(value);
  return cleanText(source.media_id || source.mediaId || source.logo_media_id || source.logoMediaId);
}

function imageUrlFromValue(value: unknown): string {
  if (typeof value === "string") return cleanText(value);
  const source = asObject(value);
  return cleanText(source.src || source.url || source.original || source.file_url || source.fileUrl || source.logo_url || source.logoUrl || source.logo);
}

async function embeddedImageDataUri(contentTypeValue: unknown, bytesValue: Buffer) {
  const contentType = cleanText(contentTypeValue).split(";")[0]?.toLowerCase() || "application/octet-stream";
  if (!contentType.startsWith("image/") && !bytesValue.subarray(0, 256).toString("utf8").includes("<svg")) return "";
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(bytesValue, { density: 192, animated: false })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function imageDataUri(orgId: string, candidates: unknown[]) {
  for (const candidate of candidates) {
    const mediaId = mediaIdFromValue(candidate);
    if (mediaId) {
      try {
        const file = await readMediaFile(orgId, mediaId, "original");
        const embedded = await embeddedImageDataUri(file.contentType, file.bytes);
        if (embedded) return embedded;
      } catch {
        // Continue through the frozen proposal and organization fallbacks.
      }
    }
    const url = imageUrlFromValue(candidate);
    if (!url) continue;
    if (/^data:image\//i.test(url)) {
      try {
        const match = url.match(/^data:([^;,]+)(;base64)?,(.*)$/is);
        if (match) {
          const contentType = match[1] || "";
          const payload = match[3] || "";
          const bytes = match[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
          const embedded = await embeddedImageDataUri(contentType, bytes);
          if (embedded) return embedded;
        }
      } catch {
        // Continue through other logo candidates.
      }
    }
    const mediaMatch = url.match(/\/media\/([^/?]+)\//i);
    if (mediaMatch?.[1]) {
      try {
        const file = await readMediaFile(orgId, decodeURIComponent(mediaMatch[1]), "original");
        const embedded = await embeddedImageDataUri(file.contentType, file.bytes);
        if (embedded) return embedded;
      } catch {
        // Continue to the remote URL fallback.
      }
    }
    if (/^https?:\/\//i.test(url)) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        const contentType = cleanText(response.headers.get("content-type")).split(";")[0] || "";
        if (response.ok && contentType.startsWith("image/")) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length <= 8 * 1024 * 1024) {
            const embedded = await embeddedImageDataUri(contentType, bytes);
            if (embedded) return embedded;
          }
        }
      } catch {
        // Render the company name when a remote logo cannot be embedded.
      }
    }
  }
  return "";
}

async function invoicePresentation(orgId: string, invoice: JsonObject, organization: JsonObject, global: JsonObject) {
  const proposalRef = asObject(invoice.proposal_ref);
  const obligationSource = asObject(asObject(asArray(invoice.obligations)[0]).source);
  const snapshotId = cleanText(proposalRef.snapshot_id || invoice.proposal_snapshot_id || obligationSource.snapshot_id);
  const snapshotDocument = snapshotId ? await readDocument(orgId, "proposal_snapshots", snapshotId).catch(() => null) : null;
  const snapshot = asObject(asObject(snapshotDocument).data);
  const content = asObject(snapshot.content);
  const branchId = cleanText(invoice.branch_id || "default") || "default";
  const styleDocument = await readBranchModule(orgId, branchId, "presentation_style").catch(() => branchId === "default"
    ? null
    : readBranchModule(orgId, "default", "presentation_style").catch(() => null));
  const branchStyle = asObject(asObject(styleDocument).data);
  const defaults = asObject(branchStyle.proposal_defaults);
  const themeValue = content.theme;
  const themeObject = asObject(themeValue);
  const rawTheme = cleanText(themeObject.key || themeObject.id || content.theme_key || (typeof themeValue === "string" ? themeValue : "") || branchStyle.default_theme || defaults.default_theme || "margin");
  const theme = ["margin", "clean", "triangles"].includes(rawTheme) ? rawTheme : "margin";
  const colors = asObject(content.brandColors);
  const styleBranding = asObject(branchStyle.branding);
  const styleColors = asObject(styleBranding.colors);
  const orgBranding = asObject(organization.branding);
  const orgColors = asObject(orgBranding.colors);
  const globalBranding = asObject(global.branding);
  const globalColors = asObject(globalBranding.colors);
  const primary = safeHex(content.primaryColor || content.primary_color || colors.primary || styleColors.primary || styleBranding.primary || orgColors.primary || orgBranding.primary || globalColors.primary || globalBranding.primary, "#d93025");
  const secondary = safeHex(content.secondaryColor || content.secondary_color || content.accentColor || colors.secondary || styleColors.secondary || styleBranding.secondary || orgColors.secondary || orgBranding.secondary || globalColors.secondary || globalBranding.secondary, "#f3b5b0");
  const fontFamily = cleanText(content.fontFamily || content.font_family || asObject(content.typography).font_family || defaults.font_family || branchStyle.proposal_font_family || branchStyle.font_family || "Montserrat").replace(/["'\\]/g, "") || "Montserrat";
  const companyName = cleanText(branchStyle.companyName || branchStyle.orgName || branchStyle.brandName || styleBranding.companyName || styleBranding.name || organization.name || global.company_name || "Company");
  const companyLogo = await imageDataUri(orgId, [
    styleBranding,
    { media_id: branchStyle.logo_media_id, src: branchStyle.logo_url || branchStyle.logoUrl || branchStyle.logo },
    orgBranding,
    { media_id: organization.logo_media_id, src: organization.logo_url || organization.logoUrl || organization.logo },
    globalBranding
  ]);
  const coBrand = content.coBrandLogo || content.co_brand_logo || content.cobrand_logo || content.cobrandLogo;
  const coBrandLogo = await imageDataUri(orgId, [coBrand]);
  const hasLogoLockup = !!(companyLogo || coBrandLogo);
  const headerClearance = theme === "clean"
    ? 1.05
    : theme === "triangles"
      ? (hasLogoLockup ? 2.55 : 2.15)
      : (hasLogoLockup ? 1.16 : 0.72);
  return { theme, primary, secondary, fontFamily, companyName, companyLogo, coBrandLogo, headerClearance, proposalTitle: cleanText(snapshot.title || content.title) };
}

async function invoiceHtml(orgId: string, invoice: JsonObject) {
  const [organization, globalDocument] = await Promise.all([
    readOrganization(orgId).catch(() => ({})),
    readGlobal(orgId).catch(() => ({}))
  ]);
  const global = asObject(asObject(globalDocument).data);
  const presentation = await invoicePresentation(orgId, invoice, asObject(organization), global);
  const primary = presentation.primary;
  const secondary = presentation.secondary;
  const orgName = presentation.companyName;
  const customer = asObject(invoice.customer);
  const project = asObject(invoice.project_ref);
  const proposal = asObject(invoice.proposal_ref);
  const lines = asArray(invoice.line_items).map(asObject);
  const renderPaidInFull = invoice.render_paid_in_full === true;
  const renderedPaidCents = renderPaidInFull ? Math.round(Number(invoice.total_cents || 0)) : Math.round(Number(invoice.amount_paid_cents || 0));
  const renderedBalanceCents = renderPaidInFull ? 0 : Math.round(Number(invoice.balance_due_cents ?? invoice.total_cents));
  const renderedStatus = renderPaidInFull ? "Paid in full" : cleanText(invoice.status || "draft").replace(/_/g, " ");
  const proposalTitle = cleanText(presentation.proposalTitle || proposal.title || project.title || "Project proposal");
  const primaryRgb = hexRgbCss(primary);
  const secondaryRgb = hexRgbCss(secondary);
  const taxCents = Math.max(0, Math.round(Number(invoice.tax_cents || 0)));
  const taxPercent = Math.min(100, Math.max(0, Number(invoice.tax_percent || 0)));
  const companyMark = presentation.companyLogo
    ? `<img class="company-logo" src="${presentation.companyLogo}" alt="${escapeHtml(orgName)}">`
    : `<div class="company-name">${escapeHtml(orgName)}</div>`;
  const coBrandMark = presentation.coBrandLogo ? `<img class="cobrand-logo" src="${presentation.coBrandLogo}" alt="Co-branded logo">` : "";
  const brandLockup = `<div class="brand-lockup">${companyMark}${coBrandMark}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(invoice.invoice_number)}</title><style>
  @page{size:8.5in 11in;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#111827;font-family:"${escapeHtml(presentation.fontFamily)}",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{position:relative;width:8.5in;height:11in;overflow:hidden;background:#fff;padding:var(--invoice-content-top,.72in) .65in .62in}.page-content{position:relative;z-index:2;height:100%}.page.theme-margin{padding-left:1.12in}.page.theme-margin:before{content:"";position:absolute;z-index:0;inset:0 auto 0 0;width:48px;background:${primary}}.page.theme-margin:after{content:"";position:absolute;z-index:0;inset:0 auto 0 48px;width:10px;background:${secondary}}.page.theme-triangles:before{content:"";position:absolute;z-index:0;top:0;left:0;width:40%;height:29%;background:linear-gradient(135deg,rgba(${secondaryRgb},.42) 0 65%,transparent 65.5%)}.page.theme-triangles:after{content:"";position:absolute;z-index:0;right:0;bottom:0;width:22%;height:22%;background:linear-gradient(315deg,${primary} 0 65%,transparent 66%)}.triangle-primary{display:none}.theme-triangles .triangle-primary{display:block;position:absolute;z-index:1;top:0;left:0;width:29%;height:23%;background:linear-gradient(135deg,${primary} 0 65%,transparent 65.5%)}.clean-header{display:none}.theme-clean .clean-header{display:flex;position:absolute;z-index:3;top:0;left:0;right:0;height:.78in;border-bottom:3px solid ${primary};background:linear-gradient(180deg,#f8fafc 0%,#fff 100%);align-items:center;padding:0 .36in}.cover-logo{position:absolute;z-index:4}.theme-margin .cover-logo{top:28px;left:76px}.theme-triangles .cover-logo{top:28px;right:36px}.theme-clean .cover-logo{display:none}.brand-lockup{display:inline-flex;align-items:center;gap:24px;min-width:0}.theme-triangles .brand-lockup{flex-direction:row-reverse;gap:38px}.company-logo{display:block;max-height:38px;max-width:180px;object-fit:contain}.theme-triangles .company-logo{max-height:76px;max-width:220px}.cobrand-logo{display:block;max-height:38px;max-width:170px;object-fit:contain}.theme-triangles .cobrand-logo{max-height:76px;max-width:245px}.company-name{font-size:12px;font-weight:950;letter-spacing:.16em;text-transform:uppercase;color:#111827}.theme-triangles .company-name{font-size:18px}.document-head{display:flex;justify-content:space-between;gap:28px;align-items:flex-start;margin-bottom:30px}.eyebrow{color:${primary};font-size:11px;font-weight:950;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px}h1{margin:0;color:#111827;font-size:40px;line-height:1;font-weight:950}.project-line{margin-top:10px;color:#667085;font-size:12px;font-weight:800;max-width:360px}.paid-stamp{display:inline-block;margin-top:13px;padding:7px 12px;border:2px solid #16803c;border-radius:6px;color:#16803c;font-size:12px;font-weight:950;letter-spacing:.12em;transform:rotate(-2deg)}.meta{text-align:right;line-height:1.7;font-size:11px;color:#667085}.meta strong{color:#111827;font-size:13px}.cards{display:grid;grid-template-columns:1.12fr .88fr;gap:18px;margin:28px 0 25px}.card{border:1px solid #e4e7ec;border-radius:10px;padding:16px;background:#fff}.card span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#667085;font-weight:900;margin-bottom:8px}.card strong{display:block;font-size:15px;margin-bottom:4px}.muted{color:#667085;font-size:12px;line-height:1.45}.amount-card{background:rgba(${primaryRgb},.06);border-color:rgba(${primaryRgb},.20)}.amount-card strong{font-size:27px;color:${primary}}table{width:100%;border-collapse:collapse;margin-top:10px}th{padding:11px 9px;text-align:left;background:#f2f4f7;color:#475467;font-size:10px;text-transform:uppercase;letter-spacing:.06em}td{padding:14px 9px;border-bottom:1px solid #eaecf0;font-size:13px}th:last-child,td:last-child{text-align:right}.totals{width:285px;margin:22px 0 0 auto}.total{display:flex;justify-content:space-between;padding:8px 0;font-size:13px}.total.grand{border-top:2px solid #111827;margin-top:5px;padding-top:13px;font-size:18px;font-weight:900}.notes{margin-top:28px;border-top:1px solid #eaecf0;padding-top:15px;font-size:11px;line-height:1.55}.foot{position:absolute;z-index:2;left:0;right:0;bottom:0;border-top:1px solid #eaecf0;padding-top:10px;font-size:9px;color:#667085;display:flex;justify-content:space-between}.theme-triangles .foot{padding-right:1.6in}
  </style></head><body><main class="page theme-${presentation.theme}" style="--invoice-content-top:${presentation.headerClearance}in"><div class="triangle-primary"></div><div class="cover-logo">${brandLockup}</div><div class="clean-header">${brandLockup}</div><section class="page-content"><div class="document-head"><div><div class="eyebrow">${escapeHtml(proposalTitle)}</div><h1>Invoice</h1><div class="project-line">${escapeHtml(project.address || project.title || "Project invoice")}</div>${renderPaidInFull ? '<div class="paid-stamp">PAID IN FULL</div>' : ''}</div><div class="meta"><strong>${escapeHtml(invoice.invoice_number)}</strong><br>Issued ${escapeHtml(invoice.issue_date)}<br>Due ${escapeHtml(invoice.due_date)}</div></div>
  <section class="cards"><div class="card"><span>Bill to</span><strong>${escapeHtml(customer.name || "Customer")}</strong><div class="muted">${escapeHtml(customer.email || "")}</div><div class="muted">${escapeHtml(customer.address || "")}</div></div><div class="card amount-card"><span>${renderPaidInFull ? 'Payment status' : 'Amount due'}</span><strong>${renderPaidInFull ? 'PAID IN FULL' : escapeHtml(money(renderedBalanceCents))}</strong><div class="muted">${escapeHtml(renderedStatus)}</div></div></section>
  <table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody>${lines.map((line) => `<tr><td><strong>${escapeHtml(line.description || "Project payment")}</strong></td><td>${escapeHtml(money(line.amount_cents))}</td></tr>`).join("")}</tbody></table>
  <div class="totals"><div class="total"><span>Subtotal</span><span>${escapeHtml(money(invoice.subtotal_cents))}</span></div>${taxCents > 0 ? `<div class="total"><span>Sales tax (${escapeHtml(String(taxPercent))}%)</span><span>${escapeHtml(money(taxCents))}</span></div>` : ""}<div class="total"><span>Total</span><span>${escapeHtml(money(invoice.total_cents))}</span></div><div class="total"><span>Paid</span><span>${escapeHtml(money(renderedPaidCents))}</span></div><div class="total grand"><span>Balance due</span><span>${escapeHtml(money(renderedBalanceCents))}</span></div></div>
  ${cleanText(invoice.notes) ? `<div class="notes"><strong>Notes</strong><br>${escapeHtml(invoice.notes)}</div>` : ""}<div class="foot"><span>${escapeHtml(orgName)}</span><span>${escapeHtml(invoice.invoice_number)}</span></div></section></main></body></html>`;
}

export async function renderInvoiceDocumentPdf(orgId: string, invoice: JsonObject) {
  const balanceDueCents = invoice.render_paid_in_full === true
    ? 0
    : Math.max(0, Math.round(Number(invoice.balance_due_cents ?? invoice.total_cents ?? 0)));
  const lineItems = asArray(invoice.line_items).map(asObject).map((line, index) => {
    const quantity = Number(line.quantity || 1);
    const amountCents = Math.round(Number(line.amount_cents || 0));
    const unitPriceCents = Math.round(Number(line.unit_price_cents ?? (quantity ? amountCents / quantity : amountCents)));
    return {
      ...line,
      id: cleanText(line.id || line.obligation_id) || `invoice_line_${index + 1}`,
      name: cleanText(line.name || line.description || "Project payment"),
      description: cleanText(line.description),
      quantity,
      unit: cleanText(line.unit || "ea"),
      unit_price: unitPriceCents / 100,
      unit_price_cents: unitPriceCents,
      amount_cents: amountCents,
      selected: true
    };
  });
  const rendered = await renderTemplatedArtifact({
    orgId,
    documentId: `doc_invoice_${cleanText(invoice.id || invoice.invoice_number)}`,
    documentType: "invoice",
    templateId: cleanText(invoice.template_id || asObject(invoice.template_ref).template_id) || "tpl_invoice_default",
    projectId: cleanText(invoice.project_id),
    branchId: cleanText(invoice.branch_id || "default"),
    actorUserId: cleanText(invoice.updated_by_user_id || invoice.created_by_user_id || "system_invoice"),
    title: cleanText(invoice.invoice_number || "Invoice"),
    fileName: `${cleanText(invoice.invoice_number || "invoice").toLowerCase()}.pdf`,
    params: {
      project: asObject(invoice.project_ref),
      customer: asObject(invoice.customer),
      invoice_number: cleanText(invoice.invoice_number),
      issue_date: cleanText(invoice.issue_date),
      due_date: cleanText(invoice.due_date),
      line_items: lineItems,
      scope_items: lineItems,
      tax_percent: Number(invoice.tax_percent || 0),
      amount_cents: Math.max(0, Math.round(Number(invoice.total_cents || 0))),
      amount_due_cents: balanceDueCents,
      payment_schedule: balanceDueCents > 0 ? [{
        id: `invoice_due_${cleanText(invoice.id)}`,
        label: "Invoice balance",
        kind: "fixed",
        amount_cents: balanceDueCents,
        due_at: cleanText(invoice.due_date)
      }] : [],
      status: invoice.render_paid_in_full === true ? "Paid in full" : cleanText(invoice.status || "draft"),
      notes: cleanText(invoice.notes)
    },
    metadata: {
      source_system: "payments",
      source_invoice_id: cleanText(invoice.id),
      payment_invoice: true
    }
  });
  return {
    invoice,
    bytes: rendered.bytes,
    contentType: "application/pdf",
    fileName: rendered.fileName,
    document_id: rendered.documentId,
    snapshot_id: cleanText(asObject(rendered.snapshot).id)
  };
}

export async function renderInvoicePdf(orgId: string, invoiceId: string) {
  return renderInvoiceDocumentPdf(orgId, await readInvoice(orgId, invoiceId));
}

export async function emailInvoice(orgId: string, invoiceId: string, input: JsonObject, portalUrl: string, ctx: PlatformAuthContext) {
  const rendered = await renderInvoicePdf(orgId, invoiceId);
  const invoice = rendered.invoice;
  const recipient = cleanText(input.recipient || asObject(invoice.customer).email).toLowerCase();
  if (!recipient) throw badRequest("invoice_email_required", "A customer email address is required.");
  const includePortal = input.include_portal_link === true && !!cleanText(portalUrl);
  const org = asObject(await readOrganization(orgId).catch(() => ({})));
  const orgName = cleanText(org.name || "Company");
  const subject = cleanText(input.subject || `${orgName} invoice ${invoice.invoice_number}`);
  const customMessage = cleanText(input.message);
  const renderedBalanceCents = invoice.render_paid_in_full === true ? 0 : invoice.balance_due_cents;
  const defaultMessage = invoice.render_paid_in_full === true
    ? `Your paid-in-full invoice ${cleanText(invoice.invoice_number)} is attached for your records.`
    : `Your invoice ${cleanText(invoice.invoice_number)} for ${money(renderedBalanceCents)} is attached.`;
  const portalCopy = invoice.render_paid_in_full === true
    ? `Review project details in your customer portal: ${portalUrl}`
    : `Pay or review project details in your customer portal: ${portalUrl}`;
  const textBody = [
    customMessage || defaultMessage,
    includePortal ? portalCopy : ""
  ].filter(Boolean).join("\n\n");
  const htmlBody = `<p>${escapeHtml(customMessage || defaultMessage)}</p>${includePortal ? `<p><a href="${escapeHtml(portalUrl)}">${invoice.render_paid_in_full === true ? "Open customer portal" : "Open customer portal to pay"}</a></p>` : ""}`;
  const sent = await sendOrganizationTransactionalEmail({
    organizationId: orgId,
    branchId: cleanText(invoice.branch_id || "default") || "default",
    to: recipient,
    subject,
    textBody,
    htmlBody,
    purpose: "billing",
    projectId: cleanText(invoice.project_id),
    tags: ["customer-invoice"],
    source: { type: "user", id: "invoice_delivery", user_id: ctx.userId },
    metadata: { invoice_id: invoiceId },
    idempotencyKey: `invoice_email:${invoiceId}:${asArray(invoice.email_deliveries).length + 1}`,
    attachments: [{ name: rendered.fileName, content: rendered.bytes, contentType: "application/pdf" }]
  }, ctx);
  const now = nowIso();
  const deliveries = [...asArray(invoice.email_deliveries).map(asObject), {
    recipient,
    include_portal_link: includePortal,
    attempted_at: now,
    sent: sent.ok === true,
    provider_message_id: cleanText(asObject(asArray(sent.message.deliveries)[0]).provider_message_id),
    error: sent.ok ? "" : "Organization email delivery failed."
  }];
  await upsertDocument(orgId, PAYMENT_INVOICE_COLLECTION, {
    id: invoiceId,
    data: {
      ...invoice,
      email_deliveries: deliveries,
      ...(sent.ok ? { emailed_at: now, emailed_to: recipient } : {}),
      updated_by_user_id: ctx.userId,
      updated_at: now
    },
    metadata: { kind: "payment_invoice", project_id: cleanText(invoice.project_id), status: cleanText(invoice.status), invoice_number: cleanText(invoice.invoice_number) }
  }, { replace: true });
  await recordPaymentEvent(orgId, sent.ok ? "invoice.emailed" : "invoice.email_failed", {
    project_id: cleanText(invoice.project_id), invoice_id: invoiceId, recipient, include_portal_link: includePortal
  }, ctx);
  if (sent.ok) {
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: cleanText(invoice.branch_id || "default") || "default",
      project_id: cleanText(invoice.project_id),
      type: "invoice.sent",
      // Keyed to the delivery attempt so a deliberate re-send emits again.
      idempotency_key: `invoice.sent:${invoiceId}:${deliveries.length}`,
      payload: {
        invoice_id: invoiceId,
        invoice_number: cleanText(invoice.invoice_number),
        recipient,
        total_cents: Math.max(0, Math.round(Number(invoice.total_cents || 0)))
      },
      context: { actor_user_id: ctx.userId }
    });
  }
  if (!sent.ok) throw badRequest("invoice_email_failed", "The invoice email could not be sent.");
  return { invoice: await readInvoice(orgId, invoiceId), recipient, include_portal_link: includePortal, sent: true };
}
