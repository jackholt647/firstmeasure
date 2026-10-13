import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const data = response.body ? JSON.parse(response.body) : null;
    return { statusCode: response.statusCode, data, body: response.body };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payroll-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  if (app) await app.close();
  await closePlatformFixtureStores();
  const [{ closePayrollDatabase }, { closeWorkforceDatabase }, { closeWorkDatabase }] = await Promise.all([
    import("../payroll/storage.js"),
    import("../workforce/storage.js"),
    import("../work/storage.js")
  ]);
  (await closePayrollDatabase());
  (await closeWorkforceDatabase());
  (await closeWorkDatabase());
  await closeSqlStoresForTests();
  try {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error: any) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
  }
});

async function registerOwner(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(), 
    email: `payroll-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Payroll Owner",
    company: "Payroll Test Org",
    organization_id: `org_payroll_${suffix}`
  });
  await enableExpandedPlatformFixture(String(registered.organization.id));
  await enableExpandedPlatformFixture(String(registered.organization.id), { "platform.money": true, "apps.payroll": true });
  return { orgId: String(registered.organization.id), ownerUserId: String(registered.user.id) };
}

function byPayee(items: any[], payeeId: string) {
  const item = items.find((candidate) => candidate.payee.id === payeeId);
  assert.ok(item, `Expected payroll item for ${payeeId}`);
  return item;
}

test("payroll v1 resolves policies, recognizes earnings, carries clawbacks, and preserves payment history", async (t) => {
  const client = createSessionClient();
  const { orgId, ownerUserId } = await registerOwner(client);
  const base = `/v1/payroll/organizations/${orgId}`;
  const employeeId = "employee_alex";
  const completedEmployeeId = "employee_completion_basis";
  const inheritedEmployeeId = "employee_foreman_default";
  const automationEmployeeId = "employee_scope_automation";
  const contractorId = "connection_roofing_partner";
  const finalizeBatch = async (batchId: string) => {
    let result = await client.request("POST", `${base}/batches/${batchId}/actions`, {
      action: "submit_approval", approvers: [{ user_id: ownerUserId, name: "Payroll Owner" }]
    });
    assert.equal(result.batch.approval.status, "pending");
    result = await client.request("POST", `${base}/batches/${batchId}/actions`, { action: "approve", note: "Amounts reviewed" });
    assert.equal(result.batch.approval.status, "approved");
    result = await client.request("POST", `${base}/batches/${batchId}/actions`, { action: "finalize" });
    assert.equal(result.batch.approval.status, "finalized");
    assert.equal(result.batch.approval.finalized_by.user_id, ownerUserId);
    return result.batch;
  };

  const delayedWeekly = (await client.request("POST", `${base}/schedules`, {
    id: "weekly_friday_delayed",
    name: "Weekly Friday - one week behind",
    timezone: "America/Los_Angeles",
    recurrence: { frequency: "weekly", weekday: 5 },
    delay: { periods: 1 },
    timing_basis: "worked",
    clawback_cap_percent: 50
  })).schedule;
  const commissionSchedule = (await client.request("POST", `${base}/schedules`, {
    id: "commission_first_and_fifteenth",
    name: "Commission 1st and 15th",
    timezone: "America/Los_Angeles",
    recurrence: { frequency: "semi_monthly", days: [15, 31] },
    delay: { periods: 0 },
    timing_basis: "completed",
    clawback_cap_percent: 50
  })).schedule;

  await t.test("schedule and policy inheritance includes earning-kind overrides", async () => {
    await client.request("PUT", `${base}/policies/organization/${orgId}`, {
      schedule_id: delayedWeekly.id,
      earning_kind: "*"
    });
    await client.request("PUT", `${base}/policies/access_role/crew_foreman`, {
      schedule_id: commissionSchedule.id,
      earning_kind: "commission",
      timing_basis: "completed"
    });
    await client.request("PUT", `${base}/policies/organization_user/${employeeId}`, {
      schedule_id: delayedWeekly.id,
      earning_kind: "*",
      clawback_cap_percent: 50
    });
    await client.request("PUT", `${base}/policies/organization_user/${employeeId}`, {
      schedule_id: commissionSchedule.id,
      earning_kind: "commission",
      timing_basis: "completed"
    });
    await client.request("PUT", `${base}/policies/organization_user/${completedEmployeeId}`, {
      schedule_id: delayedWeekly.id,
      earning_kind: "hourly",
      timing_basis: "completed"
    });
    await client.request("PUT", `${base}/policies/worker_type/subcontractor`, {
      schedule_id: delayedWeekly.id,
      earning_kind: "*",
      clawback_cap_percent: 50
    });
    await client.request("PUT", `${base}/policies/worker_type/subcontractor`, {
      schedule_id: commissionSchedule.id,
      earning_kind: "commission",
      timing_basis: "completed"
    });

    const directBase = await client.request("GET", `${base}/policies/effective/organization_user/${employeeId}?earning_kind=hourly&access_role_ids=crew_foreman`);
    assert.equal(directBase.policy.subject_type, "organization_user");
    assert.equal(directBase.policy.earning_kind, "*");
    assert.equal(directBase.policy.schedule_id, delayedWeekly.id);

    const directCommission = await client.request("GET", `${base}/policies/effective/organization_user/${employeeId}?earning_kind=commission&access_role_ids=crew_foreman`);
    assert.equal(directCommission.policy.subject_type, "organization_user");
    assert.equal(directCommission.policy.earning_kind, "commission");
    assert.equal(directCommission.policy.schedule_id, commissionSchedule.id);

    const inheritedCommission = await client.request("GET", `${base}/policies/effective/organization_user/${inheritedEmployeeId}?earning_kind=commission&access_role_ids=crew_foreman`);
    assert.equal(inheritedCommission.policy.subject_type, "access_role");
    assert.equal(inheritedCommission.policy.schedule_id, commissionSchedule.id);

    const inheritedBase = await client.request("GET", `${base}/policies/effective/organization_user/${inheritedEmployeeId}?earning_kind=hourly&access_role_ids=crew_foreman`);
    assert.equal(inheritedBase.policy.subject_type, "organization");
    assert.equal(inheritedBase.policy.schedule_id, delayedWeekly.id);
  });

  await t.test("worked versus completed recognition and delayed timezone cutoffs select different occurrences", async () => {
    const workedAt = "2026-07-11T06:30:00.000Z"; // Friday 11:30 PM in Los Angeles.
    const completedAt = "2026-07-14T12:00:00.000Z";
    const recorded = await client.request("POST", `${base}/ledger`, {
      entries: [
        {
          payee: { type: "organization_user", id: employeeId, name: "Alex Employee" },
          kind: "hourly",
          amount_cents: 12000,
          worked_at: workedAt,
          completed_at: completedAt,
          source_event_id: "shift_alex_july_10",
          source_trigger_id: "crew.clock_out"
        },
        {
          payee: { type: "organization_user", id: completedEmployeeId, name: "Completion Basis Employee" },
          kind: "hourly",
          amount_cents: 8000,
          worked_at: workedAt,
          completed_at: completedAt,
          source_event_id: "shift_completion_employee_july_10",
          source_trigger_id: "crew.clock_out"
        }
      ]
    });
    assert.equal(recorded.entries[0].eligible_at, workedAt);
    assert.equal(recorded.entries[0].metadata.recognition_basis, "worked");
    assert.equal(recorded.entries[1].eligible_at, completedAt);
    assert.equal(recorded.entries[1].metadata.recognition_basis, "completed");

    const upcoming = await client.request("GET", `${base}/upcoming?from=2026-07-17&through=2026-07-24&include_projected=0`);
    const july17 = upcoming.upcoming.find((entry: any) => entry.schedule_id === delayedWeekly.id && entry.pay_date === "2026-07-17");
    const july24 = upcoming.upcoming.find((entry: any) => entry.schedule_id === delayedWeekly.id && entry.pay_date === "2026-07-24");
    assert.ok(july17);
    assert.ok(july24);
    assert.equal(july17.cutoff_at, "2026-07-11T06:59:59.999Z");
    assert.equal(july17.employees.length, 1);
    assert.equal(july17.employees[0].payee.id, employeeId);
    assert.equal(july17.accrued_total_cents, 12000);
    assert.deepEqual(july24.employees.map((item: any) => item.payee.id).sort(), [completedEmployeeId]);
    assert.equal(july24.accrued_total_cents, 8000);
  });

  let employeeCommissionEntryId = "";
  let contractorCommissionEntryId = "";
  await t.test("projected earnings accrue idempotently and a reversal becomes a clawback", async () => {
    const commission = (payee: Record<string, unknown>, amount_cents: number) => ({
      payee, kind: "commission", amount_cents, project_id: "project_commission", project_title: "Commission Test Project",
      worked_at: "2026-07-10T18:00:00.000Z", completed_at: "2026-07-10T18:00:00.000Z",
      source_event_id: "proposal_project_commission_paid", source_trigger_id: "proposal_payment_commission"
    });
    const employeeProjection = (await client.request("POST", `${base}/projections`, commission({ type: "organization_user", id: employeeId, name: "Alex Employee", worker_type: "employee" }, 5001))).projection;
    const contractorProjection = (await client.request("POST", `${base}/projections`, commission({ type: "organization_connection", id: contractorId, name: "Roofing Partner", worker_type: "subcontractor" }, 5000))).projection;
    assert.equal(employeeProjection.state, "projected");
    const sourceEntries = await client.request("GET", `${base}/ledger?source_event_id=proposal_project_commission_paid`);
    assert.equal(sourceEntries.entries.length, 2);
    employeeCommissionEntryId = employeeProjection.id;
    contractorCommissionEntryId = contractorProjection.id;
    const employeeAccrued = await client.request("POST", `${base}/projections/${employeeCommissionEntryId}/accrue`, {});
    const contractorAccrued = await client.request("POST", `${base}/projections/${contractorCommissionEntryId}/accrue`, {});
    assert.equal(employeeAccrued.entry.state, "accrued");
    assert.equal(contractorAccrued.entry.state, "accrued");
    const accrueRetry = await client.request("POST", `${base}/projections/${employeeCommissionEntryId}/accrue`, {});
    assert.equal(accrueRetry.entry.id, employeeCommissionEntryId);
    assert.equal(accrueRetry.entry.state, "accrued");

    const reversal = { source_event_id: "project_commission_cancelled", occurred_at: "2026-07-11T18:00:00.000Z", description: "Cancelled project commission clawback" };
    const reversed = [
      (await client.request("POST", `${base}/ledger/${employeeCommissionEntryId}/reverse`, reversal)).entry,
      (await client.request("POST", `${base}/ledger/${contractorCommissionEntryId}/reverse`, reversal)).entry
    ];
    assert.deepEqual(reversed.map((entry: any) => entry.amount_cents), [-5001, -5000]);
    assert.ok(reversed.every((entry: any) => entry.kind === "clawback" && entry.state === "accrued"));
    const retry = (await client.request("POST", `${base}/ledger/${employeeCommissionEntryId}/reverse`, reversal)).entry;
    assert.equal(retry.id, reversed[0].id);
    const clawbacks = await client.request("GET", `${base}/ledger?project_id=project_commission&kind=clawback`);
    assert.equal(clawbacks.entries.length, 2);
  });

  let firstBatchId = "";
  await t.test("batch separates employees and subcontractors and caps clawbacks", async () => {
    await client.request("POST", `${base}/ledger`, {
      entries: [
        {
          payee: { type: "organization_user", id: employeeId, name: "Alex Employee", worker_type: "employee" },
          schedule_id: commissionSchedule.id,
          kind: "salary",
          amount_cents: 2999,
          worked_at: "2026-07-10T18:00:00.000Z",
          source_event_id: "salary_alex_july_15",
          source_trigger_id: "salary.period"
        },
        {
          payee: { type: "organization_connection", id: contractorId, name: "Roofing Partner", worker_type: "subcontractor" },
          schedule_id: commissionSchedule.id,
          kind: "piece_rate",
          amount_cents: 4000,
          completed_at: "2026-07-10T18:00:00.000Z",
          source_event_id: "piece_partner_july_15",
          source_trigger_id: "project.completed"
        }
      ]
    });
    const created = await client.request("POST", `${base}/batches`, {
      schedule_id: commissionSchedule.id,
      pay_date: "2026-07-15"
    });
    const batch = created.batch;
    firstBatchId = batch.id;
    assert.equal(batch.items.length, 2);
    const employee = byPayee(batch.items, employeeId);
    const contractor = byPayee(batch.items, contractorId);
    assert.equal(employee.payee.worker_type, "employee");
    assert.equal(contractor.payee.worker_type, "subcontractor");
    assert.equal(batch.employee_total_cents, employee.net_cents);
    assert.equal(batch.subcontractor_total_cents, contractor.net_cents);
    assert.equal(batch.total_cents, employee.net_cents + contractor.net_cents);
    assert.equal(created.contractor_payables.length, 1);
    assert.equal(created.contractor_payables[0].payee_ref.id, contractorId);
    assert.equal(created.contractor_payables[0].amount_cents, contractor.net_cents);

    assert.equal(employee.gross_cents, 8000);
    assert.equal(employee.deduction_cents, 4000);
    assert.equal(employee.net_cents, 4000);
    assert.equal(contractor.gross_cents, 9000);
    assert.equal(contractor.deduction_cents, 4500);
    assert.equal(contractor.net_cents, 4500);

    const employeeCommission = await client.request("GET", `${base}/ledger/${employeeCommissionEntryId}`);
    const contractorCommission = await client.request("GET", `${base}/ledger/${contractorCommissionEntryId}`);
    assert.equal(employeeCommission.entry.remaining_cents, 0);
    assert.equal(contractorCommission.entry.remaining_cents, 0);
    const remainingClawbacks = await client.request("GET", `${base}/ledger?kind=clawback&open_only=1`);
    const employeeClawback = remainingClawbacks.entries.find((entry: any) => entry.payee.id === employeeId);
    const contractorClawback = remainingClawbacks.entries.find((entry: any) => entry.payee.id === contractorId);
    assert.equal(employeeClawback.remaining_cents, -1001);
    assert.equal(contractorClawback.remaining_cents, -500);
  });

  await t.test("individual paid status, mark-all, carry-forward, and prior-batch history remain visible", async () => {
    let batch = (await client.request("GET", `${base}/batches/${firstBatchId}`)).batch;
    const premature = await client.raw("POST", `${base}/batches/${firstBatchId}/actions`, { action: "paid" });
    assert.equal(premature.statusCode, 400);
    assert.equal(premature.data.error, "payroll_batch_not_finalized");
    batch = await finalizeBatch(firstBatchId);
    const employeeItem = byPayee(batch.items, employeeId);
    batch = (await client.request("PATCH", `${base}/batches/${firstBatchId}/items/${employeeItem.id}`, {
      status: "paid",
      payment_reference: "check-employee-0715"
    })).batch;
    assert.equal(batch.status, "partial");
    assert.equal(byPayee(batch.items, employeeId).status, "paid");
    assert.equal(byPayee(batch.items, contractorId).status, "draft");

    batch = (await client.request("POST", `${base}/batches/${firstBatchId}/actions`, {
      action: "paid",
      payment_reference: "batch-0715"
    })).batch;
    assert.equal(batch.status, "paid");
    assert.ok(batch.paid_at);
    assert.ok(batch.items.every((item: any) => item.status === "paid" && item.paid_at));
    assert.equal(byPayee(batch.items, employeeId).payment_reference, "check-employee-0715");
    assert.equal(byPayee(batch.items, contractorId).payment_reference, "batch-0715");
    const contractorPayables = await client.request("GET", `/v1/payments/organizations/${orgId}/payables`);
    const paidContractorPayable = contractorPayables.payables.find((entry: any) => entry.metadata?.payroll_batch_id === firstBatchId);
    assert.equal(paidContractorPayable.status, "paid");

    await client.request("POST", `${base}/ledger`, {
      entries: [
        {
          payee: { type: "organization_user", id: employeeId, name: "Alex Employee", worker_type: "employee" },
          schedule_id: commissionSchedule.id,
          kind: "salary",
          amount_cents: 3000,
          worked_at: "2026-07-20T18:00:00.000Z",
          source_event_id: "salary_alex_july_31",
          source_trigger_id: "salary.period"
        },
        {
          payee: { type: "organization_connection", id: contractorId, name: "Roofing Partner", worker_type: "subcontractor" },
          schedule_id: commissionSchedule.id,
          kind: "piece_rate",
          amount_cents: 2000,
          completed_at: "2026-07-20T18:00:00.000Z",
          source_event_id: "piece_partner_july_31",
          source_trigger_id: "project.completed"
        }
      ]
    });
    const second = (await client.request("POST", `${base}/batches`, {
      schedule_id: commissionSchedule.id,
      pay_date: "2026-07-31"
    })).batch;
    const secondEmployee = byPayee(second.items, employeeId);
    const secondContractor = byPayee(second.items, contractorId);
    assert.equal(secondEmployee.gross_cents, 3000);
    assert.equal(secondEmployee.deduction_cents, 1001);
    assert.equal(secondEmployee.net_cents, 1999);
    assert.equal(secondContractor.gross_cents, 2000);
    assert.equal(secondContractor.deduction_cents, 500);
    assert.equal(secondContractor.net_cents, 1500);

    await finalizeBatch(second.id);

    const secondPaid = await client.request("POST", `${base}/batches/${second.id}/actions`, {
      action: "paid",
      payment_reference: "batch-0731"
    });
    assert.equal(secondPaid.batch.status, "paid");
    const history = await client.request("GET", `${base}/batches?schedule_id=${commissionSchedule.id}&status=paid`);
    assert.equal(history.batches.length, 2);
    assert.deepEqual(history.batches.map((entry: any) => entry.pay_date), ["2026-07-31", "2026-07-15"]);
    assert.ok(history.batches.every((entry: any) => entry.items.every((item: any) => item.status === "paid")));

    const employeeEarnings = await client.request("GET", `${base}/earnings/payees/organization_user/${employeeId}`);
    assert.equal(employeeEarnings.earnings.subject.id, employeeId);
    assert.equal(employeeEarnings.earnings.payments.length, 2);
    assert.equal(employeeEarnings.earnings.totals.paid_cents, 5999);
    assert.equal(employeeEarnings.earnings.totals.owed_cents, 12_000);
    assert.ok(employeeEarnings.earnings.projects.some((project: any) => project.project_id === "project_commission"));
    assert.ok(employeeEarnings.earnings.payments.every((payment: any) => payment.status === "paid"));

    const openClawbacks = await client.request("GET", `${base}/ledger?kind=clawback&open_only=1`);
    assert.equal(openClawbacks.entries.length, 0);
    const dashboard = await client.request("GET", `${base}/dashboard?from=2026-07-01&through=2026-08-01`);
    assert.equal(dashboard.history.length, 2);
    assert.ok(dashboard.history.every((entry: any) => entry.status === "paid"));

    const catalog = await client.request("GET", `${base}/exports/catalog`);
    assert.ok(catalog.exports.some((entry: any) => entry.type === "provider_handoff"));
    assert.ok(catalog.exports.some((entry: any) => entry.type === "contractor_payments"));
    assert.ok(catalog.exports.every((entry: any) => entry.formats.includes("pdf")));
    assert.ok(catalog.exports.every((entry: any) => entry.label && entry.description && entry.purpose && !entry.scope_label.includes("_")));
    const csvArtifact = await client.request("POST", `${base}/artifacts`, { type: "provider_handoff", format: "csv", batch_id: second.id });
    assert.equal(csvArtifact.artifact.report_type, "provider_handoff");
    assert.equal(csvArtifact.artifact.content_type, "text/csv; charset=utf-8");
    assert.match(csvArtifact.artifact.file_name, /^Payroll provider file - /);
    assert.match(csvArtifact.artifact.metadata.coverage_label, /pay date Jul 31, 2026/);
    const duplicate = await client.request("POST", `${base}/artifacts`, { type: "provider_handoff", format: "csv", batch_id: second.id });
    assert.equal(duplicate.artifact.id, csvArtifact.artifact.id);
    assert.equal(duplicate.artifact.reused, true);
    for (const report of catalog.exports) {
      const payload = report.scope === "date_range"
        ? { type: report.type, format: "pdf", from: "2026-07-01", through: "2026-07-31" }
        : { type: report.type, format: "pdf", batch_id: second.id };
      const pdfArtifact = await client.request("POST", `${base}/artifacts`, payload);
      assert.equal(pdfArtifact.artifact.content_type, "application/pdf");
      assert.equal(pdfArtifact.artifact.metadata.report_label, report.label);
    }
    const { listDocuments } = await import("../platform/storage.js");
    const generatedDocuments = (await listDocuments(orgId, "documents"))
      .map((document: any) => document.data)
      .filter((document: any) => document.metadata?.source_system === "payroll");
    assert.equal(generatedDocuments.length, catalog.exports.length);
    assert.ok(generatedDocuments.every((document: any) => document.template_ref?.template_id === "tpl_payroll_report_default"));
    const artifacts = await client.request("GET", `${base}/artifacts?batch_id=${second.id}`);
    assert.equal(artifacts.artifacts.length, 6);
  });

  await t.test("off-cycle runs accept explicit periods and preserve their reason", async () => {
    await client.request("POST", `${base}/ledger`, { entries: [{
      payee: { type: "organization_user", id: employeeId, name: "Alex Employee", worker_type: "employee" },
      schedule_id: commissionSchedule.id, kind: "salary", amount_cents: 1234, worked_at: "2026-08-02T18:00:00.000Z",
      source_event_id: "salary_alex_offcycle", source_trigger_id: "salary.correction"
    }, {
      payee: { type: "organization_user", id: "contractor_casey", name: "Casey Contractor", worker_type: "independent_contractor" },
      schedule_id: commissionSchedule.id, kind: "piece_rate", amount_cents: 500, completed_at: "2026-08-02T19:00:00.000Z",
      source_event_id: "piece_casey_offcycle", source_trigger_id: "project.completed"
    }] });
    const created = await client.request("POST", `${base}/batches`, {
      schedule_id: commissionSchedule.id, pay_date: "2026-08-03", run_type: "off_cycle",
      period_start: "2026-08-02", period_end: "2026-08-02", reason: "Correction"
    });
    assert.equal(created.batch.run_type, "off_cycle");
    assert.equal(created.batch.metadata.reason, "Correction");
    assert.equal(created.batch.approval.status, "draft");
    assert.equal(byPayee(created.batch.items, employeeId).gross_cents, 1234);
    assert.equal(byPayee(created.batch.items, "contractor_casey").payee.worker_type, "independent_contractor");
    await finalizeBatch(created.batch.id);
    await client.request("POST", `${base}/ledger`, { entries: [{
      payee: { type: "organization_user", id: employeeId, name: "Alex Employee", worker_type: "employee" },
      schedule_id: commissionSchedule.id, kind: "salary", amount_cents: 766, worked_at: "2026-08-02T20:00:00.000Z",
      source_event_id: "salary_alex_offcycle_late", source_trigger_id: "salary.correction"
    }] });
    const reopened = await client.request("POST", `${base}/batches/${created.batch.id}/actions`, { action: "reopen", note: "Late correction" });
    assert.equal(reopened.batch.approval.status, "draft");
    assert.equal(byPayee(reopened.batch.items, employeeId).gross_cents, 2000);
    assert.equal(byPayee(reopened.batch.items, "contractor_casey").gross_cents, 500);
  });
});
