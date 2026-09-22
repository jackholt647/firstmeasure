import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { badRequest, PlatformError } from "../platform/errors.js";
import { hydratedWorkforceUser } from "../workforce/service.js";
import { registerPayrollAutomations } from "./automations.js";
import {
  commissionTriggerSchema,
  commissionOverrideSchema,
  payrollBatchActionSchema,
  payrollBatchCreateSchema,
  payrollBatchItemPatchSchema,
  payrollExportCreateSchema,
  payrollLedgerBatchInputSchema,
  payrollLedgerEntryInputSchema,
  payrollLedgerReverseSchema,
  payrollPayeeRefSchema,
  payrollPolicyInputSchema,
  payrollPolicySubjectSchema,
  payrollScheduleInputSchema,
  payrollSchedulePatchSchema,
  projectPayeeSetSchema
} from "./schemas.js";
import { generatePayrollArtifact, PAYROLL_EXPORT_CATALOG } from "./exports.js";
import { syncContractorPayrollPayables, syncPaidContractorPayrollDisbursements } from "./contractor_disbursements.js";
import { payrollEarnings } from "./earnings.js";
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
  overrideProjectCommission,
  reconcileProjectedCommissionPayees,
  recordPayrollLedgerEntries,
  reversePayrollLedgerEntry,
  triggerCommissionEvent,
  upcomingPayroll
} from "./service.js";
import {
  archivePayrollSchedule,
  asObject,
  cleanText,
  createPayrollSchedule,
  deletePayrollPolicy,
  listPayrollBatches,
  listPayrollArtifacts,
  listPayrollLedgerEntries,
  listPayrollPolicies,
  listPayrollSchedules,
  listProjectPayees,
  patchPayrollSchedule,
  readPayrollBatch,
  readPayrollArtifact,
  readPayrollLedgerEntry,
  readPayrollSchedule,
  resolvePayrollPolicy,
  savePayrollPolicy,
  saveProjectPayeeRole
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

async function reconcileProjectCommissions(orgId: string, projectId: string) {
  if (!projectId) return null;
  const { reconcileProjectScopeCommissions } = await import("../scopes/service.js");
  return await reconcileProjectScopeCommissions(orgId, projectId).catch(() => null);
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
    capabilities: ["schedule_groups", "policy_inheritance", "worked_or_completed_recognition", "delays", "projections", "commissions", "clawbacks", "batches", "individual_payment_status", "named_approvals", "off_cycle_runs", "contractor_payables", "csv_exports", "report_documents"]
  }));

  app.get("/organizations/:orgId/dashboard", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const query = queryObject(request);
    return {
      ok: true,
      ...(await upcomingPayroll(orgId, query)),
      policies: (await listPayrollPolicies(orgId)),
      history: (await listPayrollBatches(orgId, { ...query, limit: Number(query.history_limit || 100) }))
    };
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
    return { ok: true, ...result, earnings: result.earnings[0] };
  });

  app.get("/organizations/:orgId/timesheets", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, ...(await listPayrollTimesheets(orgId, queryObject(request))) };
  });

  app.patch("/organizations/:orgId/timesheets/:shiftId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
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

  app.get("/organizations/:orgId/policies", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, policies: (await listPayrollPolicies(orgId)) };
  });

  app.get("/organizations/:orgId/policies/effective/:payeeType/:payeeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const query = queryObject(request);
    const payeeType = getParam(request.params, "payeeType") === "organization_connection" ? "organization_connection" : "organization_user";
    const policy = (await resolvePayrollPolicy(orgId, {
      type: payeeType,
      id: getParam(request.params, "payeeId"),
      name: cleanText(query.name),
      worker_type: ["subcontractor", "independent_contractor"].includes(cleanText(query.worker_type))
        ? cleanText(query.worker_type) as "subcontractor" | "independent_contractor" : "employee",
      access_role_ids: cleanText(query.access_role_ids).split(",").map(cleanText).filter(Boolean),
      resource_group_ids: cleanText(query.resource_group_ids).split(",").map(cleanText).filter(Boolean)
    }, cleanText(query.earning_kind || "*")));
    return { ok: true, policy };
  });

  app.put("/organizations/:orgId/policies/:subjectType/:subjectId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const subjectType = payrollPolicySubjectSchema.parse(getParam(request.params, "subjectType"));
    const policy = (await savePayrollPolicy(orgId, subjectType, getParam(request.params, "subjectId"), payrollPolicyInputSchema.parse(request.body ?? {})));
    return { ok: true, policy };
  });

  app.delete("/organizations/:orgId/policies/:subjectType/:subjectId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const subjectType = payrollPolicySubjectSchema.parse(getParam(request.params, "subjectType"));
    const result = (await deletePayrollPolicy(orgId, subjectType, getParam(request.params, "subjectId"), cleanText(queryObject(request).earning_kind || "*")));
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/projects/:projectId/payees", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const projectId = getParam(request.params, "projectId");
    await reconcileProjectCommissions(orgId, projectId);
    return { ok: true, payee_roles: (await listProjectPayees(orgId, projectId)) };
  });

  app.put("/organizations/:orgId/projects/:projectId/payees/:roleKey", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
      const projectId = getParam(request.params, "projectId");
      const roleKey = getParam(request.params, "roleKey");
      const input = projectPayeeSetSchema.parse(request.body ?? {});
      const role = (await saveProjectPayeeRole(orgId, projectId, roleKey, {
        ...input,
        metadata: { ...asObject(input.metadata), payees_explicitly_set: true }
      }));
      (await reconcileProjectedCommissionPayees(orgId, projectId, roleKey));
      await reconcileProjectCommissions(orgId, projectId);
    return { ok: true, payee_role: (await listProjectPayees(orgId, projectId)).find((entry) => cleanText(entry.role_key) === roleKey) || role };
  });

  app.post("/organizations/:orgId/projects/:projectId/commission-events", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const result = (await triggerCommissionEvent(orgId, getParam(request.params, "projectId"), commissionTriggerSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/projects/:projectId/commission-overrides", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollMutation(request, orgId);
    const result = (await overrideProjectCommission(orgId, getParam(request.params, "projectId"), commissionOverrideSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/ledger", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    const query = queryObject(request);
    await reconcileProjectCommissions(orgId, cleanText(query.project_id));
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
    await requirePayrollRead(request, orgId);
    return { ok: true, ...(await upcomingPayroll(orgId, queryObject(request))) };
  });

  app.get("/organizations/:orgId/batches", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, batches: (await listPayrollBatches(orgId, queryObject(request))) };
  });

  app.post("/organizations/:orgId/batches", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const batch = (await createPayrollBatch(orgId, payrollBatchCreateSchema.parse(request.body ?? {}), cleanText(asObject(context).userId || asObject(context).user_id)));
    const contractorPayables = await syncContractorPayrollPayables(orgId, batch, context).catch((error) => {
      app.log.warn({ error, batch_id: batch.id }, "Could not synchronize contractor payroll payables");
      return [];
    });
    reply.code(201);
    return { ok: true, batch, contractor_payables: contractorPayables };
  });

  app.get("/organizations/:orgId/batches/:batchId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePayrollRead(request, orgId);
    return { ok: true, batch: (await readPayrollBatch(orgId, getParam(request.params, "batchId"))) };
  });

  app.patch("/organizations/:orgId/batches/:batchId/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const batch = (await patchPayrollBatchItem(orgId, getParam(request.params, "batchId"), getParam(request.params, "itemId"), payrollBatchItemPatchSchema.parse(request.body ?? {})));
    await import("../payments/reimbursements.js").then(({ syncPaidPayrollReimbursements }) => syncPaidPayrollReimbursements(orgId, batch, context));
    const contractorDisbursements = await syncPaidContractorPayrollDisbursements(orgId, batch, context).catch((error) => {
      app.log.warn({ error, batch_id: batch.id }, "Could not synchronize contractor payroll disbursements");
      return [];
    });
    return { ok: true, batch, contractor_disbursements: contractorDisbursements };
  });

  app.post("/organizations/:orgId/batches/:batchId/actions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requirePayrollMutation(request, orgId);
    const body = payrollBatchActionSchema.parse(request.body ?? {});
    const namedApprovers = body.action === "submit_approval" ? await Promise.all((body.approvers || []).map(async (entry) => {
      const user = await hydratedWorkforceUser(orgId, entry.user_id);
      return { user_id: entry.user_id, name: cleanText(user.name || user.email || entry.name || entry.user_id) };
    })) : body.approvers;
    const batch = (await applyPayrollBatchAction(orgId, getParam(request.params, "batchId"), {
      ...body,
      approvers: namedApprovers,
      actor: { user_id: cleanText(asObject(context).userId || asObject(context).user_id), name: cleanText(asObject(asObject(context).user).name || asObject(asObject(context).user).email) }
    }));
    await import("../payments/reimbursements.js").then(({ syncPaidPayrollReimbursements }) => syncPaidPayrollReimbursements(orgId, batch, context));
    const contractorDisbursements = await syncPaidContractorPayrollDisbursements(orgId, batch, context).catch((error) => {
      app.log.warn({ error, batch_id: batch.id }, "Could not synchronize contractor payroll disbursements");
      return [];
    });
    return { ok: true, batch, contractor_disbursements: contractorDisbursements };
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
    const artifact = await generatePayrollArtifact(orgId, payrollExportCreateSchema.parse(request.body ?? {}), cleanText(asObject(context).userId || asObject(context).user_id));
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
