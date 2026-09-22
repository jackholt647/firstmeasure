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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payments-test-"));
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

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `payments-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Payments Owner",
    company: "Payments Test Org",
    organization_id: `org_payments_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true,
          proposals: true,
          money: true,
          pricebook: true,
          materials: true,
          project_photos: true
        },
        // money.invoices defaults OFF and the invoice routes now enforce it
        // server-side — the fixture opts in explicitly.
        money: { invoices: true }
      }
    }
  }, { replace: false });
  return { orgId, userId: String(data.user.id) };
}

test("receipt extraction routes by sniffed content and preserves credit direction", async () => {
  const { extractReceipt, inferReceiptContentType, receiptFileSupport } = await import("../payments/receipt_extraction.js");
  const pdfBytes = Buffer.from("%PDF-1.7\n% test document");
  const sniffed = inferReceiptContentType("misnamed-receipt.jpg", "application/octet-stream", pdfBytes);
  const support = receiptFileSupport("misnamed-receipt.jpg", sniffed, pdfBytes.length);
  assert.equal(sniffed, "application/pdf");
  assert.equal(support.direct_image, false);
  assert.equal(support.native_file, true);
  assert.equal(support.type_conflict, true);

  const credit = await extractReceipt({
    bytes: Buffer.from("Supplier Credit Memo\nCredit Memo #CM-9\nDate 07/09/2026\nTotal $125.00\n"),
    fileName: "credit-memo.txt",
    contentType: "text/plain"
  });
  assert.equal(credit.document_kind, "credit_memo");
  assert.equal(credit.amount_direction, "credit");
  assert.equal(credit.total_cents, 12_500);
  assert.equal(credit.signed_total_cents, -12_500);
});

test("organization receipt access honors privileged roles when resolved permission maps are empty", async () => {
  const { canManageOrganizationReceipts } = await import("../payments/api.js");
  assert.equal(canManageOrganizationReceipts({ role: "super_admin", permissions: {} } as any), true);
  assert.equal(canManageOrganizationReceipts({ role: "admin", permissions: {} } as any), true);
  assert.equal(canManageOrganizationReceipts({ role: "viewer", permissions: { view_projects: true } } as any), true);
  assert.equal(canManageOrganizationReceipts({ role: "viewer", permissions: {} } as any), false);
});

test("monthly maintenance recurrence creates independent project work and monthly billing", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_monthly_maintenance";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Monthly Maintenance", address: "101 Maintenance Way", contacts: [{ id: "maintenance_customer", primary: true, name: "Maintenance Customer" }] },
    metadata: { kind: "platform_project" }
  });

  const start = new Date(Date.now() - 35 * 86_400_000);
  start.setUTCHours(15, 0, 0, 0);
  const created = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/recurrence-series`, {
    title: "Monthly maintenance visit",
    start_at: start.toISOString(),
    recurrence: { frequency: "monthly", interval: 1 },
    scope_template_id: "maintenance",
    scope_piece_id: "maintenance_scope",
    event_template: { event_type_default_id: "project_work", schedule_item_kind: "production", duration_minutes: 120, assigned_user_ids: ["maintenance_crew"] },
    billing: { enabled: true, amount_cents: 19_900, frequency: "monthly", label: "Monthly maintenance" },
    expenses: { enabled: true, amount_cents: 5_000, kind: "labor" }
  });
  assert.equal(created.series.status, "active");
  assert.ok(created.occurrences.length >= 6);
  assert.equal(new Set(created.occurrences.map((entry: any) => entry.event_id)).size, created.occurrences.length);
  assert.ok(created.occurrences.every((entry: any) => entry.event.scope_template_id === "maintenance"));

  const occurrences = await client.request("GET", `/v1/platform/organizations/${orgId}/recurrence-series/${created.series.id}/occurrences`);
  const first = occurrences.occurrences[0];
  const completed = await client.request("POST", `/v1/platform/organizations/${orgId}/recurrence-series/${created.series.id}/occurrences/${first.id}/completed`, {});
  assert.equal(completed.occurrence.status, "completed");
  assert.ok(occurrences.occurrences.slice(1).some((entry: any) => entry.status === "scheduled"));

  const summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.recurring.series.length, 1);
  assert.ok(summary.obligations.filter((entry: any) => entry.recurrence_series_id === created.series.id).length >= 6);
  assert.ok(summary.payables.filter((entry: any) => entry.recurrence_series_id === created.series.id).length >= 6);

  const cancelled = await client.request("DELETE", `/v1/platform/organizations/${orgId}/recurrence-series/${created.series.id}`);
  assert.equal(cancelled.series.status, "cancelled");
  const afterCancel = await client.request("GET", `/v1/platform/organizations/${orgId}/recurrence-series/${created.series.id}/occurrences`);
  assert.ok(afterCancel.occurrences.filter((entry: any) => new Date(entry.starts_at) > new Date()).every((entry: any) => entry.status === "cancelled"));
});

test("payments API syncs signed proposals, allocates payments, handles refunds, and summarizes profitability", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_money_test";

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "300 Money Lane",
      title: "Money Test Roof",
      contacts: [{ id: "contact_jane", role: "customer", name: "Jane Money", email: "jane-money@example.test", phone: "555-222-3333", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });

  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Money Proposal",
    contacts: [{ role: "customer", name: "Jane Money", email: "jane-money@example.test" }],
    editable: {
      title: "Money Proposal",
      pricing: { total: 12500 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Roof", quantity: "1", amount: 12500 }] },
        { id: "signature", kind: "signature", depositAmount: 2500, completionAmount: 10000, financedAmount: 0 }
      ]
    }
  });

  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Jane Money", email: "jane-money@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  const publicToken = sent.snapshot.delivery.public_token;
  await client.request("POST", `/v1/proposals/public/${publicToken}/sign`, {
    signer_name: "Jane Money",
    signature: { type: "adopt", text: "Jane Money" }
  });

  let summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.schedules.length, 1);
  assert.equal(summary.obligations.length, 2);
  assert.equal(summary.project_total_cents, 1_250_000);
  assert.equal(summary.total_collected_cents, 0);
  assert.ok(summary.obligations.some((item: any) => item.label === "Deposit" && item.status === "due"));
  assert.ok(summary.obligations.some((item: any) => item.label === "Final Payment" && item.status === "scheduled"));

  const depositPayment = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount: 2500,
    method: { type: "check", label: "Check" }
  });
  assert.equal(depositPayment.allocations.length, 1);
  assert.equal(depositPayment.allocations[0].amount_cents, 250_000);
  const paymentReceipt = await client.raw("GET", `/v1/payments/organizations/${orgId}/payments/${depositPayment.payment.id}/receipt.pdf`);
  assert.equal(paymentReceipt.statusCode, 200);
  assert.equal(paymentReceipt.headers["content-type"], "application/pdf");
  assert.ok(paymentReceipt.body.length > 100);
  const { readDocumentInstance } = await import("../documents/storage.js");
  const receiptDocument = await readDocumentInstance(orgId, `doc_payment_receipt_${depositPayment.payment.id}`);
  assert.equal(receiptDocument.document_type, "payment_receipt");
  assert.equal((receiptDocument.template_ref as any).template_id, "tpl_payment_receipt_default");

  summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.total_collected_cents, 250_000);
  assert.equal(summary.total_remaining_cents, 1_000_000);
  assert.ok(summary.obligations.some((item: any) => item.label === "Deposit" && item.status === "paid"));

  const partialPayment = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount: 3000,
    method: { type: "card", label: "Card" }
  });
  assert.equal(partialPayment.allocations.length, 1);
  assert.equal(partialPayment.allocations[0].amount_cents, 300_000);

  summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.ok(summary.obligations.some((item: any) => item.label === "Final Payment" && item.status === "partially_paid" && item.allocated_cents === 300_000));

  const refund = await client.request("POST", `/v1/payments/organizations/${orgId}/payments/${partialPayment.payment.id}/refunds`, {
    amount: 500,
    reason: "test_adjustment"
  });
  assert.equal(refund.payment.status, "partially_refunded");

  summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.total_collected_cents, 500_000);
  assert.ok(summary.obligations.some((item: any) => item.label === "Final Payment" && item.allocated_cents === 250_000));

  await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, {
    title: "Money Materials",
    items: [
      { name: "Shingles", quantity: 10, unit: "sq", projected_unit_price: 100, paid_unit_price: 40 }
    ]
  });

  const payable = await client.request("POST", `/v1/payments/organizations/${orgId}/payables`, {
    project_id: projectId,
    kind: "crew",
    payee_ref: { kind: "resource_group", id: "resource_group_alpha", name: "Alpha Crew" },
    amount: 200
  });
  assert.equal(payable.payable.status, "open");
  assert.deepEqual(payable.payable.payee_ref, { kind: "resource_group", id: "resource_group_alpha", name: "Alpha Crew" });

  const disbursement = await client.request("POST", `/v1/payments/organizations/${orgId}/disbursements`, {
    project_id: projectId,
    kind: "crew",
    payable_ids: [payable.payable.id],
    amount: 200
  });
  assert.equal(disbursement.disbursement.status, "settled");

  const removableExpense = await client.request("POST", `/v1/payments/organizations/${orgId}/payables`, {
    project_id: projectId,
    kind: "other",
    payee_ref: { kind: "manual_payee", name: "Temporary Vendor" },
    amount: 50
  });
  const removedExpense = await client.request("DELETE", `/v1/payments/organizations/${orgId}/payables/${removableExpense.payable.id}`);
  assert.equal(removedExpense.payable.status, "void");
  const currentPayables = await client.request("GET", `/v1/payments/organizations/${orgId}/payables?project_id=${projectId}`);
  assert.ok(!currentPayables.payables.some((entry: any) => entry.id === removableExpense.payable.id));

  const intent = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-intents`, {
    project_id: projectId,
    amount: 750,
    provider: "manual_future_pos"
  });
  assert.equal(intent.intent.status, "pending");
  const cancelled = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-intents/${intent.intent.id}/cancel`, {});
  assert.equal(cancelled.intent.status, "cancelled");

  summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.materials.projected_cents, 100_000);
  assert.equal(summary.materials.paid_cents, 40_000);
  assert.equal(summary.projected_expenses_cents, 120_000);
  assert.equal(summary.expenses_to_date_cents, 60_000);
  assert.equal(summary.projected_profit_cents, 1_130_000);

  const ledger = await client.request("GET", `/v1/payments/organizations/${orgId}/ledger?project_id=${projectId}`);
  assert.ok(ledger.count >= 4);
  const events = await client.request("GET", `/v1/payments/organizations/${orgId}/events?project_id=${projectId}`);
  assert.ok(events.events.some((event: any) => event.type === "payment_schedule.created_from_signed_proposal"));
  assert.ok(events.events.some((event: any) => event.type === "payment.refunded"));
});

test("project payments partially satisfy a signed deposit and spill over only after completing it", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_payment_deposit_spill_test";

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "91 Allocation Way",
      title: "Deposit Allocation Roof",
      contacts: [{ id: "contact_allocation", role: "customer", name: "Allie Cation", email: "allie@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Deposit Allocation Proposal",
    contacts: [{ role: "customer", name: "Allie Cation", email: "allie@example.test" }],
    editable: {
      title: "Deposit Allocation Proposal",
      pricing: { total: 10_000 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Roof", quantity: "1", amount: 10_000 }] },
        { id: "signature", kind: "signature", depositAmount: 2_500, completionAmount: 7_500 }
      ]
    }
  });
  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Allie Cation", email: "allie@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  await client.request("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
    signer_name: "Allie Cation",
    signature: { type: "adopt", text: "Allie Cation" }
  });

  const partial = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 100_000,
    method: { type: "check", label: "Check" }
  });
  assert.equal(partial.allocations.length, 1);
  assert.equal(partial.allocations[0].amount_cents, 100_000);
  let summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.obligations.find((item: any) => item.label === "Deposit").status, "partially_paid");
  assert.equal(summary.obligations.find((item: any) => item.label === "Final Payment").allocated_cents, 0);
  const depositObligationId = summary.obligations.find((item: any) => item.label === "Deposit").id;
  let project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  let pipelineInstance = project.document.data.work_projection.active_instances
    .find((instance: any) => instance.kind === "pipeline");
  assert.equal(pipelineInstance.stage_id, "closing_stage");

  const overage = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    obligation_id: depositObligationId,
    amount_cents: 200_000,
    method: { type: "card", label: "Card" }
  });
  assert.deepEqual(overage.allocations.map((allocation: any) => allocation.amount_cents), [150_000, 50_000]);
  summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.obligations.find((item: any) => item.label === "Deposit").status, "paid");
  assert.equal(summary.obligations.find((item: any) => item.label === "Final Payment").allocated_cents, 50_000);
  project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  // The deposit completed the pipeline's last node; with no production
  // scope on this piece-less proposal the project lifecycle completes.
  assert.equal(project.document.data.work_projection.active_instances.length, 0);
  assert.equal(project.document.data.lifecycle.status, "completed");

  const events = await client.request("GET", `/v1/payments/organizations/${orgId}/events?project_id=${projectId}`);
  const partialEvent = events.events.find((event: any) => event.type === "payment.received" && event.payload.payment_id === partial.payment.id);
  const completedEvent = events.events.find((event: any) => event.type === "payment.received" && event.payload.payment_id === overage.payment.id);
  assert.equal(partialEvent.payload.payment_kind, "deposit_partial");
  assert.equal(completedEvent.payload.payment_kind, "deposit");
});

test("project invoices generate PDFs, publish due payments to the portal, email attachments, and accept the targeted payment", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_invoice_lifecycle_test";

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "704 Invoice Avenue",
      title: "Invoice Lifecycle Roof",
      contacts: [{ id: "contact_invoice", role: "customer", name: "Ivy Invoice", email: "ivy-invoice@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  const companyLogo = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="100"><rect width="420" height="100" rx="12" fill="#ffffff"/><path d="M20 72 55 25l35 47" fill="none" stroke="#c83232" stroke-width="12"/><text x="110" y="65" font-family="Arial" font-size="32" font-weight="700" fill="#16233a">SUMMIT ROOFING</text></svg>').toString("base64")}`;
  const coBrandLogo = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="230" height="90"><rect width="230" height="90" rx="12" fill="#16233a"/><text x="115" y="55" text-anchor="middle" font-family="Arial" font-size="25" font-weight="700" fill="#ffffff">GAF MASTER</text></svg>').toString("base64")}`;
  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/presentation_style`, {
    data: {
      default_theme: "triangles",
      companyName: "Summit Roofing",
      branding: { logo: companyLogo, colors: { primary: "#c83232", secondary: "#f4b7b2" } },
      proposal_defaults: { font_family: "Montserrat" }
    }
  });
  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Invoice Proposal",
    contacts: [{ role: "customer", name: "Ivy Invoice", email: "ivy-invoice@example.test" }],
    editable: {
      title: "Invoice Proposal",
      theme: { key: "triangles" },
      primaryColor: "#c83232",
      secondaryColor: "#f4b7b2",
      fontFamily: "Montserrat",
      coBrandLogo,
      pricing: { total: 5000 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Roof replacement", amount: 5000 }] },
        { id: "signature", kind: "signature", depositAmount: 1000, completionAmount: 4000 }
      ]
    }
  });
  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Ivy Invoice", email: "ivy-invoice@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  const publicToken = sent.snapshot.delivery.public_token;
  await client.request("POST", `/v1/proposals/public/${publicToken}/sign`, {
    signer_name: "Ivy Invoice",
    signature: { type: "adopt", text: "Ivy Invoice" }
  });

  const moneySummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  const finalObligation = moneySummary.obligations.find((item: any) => item.label === "Final Payment");
  assert.ok(finalObligation);
  assert.equal(finalObligation.status, "scheduled");

  const generated = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
    obligation_ids: [finalObligation.id],
    issue_date: "2026-07-14",
    due_date: "2026-07-14",
    notes: "Thank you for your business."
  });
  assert.match(generated.invoice.invoice_number, /^INV-/);
  assert.equal(generated.invoice.status, "draft");
  assert.equal(generated.invoice.balance_due_cents, 400_000);
  assert.equal(generated.invoice.render_paid_in_full, false);
  assert.equal(generated.invoice.customer.email, "ivy-invoice@example.test");
  assert.equal(generated.invoice.proposal_ref.id, created.proposal.id);
  assert.equal(generated.invoice.proposal_ref.snapshot_id, finalObligation.source.snapshot_id);

  const forcedReceiptStyle = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
    obligation_ids: [finalObligation.id],
    render_paid_in_full: true
  });
  assert.equal(forcedReceiptStyle.invoice.status, "draft");
  assert.equal(forcedReceiptStyle.invoice.balance_due_cents, 400_000);
  assert.equal(forcedReceiptStyle.invoice.render_paid_in_full, true);

  const due = await client.request("POST", `/v1/payments/organizations/${orgId}/invoices/${generated.invoice.id}/mark-due`, {});
  assert.equal(due.invoice.status, "due");
  assert.match(due.portal.live_url, /customer_portal/);

  const portalPayload = await client.request("GET", `/v1/platform/customer-portals/${due.portal.public_uuid}`);
  const portalProposal = portalPayload.resources.proposals.find((proposal: any) => proposal.proposal_id === created.proposal.id);
  const published = portalProposal.workflow.payment.obligations.find((item: any) => item.id === finalObligation.id);
  assert.equal(published.status, "due");
  assert.equal(published.invoice_id, generated.invoice.id);

  const emailed = await client.request("POST", `/v1/payments/organizations/${orgId}/invoices/${generated.invoice.id}/email`, {
    recipient: "ivy-invoice@example.test",
    include_portal_link: true,
    message: "Your final payment invoice is attached."
  });
  assert.equal(emailed.sent, true);
  const { readDocumentInstance } = await import("../documents/storage.js");
  const invoiceDocument = await readDocumentInstance(orgId, `doc_invoice_${generated.invoice.id}`);
  assert.equal(invoiceDocument.document_type, "invoice");
  assert.equal((invoiceDocument.template_ref as any).template_id, "tpl_invoice_default");
  const { listMessageRecords, listDeliveryRecords } = await import("../messaging/communications_storage.js");
  const invoiceMessage = (await listMessageRecords(orgId, { channel: "email", project_id: projectId }))
    .find((message: any) => message.tags.includes("customer-invoice"));
  assert.ok(invoiceMessage, "invoice email was recorded through organization communications");
  assert.match(String(invoiceMessage.html_body), /customer portal/i);
  assert.deepEqual((invoiceMessage.metadata as any).email.attachments, [{ name: String(generated.invoice.invoice_number).toLowerCase() + ".pdf", content_type: "application/pdf" }]);
  const invoiceDeliveries = (await listDeliveryRecords(orgId, String(invoiceMessage.id)));
  assert.equal(invoiceDeliveries[0]?.recipient_address, "ivy-invoice@example.test");
  assert.equal(invoiceDeliveries[0]?.transport_mode, "capture");

  const paid = await client.request("POST", `/v1/proposals/public/${publicToken}/payments/mock-deposit`, {
    obligation_id: finalObligation.id,
    amount_cents: 400_000
  });
  assert.equal(paid.payment.kind, "customer_final");
  assert.equal(paid.allocations[0].obligation_id, finalObligation.id);
  const portalPaidInvoice = await client.raw("GET", `/v1/proposals/public/${publicToken}/payments/receipt.pdf?payment_id=${encodeURIComponent(paid.payment.id)}`);
  assert.equal(portalPaidInvoice.statusCode, 200);
  assert.equal(portalPaidInvoice.headers["content-type"], "application/pdf");
  assert.match(String(portalPaidInvoice.headers["content-disposition"]), new RegExp(`paid-invoice-${paid.payment.id.slice(-8).toLowerCase()}\\.pdf`));
  assert.ok(portalPaidInvoice.body.length > 100);
  const missingPortalPaidInvoice = await client.raw("GET", `/v1/proposals/public/${publicToken}/payments/receipt.pdf?payment_id=payment_not_in_this_project`);
  assert.equal(missingPortalPaidInvoice.statusCode, 404);
  const invoiceAfterPayment = await client.request("GET", `/v1/payments/organizations/${orgId}/invoices/${generated.invoice.id}`);
  assert.equal(invoiceAfterPayment.invoice.status, "paid");
  assert.equal(invoiceAfterPayment.invoice.balance_due_cents, 0);

  const receiptStyle = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
    obligation_ids: [finalObligation.id],
    issue_date: "2026-07-14",
    due_date: "2026-07-14",
    notes: "Paid in full receipt."
  });
  assert.equal(receiptStyle.invoice.status, "paid");
  assert.equal(receiptStyle.invoice.total_cents, 400_000);
  assert.equal(receiptStyle.invoice.balance_due_cents, 0);
  assert.equal(receiptStyle.invoice.render_paid_in_full, true);

  const paidButStandard = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
    obligation_ids: [finalObligation.id],
    render_paid_in_full: false
  });
  assert.equal(paidButStandard.invoice.status, "paid");
  assert.equal(paidButStandard.invoice.render_paid_in_full, false);

  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/payment_settings`, {
    data: { sales_tax_enabled: true, default_sales_tax_percent: 8.25 }
  });
  const invoiceList = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`);
  assert.equal(invoiceList.settings.sales_tax_enabled, true);
  assert.equal(invoiceList.settings.default_sales_tax_percent, 8.25);
  const mixedInvoice = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
    line_items: [
      { type: "payment", obligation_id: finalObligation.id, description: "Final Payment", amount_cents: 400_000 },
      { type: "manual", description: "Permit closeout", amount_cents: 10_000 }
    ],
    tax_enabled: true,
    tax_percent: 8.25
  });
  assert.equal(mixedInvoice.invoice.line_items.length, 2);
  assert.equal(mixedInvoice.invoice.subtotal_cents, 410_000);
  assert.equal(mixedInvoice.invoice.tax_cents, 33_825);
  assert.equal(mixedInvoice.invoice.total_cents, 443_825);
  assert.equal(mixedInvoice.invoice.balance_due_cents, 43_825);
  assert.equal(mixedInvoice.invoice.render_paid_in_full, false);
  const mixedDue = await client.request("POST", `/v1/payments/organizations/${orgId}/invoices/${mixedInvoice.invoice.id}/mark-due`, {});
  assert.equal(mixedDue.invoice.status, "due");
  assert.equal(mixedDue.invoice.obligation_ids.length, 2);
  const mixedPortalPayload = await client.request("GET", `/v1/platform/customer-portals/${mixedDue.portal.public_uuid}`);
  const mixedPortalProposal = mixedPortalPayload.resources.proposals.find((proposal: any) => proposal.proposal_id === created.proposal.id);
  const mixedPublished = mixedPortalProposal.workflow.payment.obligations.find((item: any) => item.invoice_id === mixedInvoice.invoice.id);
  assert.equal(mixedPublished.balance_due_cents, 43_825);
});

test("public customer portal e-sign workflow signs proposal and records mock deposit", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const projectId = "project_customer_portal_money_test";

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "422 Portal Pay Street",
      title: "Portal Payment Roof",
      contacts: [{ id: "contact_portal_pay", role: "customer", name: "Pat Portal", email: "pat-portal@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });

  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Portal Proposal",
    contacts: [{ role: "customer", name: "Pat Portal", email: "pat-portal@example.test" }],
    editable: {
      title: "Portal Proposal",
      pricing: { total: 8800 },
      scope: {
        schema_version: 1,
        root_items: [
          {
            id: "scope_roof_replacement",
            scope_piece_id: "scope_roof_replacement",
            scope_template_id: "roof_replacement",
            type: "scope_item",
            name: "Roof Replacement",
            display_name: "Roof Replacement",
            unit: "ea",
            quantity: "1",
            unit_price: 8000,
            included: false,
            price_driving: true,
            selection: { mode: "fixed", selected: true, selectable_by: ["internal"] },
            children: [
              {
                id: "scope_underlayment",
                type: "scope_item",
                name: "Synthetic Underlayment",
                display_name: "Synthetic Underlayment",
                unit: "sq",
                quantity: "20",
                unit_price: 0,
                included: true,
                price_driving: false,
                selection: { mode: "fixed", selected: true, selectable_by: ["internal"] },
                children: []
              }
            ]
          }
        ],
        variables: {},
        measurements: {},
        selection_state: {}
      },
      pages: [
        { id: "pricing", kind: "pricing", scope_view: { root_item_id: "root", render_depth: 1, show_included_items: true } },
        { id: "signature", kind: "signature", depositAmount: 2200, completionAmount: 6600, taxAmount: 800 },
        { id: "terms", kind: "fine_print", title: "Terms", body: "Standard terms apply.", requireCustomerSignature: true }
      ]
    }
  });

  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Pat Portal", email: "pat-portal@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  const publicToken = sent.snapshot.delivery.public_token;
  assert.ok(publicToken);

  const html = await client.raw("GET", `/v1/proposals/public/${publicToken}/app`);
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /Deposit due/i);

  let publicView = await client.request("GET", `/v1/proposals/public/${publicToken}`);
  assert.equal(publicView.workflow.payment.deposit_amount_cents, 220_000);
  assert.equal(publicView.workflow.payment.tax_cents, 80_000);

  const adopted = await client.request("POST", `/v1/proposals/public/${publicToken}/esign/adopt`, {
    signer_name: "Pat Portal",
    signature: { type: "typed", text: "Pat Portal", style: "signature" },
    visitor_session_id: "visitor_test"
  });
  assert.equal(adopted.signature.signer_name, "Pat Portal");

  await client.request("POST", `/v1/proposals/public/${publicToken}/esign/slot`, {
    slot_id: "signature:customer_signature",
    page_id: "signature",
    page_index: 1,
    signer_name: "Pat Portal",
    signature: { type: "typed", text: "Pat Portal", style: "signature" }
  });
  await client.request("POST", `/v1/proposals/public/${publicToken}/esign/slot`, {
    slot_id: "terms:customer_signature",
    page_id: "terms",
    page_index: 2,
    signer_name: "Pat Portal",
    signature: { type: "typed", text: "Pat Portal", style: "signature" }
  });

  publicView = await client.request("POST", `/v1/proposals/public/${publicToken}/esign/complete`, {
    signer_name: "Pat Portal",
    signature: { type: "typed", text: "Pat Portal", style: "signature" }
  });
  assert.equal(publicView.snapshot.status, "signed");
  assert.equal(publicView.workflow.payment.deposit_due_cents, 220_000);

  const commissionPayees = await client.request("GET", `/v1/payroll/organizations/${orgId}/projects/${projectId}/payees`);
  const estimatorRole = commissionPayees.payee_roles.find((role: any) => role.role_key === "estimator");
  const insideSalesRole = commissionPayees.payee_roles.find((role: any) => role.role_key === "inside_salesperson");
  assert.equal(estimatorRole.payees[0].id, userId, "proposal creator should be the estimator when no sales appointment exists");
  assert.deepEqual(insideSalesRole.payees, [], "inside salesperson requires an appointment scheduler");
  const projectedCommissions = await client.request("GET", `/v1/payroll/organizations/${orgId}/ledger?project_id=${projectId}&kind=commission`);
  const estimatorCommissions = projectedCommissions.entries.filter((entry: any) => entry.metadata.commission_rule_id === "roof_estimator_standard");
  assert.equal(estimatorCommissions.length, 2);
  assert.ok(estimatorCommissions.every((entry: any) => entry.state === "projected"));
  assert.ok(estimatorCommissions.every((entry: any) => entry.amount_cents === 44_000));
  const clearedEstimator = await client.request("PUT", `/v1/payroll/organizations/${orgId}/projects/${projectId}/payees/estimator`, {
    label: estimatorRole.label,
    payees: [],
    metadata: estimatorRole.metadata,
    expected_revision: estimatorRole.revision
  });
  const payeesAfterClear = await client.request("GET", `/v1/payroll/organizations/${orgId}/projects/${projectId}/payees`);
  const emptyEstimatorRole = payeesAfterClear.payee_roles.find((role: any) => role.role_key === "estimator");
  assert.deepEqual(emptyEstimatorRole.payees, [], "an explicitly cleared automatic role should remain empty after reconciliation");
  assert.equal(emptyEstimatorRole.metadata.payees_explicitly_set, true);
  const restoredEstimator = await client.request("PUT", `/v1/payroll/organizations/${orgId}/projects/${projectId}/payees/estimator`, {
    label: estimatorRole.label,
    payees: estimatorRole.payees,
    metadata: emptyEstimatorRole.metadata,
    expected_revision: clearedEstimator.payee_role.revision
  });
  assert.equal(restoredEstimator.payee_role.payees[0].id, userId);
  const preDepositMoney = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(preDepositMoney.accrued_commissions_cents, 0);
  assert.equal(preDepositMoney.expense_summary.groups.some((group: any) => group.targets?.some((target: any) => target.resource_type === "commission")), false);

  const paid = await client.request("POST", `/v1/proposals/public/${publicToken}/payments/mock-deposit`, {});
  assert.equal(paid.payment.kind, "customer_deposit");
  assert.equal(paid.payment.status, "settled");
  assert.equal(paid.payment.amount_cents, 220_000);
  assert.equal(paid.snapshot.customer_payment.status, "deposit_paid");

  const recognizedCommissions = await client.request("GET", `/v1/payroll/organizations/${orgId}/ledger?project_id=${projectId}&kind=commission`);
  const depositCommission = recognizedCommissions.entries.find((entry: any) => entry.metadata.commission_installment_id === "deposit");
  const completionCommission = recognizedCommissions.entries.find((entry: any) => entry.metadata.commission_installment_id === "completion");
  assert.equal(depositCommission.state, "accrued");
  assert.equal(completionCommission.state, "projected");

  const soldProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const soldProjection = soldProject.document.data.work_projection;
  const soldRoof = soldProjection.active_instances.find((instance: any) => instance.template_id === "roof_replacement");
  assert.ok(["newly_sold_stage", "scheduled_stage"].includes(soldRoof.stage_id));
  assert.equal(soldProject.document.data.lifecycle.status, "open");
  assert.ok(soldProject.document.data.lifecycle.sold_at);

  const summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(summary.total_collected_cents, 220_000);
  assert.ok(summary.obligations.some((item: any) => item.label === "Deposit" && item.status === "paid"));
  assert.equal(summary.accrued_commissions_cents, 44_000);
  assert.equal(summary.expense_summary.by_resource.commission.actual_cents, 44_000);
  assert.equal(summary.expense_summary.by_resource.commission.current_cents, 44_000);
  const commissionExpense = summary.expense_summary.groups.find((group: any) => group.targets?.some((target: any) => target.resource_type === "commission"));
  assert.equal(commissionExpense.title, "Commissions Accrued");
  assert.equal(commissionExpense.actual_cents, 44_000);
  assert.equal(commissionExpense.projected_cents, 0);
  assert.ok(summary.expenses_to_date_cents >= 44_000);

  const portal = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`, {
    contact_id: "contact_portal_pay"
  });
  const portalPayload = await client.request("GET", `/v1/platform/customer-portals/${portal.portal.public_uuid}`);
  const shared = portalPayload.resources.proposals.find((proposal: any) => proposal.proposal_id === created.proposal.id);
  assert.ok(shared, "sent proposal should be visible in customer portal resources");
  assert.equal(shared.workflow.payment.status, "deposit_paid");
  const pricingPage = shared.pages.find((page: any) => page.kind === "pricing");
  assert.equal(pricingPage.line_items[0].label, "Roof Replacement");
  assert.equal(pricingPage.line_items[0].amount, "$8,000.00");
  assert.equal(pricingPage.line_items[1].label, "Synthetic Underlayment");
  assert.equal(pricingPage.line_items[1].included, true);
});

test("public customer portal mock deposit can be recorded before proposal signature", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_customer_portal_unsigned_payment_test";

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "118 Unsigned Pay Lane",
      title: "Unsigned Payment Roof",
      contacts: [{ id: "contact_unsigned_pay", role: "customer", name: "Una Signed", email: "una@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });

  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Unsigned Payment Proposal",
    contacts: [{ role: "customer", name: "Una Signed", email: "una@example.test" }],
    editable: {
      title: "Unsigned Payment Proposal",
      pricing: { total: 5000 },
      pages: [
        { id: "pricing", kind: "pricing", line_items: [{ label: "Roof Work", amount: 5000 }] },
        { id: "signature", kind: "signature", depositAmount: 1250, completionAmount: 3750 }
      ]
    }
  });

  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Una Signed", email: "una@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  const publicToken = sent.snapshot.delivery.public_token;
  assert.ok(publicToken);

  const paid = await client.request("POST", `/v1/proposals/public/${publicToken}/payments/mock-deposit`, {
    amount_cents: 150_000
  });
  assert.equal(paid.payment.kind, "customer_deposit");
  assert.equal(paid.payment.status, "settled");
  assert.equal(paid.payment.amount_cents, 150_000);
  assert.equal(paid.snapshot.customer_payment.status, "deposit_paid");
  assert.notEqual(paid.snapshot.status, "signed");
  assert.notEqual(paid.snapshot.delivery.state, "signed");

  const publicView = await client.request("GET", `/v1/proposals/public/${publicToken}`);
  assert.equal(publicView.workflow.payment.status, "deposit_paid");
  assert.notEqual(publicView.snapshot.status, "signed");

  await client.request("POST", `/v1/proposals/public/${publicToken}/sign`, {
    signer_name: "Una Signed",
    signature: { type: "adopt", text: "Una Signed" }
  });

  const signedMoney = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  const deposit = signedMoney.obligations.find((item: any) => item.label === "Deposit");
  const finalPayment = signedMoney.obligations.find((item: any) => item.label === "Final Payment");
  assert.equal(deposit.status, "paid");
  assert.equal(deposit.allocated_cents, 125_000);
  assert.equal(finalPayment.status, "partially_paid");
  assert.equal(finalPayment.allocated_cents, 25_000);

  const signedPublicView = await client.request("GET", `/v1/proposals/public/${publicToken}`);
  assert.equal(signedPublicView.workflow.payment.deposit_paid_cents, 125_000);
  assert.equal(signedPublicView.workflow.payment.deposit_due_cents, 0);
  assert.equal(signedPublicView.workflow.payment.remaining_cents, 350_000);
  assert.equal(signedPublicView.workflow.payment.obligations.find((item: any) => item.label === "Final Payment").allocated_cents, 25_000);

  const soldProject = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const soldProjection = soldProject.document.data.work_projection;
  assert.ok(soldProjection.instances.some((instance: any) => instance.kind === "pipeline" && instance.status === "completed"));
  assert.equal(soldProject.document.data.lifecycle.status, "completed");
  const paymentEvents = await client.request("GET", `/v1/payments/organizations/${orgId}/events?project_id=${projectId}`);
  assert.ok(paymentEvents.events.some((event: any) => event.type === "payment.automatically_applied"
    && event.payload.payment_id === paid.payment.id
    && event.payload.payment_kind === "deposit"));
});

test("expense tracking projects mixed labor, preserves receipt evidence, and groups overlapping attributions transitively", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const projectId = "project_expense_tracking_test";
  const branchBase = `/v1/workforce/organizations/${orgId}/branches/default`;

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Expense Tracking Roof", address: "77 Ledger Lane", documents: [] },
    metadata: { kind: "platform_project" }
  });

  await client.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
    compensation_profile: {
      name: "Hourly installer",
      components: [{ id: "installer_hourly", kind: "hourly", rate_cents: 4500, period: "hour" }]
    }
  });
  const salariedEmail = `salary-${Date.now()}@example.test`;
  const salariedPassword = "salary test password";
  const salariedUser = await client.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email: salariedEmail,
      password: salariedPassword,
      name: "Salary Supervisor",
      status: "active",
      role: "viewer",
      permissions: { view_projects: true },
      send_invite: false
    }
  });
  const salariedUserId = String(salariedUser.document.id);
  await client.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${salariedUserId}/profile`, {
    access_role_ids: ["crew_member"],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: "member", permissions: { view_assigned_work: true } }
    },
    compensation_profile: {
      name: "Salary supervisor",
      components: [{ id: "supervisor_salary", kind: "salary", rate_cents: 200000, period: "week", hours_per_period: 40 }]
    }
  });
  const restrictedMediaEmail = `media-viewer-${Date.now()}@example.test`;
  const restrictedMediaPassword = "media viewer test password";
  const restrictedMediaUser = await client.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email: restrictedMediaEmail,
      password: restrictedMediaPassword,
      name: "Restricted Media Viewer",
      status: "active",
      role: "custom",
      permissions: {},
      send_invite: false
    }
  });
  const restrictedMediaUserId = String(restrictedMediaUser.document.id);
  await client.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${restrictedMediaUserId}/profile`, {
    application_access: {
      management: { enabled: true, role_id: "viewer", permissions: {} },
      field: { enabled: false, role_id: "member", permissions: {} }
    }
  });
  const createdGroup = await client.request("POST", `${branchBase}/resource-groups`, {
    name: "Mixed Pay Install Team",
    members: [
      { user_id: userId, role: "installer", is_lead: true },
      { user_id: salariedUserId, role: "supervisor" }
    ],
    capability_scope_ids: ["roof_replacement"],
    compensation_profile: {
      name: "Piece-rate work",
      components: [{ id: "roof_piece", kind: "piece_rate", rate_cents: 10000, unit: "square", label: "Shingles" }]
    }
  });
  const group = createdGroup.resource_group;

  const fieldClient = createSessionClient();
  await fieldClient.request("POST", "/v1/platform/auth/login", { email: salariedEmail, password: salariedPassword, organization_id: orgId });
  const crewReceiptText = "Corner Hardware\nReceipt #FIELD-1\nTotal $42.50\n";
  const forbiddenProjectUpload = await fieldClient.raw("POST", `/v1/payments/organizations/${orgId}/receipts`, {
    project_id: projectId,
    file_name: "unauthorized-project-receipt.txt",
    content_type: "text/plain",
    file_base64: Buffer.from(crewReceiptText).toString("base64"),
    owner: { kind: "project", id: projectId }
  });
  assert.equal(forbiddenProjectUpload.statusCode, 403);
  const crewReceipt = await fieldClient.request("POST", `/v1/payments/organizations/${orgId}/receipts`, {
    file_name: "crew-purchase.txt",
    content_type: "text/plain",
    file_base64: Buffer.from(crewReceiptText).toString("base64"),
    associations: [{ kind: "resource_group", id: group.id }],
    owner: { kind: "resource_group", id: group.id },
    metadata: { source_surface: "field_app" }
  });
  assert.equal(crewReceipt.receipt.project_id, "");
  assert.equal(crewReceipt.receipt.owner.kind, "resource_group");
  assert.equal(crewReceipt.receipt.owner.id, group.id);
  assert.equal(crewReceipt.receipt.owner.verification.status, "verified");
  assert.ok(crewReceipt.receipt.associations.some((association: any) => association.kind === "organization_user" && association.id === salariedUserId));
  const fieldReceiptList = await fieldClient.request("GET", `/v1/payments/organizations/${orgId}/receipts`);
  assert.ok(fieldReceiptList.receipts.some((receipt: any) => receipt.id === crewReceipt.receipt.id));

  const materialLists: any[] = [];
  for (const [id, title, quantity, unitPrice, sortOrder] of [
    ["expense_shingles", "Shingle materials", 95, 100, 10],
    ["expense_dry_in", "Dry-in materials", 50, 100, 20],
    ["expense_gutters", "Gutter materials", 10, 100, 30]
  ] as const) {
    const created = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, {
      id,
      title,
      sort_order: sortOrder,
      resource_type: "material",
      metadata: { generated_from_scope: true },
      items: [{ name: title, quantity, unit: "unit", projected_unit_price: unitPrice }]
    });
    materialLists.push(created.material_list);
  }

  const laborListResponse = await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, {
    id: "expense_labor",
    title: "Installation labor",
    sort_order: 40,
    resource_type: "labor",
    metadata: { generated_from_scope: true },
    scope_template_id: "roof_replacement",
    assignment: { work_resource_ref: { kind: "resource_group", id: group.id, name: group.name } },
    compensation: {
      mode: "crew_default",
      resolved_mode: "hybrid",
      estimated_hours: 10,
      salary_expense_mode: "hourly",
      include_salary_as_hourly: true
    },
    items: [{
      name: "Shingles",
      quantity: 20,
      unit: "square",
      projected_unit_price: 100,
      metadata: { compensation_kind: "piece_rate" }
    }]
  });
  const laborList = laborListResponse.material_list;

  await client.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists`, {
    id: "expense_equipment",
    title: "Roofing equipment",
    sort_order: 50,
    resource_type: "equipment",
    metadata: { generated_from_scope: true },
    items: [{ name: "Disposal trailer", quantity: 1, unit: "ea", projected_unit_price: 750 }]
  });

  let expenseSummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-summary`)).expense_summary;
  const laborTarget = expenseSummary.targets.find((target: any) => target.source_id === laborList.id);
  assert.equal(laborTarget.projected_cents, 295_000);
  assert.equal(laborTarget.details.hourly_cents, 45_000);
  assert.equal(laborTarget.details.salary_cents, 50_000);
  assert.equal(laborTarget.details.piece_rate_cents, 200_000);
  assert.deepEqual(new Set(laborTarget.details.details.map((detail: any) => detail.kind)), new Set(["hourly", "salary", "piece_rate"]));

  await client.request("PATCH", `/v1/materials/organizations/${orgId}/material-lists/${laborList.id}`, {
    expected_revision: laborList.revision,
    compensation: {
      ...laborList.compensation,
      mode: "crew_default",
      resolved_mode: "hybrid",
      estimated_hours: 10,
      salary_expense_mode: "ignore",
      include_salary_as_hourly: false
    }
  });
  expenseSummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-summary`)).expense_summary;
  const salaryIgnored = expenseSummary.targets.find((target: any) => target.source_id === laborList.id);
  assert.equal(salaryIgnored.projected_cents, 245_000);
  assert.equal(salaryIgnored.details.salary_cents, 0);
  assert.ok(!salaryIgnored.details.details.some((detail: any) => detail.kind === "salary"));

  const supplemental = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/expenses`, {
    title: "Additional chimney flashing",
    resource_type: "material",
    projected_cents: 25_000,
    notes: "Supplemental field purchase"
  });
  const supplementalKey = `supplemental_expense:${supplemental.expense.id}`;
  await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-actual`, {
    target_key: supplementalKey,
    actual_cents: 28_500,
    reason: "Vendor invoice"
  });
  const invalidOverride = await client.raw("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-actual`, {
    target_key: "scope_resource_list:not-in-this-project",
    actual_cents: 1
  });
  assert.equal(invalidOverride.statusCode, 400);

  expenseSummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-summary`)).expense_summary;
  assert.deepEqual(
    expenseSummary.groups.map((group: any) => group.title),
    ["Shingle materials", "Dry-in materials", "Gutter materials", "Installation labor", "Roofing equipment", "Additional chimney flashing"]
  );
  const targetByTitle = new Map<string, any>(expenseSummary.targets.map((target: any) => [String(target.title), target]));
  const shingleKey = targetByTitle.get("Shingle materials").target_key;
  const dryInKey = targetByTitle.get("Dry-in materials").target_key;
  const gutterKey = targetByTitle.get("Gutter materials").target_key;

  const firstText = "Acme Supply\nInvoice #INV-100\nPurchase date 07/10/2026\nGrand Total $14,500.00\n";
  const firstUpload = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    file_name: "invoice-100.txt",
    content_type: "text/plain",
    file_base64: Buffer.from(firstText).toString("base64"),
    upload_location: { client: { client_timezone: "America/Los_Angeles", surface: "payments_test" } },
    metadata: { test_case: "overlapping_attribution" }
  });
  assert.equal(firstUpload.receipt.status, "ready");
  assert.equal(firstUpload.receipt.total_cents, 1_450_000);
  assert.equal(firstUpload.receipt.purchase_date, "2026-07-10");
  assert.equal(firstUpload.receipt.extraction.document_number, "INV-100");
  assert.equal(firstUpload.receipt.uploaded_by.user_id, userId);
  assert.ok(firstUpload.receipt.uploaded_at);
  assert.equal(firstUpload.receipt.upload_location, undefined);
  const organizationReceipts = await client.request("GET", `/v1/payments/organizations/${orgId}/receipts?association_kind=organization&association_id=${orgId}`);
  assert.ok(organizationReceipts.receipts.some((receipt: any) => receipt.id === firstUpload.receipt.id));
  assert.ok(organizationReceipts.receipts.some((receipt: any) => receipt.id === crewReceipt.receipt.id));
  const receiptAudit = await client.request("GET", `/v1/payments/organizations/${orgId}/receipts/${firstUpload.receipt.id}/audit`);
  assert.equal(receiptAudit.audit.file.sha256.length, 64);
  assert.ok(receiptAudit.audit.upload_location.network.request_ip);
  assert.equal(receiptAudit.audit.upload_location.browser.client.client_timezone, "America/Los_Angeles");

  const restrictedMediaClient = createSessionClient();
  await restrictedMediaClient.request("POST", "/v1/platform/auth/login", {
    email: restrictedMediaEmail,
    password: restrictedMediaPassword,
    organization_id: orgId
  });
  const restrictedMediaList = await restrictedMediaClient.request("GET", `/v1/platform/organizations/${orgId}/media`);
  assert.ok(!restrictedMediaList.media.some((media: any) => media.id === firstUpload.receipt.file.media_id));
  const restrictedMediaMetadata = await restrictedMediaClient.raw("GET", `/v1/platform/organizations/${orgId}/media/${firstUpload.receipt.file.media_id}`);
  assert.equal(restrictedMediaMetadata.statusCode, 403);
  const restrictedMediaFile = await restrictedMediaClient.raw("GET", `/v1/platform/organizations/${orgId}/media/${firstUpload.receipt.file.media_id}/file`);
  assert.equal(restrictedMediaFile.statusCode, 403);
  const restrictedMediaMarkup = await restrictedMediaClient.raw("GET", `/v1/platform/organizations/${orgId}/media/${firstUpload.receipt.file.media_id}/markup/default`);
  assert.equal(restrictedMediaMarkup.statusCode, 403);
  const restrictedMediaMarkupWrite = await restrictedMediaClient.raw("PUT", `/v1/platform/organizations/${orgId}/media/${firstUpload.receipt.file.media_id}/markup/default`, { shapes: [] });
  assert.equal(restrictedMediaMarkupWrite.statusCode, 403);
  const ownerMediaMetadata = await client.request("GET", `/v1/platform/organizations/${orgId}/media/${firstUpload.receipt.file.media_id}`);
  assert.equal(ownerMediaMetadata.media.metadata.uploaded_by_email, undefined);
  assert.equal(ownerMediaMetadata.media.metadata.test_case, undefined);
  assert.equal(ownerMediaMetadata.media.metadata.receipt_id, firstUpload.receipt.id);
  const forbiddenMediaReuse = await fieldClient.raw("POST", `/v1/payments/organizations/${orgId}/receipts`, {
    media_id: firstUpload.receipt.file.media_id,
    owner: { kind: "organization_user", id: salariedUserId }
  });
  assert.equal(forbiddenMediaReuse.statusCode, 403);

  const retryKey = `receipt-retry-${Date.now()}`;
  const retryPayload = {
    file_name: "idempotent-receipt.txt",
    content_type: "text/plain",
    file_base64: Buffer.from("Retry Supply\nReceipt #RETRY-1\nTotal $11.00\n").toString("base64")
  };
  const retryResponses = await Promise.all([
    client.raw("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, retryPayload, { "idempotency-key": retryKey }),
    client.raw("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, retryPayload, { "idempotency-key": retryKey })
  ]);
  assert.deepEqual(retryResponses.map((response: any) => response.statusCode).sort(), [200, 201]);
  const retryBodies = retryResponses.map((response: any) => JSON.parse(response.body));
  assert.equal(retryBodies[0].receipt.id, retryBodies[1].receipt.id);
  assert.deepEqual(retryBodies.map((body: any) => body.created).sort(), [false, true]);
  const retryReceiptList = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`);
  assert.equal(retryReceiptList.receipts.filter((receipt: any) => receipt.id === retryBodies[0].receipt.id).length, 1);
  const mismatchedRetry = await client.raw("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    ...retryPayload,
    file_base64: Buffer.from("Different Supply\nReceipt #RETRY-2\nTotal $12.00\n").toString("base64")
  }, { "idempotency-key": retryKey });
  assert.equal(mismatchedRetry.statusCode, 409);
  const { readDocument: readRetryDocument, upsertDocument: upsertRetryDocument } = await import("../platform/storage.js");
  const retryStored = await readRetryDocument(orgId, "payment_receipts", retryBodies[0].receipt.id);
  await upsertRetryDocument(orgId, "payment_receipts", {
    id: retryBodies[0].receipt.id,
    expected_revision: retryStored.revision,
    data: {
      ...retryStored.data,
      status: "processing",
      processing_started_at: "2000-01-01T00:00:00.000Z"
    },
    metadata: { ...retryStored.metadata, status: "processing" }
  }, { replace: true });
  const recoveredRetry = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, retryPayload, { "idempotency-key": retryKey });
  assert.equal(recoveredRetry.created, false);
  assert.equal(recoveredRetry.recovered, true);
  assert.notEqual(recoveredRetry.receipt.status, "processing");
  await client.request("DELETE", `/v1/payments/organizations/${orgId}/receipts/${retryBodies[0].receipt.id}`);
  const retryAfterVoid = await client.raw("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, retryPayload, { "idempotency-key": retryKey });
  assert.equal(retryAfterVoid.statusCode, 200);
  assert.equal(JSON.parse(retryAfterVoid.body).receipt.status, "void");

  const firstApplied = await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${firstUpload.receipt.id}/apply`, {
    target_keys: [shingleKey, dryInKey],
    title: "Acme roof package",
    total_cents: 1_450_000,
    purchase_date: "2026-07-10"
  });
  assert.equal(firstApplied.receipt.status, "applied");
  const invalidatedApplied = await client.request("PATCH", `/v1/payments/organizations/${orgId}/receipts/${firstUpload.receipt.id}`, {
    expected_revision: firstApplied.receipt.revision,
    currency: "CAD"
  });
  assert.equal(invalidatedApplied.receipt.status, "needs_review");
  const repairedApplied = await client.request("PATCH", `/v1/payments/organizations/${orgId}/receipts/${firstUpload.receipt.id}`, {
    expected_revision: invalidatedApplied.receipt.revision,
    currency: "USD"
  });
  assert.equal(repairedApplied.receipt.status, "ready");
  const reapplied = await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${firstUpload.receipt.id}/apply`, {
    expected_revision: repairedApplied.receipt.revision,
    target_keys: [shingleKey, dryInKey]
  });
  assert.equal(reapplied.receipt.status, "applied");
  const { readDocument: readPlatformDocument } = await import("../platform/storage.js");
  const storedReapplied = await readPlatformDocument(orgId, "payment_receipts", firstUpload.receipt.id);
  const storedAttribution = storedReapplied.data.attribution as any;
  assert.deepEqual(
    new Set((storedAttribution.target_snapshots as any[]).map((snapshot: any) => snapshot.target_key)),
    new Set([shingleKey, dryInKey])
  );

  const secondText = "Acme Supply\nReceipt #RCPT-200\nDate 07/11/2026\nTotal $6,000.00\n";
  const secondUpload = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    file_name: "receipt-200.txt",
    content_type: "text/plain",
    file_base64: Buffer.from(secondText).toString("base64")
  });
  await client.request("POST", `/v1/payments/organizations/${orgId}/receipts/${secondUpload.receipt.id}/apply`, {
    target_keys: [dryInKey, gutterKey],
    total_cents: 600_000
  });

  const cadUpload = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/receipts`, {
    file_name: "canadian-invoice.txt",
    content_type: "text/plain",
    file_base64: Buffer.from("North Supply\nInvoice #CAD-1\nTotal $100.00\n").toString("base64"),
    total_cents: 10_000
  });
  const cadPatched = await client.request("PATCH", `/v1/payments/organizations/${orgId}/receipts/${cadUpload.receipt.id}`, {
    expected_revision: cadUpload.receipt.revision,
    currency: "CAD"
  });
  const rejectedCurrency = await client.raw("POST", `/v1/payments/organizations/${orgId}/receipts/${cadUpload.receipt.id}/apply`, {
    expected_revision: cadPatched.receipt.revision,
    target_keys: [gutterKey]
  });
  assert.equal(rejectedCurrency.statusCode, 400);
  const voidedCad = await client.request("DELETE", `/v1/payments/organizations/${orgId}/receipts/${cadUpload.receipt.id}`);
  assert.equal(voidedCad.receipt.status, "void");
  const editVoided = await client.raw("PATCH", `/v1/payments/organizations/${orgId}/receipts/${cadUpload.receipt.id}`, { title: "Revived" });
  assert.equal(editVoided.statusCode, 409);

  expenseSummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-summary`)).expense_summary;
  const linkedGroup = expenseSummary.groups.find((groupValue: any) => groupValue.target_keys.includes(shingleKey));
  assert.equal(linkedGroup.grouped, true);
  assert.deepEqual(new Set(linkedGroup.target_keys), new Set([shingleKey, dryInKey, gutterKey]));
  assert.equal(linkedGroup.projected_cents, 1_550_000);
  assert.equal(linkedGroup.actual_cents, 2_050_000);
  assert.equal(linkedGroup.variance_cents, 500_000);
  assert.equal(linkedGroup.receipt_ids.length, 2);
  assert.deepEqual(linkedGroup.targets.map((target: any) => target.projected_cents).sort((a: number, b: number) => a - b), [100_000, 500_000, 950_000]);
  const resourceCurrent = Object.values(expenseSummary.by_resource).reduce((sum: number, value: any) => sum + Number(value.current_cents || 0), 0);
  assert.equal(resourceCurrent, expenseSummary.totals.current_cents);

  const project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const libraryReceipt = project.document.data.documents.find((document: any) => document.media_id === firstUpload.receipt.file.media_id);
  assert.equal(libraryReceipt.document_type, "receipt");
  assert.equal(libraryReceipt.type_label, "Receipt");

  const original = await client.raw("GET", `/v1/payments/organizations/${orgId}/receipts/${firstUpload.receipt.id}/file`);
  assert.equal(original.statusCode, 200);
  assert.equal(original.headers["x-content-type-options"], "nosniff");
  assert.match(String(original.headers["content-disposition"]), /^attachment;/);
  assert.equal(original.body, firstText);
  const inline = await client.raw("GET", `/v1/payments/organizations/${orgId}/receipts/${firstUpload.receipt.id}/file?inline=1`);
  assert.equal(inline.statusCode, 200);
  assert.match(String(inline.headers["content-disposition"]), firstUpload.receipt.file.support.safe_inline_preview ? /^inline;/ : /^attachment;/);

  const linkedPayable = await client.request("POST", `/v1/payments/organizations/${orgId}/payables`, {
    project_id: projectId,
    kind: "labor",
    payee_ref: { kind: "resource_group", id: group.id, name: group.name },
    expense_target_keys: [laborTarget.target_key],
    amount_cents: 100_000
  });
  assert.deepEqual(linkedPayable.payable.expense_target_keys, [laborTarget.target_key]);

  const moneySummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(moneySummary.materials.projected_cents, 1_550_000);
  assert.equal(moneySummary.expense_summary.by_resource.material.projected_cents, 1_575_000);
  assert.equal(moneySummary.labor.projected_cents, 245_000);
  assert.equal(moneySummary.expense_summary.totals.receipt_count, 2);
  assert.equal(moneySummary.projected_expenses_cents, moneySummary.expense_summary.totals.projected_cents);
  assert.ok(moneySummary.forecast_expenses_cents > moneySummary.projected_expenses_cents);

  for (const materialList of materialLists) {
    await client.request("PATCH", `/v1/materials/organizations/${orgId}/material-lists/${materialList.id}`, {
      expected_revision: materialList.revision,
      status: "archived"
    });
  }
  const archivedSummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/expense-summary`)).expense_summary;
  const archivedReceiptGroup = archivedSummary.groups.find((groupValue: any) => groupValue.receipt_ids.includes(firstUpload.receipt.id));
  assert.equal(archivedReceiptGroup.unresolved_attribution, true);
  assert.equal(archivedReceiptGroup.actual_cents, 2_050_000);
  assert.equal(archivedReceiptGroup.projected_cents, 1_550_000);
  assert.equal(archivedReceiptGroup.receipt_ids.length, 2);
  assert.equal(archivedReceiptGroup.targets.filter((target: any) => target.archived === true).length, 3);
  assert.equal(archivedSummary.totals.applied_receipt_count, 2);
  assert.equal(archivedSummary.totals.actual_cents, expenseSummary.totals.actual_cents);
  const archivedResourceCurrent = Object.values(archivedSummary.by_resource).reduce((sum: number, value: any) => sum + Number(value.current_cents || 0), 0);
  assert.equal(archivedResourceCurrent, archivedSummary.totals.current_cents);

  const zeroProjectId = "project_explicit_zero_actual_test";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${zeroProjectId}`, {
    data: { id: zeroProjectId, title: "Zero Actual Project", documents: [] },
    metadata: { kind: "platform_project" }
  });
  const zeroExpense = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${zeroProjectId}/expenses`, {
    title: "Unused allowance",
    resource_type: "other",
    projected_cents: 123_400
  });
  await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${zeroProjectId}/expense-actual`, {
    target_key: `supplemental_expense:${zeroExpense.expense.id}`,
    actual_cents: 0,
    reason: "No cost incurred"
  });
  const zeroMoneySummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${zeroProjectId}/money-summary`)).summary;
  assert.equal(zeroMoneySummary.expense_summary.totals.projected_cents, 123_400);
  assert.equal(zeroMoneySummary.expense_summary.totals.current_cents, 0);
  assert.equal(zeroMoneySummary.forecast_expenses_cents, 0);
  assert.equal(zeroMoneySummary.expense_variance_cents, -123_400);
  assert.equal(zeroMoneySummary.forecast_profit_cents, 0);

  const zeroStored = await readRetryDocument(orgId, "payment_expense_items", zeroExpense.expense.id);
  const concurrentRevisionWrites = await Promise.allSettled(["first", "second"].map((notes) => upsertRetryDocument(orgId, "payment_expense_items", {
    id: zeroExpense.expense.id,
    expected_revision: zeroStored.revision,
    data: { ...zeroStored.data, notes },
    metadata: zeroStored.metadata
  }, { replace: true })));
  assert.equal(concurrentRevisionWrites.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrentRevisionWrites.filter((result) => result.status === "rejected").length, 1);
  const zeroAfterConcurrentWrites = await readRetryDocument(orgId, "payment_expense_items", zeroExpense.expense.id);
  assert.equal(zeroAfterConcurrentWrites.revision, zeroStored.revision + 1);
});

test("organization invoices list, uninvoiced projection, quick send, production hold, and void round-trip", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_invoice_org_view_test";

  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "12 Aging Report Road",
      title: "Org Invoices Bungalow",
      contacts: [{ id: "contact_org_invoice", role: "customer", name: "Ora Invoice", email: "ora-invoice@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/payment_settings`, {
    data: { sales_tax_enabled: false, default_due_days: 14 }
  });
  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Org Invoice Proposal",
    contacts: [{ role: "customer", name: "Ora Invoice", email: "ora-invoice@example.test" }],
    editable: {
      title: "Org Invoice Proposal",
      pricing: { total: 5000 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Siding replacement", amount: 5000 }] },
        { id: "signature", kind: "signature", depositAmount: 1000, completionAmount: 4000 }
      ]
    }
  });
  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Ora Invoice", email: "ora-invoice@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  await client.request("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
    signer_name: "Ora Invoice",
    signature: { type: "adopt", text: "Ora Invoice" }
  });

  // Signed schedule but nothing invoiced yet: the org list is empty and the
  // uninvoiced projection reports both obligations, with only the deposit ready.
  const emptyList = await client.request("GET", `/v1/payments/organizations/${orgId}/invoices`);
  assert.equal(emptyList.count, 0);
  assert.equal(emptyList.summary.outstanding_count, 0);
  assert.equal(emptyList.settings.default_due_days, 14);
  const uninvoiced = await client.request("GET", `/v1/payments/organizations/${orgId}/uninvoiced`);
  const group = uninvoiced.projects.find((item: any) => item.project_id === projectId);
  assert.ok(group, "signed project appears in the uninvoiced projection");
  assert.equal(group.customer.email, "ora-invoice@example.test");
  assert.equal(group.obligations.length, 2);
  assert.equal(group.uninvoiced_cents, 500_000);
  assert.equal(group.ready_cents, 100_000);
  const depositObligation = group.obligations.find((item: any) => item.status === "due");
  const finalObligation = group.obligations.find((item: any) => item.status === "scheduled");
  assert.ok(depositObligation && finalObligation);

  // Quick invoice with no explicit selection bills only the ready deposit and
  // applies the configured payment terms to the due date.
  const draft = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices/quick`, {});
  assert.equal(draft.sent, false);
  // Status is derived from the obligations: the deposit is already due, so the
  // unsent invoice reads "due" rather than a persisted "draft".
  assert.equal(draft.invoice.status, "due");
  assert.equal(draft.invoice.email_deliveries.length, 0);
  assert.equal(draft.invoice.total_cents, 100_000);
  assert.deepEqual(draft.invoice.obligation_ids, [depositObligation.id]);
  const issueMs = Date.parse(`${draft.invoice.issue_date}T00:00:00.000Z`);
  assert.equal(draft.invoice.due_date, new Date(issueMs + 14 * 86_400_000).toISOString().slice(0, 10));

  const afterDraft = await client.request("GET", `/v1/payments/organizations/${orgId}/uninvoiced`);
  const afterDraftGroup = afterDraft.projects.find((item: any) => item.project_id === projectId);
  assert.equal(afterDraftGroup.obligations.length, 1, "invoiced deposit left the uninvoiced projection");
  assert.equal(afterDraftGroup.obligations[0].id, finalObligation.id);

  // Production hold surfaces on the org summary and the project money summary.
  const held = await client.request("POST", `/v1/payments/organizations/${orgId}/invoices/${draft.invoice.id}/production-hold`, {
    enabled: true,
    note: "Deposit required before install"
  });
  assert.equal(held.invoice.production_hold.enabled, true);
  const heldList = await client.request("GET", `/v1/payments/organizations/${orgId}/invoices`);
  assert.equal(heldList.summary.production_hold_count, 1);
  assert.equal(heldList.summary.production_hold_cents, 100_000);
  assert.equal(heldList.summary.outstanding_count, 1);
  const heldSummary = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary;
  assert.equal(heldSummary.production_hold_count, 1);
  assert.equal(heldSummary.production_holds[0].invoice_id, draft.invoice.id);
  assert.equal(heldSummary.production_holds[0].note, "Deposit required before install");
  assert.equal(heldSummary.production_hold_balance_cents, 100_000);

  // Quick send with an explicit selection emails the invoice and marks it due.
  const sentInvoice = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices/quick`, {
    obligation_ids: [finalObligation.id],
    send: true,
    recipient: "ora-invoice@example.test",
    message: "Final balance for your project."
  });
  assert.equal(sentInvoice.sent, true);
  assert.equal(sentInvoice.recipient, "ora-invoice@example.test");
  assert.equal(sentInvoice.invoice.status, "due");
  assert.equal(sentInvoice.invoice.total_cents, 400_000);

  const outstanding = await client.request("GET", `/v1/payments/organizations/${orgId}/invoices?status=due,overdue`);
  assert.equal(outstanding.count, 2, "both the deposit and final invoices derive a due status");
  assert.ok(outstanding.invoices.some((item: any) => item.id === sentInvoice.invoice.id));
  assert.equal(outstanding.summary.outstanding_cents, 500_000);

  // Voiding the draft returns its obligation to the uninvoiced pool and drops
  // it from outstanding balances without touching the proposal receivable.
  const voided = await client.request("POST", `/v1/payments/organizations/${orgId}/invoices/${draft.invoice.id}/void`, {
    reason: "Rebilling with different terms"
  });
  assert.equal(voided.invoice.status, "void");
  assert.equal(voided.invoice.balance_due_cents, 0);
  const afterVoid = await client.request("GET", `/v1/payments/organizations/${orgId}/invoices`);
  assert.equal(afterVoid.summary.outstanding_cents, 400_000);
  assert.equal(afterVoid.summary.production_hold_count, 0, "void invoices stop holding production");
  const afterVoidUninvoiced = await client.request("GET", `/v1/payments/organizations/${orgId}/uninvoiced`);
  const afterVoidGroup = afterVoidUninvoiced.projects.find((item: any) => item.project_id === projectId);
  assert.ok(afterVoidGroup.obligations.some((item: any) => item.id === depositObligation.id), "voided invoice releases its obligation");
  const depositAfterVoid = afterVoidGroup.obligations.find((item: any) => item.id === depositObligation.id);
  assert.notEqual(depositAfterVoid.status, "void", "the proposal receivable itself is not voided");
});
