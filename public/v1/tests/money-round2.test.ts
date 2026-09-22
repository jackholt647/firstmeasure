import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Money tab round two: cleared-payment reconciliation, reimbursement payables
 * from receipts, and report documents (job cost report) on the document
 * engine.
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-money-round2-test-"));
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
    email: `round2-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Round Two Owner",
    company: "Money Round Two Org",
    organization_id: `org_round2_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, documents: true, proposals: true, money: true, pricebook: true, materials: true, project_photos: true }
      }
    }
  }, { replace: false });
  return { orgId, userId: String(data.user.id) };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "7 Reconcile Row",
      title: "Round Two Customer",
      project_type: "residential",
      contacts: [{ name: "Round Two Customer", email: "round2@example.test", phone: "555-222-3333", primary: true }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

test("settled payments reconcile: clear stamps cleared_at, unclear reopens, worklist reports both", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_reconcile";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 125000,
    method: { type: "check" },
    status: "settled"
  });
  const paymentId = created.payment.id as string;
  assert.equal(created.payment.status, "settled");
  assert.equal(created.payment.cleared_at || "", "", "new payments start unreconciled");

  const openList = await client.request("GET", `/v1/payments/organizations/${orgId}/reconciliation?project_id=${projectId}`);
  assert.equal(openList.totals.uncleared_count, 1);
  assert.equal(openList.totals.uncleared_inbound_cents, 125000);
  assert.equal(openList.uncleared[0].project_title, "Round Two Customer", "worklist rows carry project titles for the Financials view");

  const cleared = await client.request("POST", `/v1/payments/organizations/${orgId}/payments/${paymentId}/clear`, {
    cleared_at: "2026-07-28T15:00:00.000Z",
    note: "Matched July bank statement"
  });
  assert.equal(cleared.payment.cleared_at, "2026-07-28T15:00:00.000Z");
  assert.equal(cleared.payment.reconciliation.state, "cleared");

  const clearedList = await client.request("GET", `/v1/payments/organizations/${orgId}/reconciliation?project_id=${projectId}`);
  assert.equal(clearedList.totals.uncleared_count, 0);
  assert.equal(clearedList.totals.cleared_count, 1);
  assert.equal(clearedList.totals.cleared_inbound_cents, 125000);

  const uncleared = await client.request("POST", `/v1/payments/organizations/${orgId}/payments/${paymentId}/unclear`, {});
  assert.equal(uncleared.payment.cleared_at || "", "");
  assert.equal(uncleared.payment.reconciliation.state, "open");

  // A pending outbound payment is not reconcilable.
  const pendingOut = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    direction: "outbound",
    amount_cents: 5000,
    status: "pending",
    allocate: false
  });
  const rejected = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments/${pendingOut.payment.id}/clear`, {});
  assert.equal(rejected.statusCode, 400, "pending payments cannot be marked cleared");
});

test("applying a receipt with a reimbursement payee creates the payable owed to that person, idempotently", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_reimburse";
  await createProject(client, orgId, projectId);

  await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/expenses`, {
    title: "Site supplies",
    resource_type: "material",
    projected_amount: 500
  });

  const uploaded = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    file_name: "gas-station.txt",
    content_type: "text/plain",
    file_base64: Buffer.from("Hardware Store\nDate 07/29/2026\nTotal $84.50\n").toString("base64"),
    title: "Hardware run"
  });
  const receiptId = (uploaded.receipt?.id || uploaded.id) as string;
  assert.ok(receiptId, "receipt uploaded");

  const summary = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-summary`);
  const targetKey = (summary.expense_summary.targets as any[]).find((target: any) => target.receipt_attribution_enabled !== false)?.target_key;
  assert.ok(targetKey, "expense target exists");

  const applied = await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${receiptId}/apply`, {
    total_cents: 8450,
    target_keys: [targetKey],
    reimbursement: {
      payee_ref: { kind: "organization_user", id: "user_alex", name: "Alex Crew" }
    }
  });
  assert.ok(applied.reimbursement_payable, "reimbursement payable returned");
  assert.equal(applied.reimbursement_payable.kind, "reimbursement");
  assert.equal(applied.reimbursement_payable.amount_cents, 8450, "payable defaults to the receipt total");
  assert.equal(applied.reimbursement_payable.payee_ref.name, "Alex Crew");
  assert.equal(applied.reimbursement_payable.source.type, "receipt");
  assert.equal(applied.reimbursement_payable.source.id, receiptId);

  // Re-applying does not duplicate the payable.
  const reapplied = await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${receiptId}/apply`, {
    total_cents: 8450,
    target_keys: [targetKey],
    reimbursement: { payee_ref: { kind: "organization_user", id: "user_alex", name: "Alex Crew" } }
  });
  assert.equal(reapplied.reimbursement_payable.id, applied.reimbursement_payable.id);
  const payables = await client.request("GET", `/v1/payments/organizations/${orgId}/payables?project_id=${projectId}`);
  const reimbursements = (payables.payables as any[]).filter((payable: any) => payable.kind === "reimbursement");
  assert.equal(reimbursements.length, 1, "one reimbursement payable per receipt");

  // Paying it flows through the normal disbursement path and closes the debt.
  await client.request("POST", `/v1/payments/organizations/${orgId}/disbursements`, {
    project_id: projectId,
    payable_ids: [applied.reimbursement_payable.id],
    amount_cents: 8450
  });
  const paid = await client.request("GET", `/v1/payments/organizations/${orgId}/payables?project_id=${projectId}`);
  assert.equal((paid.payables as any[]).find((payable: any) => payable.kind === "reimbursement").status, "paid");
});

test("receipt-backed reimbursement requests move from Crew submission through office approval and off-cycle payment", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await registerOrg(client);
  const projectId = "project_reimbursement_workflow";
  await createProject(client, orgId, projectId);

  const uploaded = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    file_name: "personal-purchase.txt",
    content_type: "text/plain",
    file_base64: Buffer.from("Supply House\nDate 07/30/2026\nTotal $63.25\n").toString("base64"),
    title: "Personal purchase"
  });
  const receiptId = String(uploaded.receipt.id);
  const submitted = await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${receiptId}/reimbursement-request`, {
    funding_source: "personal",
    amount_cents: 6325,
    note: "Emergency fittings"
  });
  assert.equal(submitted.reimbursement_request.status, "submitted");
  assert.ok(submitted.reimbursement_request.action_item_id, "office action item created");

  const approved = await client.request("POST", `/v1/payments/organizations/${orgId}/reimbursements/${receiptId}/actions`, {
    action: "approve",
    payment_timing: "off_cycle",
    project_id: projectId
  });
  assert.equal(approved.reimbursement_request.status, "approved");
  assert.equal(approved.reimbursement_request.payment_timing, "off_cycle");
  assert.equal(approved.reimbursement_request.payable.status, "open");

  const paid = await client.request("POST", `/v1/payments/organizations/${orgId}/reimbursements/${receiptId}/actions`, {
    action: "mark_paid",
    note: "Included in Friday check run"
  });
  assert.equal(paid.reimbursement_request.status, "paid");
  const queue = await client.request("GET", `/v1/payments/organizations/${orgId}/reimbursements`);
  const row = queue.reimbursements.find((item: any) => item.receipt.id === receiptId);
  assert.equal(row.reimbursement_request.payable.status, "paid");

  const schedule = (await client.request("POST", `/v1/payroll/organizations/${orgId}/schedules`, {
    name: "Weekly reimbursements",
    timezone: "America/Los_Angeles",
    recurrence: { frequency: "weekly", weekday: 5 },
    delay: { periods: 0 },
    timing_basis: "completed"
  })).schedule;
  await client.request("PUT", `/v1/payroll/organizations/${orgId}/policies/organization_user/${userId}`, {
    schedule_id: schedule.id,
    earning_kind: "reimbursement"
  });
  const payrollReceipt = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    file_name: "payroll-reimbursement.txt",
    content_type: "text/plain",
    file_base64: Buffer.from("Tool Store\nDate 07/31/2026\nTotal $22.40\n").toString("base64")
  });
  await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${payrollReceipt.receipt.id}/reimbursement-request`, {
    funding_source: "personal",
    amount_cents: 2240
  });
  const payrollApproved = await client.request("POST", `/v1/payments/organizations/${orgId}/reimbursements/${payrollReceipt.receipt.id}/actions`, {
    action: "approve",
    payment_timing: "next_payroll",
    project_id: projectId
  });
  assert.equal(payrollApproved.reimbursement_request.payroll_status, "queued");
  const ledgerEntry = await client.request("GET", `/v1/payroll/organizations/${orgId}/ledger/${payrollApproved.reimbursement_request.payroll_entry_id}`);
  assert.equal(ledgerEntry.entry.kind, "reimbursement");
  assert.equal(ledgerEntry.entry.amount_cents, 2240);

  const cardReceipt = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    file_name: "company-card.txt",
    content_type: "text/plain",
    file_base64: Buffer.from("Fuel\nDate 07/31/2026\nTotal $40.00\n").toString("base64")
  });
  const noReimbursement = await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${cardReceipt.receipt.id}/reimbursement-request`, {
    funding_source: "company_card"
  });
  assert.equal(noReimbursement.reimbursement_request.status, "not_required");
  assert.equal(noReimbursement.reimbursement_request.amount_cents, 0);
});

test("report documents generate from the seeded job cost template with live money widget data", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_report";
  await createProject(client, orgId, projectId);

  // Give the project real money facts: a schedule and a settled payment.
  const { ensureReceivablesFromSchedule } = await import("../payments/storage.js");
  await ensureReceivablesFromSchedule(orgId, {
    project_id: projectId,
    title: "Contract",
    source: { type: "manual", id: "report_contract_1" },
    items: [
      {
        label: "Deposit", amount_cents: 300000, payment_kind: "deposit", due_rule: "on_signature",
        due_at: "2026-07-01T00:00:00.000Z", grace_days: 1,
        recognition: { node_id: "", hook: "onCompleted" }, amount_expression: "", metadata: {}
      },
      {
        label: "Final Payment", amount_cents: 700000, payment_kind: "final", due_rule: "project_completion",
        due_at: "", grace_days: 1,
        recognition: { node_id: "", hook: "onCompleted" }, amount_expression: "", metadata: {}
      }
    ]
  });
  await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 300000,
    method: { type: "ach" },
    status: "settled"
  });

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "report",
    title: "Job Cost Report — July"
  });
  const documentId = created.document.id as string;
  assert.equal(created.document.template_ref.template_id, "tpl_money_report_default", "report type resolves the seeded template");
  assert.deepEqual(created.missing_params, [], "reports require no hand-entered params");

  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  const widgetData = resolved.widget_data as Record<string, any>;
  const metricsData = Object.values(widgetData).find((value: any) => value && Array.isArray(value.metrics));
  assert.ok(metricsData, "doc.money_metrics resolved");
  const contractMetric = metricsData.metrics.find((metric: any) => metric.key === "contract_value");
  const collectedMetric = metricsData.metrics.find((metric: any) => metric.key === "collected");
  assert.equal(contractMetric.amount_cents, 1_000_000, "contract value from the payment schedule");
  assert.equal(collectedMetric.amount_cents, 300000, "collected from settled payments");
  const historyData = Object.values(widgetData).find((value: any) => value && Array.isArray(value.rows)
    && value.totals && Number.isFinite(Number(value.totals.inbound_cents)));
  assert.ok(historyData, "doc.payment_history resolved");
  assert.equal(historyData.totals.inbound_cents, 300000);

  const issued = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/issue`, {});
  assert.equal(issued.document.status, "issued");

  // The PDF route responds with a rendered document (Playwright harness or
  // the deterministic fallback renderer — either way a real PDF).
  const pdf = await client.raw("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/pdf`);
  assert.equal(pdf.statusCode, 200, `report pdf renders: ${pdf.statusCode}`);
  assert.ok(String(pdf.headers["content-type"]).includes("pdf"), "response is a PDF");

  // Reports list under the project for the Money tab's Reports view.
  const listed = await client.request("GET", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents?document_type=report`);
  const reports = (listed.documents || listed.items || []) as any[];
  assert.ok(reports.some((doc) => doc.id === documentId), "report listed for the project");
});

test("period-scoped reports filter payment history to the requested window", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_period_report";
  await createProject(client, orgId, projectId);

  await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 100000, status: "settled", received_at: "2026-06-15T12:00:00.000Z"
  });
  await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 50000, status: "settled", received_at: "2026-07-15T12:00:00.000Z"
  });

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "report",
    title: "July report",
    params: { period_from: "2026-07-01", period_to: "2026-07-31" }
  });
  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/resolve`, {});
  const widgetData = resolved.widget_data as Record<string, any>;
  const historyData = Object.values(widgetData).find((value: any) => value && Array.isArray(value.rows)
    && value.totals && Number.isFinite(Number(value.totals.inbound_cents)));
  assert.ok(historyData, "payment history resolved");
  assert.equal(historyData.rows.length, 1, "only the July payment falls in the period");
  assert.equal(historyData.totals.inbound_cents, 50000);
});
