import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, forbidden, PlatformError } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { readOrganization } from "../platform/storage.js";
import {
  cancelPaymentIntent,
  createDisbursement,
  createPayable,
  createPayment,
  createPaymentIntent,
  ensureReceivablesForSignedProposal,
  listLedger,
  listPayables,
  listPaymentEvents,
  listProjectObligations,
  listProjectPaymentSchedules,
  listProjectPayments,
  projectMoneySummary,
  reconciliationSummary,
  recordPaymentEvent,
  readPayment,
  reallocatePayment,
  refundPayment,
  setPaymentCleared,
  setPaymentUncleared,
  voidPayable
} from "./storage.js";
import {
  createSupplementalExpense,
  listReceiptsForAssociation,
  listProjectReceipts,
  patchSupplementalExpense,
  projectExpenseSummary,
  readReceipt,
  setExpenseActualOverride
} from "./expenses.js";
import {
  applyReceiptAttribution,
  createReceiptFromUpload,
  patchReceipt,
  readReceiptFile,
  receiptAuditView,
  receiptView,
  reextractReceipt,
  voidReceipt,
  type ReceiptUploadInput
} from "./receipts.js";
import {
  createInvoice,
  emailInvoice,
  getInvoicePaymentSettings,
  invoicePaymentSettingsForProject,
  listOrganizationInvoices,
  listProjectInvoices,
  listUninvoicedObligations,
  markInvoiceDue,
  quickInvoiceCandidates,
  readInvoice,
  renderInvoicePdf,
  setInvoiceProductionHold,
  voidInvoice
} from "./invoices.js";
import { OPENAI_FILE_INPUT_LIMIT_BYTES } from "./receipt_extraction.js";
import { renderPaymentReceiptPdf } from "./payment_receipts.js";
import {
  actOnReimbursementRequest,
  listReimbursementRequests,
  submitReimbursementRequest
} from "./reimbursements.js";
import { getMerchantConfig, maybeNotifyMerchantApproved, upsertMerchantConfig } from "./merchant_config.js";
import {
  financeSummary,
  getPayoutDetail,
  listDisputes,
  listPayouts
} from "./payouts.js";
import { advanceMockMerchant, MOCK_PROVIDER } from "./providers/mock.js";
import { forwardConfigured } from "./providers/forward.js";
import { ForwardApiError, getBoardingProvider, getPaymentProvider } from "./providers/index.js";
import { env } from "../src/config/env.js";
import {
  createSavedMethod,
  deleteSavedMethod,
  listSavedMethods,
  paymentIntakeConfig,
  recordProviderChargedPayment,
  surchargeQuote,
  tokenizePaymentMethod
} from "./intake.js";
import { registerForwardWebhooks } from "./webhooks_forward.js";
import {
  getProjectAutopay,
  removeProjectAutopay,
  runAutopayForOrganization,
  startAutopayScheduler,
  upsertProjectAutopay
} from "./autopay.js";
import {
  dismissUnmatchedSettlement,
  listUnmatchedSettlements,
  matchUnmatchedSettlement
} from "./reconciliation.js";
import { registerPaymentsAdminApi } from "./admin_api.js";
import { registerMoneyOnboardingAttentionSource } from "./onboarding_attention.js";
import {
  applyReceiptSchema,
  createInvoiceSchema,
  createDisbursementSchema,
  createPayableSchema,
  createPaymentIntentSchema,
  createPaymentSchema,
  createSupplementalExpenseSchema,
  emailInvoiceSchema,
  invoiceProductionHoldSchema,
  jsonReceiptUploadSchema,
  markInvoiceDueSchema,
  boardingApplicationSchema,
  hostedSignupSchema,
  createSavedMethodSchema,
  merchantMockAdvanceSchema,
  paymentMethodIntentSchema,
  patchMerchantConfigSchema,
  quickInvoiceSchema,
  voidInvoiceSchema,
  patchReceiptSchema,
  patchSupplementalExpenseSchema,
  refundPaymentSchema,
  reallocatePaymentSchema,
  clearPaymentSchema,
  setExpenseActualSchema,
  autopayEnrollSchema,
  autopayRunSchema,
  matchUnmatchedSchema,
  dismissUnmatchedSchema
} from "./schemas.js";

/**
 * Server-side feature enforcement (Phase 0 gap fix): money.invoices and
 * money.take_payment were UI-gated only. Mirrors requireMoneyFlag's forbidden
 * error shape so clients see the same app_flag_disabled envelope.
 */
async function requireMoneyFeature(orgId: string, flag: string, label: string) {
  if (!(await isAppFlagEnabled(orgId, "money", flag))) {
    throw forbidden("app_flag_disabled", `${label} is not enabled for this organization.`);
  }
}

export function canManageOrganizationReceipts(ctx: Pick<PlatformAuthContext, "role" | "permissions">) {
  const permissions = asObject(ctx.permissions);
  return ["owner", "admin", "super_admin"].includes(cleanText(ctx.role).toLowerCase())
    || permissions["*"] === true
    || permissions.view_projects === true
    || permissions.manage_projects === true
    || permissions.manage_company_settings === true;
}

const objectBodySchema = z.object({}).passthrough();
const RECEIPT_REQUEST_BODY_LIMIT = Math.ceil(OPENAI_FILE_INPUT_LIMIT_BYTES * 4 / 3) + (1024 * 1024);

function requireFieldReceiptPermission(ctx: PlatformAuthContext) {
  // Management users retain the existing receipt-library behavior. A user
  // entering through only the field application must have the effective Crew
  // permission, including any explicit per-user denial layered over a role.
  if (ctx.applicationAccess.management?.enabled === true) return;
  const permissions = asObject(ctx.permissions);
  const permission = "crew.receipts.upload";
  const allowed = permissions[permission] === true
    || (permissions[permission] !== false && permissions["*"] === true);
  if (ctx.applicationAccess.field?.enabled !== true || !allowed) {
    throw forbidden("crew_permission_denied", "This user does not have access to Crew receipts.", { permission });
  }
}

export const registerPaymentsApi: FastifyPluginAsync = async (app) => {
  // The Money onboarding banner set is computed from live boarding state on
  // every attention-feed read (see onboarding_attention.ts).
  registerMoneyOnboardingAttentionSource();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      reply.code(Number((error as { statusCode: number }).statusCode));
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "payments",
    message: "payments API is mounted",
    endpoints: {
      projectSummary: "/organizations/:orgId/projects/:projectId/money-summary",
      projectSchedules: "/organizations/:orgId/projects/:projectId/payment-schedules",
      projectObligations: "/organizations/:orgId/projects/:projectId/obligations",
      projectPayments: "/organizations/:orgId/projects/:projectId/payments",
      projectInvoices: "/organizations/:orgId/projects/:projectId/invoices",
      organizationInvoices: "/organizations/:orgId/invoices",
      uninvoiced: "/organizations/:orgId/uninvoiced",
      payments: "/organizations/:orgId/payments",
      refunds: "/organizations/:orgId/payments/:paymentId/refunds",
      paymentIntents: "/organizations/:orgId/payment-intents",
      payables: "/organizations/:orgId/payables",
      disbursements: "/organizations/:orgId/disbursements",
      projectExpenses: "/organizations/:orgId/projects/:projectId/expense-summary",
      projectReceipts: "/organizations/:orgId/projects/:projectId/receipts",
      receiptUploads: "/organizations/:orgId/receipts",
      receipts: "/organizations/:orgId/receipts/:receiptId",
      ledger: "/organizations/:orgId/ledger",
      payouts: "/organizations/:orgId/payouts",
      payoutDetail: "/organizations/:orgId/payouts/:payoutId",
      financeSummary: "/organizations/:orgId/finance-summary",
      disputes: "/organizations/:orgId/disputes",
      paymentIntakeConfig: "/organizations/:orgId/payment-intake-config",
      paymentMethodIntents: "/organizations/:orgId/payment-method-intents",
      surchargeQuote: "/organizations/:orgId/surcharge-quote",
      customerPaymentMethods: "/organizations/:orgId/customers/:contactRef/payment-methods",
      merchantConfig: "/organizations/:orgId/merchant-config",
      merchantMockAdvance: "/organizations/:orgId/merchant-mock/advance",
      merchantBoardingPlans: "/organizations/:orgId/merchant-boarding/processing-plans",
      merchantBoardingApplications: "/organizations/:orgId/merchant-boarding/applications",
      merchantBoardingApplication: "/organizations/:orgId/merchant-boarding/applications/:applicationId",
      merchantBoardingSubmit: "/organizations/:orgId/merchant-boarding/applications/:applicationId/submit",
      merchantBoardingLink: "/organizations/:orgId/merchant-boarding/applications/:applicationId/link",
      merchantBoardingBankAccounts: "/organizations/:orgId/merchant-boarding/bank-accounts",
      merchantPortalLoginUrl: "/organizations/:orgId/merchant-portal/login-url",
      projectAutopay: "/organizations/:orgId/projects/:projectId/autopay",
      autopayRun: "/organizations/:orgId/autopay/run",
      reconciliationUnmatched: "/organizations/:orgId/reconciliation/unmatched"
    }
  }));

  app.get("/ping", async (request) => ({
    ok: true,
    api: "payments",
    route: "/ping",
    method: request.method,
    receivedAt: new Date().toISOString()
  }));

  app.get("/organizations/:orgId/projects/:projectId/money-summary", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const summary = await projectMoneySummary(orgId, getParam(request.params, "projectId"));
    return { ok: true, summary };
  });

  app.get("/organizations/:orgId/projects/:projectId/expense-summary", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const summary = await projectExpenseSummary(orgId, getParam(request.params, "projectId"));
    return { ok: true, expense_summary: summary };
  });

  app.post("/organizations/:orgId/projects/:projectId/expenses", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const expense = await createSupplementalExpense(orgId, projectId, createSupplementalExpenseSchema.parse(request.body ?? {}), ctx);
    await recordPaymentEvent(orgId, "project_expense.created", { project_id: projectId, expense_id: cleanText(expense.id), amount_cents: Number(expense.projected_cents || expense.actual_override_cents || 0) }, ctx);
    reply.code(201);
    return { ok: true, expense, expense_summary: await projectExpenseSummary(orgId, projectId) };
  });

  app.patch("/organizations/:orgId/projects/:projectId/expenses/:expenseId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const expense = await patchSupplementalExpense(orgId, projectId, getParam(request.params, "expenseId"), patchSupplementalExpenseSchema.parse(request.body ?? {}), ctx);
    await recordPaymentEvent(orgId, "project_expense.updated", { project_id: projectId, expense_id: cleanText(expense.id) }, ctx);
    return { ok: true, expense, expense_summary: await projectExpenseSummary(orgId, projectId) };
  });

  app.put("/organizations/:orgId/projects/:projectId/expense-actual", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = setExpenseActualSchema.parse(request.body ?? {});
    const override = await setExpenseActualOverride(orgId, projectId, body, ctx);
    await recordPaymentEvent(orgId, "project_expense.actual_overridden", { project_id: projectId, target_key: body.target_key, actual_cents: body.actual_cents }, ctx);
    return { ok: true, override, expense_summary: await projectExpenseSummary(orgId, projectId) };
  });

  app.get("/organizations/:orgId/projects/:projectId/receipts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const receipts = (await listProjectReceipts(orgId, getParam(request.params, "projectId"))).map(receiptView);
    return { ok: true, receipts, count: receipts.length };
  });

  app.post("/organizations/:orgId/projects/:projectId/receipts", { bodyLimit: RECEIPT_REQUEST_BODY_LIMIT }, async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const upload = await parseReceiptUploadRequest(request);
    upload.idempotencyKey = headerValue(request.headers, "idempotency-key");
    const serverLocation = requestUploadLocation(request);
    const clientReportedLocation = asObject(upload.uploadLocation);
    upload.uploadLocation = {
      ...serverLocation,
      browser: clientReportedLocation
    };
    const result = await createReceiptFromUpload(orgId, projectId, upload, ctx);
    await recordPaymentEvent(orgId, result.created ? "receipt.uploaded" : "receipt.upload_deduplicated", {
      project_id: projectId,
      receipt_id: cleanText(result.receipt.id),
      total_cents: Number(result.receipt.total_cents || 0),
      media_id: cleanText(asObject(result.receipt.file).media_id)
    }, ctx);
    reply.code(result.created ? 201 : 200);
    return { ok: true, ...result, expense_summary: await projectExpenseSummary(orgId, projectId) };
  });

  app.get("/organizations/:orgId/receipts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"] });
    requireFieldReceiptPermission(ctx);
    const query = asObject(request.query);
    const manager = canManageOrganizationReceipts(ctx);
    const kind = manager ? cleanText(query.association_kind || query.kind || "organization_user") : "organization_user";
    const id = manager ? cleanText(query.association_id || query.id || ctx.userId) : ctx.userId;
    const receipts = (await listReceiptsForAssociation(orgId, kind, id, { include_void: query.include_void === true || cleanText(query.include_void) === "1" })).map(receiptView);
    return { ok: true, receipts, count: receipts.length, association: { kind, id } };
  });

  app.post("/organizations/:orgId/receipts", { bodyLimit: RECEIPT_REQUEST_BODY_LIMIT }, async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, application: ["management", "field"] });
    requireFieldReceiptPermission(ctx);
    const upload = await parseReceiptUploadRequest(request);
    upload.idempotencyKey = headerValue(request.headers, "idempotency-key");
    const serverLocation = requestUploadLocation(request);
    upload.uploadLocation = { ...serverLocation, browser: asObject(upload.uploadLocation) };
    const result = await createReceiptFromUpload(orgId, cleanText(upload.projectId), upload, ctx);
    await recordPaymentEvent(orgId, result.created ? "receipt.uploaded" : "receipt.upload_deduplicated", {
      project_id: cleanText(result.receipt.project_id),
      receipt_id: cleanText(result.receipt.id),
      total_cents: Number(result.receipt.total_cents || 0),
      owner: asObject(result.receipt.owner),
      media_id: cleanText(asObject(result.receipt.file).media_id)
    }, ctx);
    reply.code(result.created ? 201 : 200);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/reimbursements", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"] });
    const reimbursements = await listReimbursementRequests(orgId, asObject(request.query), ctx);
    return { ok: true, reimbursements, count: reimbursements.length };
  });

  app.post("/organizations/:orgId/receipts/:receiptId/reimbursement-request", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, application: ["management", "field"] });
    const result = await submitReimbursementRequest(orgId, getParam(request.params, "receiptId"), objectBodySchema.parse(request.body ?? {}), ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/reimbursements/:receiptId/actions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, application: ["management"] });
    return { ok: true, ...(await actOnReimbursementRequest(orgId, getParam(request.params, "receiptId"), objectBodySchema.parse(request.body ?? {}), ctx)) };
  });

  app.get("/organizations/:orgId/receipts/:receiptId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"] });
    requireFieldReceiptPermission(ctx);
    const receipt = await readReceipt(orgId, getParam(request.params, "receiptId"));
    const manager = canManageOrganizationReceipts(ctx);
    if (!manager && cleanText(asObject(receipt.uploaded_by).user_id) !== ctx.userId) throw forbidden("receipt_forbidden", "This receipt is not available to this user.");
    return { ok: true, receipt: receiptView(receipt) };
  });

  app.get("/organizations/:orgId/receipts/:receiptId/audit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, ...receiptAuditView(await readReceipt(orgId, getParam(request.params, "receiptId"))) };
  });

  app.get("/organizations/:orgId/receipts/:receiptId/file", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"] });
    requireFieldReceiptPermission(ctx);
    const receiptId = getParam(request.params, "receiptId");
    const receipt = await readReceipt(orgId, receiptId);
    const manager = canManageOrganizationReceipts(ctx);
    if (!manager && cleanText(asObject(receipt.uploaded_by).user_id) !== ctx.userId) throw forbidden("receipt_forbidden", "This receipt is not available to this user.");
    const file = await readReceiptFile(orgId, receiptId);
    const fileName = safeDownloadName(file.fileName);
    const inlineRequested = cleanText(asObject(request.query).inline) === "1";
    const safeInline = asObject(asObject(receipt.file).support).safe_inline_preview === true;
    reply.header("Content-Type", file.contentType || "application/octet-stream");
    reply.header("Content-Disposition", `${inlineRequested && safeInline ? "inline" : "attachment"}; filename="${fileName}"`);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(file.bytes);
  });

  app.patch("/organizations/:orgId/receipts/:receiptId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const receipt = await patchReceipt(orgId, getParam(request.params, "receiptId"), patchReceiptSchema.parse(request.body ?? {}), ctx);
    await recordPaymentEvent(orgId, "receipt.review_updated", { project_id: cleanText(receipt.project_id), receipt_id: cleanText(receipt.id), total_cents: Number(receipt.total_cents || 0) }, ctx);
    return { ok: true, receipt, expense_summary: await projectExpenseSummary(orgId, cleanText(receipt.project_id)) };
  });

  app.post("/organizations/:orgId/receipts/:receiptId/apply", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const { reimbursement_payable, ...receipt } = await applyReceiptAttribution(orgId, getParam(request.params, "receiptId"), applyReceiptSchema.parse(request.body ?? {}), ctx);
    await recordPaymentEvent(orgId, "receipt.applied", { project_id: cleanText(receipt.project_id), receipt_id: cleanText(receipt.id), total_cents: Number(receipt.total_cents || 0), target_keys: receipt.attributed_target_keys }, ctx);
    return {
      ok: true,
      receipt,
      ...(reimbursement_payable ? { reimbursement_payable } : {}),
      expense_summary: await projectExpenseSummary(orgId, cleanText(receipt.project_id))
    };
  });

  app.post("/organizations/:orgId/receipts/:receiptId/extract", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const receipt = await reextractReceipt(orgId, getParam(request.params, "receiptId"), ctx);
    await recordPaymentEvent(orgId, "receipt.extracted", { project_id: cleanText(receipt.project_id), receipt_id: cleanText(receipt.id), extraction_status: cleanText(asObject(receipt.extraction).status) }, ctx);
    return { ok: true, receipt, expense_summary: await projectExpenseSummary(orgId, cleanText(receipt.project_id)) };
  });

  app.delete("/organizations/:orgId/receipts/:receiptId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const receipt = await voidReceipt(orgId, getParam(request.params, "receiptId"), ctx);
    await recordPaymentEvent(orgId, "receipt.voided", { project_id: cleanText(receipt.project_id), receipt_id: cleanText(receipt.id) }, ctx);
    return { ok: true, receipt, expense_summary: await projectExpenseSummary(orgId, cleanText(receipt.project_id)) };
  });

  app.get("/organizations/:orgId/projects/:projectId/payment-schedules", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const schedules = await listProjectPaymentSchedules(orgId, getParam(request.params, "projectId"));
    return { ok: true, schedules, count: schedules.length };
  });

  app.get("/organizations/:orgId/projects/:projectId/obligations", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const obligations = await listProjectObligations(orgId, getParam(request.params, "projectId"));
    return { ok: true, obligations, count: obligations.length };
  });

  app.get("/organizations/:orgId/projects/:projectId/payments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const payments = await listProjectPayments(orgId, getParam(request.params, "projectId"));
    return { ok: true, payments, count: payments.length };
  });

  app.get("/organizations/:orgId/projects/:projectId/invoices", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const [invoices, settings] = await Promise.all([
      listProjectInvoices(orgId, projectId),
      invoicePaymentSettingsForProject(orgId, projectId)
    ]);
    return { ok: true, invoices, settings, count: invoices.length };
  });

  app.post("/organizations/:orgId/projects/:projectId/invoices", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "invoices", "Invoicing");
    const invoice = await createInvoice(orgId, projectId, createInvoiceSchema.parse(request.body ?? {}), ctx);
    reply.code(201);
    return { ok: true, invoice };
  });

  app.get("/organizations/:orgId/invoices", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = asObject(request.query);
    const [result, settings] = await Promise.all([
      listOrganizationInvoices(orgId, { project_id: cleanText(query.project_id), status: cleanText(query.status) }),
      getInvoicePaymentSettings(orgId)
    ]);
    return { ok: true, invoices: result.invoices, summary: result.summary, settings, count: result.invoices.length };
  });

  app.get("/organizations/:orgId/uninvoiced", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const projects = await listUninvoicedObligations(orgId);
    return { ok: true, projects, count: projects.length };
  });

  app.post("/organizations/:orgId/projects/:projectId/invoices/quick", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "invoices", "Invoicing");
    const body = quickInvoiceSchema.parse(request.body ?? {});
    const candidates = await quickInvoiceCandidates(orgId, projectId);
    const requestedIds = (body.obligation_ids ?? []).map((id) => cleanText(id)).filter(Boolean);
    const candidateIds = new Set(candidates.map((item) => cleanText(item.id)));
    if (requestedIds.some((id) => !candidateIds.has(id))) {
      throw badRequest("invoice_obligations_invalid", "One or more selected payments are already invoiced or unavailable.");
    }
    const selected = requestedIds.length
      ? requestedIds
      : candidates.filter((item) => ["due", "overdue", "partially_paid"].includes(cleanText(item.status))).map((item) => cleanText(item.id));
    if (!selected.length) throw badRequest("invoice_nothing_ready", "There are no uninvoiced payments ready to bill on this project.");
    let invoice = await createInvoice(orgId, projectId, {
      obligation_ids: selected,
      ...(body.tax_enabled === undefined ? {} : { tax_enabled: body.tax_enabled }),
      ...(cleanText(body.notes) ? { notes: cleanText(body.notes) } : {})
    }, ctx);
    let sent = false;
    let recipient = "";
    if (body.send === true) {
      invoice = await markInvoiceDue(orgId, cleanText(invoice.id), {}, ctx);
      let portalUrl = "";
      if (body.include_portal_link !== false) {
        const { ensureCustomerPortalRecord } = await import("../platform/api.js");
        const portal = await ensureCustomerPortalRecord(orgId, projectId, { actor_user_id: ctx.userId }, requestPublicBaseUrl(request));
        portalUrl = cleanText(portal.portal.live_url);
      }
      const emailed = await emailInvoice(orgId, cleanText(invoice.id), {
        recipient: cleanText(body.recipient || asObject(invoice.customer).email),
        include_portal_link: body.include_portal_link !== false && !!portalUrl,
        ...(cleanText(body.message) ? { message: cleanText(body.message) } : {})
      }, portalUrl, ctx);
      invoice = asObject(emailed.invoice);
      sent = emailed.sent === true;
      recipient = cleanText(emailed.recipient);
    }
    reply.code(201);
    return { ok: true, invoice, sent, recipient };
  });

  app.post("/organizations/:orgId/invoices/:invoiceId/void", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "invoices", "Invoicing");
    const invoice = await voidInvoice(orgId, getParam(request.params, "invoiceId"), voidInvoiceSchema.parse(request.body ?? {}), ctx);
    return { ok: true, invoice };
  });

  app.post("/organizations/:orgId/invoices/:invoiceId/production-hold", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "invoices", "Invoicing");
    const invoice = await setInvoiceProductionHold(orgId, getParam(request.params, "invoiceId"), invoiceProductionHoldSchema.parse(request.body ?? {}), ctx);
    return { ok: true, invoice };
  });

  app.get("/organizations/:orgId/invoices/:invoiceId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    return { ok: true, invoice: await readInvoice(orgId, getParam(request.params, "invoiceId")) };
  });

  app.get("/organizations/:orgId/invoices/:invoiceId/pdf", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const file = await renderInvoicePdf(orgId, getParam(request.params, "invoiceId"));
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Disposition", `attachment; filename="${safeDownloadName(file.fileName)}"`);
    return reply.send(file.bytes);
  });

  app.post("/organizations/:orgId/invoices/:invoiceId/mark-due", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "invoices", "Invoicing");
    const invoice = await markInvoiceDue(orgId, getParam(request.params, "invoiceId"), markInvoiceDueSchema.parse(request.body ?? {}), ctx);
    const { ensureCustomerPortalRecord } = await import("../platform/api.js");
    const portal = await ensureCustomerPortalRecord(orgId, cleanText(invoice.project_id), { actor_user_id: ctx.userId }, requestPublicBaseUrl(request));
    return { ok: true, invoice, portal: portal.portal };
  });

  app.post("/organizations/:orgId/invoices/:invoiceId/email", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "invoices", "Invoicing");
    const body = emailInvoiceSchema.parse(request.body ?? {});
    let invoice = await readInvoice(orgId, getParam(request.params, "invoiceId"));
    let portalUrl = "";
    if (body.include_portal_link === true) {
      if (invoice.render_paid_in_full !== true && !["due", "overdue", "paid"].includes(cleanText(invoice.status))) {
        invoice = await markInvoiceDue(orgId, cleanText(invoice.id), {}, ctx);
      }
      const { ensureCustomerPortalRecord } = await import("../platform/api.js");
      const portal = await ensureCustomerPortalRecord(orgId, cleanText(invoice.project_id), { actor_user_id: ctx.userId }, requestPublicBaseUrl(request));
      portalUrl = cleanText(portal.portal.live_url);
    }
    return { ok: true, ...(await emailInvoice(orgId, cleanText(invoice.id), body, portalUrl, ctx)) };
  });

  app.post("/organizations/:orgId/payments", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "take_payment", "Taking payments");
    const body = createPaymentSchema.parse(request.body ?? {});
    // Provider charge path: only when the request carries a payment-method
    // token AND the org resolves a provider. Otherwise the legacy record
    // flow below runs unchanged (tokens are simply ignored without one).
    const token = cleanText(body.payment_method_id);
    const savedMethodId = cleanText(body.saved_method_id);
    if (token || savedMethodId) {
      const provider = await getPaymentProvider(orgId);
      if (provider) {
        const result = await recordProviderChargedPayment(orgId, provider, {
          amount_cents: Number(body.amount_cents ?? (Number(body.amount) || 0) * 100),
          payment_method_id: token,
          saved_method_id: savedMethodId,
          method: cleanText(asObject(body.method).type || body.method_type),
          method_label: cleanText(body.method_label || asObject(body.method).label),
          method_descriptor: asObject(body.method),
          project_id: cleanText(body.project_id),
          branch_id: cleanText(body.branch_id || ctx.branchId || "default") || "default",
          save_payment_method: body.save_payment_method === true,
          apply_surcharge: body.apply_surcharge !== false,
          contact_ref: asObject(body.contact_ref),
          payment: body
        }, ctx);
        reply.code(201);
        return { ok: true, ...result };
      }
    }
    const result = await createPayment(orgId, body, ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/payments/:paymentId/receipt.pdf", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_projects" });
    const file = await renderPaymentReceiptPdf(orgId, getParam(request.params, "paymentId"), ctx.userId);
    reply.type(file.contentType);
    reply.header("Content-Disposition", `inline; filename="${safeDownloadName(file.fileName)}"`);
    return reply.send(file.bytes);
  });

  // --- Payment intake: tokenization, saved methods, surcharge ---------------

  app.get("/organizations/:orgId/payment-intake-config", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_projects" });
    const query = asObject(request.query);
    const config = await paymentIntakeConfig(orgId, cleanText(query.contact_ref), cleanText(query.branch_id || ctx.branchId || "default") || "default");
    return { ok: true, ...config };
  });

  app.post("/organizations/:orgId/payment-method-intents", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = paymentMethodIntentSchema.parse(request.body ?? {});
    const provider = await getPaymentProvider(orgId);
    if (!provider) throw badRequest("merchant_not_configured", "This organization has no payment provider configured.");
    const result = await tokenizePaymentMethod(orgId, provider, body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/surcharge-quote", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = asObject(request.query);
    const provider = await getPaymentProvider(orgId);
    if (!provider) return { ok: true, quote: { amount_cents: Math.max(0, Math.round(Number(query.amount_cents) || 0)), surcharge_cents: 0, total_cents: Math.max(0, Math.round(Number(query.amount_cents) || 0)), enabled: false } };
    const quote = await surchargeQuote(orgId, provider, {
      amount_cents: Math.max(0, Math.round(Number(query.amount_cents) || 0)),
      method: cleanText(query.method),
      branch_id: cleanText(query.branch_id || ctx.branchId || "default") || "default"
    });
    return { ok: true, quote };
  });

  app.get("/organizations/:orgId/customers/:contactRef/payment-methods", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const methods = await listSavedMethods(orgId, getParam(request.params, "contactRef"));
    return { ok: true, payment_methods: methods, count: methods.length };
  });

  app.post("/organizations/:orgId/customers/:contactRef/payment-methods", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createSavedMethodSchema.parse(request.body ?? {});
    const provider = await getPaymentProvider(orgId);
    if (!provider) throw badRequest("merchant_not_configured", "This organization has no payment provider configured.");
    const details = await provider.getPaymentMethod(cleanText(body.provider_payment_method_id)).catch(() => null);
    const method = await createSavedMethod(orgId, getParam(request.params, "contactRef"), {
      provider: provider.provider,
      provider_payment_method_id: cleanText(body.provider_payment_method_id),
      type: cleanText(body.type) || (details?.type === "card" ? "card" : details ? "bank" : "card"),
      brand: cleanText(body.brand) || details?.brand,
      last4: cleanText(body.last4) || details?.last4,
      exp_month: body.exp_month ?? details?.exp_month ?? null,
      exp_year: body.exp_year ?? details?.exp_year ?? null,
      label: cleanText(body.label),
      default: body.default === true
    });
    await recordPaymentEvent(orgId, "payment_method.saved", { contact_ref: getParam(request.params, "contactRef"), method_id: method.id }, ctx);
    reply.code(201);
    return { ok: true, payment_method: method };
  });

  app.delete("/organizations/:orgId/customers/:contactRef/payment-methods/:methodId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const method = await deleteSavedMethod(orgId, getParam(request.params, "contactRef"), getParam(request.params, "methodId"));
    await recordPaymentEvent(orgId, "payment_method.removed", { contact_ref: getParam(request.params, "contactRef"), method_id: method.id }, ctx);
    return { ok: true, payment_method: method };
  });

  app.get("/organizations/:orgId/payments/:paymentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const payment = await readPayment(orgId, getParam(request.params, "paymentId"));
    return { ok: true, payment };
  });

  app.post("/organizations/:orgId/payments/:paymentId/refunds", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = refundPaymentSchema.parse(request.body ?? {});
    const result = await refundPayment(orgId, getParam(request.params, "paymentId"), body, ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/payments/:paymentId/reallocate", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = reallocatePaymentSchema.parse(request.body ?? {});
    const result = await reallocatePayment(orgId, getParam(request.params, "paymentId"), body, ctx);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/payments/:paymentId/clear", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = clearPaymentSchema.parse(request.body ?? {});
    const payment = await setPaymentCleared(orgId, getParam(request.params, "paymentId"), body, ctx);
    return { ok: true, payment };
  });

  app.post("/organizations/:orgId/payments/:paymentId/unclear", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const payment = await setPaymentUncleared(orgId, getParam(request.params, "paymentId"), ctx);
    return { ok: true, payment };
  });

  app.get("/organizations/:orgId/reconciliation", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const summary = await reconciliationSummary(orgId, asObject(request.query));
    return { ok: true, ...summary };
  });

  // --- Unmatched-settlements reconciliation queue ---------------------------

  app.get("/organizations/:orgId/reconciliation/unmatched", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const records = await listUnmatchedSettlements(orgId);
    return { ok: true, records, count: records.length };
  });

  app.post("/organizations/:orgId/reconciliation/unmatched/:recordId/match", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = matchUnmatchedSchema.parse(request.body ?? {});
    const result = await matchUnmatchedSettlement(orgId, getParam(request.params, "recordId"), body.payment_id, ctx);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/reconciliation/unmatched/:recordId/dismiss", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = dismissUnmatchedSchema.parse(request.body ?? {});
    const result = await dismissUnmatchedSettlement(orgId, getParam(request.params, "recordId"), ctx, cleanText(body.reason));
    return { ok: true, ...result };
  });

  // --- Autopay (charge stored methods when obligations come due) ------------

  app.get("/organizations/:orgId/projects/:projectId/autopay", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const autopay = await getProjectAutopay(orgId, getParam(request.params, "projectId"));
    return { ok: true, autopay };
  });

  app.put("/organizations/:orgId/projects/:projectId/autopay", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "take_payment", "Taking payments");
    const body = autopayEnrollSchema.parse(request.body ?? {});
    const autopay = await upsertProjectAutopay(orgId, getParam(request.params, "projectId"), body, ctx);
    return { ok: true, autopay };
  });

  app.delete("/organizations/:orgId/projects/:projectId/autopay", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const autopay = await removeProjectAutopay(orgId, getParam(request.params, "projectId"), ctx);
    return { ok: true, autopay };
  });

  app.post("/organizations/:orgId/autopay/run", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "take_payment", "Taking payments");
    const body = autopayRunSchema.parse(request.body ?? {});
    const now = cleanText(body.now) && Number.isFinite(Date.parse(cleanText(body.now)))
      ? new Date(cleanText(body.now))
      : undefined;
    const result = await runAutopayForOrganization(orgId, now ? { now } : {});
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/payment-intents", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await requireMoneyFeature(orgId, "take_payment", "Taking payments");
    const body = createPaymentIntentSchema.parse(request.body ?? {});
    const intent = await createPaymentIntent(orgId, body, ctx);
    reply.code(201);
    return { ok: true, intent };
  });

  app.post("/organizations/:orgId/payment-intents/:intentId/cancel", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const intent = await cancelPaymentIntent(orgId, getParam(request.params, "intentId"), ctx);
    return { ok: true, intent };
  });

  app.get("/organizations/:orgId/payables", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const payables = await listPayables(orgId, asObject(request.query));
    return { ok: true, payables, count: payables.length };
  });

  app.post("/organizations/:orgId/payables", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createPayableSchema.parse(request.body ?? {});
    const payable = await createPayable(orgId, body, ctx);
    reply.code(201);
    return { ok: true, payable };
  });

  app.delete("/organizations/:orgId/payables/:payableId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const payable = await voidPayable(orgId, getParam(request.params, "payableId"), ctx);
    return { ok: true, payable };
  });

  app.post("/organizations/:orgId/disbursements", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createDisbursementSchema.parse(request.body ?? {});
    const result = await createDisbursement(orgId, body, ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/ledger", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const ledger = await listLedger(orgId, asObject(request.query));
    return { ok: true, ledger, count: ledger.length };
  });

  app.get("/organizations/:orgId/events", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const events = await listPaymentEvents(orgId, asObject(request.query));
    return { ok: true, events, count: events.length };
  });

  app.get("/organizations/:orgId/merchant-config", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects" });
    const config = await getMerchantConfig(orgId);
    return { ok: true, merchant_config: config, forward_environment: forwardEnvironment() };
  });

  app.patch("/organizations/:orgId/merchant-config", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = patchMerchantConfigSchema.parse(request.body ?? {});
    const config = await upsertMerchantConfig(orgId, body);
    await recordPaymentEvent(orgId, "merchant_config.updated", { provider: cleanText(config.provider) }, ctx);
    return { ok: true, merchant_config: config };
  });

  // --- Merchant boarding (application lifecycle over the boarding adapter) --
  // Thin org-scoped shims over getBoardingProvider(orgId) so the settings UI
  // can drive the boarding lifecycle without knowing which provider backs it.

  /**
   * Which Forward environment this deployment talks to: "sandbox" when the
   * configured API base is a sandbox.getfwd.com host, "production" for any
   * other configured base, "" when Forward keys are absent. Gates the
   * hosted-first signup harness (and tells the settings UI whether to show
   * its test-mode card).
   */
  function forwardEnvironment() {
    if (!forwardConfigured()) return "";
    return env.forwardApiBase.includes("sandbox") ? "sandbox" : "production";
  }

  async function requireBoardingProvider(orgId: string) {
    const boarding = await getBoardingProvider(orgId);
    if (!boarding) {
      throw badRequest("merchant_boarding_unavailable", "Merchant boarding is not available for this organization. Enable merchant processing and select a provider first.");
    }
    return boarding;
  }

  async function ensureForwardApplicationRedirect(boarding: Awaited<ReturnType<typeof requireBoardingProvider>>, applicationId: string, redirectUrl: string, application?: Awaited<ReturnType<typeof boarding.getApplication>>) {
    if (boarding.provider !== "forward") return application;
    const current = application || await boardingCall(() => boarding.getApplication(applicationId));
    if (current.status !== "DRAFT" || cleanText(asObject(current.raw.partner_data).redirect_url) === redirectUrl) return current;
    return boardingCall(() => boarding.updateApplication(applicationId, {
      partner_data: { redirect_url: redirectUrl }
    }));
  }

  /**
   * Provider API failures (validation, capability gates, upstream 4xx) become
   * structured 400s instead of opaque 500s — e.g. Forward's "You cannot
   * submit applications via the API because this capability is not enabled
   * for your integration."
   */
  async function boardingCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ForwardApiError && error.status > 0 && error.status < 500) {
        throw badRequest("merchant_boarding_provider_error", error.message, {
          provider_status: error.status,
          provider_code: cleanText(asObject(error.body).code)
        });
      }
      throw error;
    }
  }

  app.get("/organizations/:orgId/merchant-boarding/processing-plans", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects" });
    const boarding = await requireBoardingProvider(orgId);
    const plans = await boardingCall(() => boarding.listProcessingPlans());
    return { ok: true, processing_plans: plans, count: plans.length };
  });

  app.post("/organizations/:orgId/merchant-boarding/applications", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = boardingApplicationSchema.parse(request.body ?? {});
    const boarding = await requireBoardingProvider(orgId);
    const businessInput = asObject(body.business);
    let businessId = cleanText(body.business_id);
    if (!businessId && cleanText(businessInput.name)) {
      const business = await boardingCall(() => boarding.createBusiness({
        name: cleanText(businessInput.name),
        email: cleanText(businessInput.email) || undefined,
        phone: cleanText(businessInput.phone) || undefined
      }));
      businessId = business.id;
    }
    const { business: _business, ...applicationInput } = body;
    const application = await boardingCall(() => boarding.createApplication({
      ...applicationInput,
      business_id: businessId || undefined,
      external_account_id: cleanText(body.external_account_id) || orgId,
      ...(boarding.provider === "forward" ? { partner_data: { ...asObject(body.partner_data), redirect_url: forwardApplicationRedirectUrl(request) } } : {})
    }));
    // Record identifiers immediately (webhook projections also update these,
    // but business_id only travels through this seam).
    await upsertMerchantConfig(orgId, {
      forward: {
        ...(businessId ? { business_id: businessId } : {}),
        application_id: application.id,
        ...(cleanText(application.processing_plan_id) ? { processing_plan_id: cleanText(application.processing_plan_id) } : {}),
        boarding_status: application.status
      }
    });
    await recordPaymentEvent(orgId, "merchant_boarding.application_created", { application_id: application.id }, ctx);
    reply.code(201);
    return { ok: true, application, merchant_config: await getMerchantConfig(orgId) };
  });

  app.get("/organizations/:orgId/merchant-boarding/applications/:applicationId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects" });
    const boarding = await requireBoardingProvider(orgId);
    const application = await boardingCall(() => boarding.getApplication(getParam(request.params, "applicationId")));
    // Sync the tracked boarding state from the provider read: submissions and
    // approvals happen on Forward's side and the v2.application.* /
    // v2.account.* webhooks only land on a publicly registered endpoint, so
    // polling this shim is how a local/dev pane learns the merchant finished
    // (DRAFT -> UNDER_REVIEW) or was approved (account id + rails backfill).
    const config = await getMerchantConfig(orgId);
    const tracked = cleanText(config.forward.boarding_status);
    const live = cleanText(application.status);
    const patch: JsonObject = {};
    if (cleanText(config.forward.application_id) === application.id) {
      if (live && live !== tracked) patch.boarding_status = live;
      if (live === "APPROVED" && !cleanText(config.forward.account_id)) {
        const accounts = await boardingCall(() => boarding.listAccounts({
          business_id: cleanText(config.forward.business_id) || undefined
        })).catch(() => []);
        const account = accounts.find((entry) => cleanText(entry.external_account_id) === orgId
          || (cleanText(config.forward.business_id) && cleanText(entry.business_id) === cleanText(config.forward.business_id)));
        if (account) {
          patch.account_id = account.id;
          patch.processing_enabled = account.processing_enabled;
          patch.payouts_enabled = account.payouts_enabled;
        }
      }
    }
    if (Object.keys(patch).length) {
      const merchantConfig = await upsertMerchantConfig(orgId, { forward: patch });
      if (live === "APPROVED") await maybeNotifyMerchantApproved(orgId).catch(() => null);
      return { ok: true, application, merchant_config: await getMerchantConfig(orgId).catch(() => merchantConfig) };
    }
    return { ok: true, application };
  });

  app.patch("/organizations/:orgId/merchant-boarding/applications/:applicationId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = boardingApplicationSchema.parse(request.body ?? {});
    const boarding = await requireBoardingProvider(orgId);
    const { business: _business, ...applicationInput } = body;
    const application = await boardingCall(() => boarding.updateApplication(getParam(request.params, "applicationId"), {
      ...applicationInput,
      ...(boarding.provider === "forward" ? { partner_data: { ...asObject(body.partner_data), redirect_url: forwardApplicationRedirectUrl(request) } } : {})
    }));
    return { ok: true, application };
  });

  // Direct API submission is PARTNER-CAPABILITY-GATED at Forward (not enabled
  // for our integration) — kept for parity/testing, but the org-facing flow
  // goes through the hosted-application link below.
  app.post("/organizations/:orgId/merchant-boarding/applications/:applicationId/submit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const boarding = await requireBoardingProvider(orgId);
    const application = await boardingCall(() => boarding.submitApplication(getParam(request.params, "applicationId")));
    await recordPaymentEvent(orgId, "merchant_boarding.application_submitted", { application_id: application.id, status: application.status }, ctx);
    return { ok: true, application, merchant_config: await getMerchantConfig(orgId) };
  });

  // Hosted application link (Forward's mandatory submission surface): reuses
  // the persisted link until it expires, then regenerates. The merchant
  // finishes signatures + bank verification on Forward's hosted form; the
  // v2.application.submitted webhook closes the loop.
  app.post("/organizations/:orgId/merchant-boarding/applications/:applicationId/link", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const applicationId = getParam(request.params, "applicationId");
    const config = await getMerchantConfig(orgId);
    const storedUrl = cleanText(config.forward.application_link_url);
    const storedExpiry = cleanText(config.forward.application_link_expires_at);
    // force skips reuse: Forward can invalidate a link server-side before its
    // stamped expiry (LINK_EXPIRED_OR_REMOVED), so surfaces that are about to
    // RENDER the link mint a fresh one instead of trusting the stored URL.
    const force = asObject(request.body).force === true;
    const boarding = await requireBoardingProvider(orgId);
    await ensureForwardApplicationRedirect(boarding, applicationId, forwardApplicationRedirectUrl(request));
    const storedFresh = !force && storedUrl && storedExpiry && Date.parse(storedExpiry) > Date.now();
    if (storedFresh && cleanText(config.forward.application_id) === applicationId) {
      return { ok: true, link: { url: storedUrl, expires_at: storedExpiry, reused: true }, merchant_config: config };
    }
    const link = await boardingCall(() => boarding.generateApplicationLink(applicationId));
    const merchantConfig = await upsertMerchantConfig(orgId, {
      forward: {
        application_id: applicationId,
        application_link_url: link.url,
        application_link_expires_at: link.expires_at
      }
    });
    await recordPaymentEvent(orgId, "merchant_boarding.application_link_generated", {
      application_id: applicationId,
      expires_at: link.expires_at
    }, ctx);
    return { ok: true, link: { url: link.url, expires_at: link.expires_at, reused: false }, merchant_config: merchantConfig };
  });

  // Hosted-first signup (test harness): skips FirstMate's wizard steps
  // entirely — creates a minimal draft business + application and hands the
  // merchant straight to Forward's hosted application, where they fill
  // everything out on Forward's own form. Deliberately restricted to the mock
  // provider and the Forward SANDBOX so it can never become a production
  // bypass of the vetted wizard flow. Idempotent: an existing application is
  // reused and only the hosted link is (re)generated.
  // SINGLE-FLIGHT per org: Forward keeps ONE active hosted link per
  // application — generating a new link invalidates the previous one, so two
  // concurrent signup calls must share a single link generation or the
  // first-rendered link dies instantly (LINK_EXPIRED_OR_REMOVED).
  const hostedSignupInFlight = new Map<string, Promise<JsonObject>>();

  app.post("/organizations/:orgId/merchant-boarding/hosted-signup", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = hostedSignupSchema.parse(request.body ?? {});
    const inFlight = hostedSignupInFlight.get(orgId);
    if (inFlight) {
      const shared = await inFlight;
      return { ...shared, shared_in_flight: true };
    }
    // Reserve the slot BEFORE any further awaits — the check and set must be
    // adjacent synchronous operations or two requests both slip past the
    // check while awaiting config reads.
    let settle!: (value: JsonObject) => void;
    let fail!: (error: unknown) => void;
    const placeholder = new Promise<JsonObject>((resolve, reject) => { settle = resolve; fail = reject; });
    placeholder.catch(() => { /* each awaiting caller handles the rejection */ });
    hostedSignupInFlight.set(orgId, placeholder);
    const work = (async (): Promise<{ result: JsonObject; created: boolean }> => {
      const config = await getMerchantConfig(orgId);
      const environment = forwardEnvironment();
      if (config.provider !== MOCK_PROVIDER && environment !== "sandbox") {
        throw badRequest("hosted_signup_sandbox_only", "Hosted-first signup is a test harness: it is only available on the mock provider or the Forward sandbox.");
      }
      const boarding = await requireBoardingProvider(orgId);
      const existingApplicationId = cleanText(config.forward.application_id);
      let businessId = cleanText(config.forward.business_id);
      let application;
      if (existingApplicationId) {
        application = await boardingCall(() => boarding.getApplication(existingApplicationId));
        application = await ensureForwardApplicationRedirect(boarding, existingApplicationId, forwardApplicationRedirectUrl(request), application) || application;
      } else {
        const organization = asObject(await readOrganization(orgId).catch(() => null));
        const businessName = cleanText(body.business_name) || cleanText(organization.name) || `FirstMate Test Business ${orgId}`;
        if (!businessId) {
          const businessInput = (name: string) => ({
            name,
            email: cleanText(body.email) || cleanText(asObject(ctx.user).email) || undefined
          });
          let business;
          try {
            business = await boardingCall(() => boarding.createBusiness(businessInput(businessName)));
          } catch (error) {
            // Forward requires partner-wide unique business names; two orgs
            // with the same company name are legitimate on our side, so
            // retry once with a deterministic org-derived suffix.
            const providerCode = cleanText(asObject((error as PlatformError)?.details).provider_code);
            if (providerCode !== "BUSINESS_NAME_DUPLICATE") throw error;
            business = await boardingCall(() => boarding.createBusiness(businessInput(`${businessName} (${orgId.slice(-6)})`)));
          }
          businessId = business.id;
        }
        let planId = cleanText(body.processing_plan_id);
        if (!planId) {
          // Forward's hosted form needs a plan on the draft; prefer a US plan
          // (the partner sandbox also carries CAN test plans).
          const plans = await boardingCall(() => boarding.listProcessingPlans()).catch(() => []);
          const usPlan = plans.find((plan) => /\bUS\b/i.test(cleanText(plan.name))
            || cleanText(asObject(plan.raw).country).toUpperCase() === "US");
          planId = cleanText((usPlan || plans[0])?.id);
        }
        application = await boardingCall(() => boarding.createApplication({
          business_id: businessId || undefined,
          name: businessName,
          ...(planId ? { processing_plan_id: planId } : {}),
          external_account_id: orgId,
          user_fields: { hosted_signup: "true", firstmate_org_id: orgId },
          ...(boarding.provider === "forward" ? { partner_data: { redirect_url: forwardApplicationRedirectUrl(request) } } : {})
        }));
      }
      const link = await boardingCall(() => boarding.generateApplicationLink(application.id));
      const merchantConfig = await upsertMerchantConfig(orgId, {
        forward: {
          ...(businessId ? { business_id: businessId } : {}),
          application_id: application.id,
          ...(cleanText(application.processing_plan_id) ? { processing_plan_id: cleanText(application.processing_plan_id) } : {}),
          boarding_status: application.status,
          application_link_url: link.url,
          application_link_expires_at: link.expires_at
        }
      });
      await recordPaymentEvent(orgId, "merchant_boarding.hosted_signup_started", {
        application_id: application.id,
        reused_application: Boolean(existingApplicationId)
      }, ctx);
      return {
        result: {
          ok: true,
          application,
          link: { url: link.url, expires_at: link.expires_at },
          merchant_config: merchantConfig,
          forward_environment: environment
        } as JsonObject,
        created: !existingApplicationId
      };
    })();
    try {
      const { result, created } = await work;
      settle(result);
      reply.code(created ? 201 : 200);
      return result;
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      hostedSignupInFlight.delete(orgId);
    }
  });

  // Bank-account status passthrough — bank accounts are managed inside
  // Forward's merchant portal (portal-only per the rep); we only display.
  app.get("/organizations/:orgId/merchant-boarding/bank-accounts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects" });
    const boarding = await requireBoardingProvider(orgId);
    const config = await getMerchantConfig(orgId);
    const accountId = cleanText(config.forward.account_id);
    let account = null;
    if (accountId) {
      try { account = await boardingCall(() => boarding.getAccount(accountId)); }
      catch { /* Bank-account discovery can still use the persisted business. */ }
    }
    const businessId = cleanText(config.forward.business_id || account?.business_id);
    if (!businessId) return { ok: true, bank_accounts: [], count: 0, payout_bank_account_id: "" };
    const listed = await boardingCall(() => boarding.listBankAccounts({ business_id:businessId, limit:100 }));
    // Never trust a provider-side filter as the authorization boundary. A
    // partner credential can see multiple merchants, so enforce org ownership
    // again before returning anything to the browser.
    const bankAccounts = listed.filter((bankAccount) => cleanText(bankAccount.business_id) === businessId);
    let payoutBankAccountId = "";
    if (account && cleanText(account.business_id) === businessId) payoutBankAccountId = cleanText(account.raw.bank_account_id);
    return { ok: true, bank_accounts: bankAccounts, count: bankAccounts.length, payout_bank_account_id:payoutBankAccountId };
  });

  // Single-use magic-link SSO into Forward's merchant portal (bank-account
  // changes + dispute responses happen there, per the rep). The portal user
  // identity is the application's control signer when one exists, else the
  // calling user. The minted URL is returned once and never logged.
  app.post("/organizations/:orgId/merchant-portal/login-url", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const boarding = await requireBoardingProvider(orgId);
    const config = await getMerchantConfig(orgId);
    // Prefer the application's control signer — Forward creates the portal
    // identity around the signer; fall back to the calling user.
    let email = "";
    let name = "";
    const applicationId = cleanText(config.forward.application_id);
    if (applicationId) {
      try {
        const application = await boarding.getApplication(applicationId);
        const owners = (Array.isArray(application.raw.owners) ? application.raw.owners : [])
          .map((owner) => asObject(owner));
        const signer = owners.find((owner) => owner.signer === true) || owners[0];
        if (signer) {
          email = cleanText(signer.email);
          name = cleanText(signer.name) || [cleanText(signer.first_name), cleanText(signer.last_name)].filter(Boolean).join(" ");
        }
      } catch {
        // Application read failures fall back to the calling user below.
      }
    }
    if (!email) {
      email = cleanText(asObject(ctx.user).email);
      name = cleanText(asObject(ctx.user).name);
    }
    if (!email) {
      throw badRequest("merchant_portal_user_unresolved", "No signer or user email is available to create the merchant portal login.");
    }
    const user = await boardingCall(() => boarding.ensurePortalUser({
      business_id: cleanText(config.forward.business_id) || undefined,
      name: name || undefined,
      email
    }));
    const login = await boardingCall(() => boarding.generatePortalLoginUrl(user.id));
    await recordPaymentEvent(orgId, "merchant_portal.login_url_generated", { user_id: user.id }, ctx);
    return { ok: true, login_url: login.url, user_id: user.id };
  });

  // --- Payout / dispute / finance read models (webhook-fed projections) ----

  app.get("/organizations/:orgId/payouts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const payouts = await listPayouts(orgId, asObject(request.query));
    return { ok: true, payouts, count: payouts.length };
  });

  app.get("/organizations/:orgId/payouts/:payoutId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const detail = await getPayoutDetail(orgId, getParam(request.params, "payoutId"));
    return { ok: true, ...detail };
  });

  app.get("/organizations/:orgId/finance-summary", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const summary = await financeSummary(orgId);
    return { ok: true, summary };
  });

  app.get("/organizations/:orgId/disputes", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const disputes = await listDisputes(orgId, asObject(request.query));
    return { ok: true, disputes, count: disputes.length };
  });

  // Test-only underwriting/settlement simulation for the mock provider —
  // guarded like the other org-admin payment routes and refused unless the
  // org's merchant provider is "mock".
  app.post("/organizations/:orgId/merchant-mock/advance", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = merchantMockAdvanceSchema.parse(request.body ?? {});
    const op = cleanText(body.op) || "underwriting";
    // op "charge" is handled here (not in the mock adapter) — it drives the
    // provider-agnostic payments adapter exactly like the future intake modal
    // will, so harnesses can produce fee-bearing charges over HTTP today.
    if (op === "charge") {
      const config = await getMerchantConfig(orgId);
      if (cleanText(config.provider) !== MOCK_PROVIDER) {
        throw badRequest("merchant_provider_not_mock", "The mock charge op requires the organization's merchant provider to be \"mock\".");
      }
      const provider = await getPaymentProvider(orgId);
      if (!provider) throw badRequest("merchant_not_boarded", "The organization has no approved merchant account to charge against.");
      const amountCents = Number(body.amount_cents);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        throw badRequest("mock_charge_amount_invalid", "A positive amount_cents is required for the mock charge op.");
      }
      const paymentId = cleanText(body.payment_id);
      const intent = await provider.createPaymentIntent({
        amount_cents: Math.round(amountCents),
        reference_id: paymentId,
        user_fields: {
          ...(paymentId ? { payment_id: paymentId } : {}),
          ...(cleanText(body.project_id) ? { project_id: cleanText(body.project_id) } : {})
        }
      });
      const charge = await provider.createPayment(intent.id, {
        payment_method_id: cleanText(body.payment_method_id) || "pm_mock_visa"
      });
      await recordPaymentEvent(orgId, "merchant_mock.advanced", { op, payment_id: paymentId, status: charge.status }, ctx);
      return { ok: true, intent, charge, merchant_config: await getMerchantConfig(orgId) };
    }
    const result = await advanceMockMerchant(orgId, body);
    await recordPaymentEvent(orgId, "merchant_mock.advanced", { op, to: cleanText(body.to) }, ctx);
    return { ok: true, ...result, merchant_config: await getMerchantConfig(orgId) };
  });

  // Forward (merchant processing) webhooks — unauthenticated, signature
  // verified over the raw body inside a scoped sub-plugin.
  await app.register(registerForwardWebhooks);

  // Autopay runner heartbeat — same seam as the appointment-confirmation
  // scheduler (env kill switches, unref'd interval).
  startAutopayScheduler();

  // --- Boarding ops console (FirstMate staff, cross-org) --------------------
  // /v1/payments/admin/* — internal-staff-guarded pipeline/plan/provider
  // management. Lives in its own file; nothing org-facing registers there.
  await app.register(registerPaymentsAdminApi, { prefix: "/admin" });

  app.post("/organizations/:orgId/proposals/:proposalId/sync-schedule", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await ensureReceivablesForSignedProposal(orgId, getParam(request.params, "proposalId"), cleanText(body.snapshot_id || body.snapshotId), body);
    reply.code(result.created ? 201 : 200);
    return { ok: true, ...result };
  });
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function forwardApplicationRedirectUrl(request: FastifyRequest) {
  const forwardedHost = cleanText(request.headers["x-forwarded-host"]).split(",")[0]?.trim().toLowerCase();
  const host = forwardedHost || cleanText(request.headers.host).split(",")[0]?.trim().toLowerCase();
  // These are the public FirstMate origins; never echo an arbitrary Host into
  // Forward's stored return URL. Local development retains PUBLIC_BASE_URL.
  const origin = host === "dev.1m8.ai" || host === "app.1m8.ai" ? `https://${host}` : env.publicBaseUrl;
  return new URL("/portal/payments-setup-complete.html", origin).toString();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function headerValue(headersValue: unknown, name: string) {
  const headers = asObject(headersValue);
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? cleanText(value[0]) : cleanText(value);
}

function requestPublicBaseUrl(requestValue: unknown) {
  const request = requestValue as { headers?: unknown };
  const headers = asObject(request.headers);
  const origin = headerValue(headers, "origin");
  if (origin && /^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");
  const host = headerValue(headers, "x-forwarded-host") || headerValue(headers, "host");
  const protocol = headerValue(headers, "x-forwarded-proto") || "http";
  return host ? `${protocol}://${host}` : "";
}

function tryParseJson(value: unknown, fallback: unknown = {}) {
  if (value && typeof value === "object") return value;
  try {
    return cleanText(value) ? JSON.parse(cleanText(value)) : fallback;
  } catch {
    return fallback;
  }
}

function requestUploadLocation(requestValue: unknown): JsonObject {
  const request = requestValue as { ip?: unknown; headers?: unknown; url?: unknown; routerPath?: unknown };
  const headers = asObject(request.headers);
  const forwardedFor = headerValue(headers, "x-forwarded-for");
  return {
    network: {
      request_ip: cleanText(request.ip),
      forwarded_for: forwardedFor,
      forwarded_ip: cleanText(forwardedFor.split(",")[0]),
      connecting_ip: headerValue(headers, "cf-connecting-ip") || headerValue(headers, "x-real-ip"),
      source: forwardedFor || headerValue(headers, "cf-connecting-ip") || headerValue(headers, "x-real-ip") ? "proxy_headers_unverified" : "request_socket"
    },
    proxy_geo: {
      country: headerValue(headers, "cf-ipcountry") || headerValue(headers, "x-vercel-ip-country"),
      region: headerValue(headers, "cf-region") || headerValue(headers, "x-vercel-ip-country-region"),
      city: headerValue(headers, "cf-ipcity") || headerValue(headers, "x-vercel-ip-city"),
      latitude: headerValue(headers, "x-vercel-ip-latitude"),
      longitude: headerValue(headers, "x-vercel-ip-longitude"),
      source: headerValue(headers, "cf-ipcountry") || headerValue(headers, "x-vercel-ip-country") ? "proxy_geo_headers_unverified" : ""
    },
    client: {
      user_agent: headerValue(headers, "user-agent"),
      referer: headerValue(headers, "referer"),
      route: cleanText(request.url || request.routerPath)
    },
    captured_at: new Date().toISOString()
  };
}

function dataUrlBytes(value: unknown) {
  const raw = cleanText(value);
  const encoded = raw.replace(/^data:[^,]*,/i, "");
  if (encoded.length > Math.ceil(OPENAI_FILE_INPUT_LIMIT_BYTES * 4 / 3) + 8) throw badRequest("receipt_file_too_large", "Receipt uploads must be smaller than 49 MB.");
  if (!/^[a-z0-9+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) throw badRequest("invalid_receipt_file", "The receipt file data is not valid base64.");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw badRequest("invalid_receipt_file", "The receipt file data is empty or invalid.");
  if (bytes.length >= OPENAI_FILE_INPUT_LIMIT_BYTES) throw badRequest("receipt_file_too_large", "Receipt uploads must be smaller than 49 MB.");
  return bytes;
}

async function parseReceiptUploadRequest(requestValue: unknown): Promise<ReceiptUploadInput> {
  const request = requestValue as {
    headers?: Record<string, unknown>;
    body?: unknown;
    parts?: (options?: JsonObject) => AsyncIterable<{
      type: "file" | "field";
      fieldname: string;
      value?: unknown;
      filename?: string;
      mimetype?: string;
      toBuffer?: () => Promise<Buffer>;
    }>;
  };
  const contentType = headerValue(request.headers, "content-type");
  if (contentType.includes("multipart/form-data")) {
    const parts = request.parts?.({ limits: { fileSize: OPENAI_FILE_INPUT_LIMIT_BYTES - 1, files: 1, fields: 32 } });
    if (!parts) throw badRequest("multipart_unavailable", "Multipart receipt uploads are unavailable.");
    let bytes: Buffer | undefined;
    let fileName = "";
    let fileContentType = "application/octet-stream";
    let fileCount = 0;
    const fields: Record<string, unknown> = {};
    for await (const part of parts) {
      if (part.type === "file") {
        fileCount += 1;
        if (fileCount > 1) throw badRequest("too_many_receipt_files", "Upload exactly one receipt or invoice at a time.");
        const buffer = await part.toBuffer?.();
        if (!buffer?.length) continue;
        if (!bytes || ["file", "receipt", "invoice", "document"].includes(part.fieldname)) {
          bytes = buffer;
          fileName = cleanText(part.filename || part.fieldname || "receipt-upload");
          fileContentType = cleanText(part.mimetype || "application/octet-stream");
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    if (!bytes) throw badRequest("receipt_file_required", "Choose a receipt or invoice file to upload.");
    const metadata = asObject(tryParseJson(fields.metadata, {}));
    const location = asObject(tryParseJson(fields.upload_location || fields.location, {}));
    const total = Number(fields.total_cents ?? metadata.total_cents);
    return {
      projectId: cleanText(fields.project_id || metadata.project_id),
      bytes,
      fileName,
      contentType: fileContentType,
      title: cleanText(fields.title || metadata.title),
      totalCents: Number.isFinite(total) ? Math.max(0, Math.round(total)) : null,
      purchaseDate: cleanText(fields.purchase_date || metadata.purchase_date),
      purchaseTime: cleanText(fields.purchase_time || metadata.purchase_time),
      purchaseTimezone: cleanText(fields.purchase_timezone || metadata.purchase_timezone),
      uploadLocation: location,
      owner: {
        kind: cleanText(fields.owner_kind || asObject(tryParseJson(fields.owner, {})).kind),
        id: cleanText(fields.owner_id || asObject(tryParseJson(fields.owner, {})).id)
      },
      associations: Array.isArray(tryParseJson(fields.associations, [])) ? tryParseJson(fields.associations, []) as JsonObject[] : [],
      metadata
    };
  }
  const body = jsonReceiptUploadSchema.parse(request.body ?? {});
  return {
    projectId: cleanText(body.project_id),
    ...(body.file_base64 ? { bytes: dataUrlBytes(body.file_base64) } : {}),
    fileName: cleanText(body.file_name || "receipt-upload"),
    contentType: cleanText(body.content_type || "application/octet-stream"),
    mediaId: cleanText(body.media_id),
    title: cleanText(body.title),
    totalCents: body.total_cents ?? null,
    purchaseDate: cleanText(body.purchase_date),
    purchaseTime: cleanText(body.purchase_time),
    purchaseTimezone: cleanText(body.purchase_timezone),
    uploadLocation: asObject(body.upload_location),
    owner: asObject(body.owner),
    associations: Array.isArray(body.associations) ? body.associations : [],
    metadata: asObject(body.metadata)
  };
}

function safeDownloadName(value: unknown) {
  return cleanText(value || "receipt").replace(/[\r\n"\\/]+/g, "_").slice(0, 240) || "receipt";
}
