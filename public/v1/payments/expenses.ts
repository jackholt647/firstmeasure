import { createHash, randomBytes } from "node:crypto";

import { readOrganizationConnection } from "../connections/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { listPayrollLedgerEntries } from "../payroll/storage.js";
import { emitWorkEvent } from "../work/engine.js";
import { readResourceGroup } from "../workforce/storage.js";

export const PAYMENT_EXPENSE_ITEM_COLLECTION = "payment_expense_items";
export const PAYMENT_EXPENSE_OVERRIDE_COLLECTION = "payment_expense_overrides";
export const PAYMENT_RECEIPT_COLLECTION = "payment_receipts";

export type ExpenseSummarySources = {
  materialLists: JsonObject[];
  supplementalExpenses: JsonObject[];
  overrides: JsonObject[];
  receipts: JsonObject[];
  payrollLedgerEntries?: JsonObject[];
};

const EXPENSE_SCHEMA_VERSION = 1;

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
  const data = documentData(doc);
  return {
    ...data,
    id: cleanText(data.id || source.id),
    revision: Number(source.revision || data.revision || 0),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

function receiptDocumentView(doc: unknown): JsonObject {
  const receipt = documentView(doc);
  const extraction = asObject(receipt.extraction);
  const overrides = asObject(receipt.user_overrides);
  return {
    ...receipt,
    title: cleanText(overrides.title || extraction.title || asObject(receipt.file).file_name || "Receipt"),
    total_cents: Object.prototype.hasOwnProperty.call(overrides, "total_cents") ? integerCents(overrides.total_cents) : integerCents(extraction.total_cents),
    currency: cleanText(overrides.currency || extraction.currency || "USD").toUpperCase(),
    purchase_date: cleanText(overrides.purchase_date || extraction.purchase_date),
    purchase_time: cleanText(overrides.purchase_time || extraction.purchase_time),
    purchase_timezone: cleanText(overrides.purchase_timezone || extraction.purchase_timezone)
  };
}

export async function loadExpenseSummarySources(orgId: string): Promise<ExpenseSummarySources> {
  const [materialLists, supplementalExpenses, overrides, receipts] = await Promise.all([
    listDocuments(orgId, "material_lists"),
    listDocuments(orgId, PAYMENT_EXPENSE_ITEM_COLLECTION),
    listDocuments(orgId, PAYMENT_EXPENSE_OVERRIDE_COLLECTION),
    listDocuments(orgId, PAYMENT_RECEIPT_COLLECTION)
  ]);
  return {
    materialLists: materialLists.map(documentView),
    supplementalExpenses: supplementalExpenses.map(documentView),
    overrides: overrides.map(documentView),
    receipts: receipts.map(receiptDocumentView)
  };
}

function integerCents(value: unknown, fallback = 0) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : fallback;
}

function dollarsToCents(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
}

function moneyInputCents(input: JsonObject, fallback = 0) {
  if (Number.isFinite(Number(input.amount_cents))) return Math.max(0, Math.round(Number(input.amount_cents)));
  if (Number.isFinite(Number(input.actual_cents))) return Math.max(0, Math.round(Number(input.actual_cents)));
  if (Number.isFinite(Number(input.projected_cents))) return Math.max(0, Math.round(Number(input.projected_cents)));
  if (Number.isFinite(Number(input.amount))) return Math.max(0, Math.round(Number(input.amount) * 100));
  return fallback;
}

function uniqueText(value: unknown) {
  return [...new Set(asArray(value).map(cleanText).filter(Boolean))];
}

function resourceType(value: unknown) {
  const type = cleanText(value).toLowerCase();
  return ["labor", "equipment"].includes(type) ? type : "material";
}

function listProjectedCents(list: JsonObject) {
  const stored = Number(asObject(list.totals).projected_total);
  if (Number.isFinite(stored)) return dollarsToCents(stored);
  return asArray(list.current_items).map(asObject).reduce((sum, item) => sum + dollarsToCents(item.projected_total), 0);
}

function compensationComponents(profileValue: unknown) {
  return asArray(asObject(profileValue).components).map(asObject)
    .filter((component) => cleanText(component.kind));
}

function salaryPeriodHours(component: JsonObject) {
  const metadata = asObject(component.metadata);
  const explicit = Number(metadata.hours_per_period || component.hours_per_period);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const period = cleanText(component.period || "week").toLowerCase().replace(/[\s_-]+/g, "");
  const hours: Record<string, number> = {
    hour: 1,
    day: 8,
    week: 40,
    weekly: 40,
    biweek: 80,
    biweekly: 80,
    fortnight: 80,
    semimonth: 86.6667,
    semimonthly: 86.6667,
    month: 173.3333,
    monthly: 173.3333,
    quarter: 520,
    quarterly: 520,
    year: 2080,
    annual: 2080,
    annually: 2080
  };
  return hours[period] || 40;
}

function salaryHourlyRate(component: JsonObject) {
  const explicit = integerCents(component.hourly_equivalent_rate_cents);
  if (explicit > 0) return explicit;
  const rate = integerCents(component.rate_cents);
  const hours = salaryPeriodHours(component);
  return hours > 0 ? Math.round(rate / hours) : 0;
}

function itemCompensationKind(item: JsonObject) {
  const metadata = asObject(item.metadata);
  const raw = cleanText(metadata.compensation_kind || metadata.pay_type || metadata.estimate_mode || item.compensation_kind).toLowerCase();
  if (["hourly", "salary", "piece_rate"].includes(raw)) return raw;
  if (raw === "piece" || raw === "piece-rate") return "piece_rate";
  return "piece_rate";
}

function lineProjectedCents(item: JsonObject, fallbackRateCents = 0) {
  const explicitTotal = Number(item.projected_total);
  if (Number.isFinite(explicitTotal) && explicitTotal > 0) return dollarsToCents(explicitTotal);
  const quantity = Number(item.quantity);
  const unitPrice = Number(item.projected_unit_price);
  if (Number.isFinite(quantity) && Number.isFinite(unitPrice) && unitPrice > 0) return dollarsToCents(quantity * unitPrice);
  if (Number.isFinite(quantity) && fallbackRateCents > 0) return Math.max(0, Math.round(quantity * fallbackRateCents));
  return 0;
}

function profileMode(profileValue: unknown) {
  const kinds = new Set(compensationComponents(profileValue).map((component) => cleanText(component.kind)));
  const hourly = kinds.has("hourly");
  const salary = kinds.has("salary");
  const piece = kinds.has("piece_rate");
  if ((hourly || salary) && piece) return "hybrid";
  if (piece) return "piece_rate";
  if (hourly) return "hourly";
  if (salary) return "salary";
  return "none";
}

function resourceCompensationMode(resource: JsonObject) {
  const kinds = new Set<string>();
  const collect = (profile: unknown) => compensationComponents(profile).forEach((component) => {
    const kind = cleanText(component.kind);
    if (kind) kinds.add(kind);
  });
  const collectPlan = (planValue: unknown) => {
    const plan = asObject(planValue);
    const type = cleanText(plan.type).toLowerCase();
    if (plan.default_hourly === true || ["hourly", "hybrid"].includes(type)) kinds.add("hourly");
    if (plan.default_salary === true || ["salary", "hybrid"].includes(type)) kinds.add("salary");
    if (plan.default_piece_rate === true || ["piece_rate", "hybrid"].includes(type)) kinds.add("piece_rate");
  };
  collect(resource.compensation_profile);
  collectPlan(resource.compensation_plan);
  for (const member of asArray(resource.members).map(asObject)) {
    collect(member.effective_compensation_profile || member.direct_compensation_profile);
    collectPlan(member.compensation_plan);
  }
  return profileMode({ components: [...kinds].map((kind) => ({ kind })) });
}

function resolvedLaborMode(list: JsonObject, resource: JsonObject) {
  const compensation = asObject(list.compensation);
  const configured = cleanText(compensation.resolved_mode || compensation.mode || compensation.default_mode || "crew_default").toLowerCase();
  if (configured && configured !== "crew_default") return configured;
  return resourceCompensationMode(resource);
}

function assignmentReference(list: JsonObject) {
  const assignment = asObject(list.assignment);
  const ref = asObject(assignment.work_resource_ref);
  const id = cleanText(ref.id || assignment.resource_id || assignment.crew_id);
  return id ? {
    kind: cleanText(ref.kind || assignment.resource_kind || "resource_group") || "resource_group",
    id,
    name: cleanText(ref.name || assignment.resource_name || assignment.crew_name)
  } : null;
}

async function assignedLaborResource(orgId: string, list: JsonObject) {
  const ref = assignmentReference(list);
  if (!ref) return { ref: null, resource: {} as JsonObject };
  try {
    const resource = ref.kind === "organization_connection"
      ? (await readOrganizationConnection(orgId, ref.id))
      : await readResourceGroup(orgId, ref.id);
    return { ref, resource: asObject(resource) };
  } catch {
    return {
      ref,
      resource: {
        id: ref.id,
        name: ref.name,
        compensation_plan: asObject(asObject(list.compensation).resource_plan)
      }
    };
  }
}

function compatiblePieceRate(item: JsonObject, components: JsonObject[]) {
  const unit = cleanText(item.unit).toLowerCase();
  const name = cleanText(item.name).toLowerCase();
  return components.find((component) => cleanText(component.label).toLowerCase() === name)
    || components.find((component) => unit && cleanText(component.unit).toLowerCase() === unit)
    || components[0]
    || null;
}

export async function laborListProjection(orgId: string, list: JsonObject) {
  const { ref, resource } = await assignedLaborResource(orgId, list);
  const compensation = asObject(list.compensation);
  const mode = resolvedLaborMode(list, resource);
  const includeHourly = ["hourly", "hybrid"].includes(mode);
  const includePiece = ["piece_rate", "hybrid"].includes(mode);
  const includeSalary = mode !== "none" && (compensation.include_salary_as_hourly === true || cleanText(compensation.salary_expense_mode) === "hourly");
  const defaultHours = Math.max(0, Number(compensation.estimated_hours || compensation.hours || 0));
  const memberHours = asObject(compensation.member_hours);
  const resourceProfile = asObject(resource.compensation_profile);
  const groupPieces = compensationComponents(resourceProfile).filter((component) => cleanText(component.kind) === "piece_rate");
  const details: JsonObject[] = [];

  if (includePiece) {
    for (const item of asArray(list.current_items).map(asObject).filter((entry) => itemCompensationKind(entry) === "piece_rate")) {
      const matched = compatiblePieceRate(item, groupPieces);
      const amount = lineProjectedCents(item, integerCents(matched?.rate_cents));
      if (amount <= 0) continue;
      details.push({
        id: `piece:${cleanText(item.id)}`,
        kind: "piece_rate",
        label: cleanText(item.name || "Piece-rate work"),
        quantity: Number(item.quantity || 0),
        unit: cleanText(item.unit),
        rate_cents: Number.isFinite(Number(item.projected_unit_price))
          ? dollarsToCents(item.projected_unit_price)
          : integerCents(matched?.rate_cents),
        projected_cents: amount,
        work_resource_ref: ref
      });
    }
  }

  const members = asArray(resource.members).map(asObject).filter((member) => cleanText(member.status || "active").toLowerCase() === "active");
  for (const member of members) {
    const user = asObject(member.user);
    const userId = cleanText(member.user_id || user.id);
    const name = cleanText(user.name || user.email || userId || "Team member");
    const hoursValue = Number(memberHours[userId]);
    const hours = Number.isFinite(hoursValue) && hoursValue >= 0 ? hoursValue : defaultHours;
    if (hours <= 0) continue;
    const components = compensationComponents(member.effective_compensation_profile || member.direct_compensation_profile);
    const hourly = components.find((component) => cleanText(component.kind) === "hourly");
    if (includeHourly && hourly) {
      const rate = integerCents(hourly.rate_cents);
      const amount = Math.max(0, Math.round(rate * hours));
      if (amount > 0) details.push({
        id: `hourly:${userId}`,
        kind: "hourly",
        label: name,
        user_id: userId,
        hours,
        rate_cents: rate,
        projected_cents: amount,
        compensation_source: cleanText(member.compensation_source),
        work_resource_ref: ref
      });
    }
    const salary = components.find((component) => cleanText(component.kind) === "salary");
    if (includeSalary && salary) {
      const rate = salaryHourlyRate(salary);
      const amount = Math.max(0, Math.round(rate * hours));
      if (amount > 0) details.push({
        id: `salary:${userId}`,
        kind: "salary",
        label: name,
        user_id: userId,
        hours,
        rate_cents: rate,
        salary_rate_cents: integerCents(salary.rate_cents),
        salary_period: cleanText(salary.period || "week"),
        projected_cents: amount,
        compensation_source: cleanText(member.compensation_source),
        work_resource_ref: ref
      });
    }
  }

  // Explicit hourly/salary scope lines remain useful for contractors or people
  // who are not represented by an internal resource-group membership.
  for (const item of asArray(list.current_items).map(asObject)) {
    const kind = itemCompensationKind(item);
    if ((kind === "hourly" && !includeHourly) || (kind === "salary" && !includeSalary) || kind === "piece_rate") continue;
    const itemMetadata = asObject(item.metadata);
    if (members.length && itemMetadata.include_alongside_members !== true && itemMetadata.standalone_compensation !== true) continue;
    const amount = lineProjectedCents(item);
    if (amount <= 0) continue;
    details.push({
      id: `${kind}:${cleanText(item.id)}`,
      kind,
      label: cleanText(item.name || (kind === "salary" ? "Salary" : "Hourly labor")),
      quantity: Number(item.quantity || 0),
      hours: cleanText(item.unit).toLowerCase().startsWith("hour") ? Number(item.quantity || 0) : undefined,
      unit: cleanText(item.unit),
      rate_cents: Number.isFinite(Number(item.projected_unit_price)) ? dollarsToCents(item.projected_unit_price) : 0,
      projected_cents: amount,
      work_resource_ref: ref
    });
  }

  const byKind = { hourly_cents: 0, salary_cents: 0, piece_rate_cents: 0 };
  for (const detail of details) {
    const amount = integerCents(detail.projected_cents);
    if (cleanText(detail.kind) === "hourly") byKind.hourly_cents += amount;
    else if (cleanText(detail.kind) === "salary") byKind.salary_cents += amount;
    else if (cleanText(detail.kind) === "piece_rate") byKind.piece_rate_cents += amount;
  }
  return {
    mode,
    estimated_hours: defaultHours,
    include_salary_as_hourly: includeSalary,
    work_resource_ref: ref,
    details,
    ...byKind,
    projected_cents: byKind.hourly_cents + byKind.salary_cents + byKind.piece_rate_cents
  };
}

function overrideId(projectId: string, targetKey: string) {
  return `expense_override_${createHash("sha256").update(`${projectId}:${targetKey}`).digest("hex").slice(0, 20)}`;
}

async function expenseOverrides(orgId: string, projectId: string) {
  const docs = await listDocuments(orgId, PAYMENT_EXPENSE_OVERRIDE_COLLECTION);
  return docs.map(documentView).filter((item) => cleanText(item.project_id) === projectId);
}

export async function listSupplementalExpenses(orgId: string, projectId: string) {
  const docs = await listDocuments(orgId, PAYMENT_EXPENSE_ITEM_COLLECTION);
  return docs.map(documentView)
    .filter((item) => cleanText(item.project_id) === projectId && cleanText(item.status || "active") !== "archived")
    .sort((a, b) => cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

export async function listProjectReceipts(orgId: string, projectId: string, options: JsonObject = {}): Promise<JsonObject[]> {
  const docs = await listDocuments(orgId, PAYMENT_RECEIPT_COLLECTION);
  return docs.map(receiptDocumentView)
    .filter((item) => {
      const matchesScope = projectId
        ? cleanText(item.project_id) === projectId
        : options.include_unscoped === true && !cleanText(item.project_id);
      return matchesScope && (options.include_void === true || cleanText(item.status) !== "void");
    })
    .sort((a, b) => cleanText(b.uploaded_at || b.created_at).localeCompare(cleanText(a.uploaded_at || a.created_at)));
}

export async function listReceiptsForAssociation(orgId: string, kindValue: unknown, idValue: unknown, options: JsonObject = {}) {
  const kind = cleanText(kindValue).toLowerCase();
  const id = cleanText(idValue);
  const docs = await listDocuments(orgId, PAYMENT_RECEIPT_COLLECTION);
  return docs.map(documentView).filter((receipt) => {
    if (kind === "organization" && id === orgId) return options.include_void === true || cleanText(receipt.status) !== "void";
    const associations = asArray(receipt.associations).map(asObject);
    const matches = associations.some((association) => cleanText(association.kind).toLowerCase() === kind && cleanText(association.id) === id);
    return matches && (options.include_void === true || cleanText(receipt.status) !== "void");
  }).sort((a, b) => cleanText(b.uploaded_at || b.created_at).localeCompare(cleanText(a.uploaded_at || a.created_at)));
}

export async function readReceipt(orgId: string, receiptId: string) {
  const receipt = documentView(await readDocument(orgId, PAYMENT_RECEIPT_COLLECTION, receiptId));
  if (cleanText(receipt.organization_id) !== orgId) throw notFound("receipt_not_found", "Receipt was not found.");
  return receipt;
}

export async function createSupplementalExpense(orgId: string, projectId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await readDocument(orgId, "projects", projectId);
  const title = cleanText(input.title || input.name);
  if (!title) throw badRequest("expense_title_required", "An expense title is required.");
  const projected = moneyInputCents({ projected_cents: input.projected_cents, amount: input.projected_amount ?? input.amount }, 0);
  const actual = moneyInputCents({ actual_cents: input.actual_cents, amount: input.actual_amount }, 0);
  const actualProvided = Object.prototype.hasOwnProperty.call(input, "actual_cents") || Object.prototype.hasOwnProperty.call(input, "actual_amount");
  if (projected <= 0 && actual <= 0) throw badRequest("expense_amount_required", "Enter a projected or actual expense amount.");
  const currency = cleanText(input.currency || "USD").toUpperCase() || "USD";
  if (currency !== "USD") throw badRequest("unsupported_expense_currency", "Project expense tracking currently requires USD amounts.");
  const now = nowIso();
  const id = generatedId("expense_item");
  const data = {
    schema_version: EXPENSE_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || ctx.branchId || "default") || "default",
    project_id: projectId,
    title,
    resource_type: ["material", "labor", "equipment", "other"].includes(cleanText(input.resource_type)) ? cleanText(input.resource_type) : "other",
    projected_cents: projected,
    actual_override_cents: actualProvided ? actual : null,
    currency,
    notes: cleanText(input.notes),
    status: "active",
    metadata: asObject(input.metadata),
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const created = documentView(await upsertDocument(orgId, PAYMENT_EXPENSE_ITEM_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_expense_item", project_id: projectId, resource_type: data.resource_type }
  }, { replace: true }));
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: data.branch_id,
    project_id: projectId,
    type: "expense.recorded",
    idempotency_key: `expense.recorded:${id}`,
    payload: {
      expense_id: id,
      kind: "supplemental_expense",
      title,
      resource_type: data.resource_type,
      projected_cents: projected,
      ...(actualProvided ? { actual_cents: actual } : {})
    },
    context: { actor_user_id: ctx.userId }
  });
  return created;
}

export async function patchSupplementalExpense(orgId: string, projectId: string, expenseId: string, patch: JsonObject, ctx: PlatformAuthContext) {
  const doc = await readDocument(orgId, PAYMENT_EXPENSE_ITEM_COLLECTION, expenseId);
  const current = documentView(doc);
  if (cleanText(current.project_id) !== projectId) throw notFound("expense_not_found", "Expense was not found.");
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(asObject(doc).revision || 0)) throw conflict("expense_revision_conflict", "Expense revision does not match.");
  const next = {
    ...current,
    title: Object.prototype.hasOwnProperty.call(patch, "title") ? cleanText(patch.title) : cleanText(current.title),
    projected_cents: Object.prototype.hasOwnProperty.call(patch, "projected_cents") ? integerCents(patch.projected_cents) : integerCents(current.projected_cents),
    actual_override_cents: Object.prototype.hasOwnProperty.call(patch, "actual_cents") || Object.prototype.hasOwnProperty.call(patch, "actual_override_cents")
      ? (patch.actual_cents == null && patch.actual_override_cents == null ? null : integerCents(patch.actual_cents ?? patch.actual_override_cents))
      : current.actual_override_cents,
    notes: Object.prototype.hasOwnProperty.call(patch, "notes") ? cleanText(patch.notes) : cleanText(current.notes),
    status: cleanText(patch.status || current.status || "active"),
    metadata: Object.prototype.hasOwnProperty.call(patch, "metadata") ? { ...asObject(current.metadata), ...asObject(patch.metadata) } : asObject(current.metadata),
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  };
  return documentView(await upsertDocument(orgId, PAYMENT_EXPENSE_ITEM_COLLECTION, {
    id: expenseId,
    expected_revision: expectedRevision || Number(asObject(doc).revision || 0) || undefined,
    data: next,
    metadata: { kind: "payment_expense_item", project_id: projectId, resource_type: cleanText(current.resource_type) }
  }, { replace: true }));
}

export async function setExpenseActualOverride(orgId: string, projectId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const targetKey = cleanText(input.target_key);
  if (!targetKey) throw badRequest("expense_target_required", "An expense target is required.");
  await readDocument(orgId, "projects", projectId);
  await assertExpenseTargetKeys(orgId, projectId, [targetKey]);
  const actualValue = input.actual_cents ?? input.amount_cents;
  const actual = actualValue == null || cleanText(actualValue) === "" ? null : integerCents(actualValue);
  const id = overrideId(projectId, targetKey);
  const currentDoc = await readDocument(orgId, PAYMENT_EXPENSE_OVERRIDE_COLLECTION, id).catch(() => null);
  const current = currentDoc ? documentView(currentDoc) : {};
  const expectedRevision = Number(input.expected_revision || 0);
  if (currentDoc && expectedRevision && expectedRevision !== Number(asObject(currentDoc).revision || 0)) {
    throw conflict("expense_override_revision_conflict", "Expense override revision does not match.");
  }
  const now = nowIso();
  const data = {
    ...current,
    schema_version: EXPENSE_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    project_id: projectId,
    target_key: targetKey,
    actual_cents: actual,
    active: actual != null,
    reason: cleanText(input.reason),
    notes: cleanText(input.notes),
    metadata: { ...asObject(current.metadata), ...asObject(input.metadata) },
    created_by_user_id: cleanText(current.created_by_user_id || ctx.userId),
    updated_by_user_id: ctx.userId,
    created_at: cleanText(current.created_at || now),
    updated_at: now
  };
  return documentView(await upsertDocument(orgId, PAYMENT_EXPENSE_OVERRIDE_COLLECTION, {
    id,
    expected_revision: expectedRevision || Number(asObject(currentDoc).revision || 0) || undefined,
    data,
    metadata: { kind: "payment_expense_override", project_id: projectId, target_key: targetKey }
  }, { replace: true }));
}

function receiptTargets(receipt: JsonObject) {
  return uniqueText(receipt.attributed_target_keys || receipt.target_keys || asObject(receipt.attribution).target_keys);
}

function summaryReceiptView(receiptValue: JsonObject): JsonObject {
  const receipt = asObject(receiptValue);
  const file = asObject(receipt.file);
  const uploader = asObject(receipt.uploaded_by);
  const extraction = asObject(receipt.extraction);
  delete extraction.response_id;
  delete extraction.usage;
  delete extraction.latency_ms;
  const attribution = asObject(receipt.attribution);
  const confirmedBy = asObject(attribution.confirmed_by);
  const publicAssociation = (value: unknown) => {
    const association = asObject(value);
    return {
      kind: cleanText(association.kind),
      id: cleanText(association.id),
      name: cleanText(association.name),
      role: cleanText(association.role),
      verification: asObject(association.verification)
    };
  };
  return {
    id: cleanText(receipt.id),
    revision: Number(receipt.revision || 0),
    project_id: cleanText(receipt.project_id),
    owner: publicAssociation(receipt.owner),
    associations: asArray(receipt.associations).map(publicAssociation),
    status: cleanText(receipt.status),
    title: cleanText(receipt.title),
    total_cents: integerCents(receipt.total_cents),
    currency: cleanText(receipt.currency || "USD"),
    purchase_date: cleanText(receipt.purchase_date),
    purchase_time: cleanText(receipt.purchase_time),
    purchase_timezone: cleanText(receipt.purchase_timezone),
    file: {
      media_id: cleanText(file.media_id),
      document_id: cleanText(file.document_id),
      file_name: cleanText(file.file_name),
      content_type: cleanText(file.content_type),
      size_bytes: Number(file.size_bytes || 0),
      support: asObject(file.support)
    },
    uploaded_by: { user_id: cleanText(uploader.user_id), name: cleanText(uploader.name) },
    uploaded_at: cleanText(receipt.uploaded_at),
    extraction,
    user_overrides: asObject(receipt.user_overrides),
    suggested_target_keys: uniqueText(receipt.suggested_target_keys),
    attributed_target_keys: uniqueText(receipt.attributed_target_keys),
    attribution: {
      target_keys: uniqueText(attribution.target_keys),
      method: cleanText(attribution.method),
      confirmed_at: cleanText(attribution.confirmed_at),
      confirmed_by: { user_id: cleanText(confirmedBy.user_id), name: cleanText(confirmedBy.name) }
    },
    duplicate_of_receipt_id: cleanText(receipt.duplicate_of_receipt_id),
    applied_at: cleanText(receipt.applied_at),
    created_at: cleanText(receipt.created_at),
    updated_at: cleanText(receipt.updated_at)
  };
}

type ExpenseTarget = JsonObject & { target_key: string; projected_cents: number };

function scopeResourceListDisplayOrder(lists: JsonObject[]) {
  const typeRank = (list: JsonObject) => ({ material: 0, labor: 1, equipment: 2 }[resourceType(list.resource_type)] ?? 3);
  return [...lists].sort((a, b) => {
    const rankDifference = typeRank(a) - typeRank(b);
    if (rankDifference) return rankDifference;
    const aGenerated = asObject(a.metadata).generated_from_scope === true ? 0 : 1;
    const bGenerated = asObject(b.metadata).generated_from_scope === true ? 0 : 1;
    if (aGenerated !== bGenerated) return aGenerated - bGenerated;
    if (aGenerated === 0) {
      return Number(a.sort_order || 0) - Number(b.sort_order || 0)
        || cleanText(a.title).localeCompare(cleanText(b.title));
    }
    return cleanText(b.updated_at).localeCompare(cleanText(a.updated_at));
  });
}

async function projectExpenseTargets(orgId: string, projectId: string, sources?: ExpenseSummarySources): Promise<ExpenseTarget[]> {
  const [listDocs, supplemental, overrides] = sources
    ? [sources.materialLists, sources.supplementalExpenses.filter((item) => cleanText(item.project_id) === projectId && cleanText(item.status || "active") !== "archived"), sources.overrides.filter((item) => cleanText(item.project_id) === projectId)]
    : await Promise.all([
      listDocuments(orgId, "material_lists").then((docs) => docs.map(documentView)),
      listSupplementalExpenses(orgId, projectId),
      expenseOverrides(orgId, projectId)
    ]);
  const overrideMap = new Map(overrides.map((item) => [cleanText(item.target_key), item]));
  const lists = scopeResourceListDisplayOrder(listDocs
    .filter((list) => cleanText(list.project_id) === projectId && cleanText(list.status) !== "archived"));
  const targets: ExpenseTarget[] = [];
  for (const list of lists) {
    const type = resourceType(list.resource_type);
    const labor = type === "labor" ? await laborListProjection(orgId, list) : null;
    const projected = labor ? integerCents(labor.projected_cents) : listProjectedCents(list);
    const targetKey = `scope_resource_list:${cleanText(list.id)}`;
    const override = overrideMap.get(targetKey);
    targets.push({
      target_key: targetKey,
      source_type: "scope_resource_list",
      source_id: cleanText(list.id),
      title: cleanText(list.title || (type === "labor" ? "Labor" : type === "equipment" ? "Equipment" : "Materials")),
      resource_type: type,
      color: cleanText(list.color),
      sort_order: Number(list.sort_order || 0),
      scope_template_id: cleanText(list.scope_template_id),
      scope_piece_id: cleanText(list.scope_piece_id),
      projected_cents: projected,
      actual_override_cents: override && override.active !== false ? integerCents(override.actual_cents) : null,
      override: override || null,
      details: labor || {
        item_count: asArray(list.current_items).length,
        totals: asObject(list.totals)
      },
      metadata: asObject(list.metadata)
    });
  }
  for (const item of supplemental) {
    const targetKey = `supplemental_expense:${cleanText(item.id)}`;
    const override = overrideMap.get(targetKey);
    targets.push({
      target_key: targetKey,
      source_type: "supplemental_expense",
      source_id: cleanText(item.id),
      title: cleanText(item.title || "Additional expense"),
      resource_type: cleanText(item.resource_type || "other"),
      color: cleanText(asObject(item.metadata).color || "#7c3aed"),
      sort_order: Number(item.sort_order || 10_000),
      projected_cents: integerCents(item.projected_cents),
      actual_override_cents: override
        ? (override.active !== false ? integerCents(override.actual_cents) : null)
        : (item.actual_override_cents == null ? null : integerCents(item.actual_override_cents)),
      override: override || null,
      details: { notes: cleanText(item.notes) },
      revision: Number(item.revision || 0),
      metadata: asObject(item.metadata)
    });
  }
  return targets.map((target, displayOrder) => ({ ...target, display_order: displayOrder }));
}

class DisjointTargets {
  private readonly parent = new Map<string, string>();

  add(value: string) {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value) as string;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(a: string, b: string) {
    const aRoot = this.find(a);
    const bRoot = this.find(b);
    if (aRoot !== bRoot) this.parent.set(bRoot, aRoot);
  }
}

function countableAppliedReceipt(receipt: JsonObject) {
  const direction = cleanText(asObject(receipt.extraction).amount_direction).toLowerCase();
  return cleanText(receipt.status) === "applied"
    && integerCents(receipt.total_cents) > 0
    && cleanText(receipt.currency || "USD").toUpperCase() === "USD"
    && direction !== "credit"
    && receiptTargets(receipt).length > 0;
}

function expenseGroups(targets: ExpenseTarget[], receipts: JsonObject[]) {
  const activeKeys = new Set(targets.map((target) => target.target_key));
  const sets = new DisjointTargets();
  activeKeys.forEach((key) => sets.add(key));
  const applied = receipts.filter(countableAppliedReceipt);
  for (const receipt of applied) {
    const attributed = receiptTargets(receipt);
    const first = attributed[0];
    if (!first) continue;
    sets.add(first);
    attributed.slice(1).forEach((key) => sets.union(first, key));
  }
  const groupedTargets = new Map<string, ExpenseTarget[]>();
  for (const target of targets) {
    const root = sets.find(target.target_key);
    groupedTargets.set(root, [...(groupedTargets.get(root) || []), target]);
  }
  const receiptsByRoot = new Map<string, JsonObject[]>();
  for (const receipt of applied) {
    const first = receiptTargets(receipt)[0];
    if (!first) continue;
    const root = sets.find(first);
    receiptsByRoot.set(root, [...(receiptsByRoot.get(root) || []), receipt]);
  }
  const roots = new Set([...groupedTargets.keys(), ...receiptsByRoot.keys()]);
  return [...roots].map((root) => {
    const currentTargets = groupedTargets.get(root) || [];
    const groupReceipts = receiptsByRoot.get(root) || [];
    const snapshotTargets = new Map<string, ExpenseTarget>();
    for (const receipt of groupReceipts) {
      const attribution = asObject(receipt.attribution);
      for (const value of asArray(attribution.target_snapshots)) {
        const snapshot = asObject(value);
        const targetKey = cleanText(snapshot.target_key || snapshot.key);
        if (!targetKey || activeKeys.has(targetKey) || snapshotTargets.has(targetKey)) continue;
        snapshotTargets.set(targetKey, {
          target_key: targetKey,
          source_type: cleanText(snapshot.source_type || "archived_expense_target"),
          source_id: cleanText(snapshot.source_id),
          title: cleanText(snapshot.title || "Archived expense list"),
          resource_type: cleanText(snapshot.resource_type || "other"),
          color: cleanText(snapshot.color || "#667085"),
          projected_cents: integerCents(snapshot.projected_cents),
          actual_override_cents: null,
          archived: true,
          metadata: { attribution_snapshot: true }
        });
      }
    }
    const groupTargets = [...currentTargets, ...snapshotTargets.values()];
    const groupDisplayOrder = groupTargets.reduce((lowest, target) => {
      const displayOrder = Number(target.display_order);
      return Number.isFinite(displayOrder) ? Math.min(lowest, displayOrder) : lowest;
    }, Number.MAX_SAFE_INTEGER);
    const projected = groupTargets.reduce((sum, target) => sum + integerCents(target.projected_cents), 0);
    const receiptActual = groupReceipts.reduce((sum, receipt) => sum + integerCents(receipt.total_cents), 0);
    const manualActual = currentTargets.reduce((sum, target) => sum + (target.actual_override_cents == null ? 0 : integerCents(target.actual_override_cents)), 0);
    const actual = groupReceipts.length ? receiptActual : (currentTargets.some((target) => target.actual_override_cents != null) ? manualActual : null);
    const attributedKeys = [...new Set(groupReceipts.flatMap(receiptTargets))];
    const displayTargetCount = groupTargets.length || attributedKeys.length;
    return {
      id: `expense_group_${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
      grouped: displayTargetCount > 1,
      unresolved_attribution: currentTargets.length === 0,
      target_keys: [...new Set([...groupTargets.map((target) => target.target_key), ...attributedKeys])],
      title: groupTargets.length === 1
        ? cleanText(groupTargets[0]?.title)
        : (displayTargetCount > 1 ? `${displayTargetCount} linked expense lists` : "Archived expense attribution"),
      display_order: groupDisplayOrder,
      targets: groupTargets,
      receipts: groupReceipts.map(summaryReceiptView),
      receipt_ids: groupReceipts.map((receipt) => cleanText(receipt.id)),
      projected_cents: projected,
      actual_cents: actual,
      current_cents: actual == null ? projected : actual,
      variance_cents: actual == null ? null : actual - projected,
      actual_source: groupReceipts.length ? "receipts" : (actual == null ? "projection" : "manual_override")
    };
  }).sort((a, b) => Number(a.display_order) - Number(b.display_order) || cleanText(a.title).localeCompare(cleanText(b.title)));
}

export function suggestReceiptAttributions(totalCentsValue: unknown, targets: ExpenseTarget[]) {
  const total = integerCents(totalCentsValue);
  const candidates = targets.filter((target) => target.projected_cents > 0).slice(0, 30);
  if (total <= 0 || !candidates.length) return [];
  let best: { keys: string[]; sum: number; score: number } | null = null;
  let visited = 0;
  const maxCombination = Math.min(4, candidates.length);
  const consider = (indexes: number[]) => {
    const selected = indexes.map((index) => candidates[index]).filter((target): target is ExpenseTarget => !!target);
    const sum = selected.reduce((value, target) => value + target.projected_cents, 0);
    if (sum <= 0) return;
    const relativeDifference = Math.abs(total - sum) / Math.max(total, sum, 1);
    const score = relativeDifference + Math.max(0, selected.length - 1) * 0.006;
    if (!best || score < best.score) best = { keys: selected.map((target) => target.target_key), sum, score };
  };
  const walk = (start: number, count: number, indexes: number[]) => {
    if (visited > 40_000) return;
    if (indexes.length === count) {
      visited += 1;
      consider(indexes);
      return;
    }
    for (let index = start; index < candidates.length; index += 1) walk(index + 1, count, [...indexes, index]);
  };
  for (let count = 1; count <= maxCombination; count += 1) walk(0, count, []);
  if (!best) return [];
  const selected = best as { keys: string[]; sum: number; score: number };
  return selected.score <= 0.36 ? selected.keys : [];
}

async function accruedCommissionExpense(orgId: string, projectId: string, sources?: ExpenseSummarySources) {
  const entries = (sources?.payrollLedgerEntries || (await listPayrollLedgerEntries(orgId, { project_id: projectId, limit: 5000 })))
    .filter((entry) => !sources?.payrollLedgerEntries || cleanText(entry.project_id) === projectId)
    .filter((entry) => cleanText(entry.state) === "accrued")
    .filter((entry) => cleanText(entry.subgroup) === "commission" || cleanText(entry.kind) === "commission")
    .filter((entry) => ["commission", "adjustment", "clawback"].includes(cleanText(entry.kind)));
  const actualCents = Math.max(0, entries.reduce((sum, entry) => sum + Math.round(Number(entry.amount_cents || 0)), 0));
  if (!entries.length || actualCents <= 0) return null;
  const target: ExpenseTarget = {
    target_key: "payroll_commissions:accrued",
    source_type: "payroll_commission",
    source_id: projectId,
    title: "Commissions Accrued",
    resource_type: "commission",
    color: "#7c3aed",
    sort_order: 20_000,
    projected_cents: 0,
    actual_cents: actualCents,
    current_cents: actualCents,
    actual_override_cents: null,
    system_managed: true,
    receipt_attribution_enabled: false,
    actual_override_enabled: false,
    details: {
      entry_count: entries.length,
      payee_count: new Set(entries.map((entry) => `${cleanText(asObject(entry.payee).type)}:${cleanText(asObject(entry.payee).id)}`)).size
    },
    metadata: { source: "payroll_ledger", recognition_state: "accrued" }
  };
  return {
    target,
    group: {
      id: `expense_group_${createHash("sha256").update(`${projectId}:payroll_commissions:accrued`).digest("hex").slice(0, 16)}`,
      grouped: false,
      system_managed: true,
      unresolved_attribution: false,
      target_keys: [target.target_key],
      title: target.title,
      display_order: Number.MAX_SAFE_INTEGER - 1,
      targets: [target],
      receipts: [],
      receipt_ids: [],
      projected_cents: 0,
      actual_cents: actualCents,
      current_cents: actualCents,
      variance_cents: actualCents,
      actual_source: "payroll_ledger"
    }
  };
}

const LABOR_LEDGER_KINDS = ["hourly", "salary", "piece_rate"];

/**
 * Actual labor cost from the payroll ledger — the write-back that makes a
 * project's profit move when payroll accrues. Same recognition convention as
 * accruedCommissionExpense: accrued (non-void) entries tagged to the project
 * count as incurred cost, whether or not a batch has paid them out yet.
 * Adjustments/clawbacks ride along when their subgroup is a labor earning.
 */
async function accruedPayrollLaborExpense(orgId: string, projectId: string, sources?: ExpenseSummarySources) {
  const entries = (sources?.payrollLedgerEntries || (await listPayrollLedgerEntries(orgId, { project_id: projectId, limit: 5000 })))
    .filter((entry) => !sources?.payrollLedgerEntries || cleanText(entry.project_id) === projectId)
    .filter((entry) => cleanText(entry.state) === "accrued")
    .filter((entry) => LABOR_LEDGER_KINDS.includes(cleanText(entry.kind))
      || (["adjustment", "clawback"].includes(cleanText(entry.kind)) && LABOR_LEDGER_KINDS.includes(cleanText(entry.subgroup))));
  const actualCents = Math.max(0, entries.reduce((sum, entry) => sum + Math.round(Number(entry.amount_cents || 0)), 0));
  if (!entries.length || actualCents <= 0) return null;
  const target: ExpenseTarget = {
    target_key: "payroll_labor:accrued",
    source_type: "payroll_labor",
    source_id: projectId,
    title: "Payroll Labor",
    resource_type: "labor",
    color: "#0284c7",
    sort_order: 19_000,
    projected_cents: 0,
    actual_cents: actualCents,
    current_cents: actualCents,
    actual_override_cents: null,
    system_managed: true,
    receipt_attribution_enabled: false,
    actual_override_enabled: false,
    details: {
      entry_count: entries.length,
      payee_count: new Set(entries.map((entry) => `${cleanText(asObject(entry.payee).type)}:${cleanText(asObject(entry.payee).id)}`)).size,
      by_kind: Object.fromEntries(LABOR_LEDGER_KINDS.map((kind) => [
        kind,
        entries.filter((entry) => cleanText(entry.kind) === kind || cleanText(entry.subgroup) === kind)
          .reduce((sum, entry) => sum + Math.round(Number(entry.amount_cents || 0)), 0)
      ]))
    },
    metadata: { source: "payroll_ledger", recognition_state: "accrued" }
  };
  return {
    target,
    group: {
      id: `expense_group_${createHash("sha256").update(`${projectId}:payroll_labor:accrued`).digest("hex").slice(0, 16)}`,
      grouped: false,
      system_managed: true,
      unresolved_attribution: false,
      target_keys: [target.target_key],
      title: target.title,
      display_order: Number.MAX_SAFE_INTEGER - 2,
      targets: [target],
      receipts: [],
      receipt_ids: [],
      projected_cents: 0,
      actual_cents: actualCents,
      current_cents: actualCents,
      variance_cents: actualCents,
      actual_source: "payroll_ledger"
    }
  };
}

export async function projectExpenseSummary(orgId: string, projectId: string) {
  const sources = await loadExpenseSummarySources(orgId);
  return projectExpenseSummaryFromSources(orgId, projectId, sources);
}

export async function projectExpenseSummaryFromSources(orgId: string, projectId: string, sources: ExpenseSummarySources) {
  const [trackedTargets, receipts] = await Promise.all([
    projectExpenseTargets(orgId, projectId, sources),
    Promise.resolve(sources.receipts
      .filter((item) => cleanText(item.project_id) === projectId && cleanText(item.status) !== "void")
      .sort((a, b) => cleanText(b.uploaded_at || b.created_at).localeCompare(cleanText(a.uploaded_at || a.created_at))))
  ]);
  const commission = (await accruedCommissionExpense(orgId, projectId, sources));
  const payrollLabor = (await accruedPayrollLaborExpense(orgId, projectId, sources));
  const targets = [...trackedTargets, ...(commission ? [commission.target] : []), ...(payrollLabor ? [payrollLabor.target] : [])];
  const groups = [
    ...expenseGroups(trackedTargets, receipts),
    ...(commission ? [commission.group] : []),
    ...(payrollLabor ? [payrollLabor.group] : [])
  ];
  const projected = groups.reduce((sum, group) => sum + integerCents(group.projected_cents), 0);
  const trackedActual = groups.reduce((sum, group) => sum + (group.actual_cents == null ? 0 : integerCents(group.actual_cents)), 0);
  const current = groups.reduce((sum, group) => sum + integerCents(group.current_cents), 0);
  const actualGroupCount = groups.filter((group) => group.actual_cents != null).length;
  const groupedTargetMap = new Map<string, JsonObject>();
  for (const group of groups) {
    for (const target of asArray(group.targets).map(asObject)) {
      const key = cleanText(target.target_key);
      if (key && !groupedTargetMap.has(key)) groupedTargetMap.set(key, target);
    }
  }
  const groupedExpenseTargets = [...groupedTargetMap.values()];
  const byResource: Record<string, JsonObject> = Object.fromEntries(["material", "labor", "equipment", "commission", "other"].map((type) => {
    const typedTargets = groupedExpenseTargets.filter((target) => cleanText(target.resource_type) === type);
    const actual = groups.reduce((sum, group) => {
      if (group.actual_cents == null) return sum;
      const groupTypes = new Set(asArray(group.targets).map(asObject).map((target) => cleanText(target.resource_type)));
      return groupTypes.size === 1 && groupTypes.has(type) ? sum + integerCents(group.actual_cents) : sum;
    }, 0);
    const current = groups.reduce((sum, group) => {
      const groupTyped = asArray(group.targets).map(asObject).filter((target) => cleanText(target.resource_type) === type);
      if (!groupTyped.length) return sum;
      if (group.actual_cents == null) return sum + groupTyped.reduce((value, target) => value + integerCents(target.projected_cents), 0);
      const groupTypes = new Set(asArray(group.targets).map(asObject).map((target) => cleanText(target.resource_type)));
      return groupTypes.size === 1 ? sum + integerCents(group.actual_cents) : sum;
    }, 0);
    const projectedForType = typedTargets.reduce((sum, target) => sum + integerCents(target.projected_cents), 0);
    return [type, {
      projected_cents: projectedForType,
      actual_cents: actual,
      current_cents: current,
      variance_cents: current - projectedForType,
      target_count: typedTargets.length
    }];
  }));
  const sharedActual = groups.reduce((sum, group) => {
    if (group.actual_cents == null) return sum;
    const types = new Set(asArray(group.targets).map(asObject).map((target) => cleanText(target.resource_type)));
    return types.size !== 1 ? sum + integerCents(group.actual_cents) : sum;
  }, 0);
  byResource.shared = {
    projected_cents: 0,
    actual_cents: sharedActual,
    current_cents: sharedActual,
    variance_cents: sharedActual,
    group_count: groups.filter((group) => group.actual_cents != null && new Set(asArray(group.targets).map(asObject).map((target) => cleanText(target.resource_type))).size !== 1).length,
    allocation: "unallocated_mixed_resource_receipts"
  };
  return {
    schema_version: EXPENSE_SCHEMA_VERSION,
    project_id: projectId,
    currency: "USD",
    targets,
    groups,
    receipts: receipts.map(summaryReceiptView),
    totals: {
      projected_cents: projected,
      actual_cents: trackedActual,
      current_cents: current,
      variance_cents: current - projected,
      actual_group_count: actualGroupCount,
      projected_group_count: groups.length - actualGroupCount,
      receipt_count: receipts.length,
      applied_receipt_count: receipts.filter(countableAppliedReceipt).length
    },
    by_resource: byResource,
    updated_at: nowIso()
  };
}

export async function assertExpenseTargetKeys(orgId: string, projectId: string, targetKeysValue: unknown) {
  const requested = uniqueText(targetKeysValue);
  const summary = await projectExpenseSummary(orgId, projectId);
  const available = new Set(asArray(summary.targets).map(asObject)
    .filter((target) => target.receipt_attribution_enabled !== false && target.actual_override_enabled !== false)
    .map((target) => cleanText(target.target_key)));
  const invalid = requested.filter((key) => !available.has(key));
  if (invalid.length) throw badRequest("invalid_expense_targets", "One or more selected expense lists are not available for this project.", { invalid_target_keys: invalid });
  return requested;
}

export async function receiptSuggestionForProject(orgId: string, projectId: string, totalCents: number) {
  const summary = await projectExpenseSummary(orgId, projectId);
  return suggestReceiptAttributions(totalCents, asArray(summary.targets).map(asObject) as ExpenseTarget[]);
}

export async function saveReceiptRecord(orgId: string, receipt: JsonObject, expectedRevision = 0) {
  const id = cleanText(receipt.id);
  if (!id) throw badRequest("receipt_id_required", "A receipt id is required.");
  return documentView(await upsertDocument(orgId, PAYMENT_RECEIPT_COLLECTION, {
    id,
    expected_revision: expectedRevision || undefined,
    data: receipt,
    metadata: {
      kind: "payment_receipt",
      project_id: cleanText(receipt.project_id),
      status: cleanText(receipt.status),
      media_id: cleanText(asObject(receipt.file).media_id)
    }
  }, { replace: true }));
}
