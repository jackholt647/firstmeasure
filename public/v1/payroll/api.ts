import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { badRequest, PlatformError } from "../platform/errors.js";
import { hydratedWorkforceUser } from "../workforce/service.js";
import { registerPayrollAutomations } from "./automations.js";
import {
  payrollBatchActionSchema,
  payrollBatchCreateSchema,
  payrollBatchItemPatchSchema,
  payrollExportCreateSchema,
  payrollLedgerBatchInputSchema,
  payrollLedgerEntryInputSchema,
  payrollLedgerReverseSchema,
  payrollPayeeRefSchema,
  payrollScheduleInputSchema,
  payrollSchedulePatchSchema,
} from "./schemas.js";
import { generatePayrollArtifact, PAYROLL_EXPORT_CATALOG } from "./exports.js";
import {
  createPayrollRun, updatePayrollRunItem, actOnPayrollRun, payrollDashboard, assertRunCreatable, assertRunItemManageable, assertRunManageable,
  assertShiftManageable, decideOnPayRun, myPayRunApprovals
} from "./operations.js";
import { assertPayeeManageable, payeeScope, scopedBatch, scopedUpcoming } from "./payee-scope.js";
import { listOffCyclePayments, offCyclePaymentInputSchema, readOffCyclePayment, recordOffCyclePayment, removeOffCyclePayment } from "./off-cycle.js";
import { myPayExtras, payrollEarnings } from "./earnings.js";
import { projectUserEarnings } from "./pay-refresh.js";
import { OWN_PROJECTED_EARNINGS_PERMISSION } from "./pay-rule-publication.js";
import {
  approvePayrollTimesheet,
  correctPayrollTimesheet,
  listPayrollTimesheets,
  rejectPayrollTimesheet
} from "./timesheets.js";
import {
  accruePayrollProjection,
  applyPayrollBatchAction,
  createPayrollBatch,
  patchPayrollBatchItem,
  recordPayrollLedgerEntries,
  reversePayrollLedgerEntry,
  upcomingPayroll
} from "./service.js";
import {
  archivePayrollSchedule,
  asObject,
  cleanText,
  createPayrollSchedule,
  listPayrollBatches,
  listPayrollArtifacts,
  listPayrollLedgerEntries,
  listPayrollSchedules,
  patchPayrollSchedule,
  readPayrollBatch,
  readPayrollArtifact,
  readPayrollLedgerEntry,
  readPayrollSchedule,
  readPayrollSettings,
  savePayrollSettings,
} from "./storage.js";

const querySchema = z.object({}).passthrough();

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function queryObject(request: FastifyRequest) {
  return querySchema.parse(request.query ?? {});
}

function truthy(value: unknown) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(cleanText(value).toLowerCase());
}

function queryValues(value: unknown) {
  const values = Array.isArray(value) ? value : cleanText(value).split(",");
  return values.map(cleanText).filter(Boolean);
}

function earningsPayeesFromQuery(query: Record<string, unknown>) {
  const explicit = queryValues(query.payee).map((value) => {
    const separator = value.indexOf(":");
    if (separator <= 0) throw badRequest("payroll_payee_invalid", "Payees must use the '<type>:<id>' format.");
    return payrollPayeeRefSchema.parse({ type: value.slice(0, separator), id: value.slice(separator + 1) });
  });
  if (explicit.length) return explicit;
  const type = cleanText(query.payee_type || "organization_user");
  return queryValues(query.payee_ids || query.payee_id).map((id) => payrollPayeeRefSchema.parse({ type, id }));
}

async function requirePayrollRead(request: FastifyRequest, orgId: string) {
  return await requirePlatformAuth(request, { orgId, permission: "manage_payroll|manage_company_settings", capability: "apps.payroll" });
}

async function requirePayrollMutation(request: FastifyRequest, orgId: string) {
  return await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_payroll|manage_company_settings", capability: "apps.payroll" });
}

function expectedRevision(request: FastifyRequest) {
  const revision = Number(asObject(request.query).expected_revision || 0);
  if (!Number.isInteger(revision) || revision <= 0) throw badRequest("expected_revision_required", "A positive expected_revision query parameter is required.");
  return revision;
}

export const registerPayrollApi: FastifyPluginAsync = async (app) => {
  registerPayrollAutomations();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected payroll error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "payroll",
    version: 1,
    capabilities: ["schedule_groups", "schedule_layers", "worked_or_completed_recognition", "delays", "projections", "pay_rules", "clawbacks", "batches", "individual_payment_status", "named_approvals", "off_cycle_runs", "off_cycle_payments", "contractor_payables", "csv_exports", "provider_files", "report_documents", "branch_scope"]
  }));

  app.get("/organizations/:orgId/dashboard", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollRead(request, orgId);
    const query = queryObject(request);
    return { ok: true, ...scopedUpcoming(await payrollDashboard(orgId, query), payeeScope(context, query)) };
  });

  app.get("/organizations/:orgId/earnings/me", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, application: false, capability: "payroll.self_service_earnings" });
    const query = queryObject(request);
    const workforceUser = await hydratedWorkforceUser(orgId, context.userId).catch(() => ({}));
    const result = (await payrollEarnings(orgId, [{
      type: "organization_user",
      id: context.userId,
      name: cleanText(asObject(context.user).name),
      worker_type: ["independent_contractor", "subcontractor"].includes(cleanText(asObject(workforceUser).worker_classification))
        ? cleanText(asObject(workforceUser).worker_classification) as "independent_contractor" | "subcontractor" : "employee"
    }], query));
    return { ok: true, ...result, earnings: result.earnings[0], ...(await myPayExtras(orgId, context.userId)) };
  });

  // Whether pay runs need approval. On unless the organization turned it off.
  app.get("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, settings: await readPayrollSettings(orgId) };
  });

  app.put("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const input = z.object({ approval_required: z.boolean(), expected_revision: z.number().int().min(0).optional() }).strict().parse(request.body ?? {});
    return { ok: true, settings: await savePayrollSettings(orgId, input, context.userId) };
  });

  // What the signed-in user's pay rules project they will earn from work not done yet. Never posted; see pay-refresh.ts.
  app.get("/organizations/:orgId/earnings/me/projected", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, application: false, permission: OWN_PROJECTED_EARNINGS_PERMISSION, capability: "payroll.self_service_earnings" });
    return { ok: true, projected: await projectUserEarnings(orgId, context.userId) };
  });

  app.get("/organizations/:orgId/timesheets", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollRead(request, orgId);
    const query = queryObject(request), scope = payeeScope(context, query);
    const result = await listPayrollTimesheets(orgId, query);
    const timesheets = result.timesheets.filter((row) => scope.visible({ type: "organization_user", id: row.user_id }));
    return { ok: true, ...result, timesheets, count: timesheets.length };
  });

  // The signed-in user's own timesheets. Who may see them is the time clock permission and nothing about payroll.
  app.get("/organizations/:orgId/timesheets/me", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, application: false, permission: "crew.time_clock.use", capability: "crew.time_clock" });
    const query = queryObject(request);
    return { ok: true, ...(await listPayrollTimesheets(orgId, { from: query.from, through: query.through, approval_status: query.approval_status, limit: query.limit, user_id: context.userId })) };
  });

  // Pay runs waiting for the signed-in user as a named approver, and their decision. Being named is the authority.
  app.get("/organizations/:orgId/approvals/me", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, application: false, capability: "apps.payroll" });
    return { ok: true, ...(await myPayRunApprovals(context)) };
  });

  app.post("/organizations/:orgId/batches/:batchId/decision", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePlatformAuth(request, { orgId, csrf: true, application: false, capability: "apps.payroll" });
    const body = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).optional() }).strict().parse(request.body ?? {});
    return { ok: true, approval: await decideOnPayRun(context, getParam(request.params, "batchId"), body) };
  });

  // Payments made outside a pay run; the next run that pays the payee takes them off (off-cycle.ts).
  app.get("/organizations/:orgId/off-cycle-payments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollRead(request, orgId);
    const query = queryObject(request), scope = payeeScope(context, query);
    const payments = (await listOffCyclePayments(orgId, { payee_type: cleanText(query.payee_type), payee_id: cleanText(query.payee_id) })).filter((row) => scope.visible(row.payee));
    return { ok: true, payments };
  });

  app.post("/organizations/:orgId/off-cycle-payments", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const input = offCyclePaymentInputSchema.parse(request.body ?? {});
    assertPayeeManageable(payeeScope(context), input.payee);
    const payment = await recordOffCyclePayment(orgId, input, { userId: context.userId, name: cleanText(asObject(context.user).name || asObject(context.user).email) });
    reply.code(201);
    return { ok: true, payment };
  });

  app.delete("/organizations/:orgId/off-cycle-payments/:entryId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const entryId = getParam(request.params, "entryId");
    assertPayeeManageable(payeeScope(context), (await readOffCyclePayment(orgId, entryId)).payee);
    return { ok: true, payment: await removeOffCyclePayment(orgId, entryId, { userId: context.userId, name: cleanText(asObject(context.user).name || asObject(context.user).email) }) };
  });

  app.patch("/organizations/:orgId/timesheets/:shiftId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    await assertShiftManageable(context, getParam(request.params, "shiftId"));
    const timesheet = await correctPayrollTimesheet(
      orgId,
      getParam(request.params, "shiftId"),
      asObject(request.body),
      cleanText(asObject(context).userId || asObject(context).user_id)
    );
    return { ok: true, timesheet };
  });

  app.post("/organizations/:orgId/timesheets/:shiftId/approve", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    await assertShiftManageable(context, getParam(request.params, "shiftId"));
    const timesheet = await approvePayrollTimesheet(
      orgId,
      getParam(request.params, "shiftId"),
      asObject(request.body),
      cleanText(asObject(context).userId || asObject(context).user_id)
    );
    return { ok: true, timesheet };
  });

  app.post("/organizations/:orgId/timesheets/:shiftId/reject", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    await assertShiftManageable(context, getParam(request.params, "shiftId"));
    const timesheet = await rejectPayrollTimesheet(
      orgId,
      getParam(request.params, "shiftId"),
      asObject(request.body),
      cleanText(asObject(context).userId || asObject(context).user_id)
    );
    return { ok: true, timesheet };
  });

  app.get("/organizations/:orgId/earnings/payees/:payeeType/:payeeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const payee = payrollPayeeRefSchema.parse({
      type: getParam(request.params, "payeeType"),
      id: getParam(request.params, "payeeId")
    });
    const result = (await payrollEarnings(orgId, [payee], queryObject(request)));
    return { ok: true, ...result, earnings: result.earnings[0] };
  });

  app.get("/organizations/:orgId/earnings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const query = queryObject(request);
    const payees = earningsPayeesFromQuery(query);
    if (!payees.length) throw badRequest("payroll_payee_required", "Provide at least one payee or payee_id query parameter.");
    return { ok: true, ...(await payrollEarnings(orgId, payees, query)) };
  });

  app.get("/organizations/:orgId/schedules", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, schedules: (await listPayrollSchedules(orgId, truthy(queryObject(request).include_archived))) };
  });

  app.post("/organizations/:orgId/schedules", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const schedule = (await createPayrollSchedule(orgId, payrollScheduleInputSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, schedule };
  });

  app.get("/organizations/:orgId/schedules/:scheduleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, schedule: (await readPayrollSchedule(orgId, getParam(request.params, "scheduleId"))) };
  });

  app.patch("/organizations/:orgId/schedules/:scheduleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const schedule = (await patchPayrollSchedule(orgId, getParam(request.params, "scheduleId"), payrollSchedulePatchSchema.parse(request.body ?? {})));
    return { ok: true, schedule };
  });

  app.delete("/organizations/:orgId/schedules/:scheduleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const schedule = (await archivePayrollSchedule(orgId, getParam(request.params, "scheduleId"), expectedRevision(request)));
    return { ok: true, schedule };
  });

  app.get("/organizations/:orgId/ledger", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const query = queryObject(request);
    return { ok: true, entries: (await listPayrollLedgerEntries(orgId, query)) };
  });

  app.post("/organizations/:orgId/ledger", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const source = asObject(request.body);
    const inputs = Array.isArray(source.entries)
      ? payrollLedgerBatchInputSchema.parse(source).entries
      : [payrollLedgerEntryInputSchema.parse(source)];
    const entries = (await recordPayrollLedgerEntries(orgId, inputs));
    reply.code(201);
    return { ok: true, entries };
  });

  app.post("/organizations/:orgId/projections", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const entry = payrollLedgerEntryInputSchema.parse({ ...asObject(request.body), state: "projected" });
    const [projection] = (await recordPayrollLedgerEntries(orgId, [entry]));
    reply.code(201);
    return { ok: true, projection };
  });

  app.post("/organizations/:orgId/projections/:entryId/accrue", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    return { ok: true, entry: (await accruePayrollProjection(orgId, getParam(request.params, "entryId"))) };
  });

  app.get("/organizations/:orgId/ledger/:entryId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, entry: (await readPayrollLedgerEntry(orgId, getParam(request.params, "entryId"))) };
  });

  app.post("/organizations/:orgId/ledger/:entryId/reverse", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const entry = (await reversePayrollLedgerEntry(orgId, getParam(request.params, "entryId"), payrollLedgerReverseSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, entry };
  });

  app.get("/organizations/:orgId/upcoming", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollRead(request, orgId);
    const query = queryObject(request);
    return { ok: true, ...scopedUpcoming(await upcomingPayroll(orgId, query), payeeScope(context, query)) };
  });

  app.get("/organizations/:orgId/batches", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollRead(request, orgId);
    const query = queryObject(request), scope = payeeScope(context, query);
    return { ok: true, batches: (await listPayrollBatches(orgId, query)).map((batch) => scopedBatch(batch, scope)) };
  });

  app.post("/organizations/:orgId/batches", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const input = payrollBatchCreateSchema.parse(request.body ?? {});
    await assertRunCreatable(context, input.schedule_id, input.pay_date);
    const result = await createPayrollRun(context, input);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/batches/:batchId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollRead(request, orgId);
    return { ok: true, batch: scopedBatch(await readPayrollBatch(orgId, getParam(request.params, "batchId")), payeeScope(context, queryObject(request))) };
  });

  app.patch("/organizations/:orgId/batches/:batchId/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    await assertRunItemManageable(context, getParam(request.params, "batchId"), getParam(request.params, "itemId"));
    return { ok: true, ...await updatePayrollRunItem(context, getParam(request.params, "batchId"), getParam(request.params, "itemId"), payrollBatchItemPatchSchema.parse(request.body ?? {})) };
  });

  app.post("/organizations/:orgId/batches/:batchId/actions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const input = payrollBatchActionSchema.parse(request.body ?? {});
    if (!["approve", "reject"].includes(input.action)) await assertRunManageable(context, getParam(request.params, "batchId"));
    return { ok: true, ...await actOnPayrollRun(context, getParam(request.params, "batchId"), input) };
  });

  app.get("/organizations/:orgId/exports/catalog", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, exports: PAYROLL_EXPORT_CATALOG };
  });

  app.get("/organizations/:orgId/artifacts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const artifacts = (await listPayrollArtifacts(orgId, queryObject(request)));
    return { ok: true, artifacts, count: artifacts.length };
  });

  app.post("/organizations/:orgId/artifacts", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const input = payrollExportCreateSchema.parse(request.body ?? {});
    const artifact = await generatePayrollArtifact(orgId, input, cleanText(asObject(context).userId || asObject(context).user_id), payeeScope(context, input));
    reply.code(201);
    return { ok: true, artifact };
  });

  app.get("/organizations/:orgId/artifacts/:artifactId/download", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const artifact = (await readPayrollArtifact(orgId, getParam(request.params, "artifactId"), true));
    reply.header("Content-Type", cleanText(artifact.content_type) || "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${cleanText(artifact.file_name).replace(/"/g, "")}"`);
    return reply.send(artifact.content);
  });
};
