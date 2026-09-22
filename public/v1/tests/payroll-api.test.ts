import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { compileScopeCommissionBindings, evaluateScopeCommissionRule } from "../payroll/commission_rules.js";

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

test("scope commission rules support presets, line-item context, and trusted custom code", () => {
  const context = {
    proposal: {
      content: {
        pricing: { total_cents: 900_00 },
        scope: {
          root_items: [
            { id: "roof", name: "Roof", category: "labor", unit_price: { amount_cents: 80_000 } },
            { id: "permit", name: "Permit", category: "fees", unit_price: { amount_cents: 20_000 } },
            { id: "promo", name: "Promotion", type: "discount", unit_price: { amount_cents: 10_000 } }
          ]
        }
      }
    },
    money: { total_collected_cents: 45_000, forecast_profit_cents: 30_000 },
    project: { id: "project_rule_test" },
    scope_template: { id: "roofing" }
  } as any;
  const preset = evaluateScopeCommissionRule({
    id: "discount-tier",
    payee_role: "estimators",
    allocation: "split_evenly",
    calculation: {
      mode: "preset",
      preset: "discount_tiered",
      basis: "proposal_subtotal",
      subtract_discounts: true,
      tiers: [
        { min_discount_bps: 0, max_discount_bps: 999, rate_bps: 1000 },
        { min_discount_bps: 1000, rate_bps: 500 }
      ]
    }
  }, context);
  assert.equal(preset.length, 1);
  assert.equal(preset[0]!.amount_cents, 4_500);
  assert.equal(preset[0]!.basis_cents, 90_000);
  assert.equal(preset[0]!.rate_bps, 500);

  const contractPercentage = evaluateScopeCommissionRule({
    id: "contract-total",
    payee_role: "estimators",
    calculation: { mode: "preset", preset: "percentage", basis: "proposal_total", rate_bps: 1_000 }
  }, context);
  assert.equal(contractPercentage[0]!.amount_cents, 9_000);

  const selectedItems = evaluateScopeCommissionRule({
    id: "labor-only",
    payee_role: "sales_team",
    calculation: {
      mode: "preset",
      preset: "selected_line_items",
      basis: "selected_line_items",
      rate_bps: 1_250,
      selector: { categories: ["labor"] }
    }
  }, context);
  assert.equal(selectedItems.length, 1);
  assert.equal(selectedItems[0]!.amount_cents, 10_000);

  const custom = evaluateScopeCommissionRule({
    id: "internal-code",
    calculation: {
      mode: "code",
      code: "(context) => ({ amount_cents: Math.round(context.facts.forecast_profit_cents * 0.2), payee_role: 'closers', allocation: 'each' })"
    }
  }, context);
  assert.equal(custom.length, 1);
  assert.equal(custom[0]!.amount_cents, 6_000);
  assert.equal(custom[0]!.payee_role, "closers");
  assert.equal(custom[0]!.allocation, "each");

  const bindings = compileScopeCommissionBindings({
    commissions: {
      enabled: true,
      rules: [
        { id: "plan-rule", enabled: true, trigger: { hook: "onStarted" }, calculation: { mode: "preset" } },
        { id: "node-rule", enabled: true, trigger: { hook: "onCompleted", node_id: "install" }, calculation: { mode: "code", code: "() => 100" } }
      ]
    }
  });
  assert.equal(bindings.plan.onStarted?.[0]?.automation, "payroll.commission.rule.v1");
  assert.equal(bindings.nodes.install?.onCompleted?.[0]?.input && (bindings.nodes.install.onCompleted[0]!.input as any).rule.id, "node-rule");
});

test("payroll v1 resolves policies, recognizes earnings, posts commissions, carries clawbacks, and preserves payment history", async (t) => {
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
  await t.test("project payees split commission cents and projected accrual is retry-idempotent", async () => {
    const payeeRole = await client.request("PUT", `${base}/projects/project_commission/payees/estimators`, {
      label: "Estimators",
      payees: [
        { type: "organization_user", id: employeeId, name: "Alex Employee", worker_type: "employee" },
        { type: "organization_connection", id: contractorId, name: "Roofing Partner", worker_type: "subcontractor" }
      ]
    });
    assert.equal(payeeRole.payee_role.revision, 1);

    const commissionInput = {
      source_event_id: "proposal_project_commission_paid",
      trigger_id: "proposal_payment_commission",
      state: "projected",
      payee_role: "estimators",
      amount_cents: 10001,
      allocation: "split_evenly",
      occurred_at: "2026-07-10T18:00:00.000Z",
      completed_at: "2026-07-10T18:00:00.000Z",
      project_title: "Commission Test Project"
    };
    const projected = await client.request("POST", `${base}/projects/project_commission/commission-events`, commissionInput);
    assert.equal(projected.entries.length, 2);
    assert.deepEqual(projected.entries.map((entry: any) => entry.amount_cents).sort((a: number, b: number) => a - b), [5000, 5001]);
    const retried = await client.request("POST", `${base}/projects/project_commission/commission-events`, commissionInput);
    assert.deepEqual(retried.entries.map((entry: any) => entry.id).sort(), projected.entries.map((entry: any) => entry.id).sort());
    const sourceEntries = await client.request("GET", `${base}/ledger?source_event_id=${commissionInput.source_event_id}`);
    assert.equal(sourceEntries.entries.length, 2);

    const employeeProjection = projected.entries.find((entry: any) => entry.payee.id === employeeId);
    const contractorProjection = projected.entries.find((entry: any) => entry.payee.id === contractorId);
    employeeCommissionEntryId = employeeProjection.id;
    contractorCommissionEntryId = contractorProjection.id;
    const employeeAccrued = await client.request("POST", `${base}/projections/${employeeCommissionEntryId}/accrue`, {});
    const contractorAccrued = await client.request("POST", `${base}/projections/${contractorCommissionEntryId}/accrue`, {});
    assert.equal(employeeAccrued.entry.state, "accrued");
    assert.equal(contractorAccrued.entry.state, "accrued");
    const accrueRetry = await client.request("POST", `${base}/projections/${employeeCommissionEntryId}/accrue`, {});
    assert.equal(accrueRetry.entry.id, employeeCommissionEntryId);
    assert.equal(accrueRetry.entry.state, "accrued");
  });

  await t.test("removing and restoring a project payee reconciles projected commissions", async () => {
    const projectId = "project_commission_payee_reconciliation";
    const sourceEventId = "project_commission_payee_reconciliation_created";
    const employee = { type: "organization_user", id: employeeId, name: "Alex Employee", worker_type: "employee" };
    const contractor = { type: "organization_connection", id: contractorId, name: "Roofing Partner", worker_type: "subcontractor" };
    await client.request("PUT", `${base}/projects/${projectId}/payees/estimators`, {
      label: "Estimators",
      payees: [employee, contractor]
    });
    await client.request("POST", `${base}/projects/${projectId}/commission-events`, {
      source_event_id: sourceEventId,
      trigger_id: "estimator_projection",
      state: "projected",
      payee_role: "estimators",
      amount_cents: 10001,
      allocation: "split_evenly",
      project_title: "Payee Reconciliation Project"
    });

    await client.request("PUT", `${base}/projects/${projectId}/payees/estimators`, {
      label: "Estimators",
      payees: [employee],
      expected_revision: 1
    });
    const removed = await client.request("GET", `${base}/ledger?source_event_id=${sourceEventId}`);
    const activeAfterRemoval = removed.entries.filter((entry: any) => entry.state === "projected");
    const voidAfterRemoval = removed.entries.filter((entry: any) => entry.state === "void");
    assert.equal(activeAfterRemoval.length, 1);
    assert.equal(activeAfterRemoval[0].payee.id, employeeId);
    assert.equal(activeAfterRemoval[0].amount_cents, 10001);
    assert.equal(voidAfterRemoval.length, 1);
    assert.equal(voidAfterRemoval[0].payee.id, contractorId);
    assert.equal(voidAfterRemoval[0].metadata.commission_payee_removed, true);

    await client.request("PUT", `${base}/projects/${projectId}/payees/estimators`, {
      label: "Estimators",
      payees: [employee, contractor],
      expected_revision: 2
    });
    const restored = await client.request("GET", `${base}/ledger?source_event_id=${sourceEventId}`);
    assert.equal(restored.entries.filter((entry: any) => entry.state === "projected").length, 2);
    assert.deepEqual(restored.entries.map((entry: any) => entry.amount_cents).sort((a: number, b: number) => a - b), [5000, 5001]);
  });

  await t.test("scope work automations can assign project payees and accrue commission idempotently", async () => {
    const projectId = "project_scope_commission_automation";
    await client.request("PUT", `${base}/policies/organization_user/${automationEmployeeId}`, {
      schedule_id: delayedWeekly.id,
      earning_kind: "commission"
    });
    const definition = {
      id: "plan_scope_commission_automation",
      branch_id: "default",
      source_type: "scope_template",
      source_id: "scope_commission_test",
      source_key: "scope-commission-automation-source",
      title: "Scope commission automation",
      start_immediately: true,
      root_nodes: [{
        id: "commission_trigger",
        title: "Accrue signed commission",
        actionable: true,
        automation_bindings: {
          onReady: [
            {
              id: "assign-automation-estimator",
              automation: "payroll.projectPayees.set.v1",
              input: {
                role_key: "automation_estimators",
                label: "Automation Estimators",
                payees: [{ type: "organization_user", id: automationEmployeeId, name: "Scope Automation Employee", worker_type: "employee" }]
              }
            },
            {
              id: "accrue-automation-estimator-commission",
              automation: "payroll.commission.post.v1",
              input: {
                rule_id: "scope_signed_commission",
                entry_state: "accrued",
                payee_role: "automation_estimators",
                amount: { kind: "fixed", amount_cents: 101 },
                allocation: "each",
                reason: "Scope trigger commission"
              }
            }
          ]
        }
      }]
    };
    const created = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, definition);
    assert.equal(created.created, true);
    const payees = await client.request("GET", `${base}/projects/${projectId}/payees`);
    assert.equal(payees.payee_roles.length, 1);
    assert.equal(payees.payee_roles[0].role_key, "automation_estimators");
    assert.equal(payees.payee_roles[0].payees[0].id, automationEmployeeId);
    const automatedLedger = await client.request("GET", `${base}/ledger?project_id=${projectId}&kind=commission`);
    assert.equal(automatedLedger.entries.length, 1);
    assert.equal(automatedLedger.entries[0].amount_cents, 101);
    assert.equal(automatedLedger.entries[0].state, "accrued");
    assert.equal(automatedLedger.entries[0].metadata.work_plan_id, created.plan.id);

    const retry = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, definition);
    assert.equal(retry.created, false);
    const retryLedger = await client.request("GET", `${base}/ledger?project_id=${projectId}&kind=commission`);
    assert.equal(retryLedger.entries.length, 1);
    assert.equal(retryLedger.entries[0].id, automatedLedger.entries[0].id);
  });

  await t.test("roof commission schedule projects all installments and accrues them at deposit and completion", async () => {
    const projectId = "project_roof_commission_schedule";
    const payee = { type: "organization_user", id: automationEmployeeId, name: "Scope Automation Employee", worker_type: "employee" };
    await client.request("PUT", `${base}/projects/${projectId}/payees/estimator`, { label: "Estimator", payees: [payee] });
    await client.request("PUT", `${base}/projects/${projectId}/payees/inside_salesperson`, { label: "Inside Salesperson", payees: [payee] });
    const commissions = {
      enabled: true,
      rules: [
        {
          id: "roof_estimator_standard", title: "Estimator — 10% of project revenue", payee_role: "estimator", entry_state: "projected", allocation: "split_evenly",
          trigger: { hook: "onStarted" },
          installments: [
            { id: "deposit", title: "First half when deposit is paid", share_bps: 5000, recognition: { node_id: "deposit_paid", hook: "onCompleted" } },
            { id: "completion", title: "Second half when job is completed", share_bps: 5000, recognition: { node_id: "finish_project", hook: "onCompleted" } }
          ],
          calculation: { mode: "preset", preset: "percentage", basis: "proposal_total", rate_bps: 1000 }
        },
        {
          id: "roof_inside_sales_standard", title: "Inside Salesperson — $100 booking commission", payee_role: "inside_salesperson", entry_state: "projected", allocation: "each",
          trigger: { hook: "onStarted" },
          installments: [{ id: "deposit", title: "Paid when deposit is paid", share_bps: 10000, recognition: { node_id: "deposit_paid", hook: "onCompleted" } }],
          calculation: { mode: "preset", preset: "fixed", fixed_amount_cents: 10000 }
        }
      ]
    };
    const bindings = compileScopeCommissionBindings({ commissions });
    const created = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
      id: "plan_roof_commission_schedule",
      branch_id: "default",
      source_type: "scope_template",
      source_id: "roof_replacement",
      source_key: "roof-commission-schedule-test",
      template_id: "roof_replacement",
      template_version: 17,
      title: "Roof Replacement",
      start_immediately: true,
      automation_bindings: bindings.plan,
      context: { proposal: { content: { pricing: { total_cents: 100000 } } } },
      root_nodes: [
        { id: "deposit_paid", title: "Collect deposit", actionable: true, automation_bindings: bindings.nodes.deposit_paid },
        { id: "finish_project", title: "Finish project", actionable: true, automation_bindings: bindings.nodes.finish_project }
      ]
    });
    const initial = await client.request("GET", `${base}/ledger?project_id=${projectId}&kind=commission`);
    assert.equal(initial.entries.length, 3);
    assert.deepEqual(initial.entries.map((entry: any) => entry.amount_cents).sort((a: number, b: number) => a - b), [5000, 5000, 10000]);
    assert.ok(initial.entries.every((entry: any) => entry.state === "projected"));
    const depositNode = created.tree.root_nodes.find((node: any) => node.template_node_id === "deposit_paid");
    const finishNode = created.tree.root_nodes.find((node: any) => node.template_node_id === "finish_project");
    await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${depositNode.id}/transition`, { status: "completed" });
    const afterDeposit = await client.request("GET", `${base}/ledger?project_id=${projectId}&kind=commission`);
    assert.equal(afterDeposit.entries.filter((entry: any) => entry.state === "accrued").length, 2);
    assert.equal(afterDeposit.entries.find((entry: any) => entry.metadata.commission_installment_id === "completion").state, "projected");
    await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${finishNode.id}/transition`, { status: "completed" });
    const completed = await client.request("GET", `${base}/ledger?project_id=${projectId}&kind=commission`);
    assert.ok(completed.entries.every((entry: any) => entry.state === "accrued"));
  });

  await t.test("project commission overrides update projections and append accrued adjustments", async () => {
    const projectId = "project_commission_override";
    await client.request("PUT", `${base}/projects/${projectId}/payees/estimators`, {
      label: "Estimators",
      payees: [{ type: "organization_user", id: automationEmployeeId, name: "Scope Automation Employee", worker_type: "employee" }]
    });
    const created = await client.request("POST", `${base}/projects/${projectId}/commission-events`, {
      source_event_id: "override_projection_created",
      trigger_id: "override_test",
      state: "projected",
      payee_role: "estimators",
      amount_cents: 1_000,
      allocation: "each",
      occurred_at: "2030-01-10T18:00:00.000Z",
      completed_at: "2030-01-10T18:00:00.000Z"
    });
    const entryId = created.entries[0].id;
    const projectionOverride = await client.request("POST", `${base}/projects/${projectId}/commission-overrides`, {
      entry_id: entryId,
      target_amount_cents: 1_200,
      reason: "Customer-specific exception",
      source_event_id: "override_projection_1200"
    });
    assert.equal(projectionOverride.entry.id, entryId);
    assert.equal(projectionOverride.entry.amount_cents, 1_200);
    assert.equal(projectionOverride.entry.metadata.manual_override, true);
    assert.equal(projectionOverride.adjustment, null);

    const accrued = await client.request("POST", `${base}/projections/${entryId}/accrue`, {});
    assert.equal(accrued.entry.amount_cents, 1_200);
    const accruedOverride = await client.request("POST", `${base}/projects/${projectId}/commission-overrides`, {
      entry_id: entryId,
      target_amount_cents: 1_600,
      reason: "Final approved amount",
      source_event_id: "override_accrued_1600"
    });
    assert.equal(accruedOverride.effective_amount_cents, 1_600);
    assert.equal(accruedOverride.adjustment.kind, "commission");
    assert.equal(accruedOverride.adjustment.amount_cents, 400);
    assert.equal(accruedOverride.adjustment.metadata.manual_override_for, entryId);

    const repeated = await client.request("POST", `${base}/projects/${projectId}/commission-overrides`, {
      entry_id: entryId,
      target_amount_cents: 1_600,
      reason: "No additional adjustment",
      source_event_id: "override_accrued_1600_retry"
    });
    assert.equal(repeated.adjustment, null);
    const ledger = await client.request("GET", `${base}/ledger?project_id=${projectId}`);
    assert.equal(ledger.entries.length, 2);
  });

  await t.test("cancellation creates idempotent clawbacks", async () => {
    const cancellation = {
      source_event_id: "project_commission_cancelled",
      trigger_id: "project_cancel_commission",
      state: "cancelled",
      reverses_source_event_id: "proposal_project_commission_paid",
      reverses_trigger_id: "proposal_payment_commission",
      occurred_at: "2026-07-11T18:00:00.000Z",
      completed_at: "2026-07-11T18:00:00.000Z",
      description: "Cancelled project commission clawback"
    };
    const cancelled = await client.request("POST", `${base}/projects/project_commission/commission-events`, cancellation);
    assert.equal(cancelled.reversed_count, 2);
    assert.deepEqual(cancelled.entries.map((entry: any) => entry.amount_cents).sort((a: number, b: number) => a - b), [-5001, -5000]);
    assert.ok(cancelled.entries.every((entry: any) => entry.kind === "clawback" && entry.state === "accrued"));
    const retry = await client.request("POST", `${base}/projects/project_commission/commission-events`, cancellation);
    assert.equal(retry.reversed_count, 2);
    assert.deepEqual(retry.entries.map((entry: any) => entry.id).sort(), cancelled.entries.map((entry: any) => entry.id).sort());
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
