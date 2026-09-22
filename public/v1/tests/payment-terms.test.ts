import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Data-driven payment terms: shared schedule vocabulary, source-agnostic
 * receivables minting, document-engine on_signed dispatch (proposals replace,
 * change orders append), milestone recognition, expression pricing, and
 * payroll labor actuals flowing into project money.
 */

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
  const raw = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}),
        ...extraHeaders
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await raw(method, url, payload, extraHeaders);
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
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payment-terms-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  (await closeWorkforceDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `terms-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Terms Owner",
    company: "Payment Terms Test Org",
    organization_id: `org_terms_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, documents: true,
          proposals: true,
          money: true,
          pricebook: true,
          materials: true,
          payroll: true,
          project_photos: true
        }
      }
    }
  }, { replace: false });
  return { orgId, userId: String(data.user.id) };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "42 Ledger Lane",
      title: "Terms Customer",
      project_type: "residential",
      contacts: [{ name: "Terms Customer", email: "terms@example.test", phone: "555-000-1111", primary: true }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

const SCOPE_ITEMS = [
  { id: "item_roof", name: "Roof replacement", description: "Tear-off and re-shingle", quantity: 1, unit: "job", unit_price: 10000 },
  { id: "item_gutters", name: "Gutters", description: "Seamless gutters", quantity: 2, unit: "run", unit_price: 1000 }
];
// 10000*1 + 1000*2 = $12,000 subtotal; no tax → 1,200,000 cents basis.
const BASIS_CENTS = 1_200_000;

test("normalizeScheduleRows accepts every historical vocabulary and types the rows", async () => {
  const { normalizeScheduleRows, resolveScheduleItems } = await import("../payments/schedule_terms.js");

  // Legacy proposals-app shape: formatted currency strings, positional slots.
  const legacy = normalizeScheduleRows([
    { label: "Deposit", amount: "$2,500.00", due_rule: "on_signature" },
    { label: "Progress Payment", amount: "1000", due_rule: "manual" },
    { label: "Final Payment", amount: "$1,000.00", due_rule: "project_completion" }
  ]);
  assert.equal(legacy.length, 3);
  assert.equal(legacy[0]!.amount_cents, 250000);
  assert.equal(legacy[0]!.payment_kind, "deposit");
  assert.equal(legacy[1]!.payment_kind, "progress");
  assert.equal(legacy[2]!.payment_kind, "final");
  assert.equal(legacy[2]!.due_rule, "project_completion");

  // Documents-app shape: {kind: percent|fixed, percent, amount_cents, due_date}.
  // Studio sample shape: {due: "on_acceptance"} aliases.
  const wrapped = normalizeScheduleRows({
    items: [
      { label: "Deposit", kind: "percent", percent: 30, due: "on_acceptance" },
      { label: "Dry-in draw", kind: "percent", percent: 40, recognition: { node_id: "node_dry_in", hook: "onCompleted" } },
      { label: "Final", kind: "percent", percent: 30, due: "on_completion" }
    ]
  });
  assert.equal(wrapped.length, 3);
  assert.equal(wrapped[0]!.kind, "percent");
  assert.equal(wrapped[0]!.percent_bps, 3000);
  assert.equal(wrapped[0]!.due_rule, "on_signature");
  assert.equal(wrapped[1]!.due_rule, "node");
  assert.equal(wrapped[1]!.recognition.node_id, "node_dry_in");
  assert.equal(wrapped[2]!.due_rule, "project_completion");

  // Percent resolution: cents against a basis, remainder folds into the last
  // row so a 100% schedule sums exactly to the basis.
  const resolved = resolveScheduleItems(wrapped, { total_cents: 100001, signed_at: "2026-07-30T00:00:00.000Z" });
  assert.equal(resolved.reduce((sum, item) => sum + item.amount_cents, 0), 100001);
  assert.equal(resolved[0]!.amount_cents, 30000);
  assert.equal(resolved[0]!.due_at, "2026-07-30T00:00:00.000Z");
  assert.equal(resolved[2]!.amount_cents, 30001, "rounding remainder lands on the last percent row");

  // Expression rows survive resolution with amount 0 (resolved at recognition).
  const expression = normalizeScheduleRows([
    { label: "Cost plus fee", expression: "round(expenses_to_date_cents * 1.2)", due_rule: "project_completion" }
  ]);
  assert.equal(expression[0]!.kind, "expression");
  const resolvedExpression = resolveScheduleItems(expression, { total_cents: 0 });
  assert.equal(resolvedExpression.length, 1);
  assert.equal(resolvedExpression[0]!.amount_cents, 0);
  assert.equal(resolvedExpression[0]!.amount_expression, "round(expenses_to_date_cents * 1.2)");
});

test("signing a document-engine proposal mints receivables from params.payment_schedule (percent resolved server-side)", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_doc_receivables";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Data-driven Proposal",
    params: {
      customer: { name: "Terms Customer", email: "terms@example.test" },
      scope_items: SCOPE_ITEMS,
      payment_schedule: [
        { label: "Deposit", kind: "percent", percent: 30, due_rule: "on_signature" },
        { label: "Final Payment", kind: "percent", percent: 70, due_rule: "project_completion" }
      ]
    }
  });
  const documentId = created.document.id as string;

  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/issue`, {});
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, {
    recipients: [{ name: "Terms Customer", email: "terms@example.test", role: "customer" }]
  });
  const token = sent.snapshot.public_token as string;

  // Percent rows resolve in the rendered widget too (the old $0.00 bug).
  const widgetData = sent.snapshot.widget_data as Record<string, any>;
  const scheduleWidget = Object.values(widgetData || {}).find((value: any) => value && Array.isArray(value.rows)
    && value.rows.some((row: any) => typeof row.due_rule === "string"));
  if (scheduleWidget) {
    const depositRow = scheduleWidget.rows.find((row: any) => /deposit/i.test(row.label));
    assert.ok(depositRow, "schedule widget carries the deposit row");
    assert.equal(depositRow.amount_cents, Math.round(BASIS_CENTS * 0.3), "percent row renders resolved cents, not $0.00");
  }

  const signed = await client.request("POST", `/v1/documents/public/${token}/outputs/sig_customer`, {
    value: { type: "typed", text: "Terms Customer", signer_name: "Terms Customer", style: "style-classic" },
    evidence: { timezone: "America/Chicago", locale: "en-US" }
  });
  assert.equal(signed.document.status, "signed");

  const obligations = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/obligations`);
  const rows = (obligations.obligations || obligations.items || obligations) as any[];
  assert.ok(Array.isArray(rows) && rows.length === 2, `document signing minted obligations (got ${JSON.stringify(rows).slice(0, 200)})`);
  const deposit = rows.find((row) => row.kind === "deposit");
  const final = rows.find((row) => row.kind === "final");
  assert.ok(deposit, "deposit obligation is typed, not label-sniffed");
  assert.ok(final, "final obligation is typed");
  assert.equal(deposit.amount_cents, Math.round(BASIS_CENTS * 0.3));
  assert.equal(final.amount_cents, BASIS_CENTS - Math.round(BASIS_CENTS * 0.3));
  assert.ok(deposit.due_at, "on_signature obligation is due at signing");
  assert.equal(final.due_rule, "project_completion");
  assert.equal(final.due_at || "", "", "completion obligation has no date until recognized");
  assert.equal(deposit.source.type, "document");

  const schedules = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payment-schedules`);
  const scheduleRows = (schedules.schedules || schedules.items || schedules) as any[];
  assert.equal(scheduleRows.filter((schedule) => schedule.status === "active").length, 1);

  // --- change order appends instead of superseding -------------------------
  const changeOrder = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "change_order",
    title: "Skylight Addition",
    params: {
      customer: { name: "Terms Customer", email: "terms@example.test" },
      reason: "Customer requested skylight",
      amount_cents: 150000
    }
  });
  const changeOrderId = changeOrder.document.id as string;
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${changeOrderId}/issue`, {});
  const coSent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${changeOrderId}/send`, {
    recipients: [{ name: "Terms Customer", email: "terms@example.test", role: "customer" }]
  });
  const coSigned = await client.request("POST", `/v1/documents/public/${coSent.snapshot.public_token}/outputs/sig_customer`, {
    value: { type: "typed", text: "Terms Customer", signer_name: "Terms Customer", style: "style-classic" },
    evidence: { timezone: "America/Chicago", locale: "en-US" }
  });
  assert.equal(coSigned.document.status, "signed");

  const afterCo = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/obligations`);
  const afterCoRows = (afterCo.obligations || afterCo.items || afterCo) as any[];
  assert.equal(afterCoRows.length, 3, "change order appended an obligation without superseding the base schedule");
  const coObligation = afterCoRows.find((row) => row.kind === "change_order");
  assert.ok(coObligation, "change order obligation carries the typed kind");
  assert.equal(coObligation.amount_cents, 150000);

  const schedulesAfterCo = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payment-schedules`);
  const activeSchedules = ((schedulesAfterCo.schedules || schedulesAfterCo.items || schedulesAfterCo) as any[])
    .filter((schedule) => schedule.status === "active");
  assert.equal(activeSchedules.length, 2, "base schedule and change order schedule are both active");

  // Project revenue = base contract + change order.
  const summaryResponse = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`);
  assert.equal(summaryResponse.summary.projected_revenue_cents, BASIS_CENTS + 150000, "change order raises projected revenue");

  // --- recognition stamps completion-due obligations -----------------------
  const { reconcileObligationRecognition } = await import("../payments/recognition.js");
  const recognition = await reconcileObligationRecognition(orgId, projectId, { completion_signed: true });
  assert.ok(recognition.recognized.some((row: any) => row.id === final.id), "final payment recognized on completion sign-off");
  const afterRecognition = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/obligations`);
  const recognizedFinal = ((afterRecognition.obligations || afterRecognition.items || afterRecognition) as any[])
    .find((row) => row.id === final.id);
  assert.ok(recognizedFinal.due_at, "recognition stamped the due date");
  assert.notEqual(recognizedFinal.status, "scheduled");
});

test("expression obligations (cost-plus) resolve against actual costs at recognition", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_cost_plus";
  await createProject(client, orgId, projectId);

  // Incur a real cost: a paid payable for materials.
  await client.request("POST", `/v1/payments/organizations/${orgId}/payables`, {
    project_id: projectId,
    kind: "material_order",
    amount_cents: 400000,
    notes: "Lumber package"
  });
  const payables = await client.request("GET", `/v1/payments/organizations/${orgId}/payables?project_id=${projectId}`);
  const payableId = ((payables.payables || payables.items || payables) as any[])[0].id;
  await client.request("POST", `/v1/payments/organizations/${orgId}/disbursements`, {
    project_id: projectId,
    payable_ids: [payableId],
    amount_cents: 400000
  });

  const { ensureReceivablesFromSchedule } = await import("../payments/storage.js");
  const minted = await ensureReceivablesFromSchedule(orgId, {
    project_id: projectId,
    title: "Cost-plus contract",
    source: { type: "manual", id: "contract_cost_plus_1" },
    items: [{
      label: "Cost plus 20%",
      amount_cents: 0,
      payment_kind: "final",
      due_rule: "project_completion",
      due_at: "",
      grace_days: 1,
      recognition: { node_id: "", hook: "onCompleted" },
      amount_expression: "round(expenses_to_date_cents * 1.2)",
      metadata: {}
    }],
    mode: "append"
  });
  assert.equal(minted.created, true);
  assert.equal(minted.obligations.length, 1);
  assert.equal(minted.obligations[0]!.amount_cents, 0, "expression obligation starts unresolved");

  const { reconcileObligationRecognition } = await import("../payments/recognition.js");
  const recognition = await reconcileObligationRecognition(orgId, projectId, { completion_signed: true });
  assert.equal(recognition.recognized.length, 1);
  assert.equal(recognition.recognized[0]!.amount_cents, 480000, "cost-plus resolved as 120% of expenses to date");
});

test("payroll labor accruals flow into project money as labor actuals", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await registerOrg(client);
  const projectId = "project_labor_actuals";
  await createProject(client, orgId, projectId);

  // Write accrued labor straight to the payroll ledger (the API route
  // resolves payroll schedules first; this test targets the money read side).
  const { upsertPayrollLedgerEntry } = await import("../payroll/storage.js");
  (await upsertPayrollLedgerEntry(orgId, {
    payee: { type: "organization_user", id: userId, name: "Terms Owner" },
    kind: "hourly",
    state: "accrued",
    amount_cents: 60000,
    project_id: projectId,
    worked_at: "2026-07-20T18:00:00.000Z",
    eligible_at: "2026-07-24T00:00:00.000Z",
    source_event_id: "shift_terms_1",
    source_trigger_id: "test.manual"
  } as any));
  (await upsertPayrollLedgerEntry(orgId, {
    payee: { type: "organization_user", id: userId, name: "Terms Owner" },
    kind: "piece_rate",
    state: "accrued",
    amount_cents: 25000,
    project_id: projectId,
    worked_at: "2026-07-21T18:00:00.000Z",
    eligible_at: "2026-07-24T00:00:00.000Z",
    source_event_id: "piece_terms_1",
    source_trigger_id: "test.manual"
  } as any));

  const { summary } = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`);
  assert.equal(summary.accrued_payroll_labor_cents, 85000, "accrued payroll labor surfaces on the money summary");
  assert.equal(summary.labor.accrued_cents, 85000);
  assert.equal(summary.labor.actual_cents, 85000, "labor actuals derive from the payroll ledger without a manual payable");
  assert.ok(summary.expenses_to_date_cents >= 85000, "payroll labor counts as incurred cost");
  assert.ok(summary.profit_to_date_cents <= -85000, "profit to date moves when payroll accrues");

  const { expense_summary: expenseSummary } = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-summary`);
  const laborTarget = (expenseSummary.targets as any[]).find((target) => target.target_key === "payroll_labor:accrued");
  assert.ok(laborTarget, "payroll labor appears as a system-managed expense target");
  assert.equal(laborTarget.actual_cents, 85000);
  assert.equal(laborTarget.system_managed, true);
  assert.equal(laborTarget.resource_type, "labor");
});
