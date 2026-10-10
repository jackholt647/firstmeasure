// The production documents end to end: a signed agreement, then a change
// order, an invoice and a completion certificate against it, with the money
// each one moves. Also: system templates and the job cost report.
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => (app.inject as any)({
    method, url, payload,
    headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) }
  });
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const sessionCookie = readCookie(response.headers["set-cookie"], "fm_platform_session");
    const csrfCookie = readCookie(response.headers["set-cookie"], "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-production-docs-"));
  Object.assign(process.env, {
    NODE_ENV: "test", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

type Client = ReturnType<typeof createSessionClient>;

async function registerOrg(client: Client) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple",
    name: "Owner User", company: "Ridgeline Roofing", organization_id: `org_production_${suffix}`
  });
  const orgId = data.organization.id as string;
  await enableExpandedPlatformFixture(orgId);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, { data: { app_flags: { platform: { expanded_access: true, documents: true, proposals: true, money: true, pricebook: true, materials: true } } } }, { replace: false });
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "platform.documents": true, "documents.esign": true, "documents.payments": true, "platform.customer_portal": true, "customer_portal.payments": true, "platform.money": true, "money.take_payment": true }
  });
  return orgId;
}

async function createProject(client: Client, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "68 Northfield Rd", title: "Whitfield roof", project_type: "residential", contacts: [{ name: "Dana Whitfield", email: "dana@example.test", primary: true }], photos: [] },
    metadata: { kind: "platform_project" }
  });
}

const RECIPIENT = [{ name: "Dana Whitfield", email: "dana@example.test", role: "customer" }];

function documents(client: Client, orgId: string, projectId: string) {
  const base = `/v1/documents/organizations/${orgId}`;
  const drain = async () => { await (await import("../work/engine.js")).drainWorkEvents(200); };
  return {
    create: async (templateId: string, documentType: string, params: Record<string, unknown> = {}) =>
      (await client.request("POST", `${base}/projects/${projectId}/documents`, { document_type: documentType, template_id: templateId, params })).document,
    patch: async (id: string, params: Record<string, unknown>) => (await client.request("PATCH", `${base}/documents/${id}`, { params })).document,
    read: async (id: string) => (await client.request("GET", `${base}/documents/${id}`)).document,
    resolve: async (id: string) => client.request("POST", `${base}/documents/${id}/resolve`, {}),
    send: async (id: string) => client.request("POST", `${base}/documents/${id}/send`, { recipients: RECIPIENT, consent_contact: "office@example.test" }),
    /** The customer signs from their invitation link. */
    sign: async (sent: any, key = "sig_customer") => {
      const token = sent.signing.invitations[0].token;
      const review = await client.request("POST", `/v1/documents/public/${token}/signing/prepare`, {});
      const signed = await client.request("POST", `/v1/documents/public/${token}/outputs/${key}`, {
        value: { type: "typed", signer_name: "Dana Whitfield" }, challenge: review.challenge, content_hash: review.content_hash,
        consent: { intent: true, electronic_records: true, can_access_and_retain: true, disclosure_hash: review.disclosure.hash }
      });
      await drain();
      return signed;
    },
    /** The customer pays from the document. The amount they send is never trusted. */
    pay: async (sent: any, key: string) => {
      const token = sent.signing?.invitations?.[0]?.token || sent.snapshot.public_token;
      const response = await client.raw("POST", `/v1/documents/public/${token}/outputs/${key}`, { value: { payment_method: "card", amount_cents: 1 } });
      await drain();
      const document = response.statusCode < 400 ? (await client.request("GET", `${base}/documents/${sent.document.id}`)).document : null;
      return { status: response.statusCode, body: response.statusCode < 400 ? { document } : JSON.parse(response.body) };
    },
    output: async (sent: any, key: string, value: unknown) =>
      client.request("POST", `/v1/documents/public/${sent.signing?.invitations?.[0]?.token || sent.snapshot.public_token}/outputs/${key}`, { value }),
    obligations: async () => (await import("../payments/storage.js")).listProjectObligations(orgId, projectId, { skipFlag: true }),
    drain
  };
}

const resolvedText = (resolved: any) => JSON.stringify(resolved.resolved_definition);

test("change order, invoice and completion certificate run against a signed agreement", async () => {
  const client = createSessionClient();
  const orgId = await registerOrg(client);
  const projectId = "project_whitfield";
  await createProject(client, orgId, projectId);
  const docs = documents(client, orgId, projectId);

  // The agreement: $20,000, 30% at signing and 70% on completion.
  // (Minted as signing a proposal mints them; the sales documents have their own tests.)
  const proposal = { document: { id: "doc_signed_agreement" } };
  const terms = await import("../payments/schedule_terms.js");
  await (await import("../payments/storage.js")).ensureReceivablesFromSchedule(orgId, {
    project_id: projectId, title: "Roof replacement agreement", source: { type: "document", id: proposal.document.id, snapshot_id: "snapshot_signed" },
    items: terms.resolveScheduleItems(terms.normalizeScheduleRows([
      { id: "deposit", label: "Deposit", kind: "percent", percent: 30, payment_kind: "deposit", due_rule: "on_signature" },
      { id: "final", label: "Final payment", kind: "percent", percent: 70, payment_kind: "final", due_rule: "project_completion" }
    ]), { total_cents: 2000000, signed_at: new Date().toISOString() }),
    total_cents: 2000000, mode: "replace"
  });
  let obligations = await docs.obligations();
  assert.deepEqual(obligations.map((item) => [item.label, item.amount_cents]), [["Deposit", 600000], ["Final payment", 1400000]]);
  await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, { project_id: projectId, amount_cents: 600000, method: { type: "check" } });

  // ---- Change order -------------------------------------------------------
  let changeOrder = await docs.create("tpl_change_order_default", "change_order", { source_document_id: proposal.document.id });
  assert.equal(changeOrder.workflow_ref.workflow_id, "wfl_change_order");
  assert.equal(changeOrder.params.account.contract_cents, 2000000);
  assert.equal(changeOrder.params.account.contract_title, "Roof replacement agreement");
  changeOrder = await docs.patch(changeOrder.id, {
    reason: "Rotted decking found along the back eave during tear-off.",
    scope_items: [{ id: "deck", name: "Replace roof decking", quantity: 12, unit: "sheet", unit_price: 95 }]
  });
  let resolved = await docs.resolve(changeOrder.id);
  assert.equal(resolved.scope.params.change_cents, 114000, "the change is the sum of its lines");
  assert.equal(resolved.scope.params.new_total_cents, 2114000, "new contract total = original + change");
  assert.equal(resolved.scope.params.due_now_cents, 114000, "by default the change is due on receipt: paid in full when the customer approves it");
  assert.match(resolvedText(resolved), /\$21,140\.00/);
  assert.match(resolvedText(resolved), /Roof replacement agreement/);
  // Half on approval, half at completion.
  await docs.patch(changeOrder.id, { payment_schedule: [
    { id: "a", label: "Change order deposit", kind: "percent", percent: 50, due_rule: "on_signature", payment_kind: "deposit" },
    { id: "b", label: "Change order balance", kind: "percent", percent: 50, due_rule: "project_completion", payment_kind: "final" }
  ], deposit_at_signing: true });
  resolved = await docs.resolve(changeOrder.id);
  assert.equal(resolved.scope.params.due_now_cents, 57000);
  const sentChange = await docs.send(changeOrder.id);
  assert.equal(sentChange.document.status, "sent", "a change order is not approved until the customer signs");
  assert.equal(sentChange.document.params.new_total_cents, 2114000, "the totals the customer sees are kept on the document");
  const signedChange = await docs.sign(sentChange);
  assert.equal(signedChange.document.status, "completed");
  obligations = await docs.obligations();
  const byLabel = (label: string) => obligations.find((item) => item.label === label) as any;
  assert.equal(byLabel("Final payment").amount_cents, 1400000, "the agreement's own schedule is untouched");
  assert.deepEqual(obligations.filter((item) => item.kind === "change_order").map((item) => item.amount_cents).sort(), [57000, 57000]);
  const paidChange = await docs.pay(sentChange, "payment");
  assert.equal(paidChange.status, 200, JSON.stringify(paidChange.body));
  assert.equal(paidChange.body.document.outputs.payment.amount_cents, 57000, "the amount due on approval, not what the browser sent");
  obligations = await docs.obligations();
  assert.equal(byLabel("Change order deposit").status, "paid");
  assert.equal(byLabel("Final payment").allocated_cents, 0, "the payment went to the change order, not the next open payment");

  // ---- Invoice ------------------------------------------------------------
  let invoice = await docs.create("tpl_invoice_default", "invoice");
  assert.equal(invoice.workflow_ref.workflow_id, "wfl_invoice");
  assert.match(invoice.params.invoice_number, /^INV-\d{6}-/);
  assert.equal(invoice.params.account.total_cents, 2114000);
  assert.equal(invoice.params.account.paid_cents, 657000);
  const options = invoice.params.account.bill_options;
  assert.deepEqual(options.map((option: any) => [option.label, option.price_cents ?? null]), [
    ["Final payment", 1400000], ["Change order balance", 57000], ["Remaining balance", 1457000], ["Other charges only", null]
  ]);
  const finalPayment = byLabel("Final payment");
  await docs.patch(invoice.id, { bill: finalPayment.id, due_date: "2026-11-15", line_items: [{ id: "permit", name: "Building permit", quantity: 1, unit: "ea", unit_price: 150 }] });
  resolved = await docs.resolve(invoice.id);
  assert.deepEqual(resolved.scope.params.billing.lines.map((line: any) => [line.label, line.amount_cents]), [["Final payment", 1400000], ["Building permit", 15000]]);
  assert.equal(resolved.scope.params.amount_due_cents, 1415000);
  assert.match(resolvedText(resolved), /\$14,150\.00/);
  // A payment recorded before the invoice goes out lowers what it asks for.
  await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, { project_id: projectId, amount_cents: 400000, method: { type: "check" }, obligation_id: finalPayment.id });
  resolved = await docs.resolve(invoice.id);
  assert.equal(resolved.scope.params.amount_due_cents, 1015000);
  assert.equal(resolved.scope.params.account.paid_cents, 1057000);
  const sentInvoice = await docs.send(invoice.id);
  obligations = await docs.obligations();
  assert.equal(String(byLabel("Final payment").due_at).slice(0, 10), "2026-11-15", "sending the invoice makes the billed payment due");
  const charges = obligations.find((item) => /^Invoice INV-/.test(String(item.label))) as any;
  assert.equal(charges.amount_cents, 15000, "charges outside the agreement become a receivable");
  const paidInvoice = await docs.pay(sentInvoice, "payment");
  assert.equal(paidInvoice.status, 200, JSON.stringify(paidInvoice.body));
  assert.equal(paidInvoice.body.document.outputs.payment.amount_cents, 1015000);
  assert.equal(paidInvoice.body.document.status, "completed");
  obligations = await docs.obligations();
  assert.equal(byLabel("Final payment").status, "paid");
  assert.equal(obligations.find((item) => item.id === charges.id)?.status, "paid");
  assert.equal(byLabel("Change order balance").allocated_cents, 0, "an invoice pays only what it bills");

  // ---- Completion certificate ---------------------------------------------
  let certificate = await docs.create("tpl_roofing_completion_certificate", "completion_certificate");
  assert.equal(certificate.workflow_ref.workflow_id, "wfl_roofing_completion_signoff");
  assert.equal(certificate.params.amount_due_cents, 57000, "what is left on the contract");
  assert.equal(certificate.params.warranty_start, certificate.params.completed_at);
  resolved = await docs.resolve(certificate.id);
  assert.match(resolvedText(resolved), /None\. Everything in the agreement has been completed\./);
  certificate = await docs.patch(certificate.id, { punch_list: "Touch up paint on the front fascia" });
  const sentCertificate = await docs.send(certificate.id);
  assert.equal(sentCertificate.document.status, "sent");
  await docs.output(sentCertificate, "completion_ack", "accepted");
  const signedCertificate = await docs.sign(sentCertificate);
  assert.equal(signedCertificate.document.status, "completed", "acknowledgement and signature complete the certificate");
  obligations = await docs.obligations();
  assert.ok(byLabel("Change order balance").due_at, "the customer's sign-off makes completion payments due");
  const paidFinal = await docs.pay(sentCertificate, "final_payment");
  assert.equal(paidFinal.status, 200, JSON.stringify(paidFinal.body));
  assert.equal(paidFinal.body.document.outputs.final_payment.amount_cents, 57000);
  obligations = await docs.obligations();
  assert.ok(obligations.every((item) => item.status === "paid"), "the project is paid in full");
  assert.equal((await docs.pay(sentCertificate, "final_payment")).status, 409, "nothing is left to pay");

  // ---- Job cost report, with activity --------------------------------------
  const report = await docs.create("tpl_money_report_default", "report");
  const reportData = Object.values((await docs.resolve(report.id)).widget_data) as any[];
  const metrics = reportData.find((data) => Array.isArray(data?.metrics)).metrics;
  const metric = (key: string) => metrics.find((entry: any) => entry.key === key).amount_cents;
  assert.equal(metric("contract_value"), 2129000);
  assert.equal(metric("change_orders"), 114000);
  assert.equal(metric("collected"), 2129000);
  assert.equal(metric("balance"), 0);
  assert.equal(reportData.find((data) => data?.totals?.inbound_cents !== undefined).rows.length, 5, "every payment is listed");
});

test("a project with no signed agreement or activity still reads sensibly", async () => {
  const client = createSessionClient();
  const orgId = await registerOrg(client);
  const projectId = "project_empty";
  await createProject(client, orgId, projectId);
  const docs = documents(client, orgId, projectId);

  const changeOrder = await docs.create("tpl_change_order_default", "change_order");
  assert.equal(changeOrder.params.account.has_contract, false);
  await docs.patch(changeOrder.id, { reason: "Add gutter guards", scope_items: [{ id: "g", name: "Gutter guards", quantity: 80, unit: "ft", unit_price: 9 }] });
  const resolvedChange = await docs.resolve(changeOrder.id);
  assert.equal(resolvedChange.scope.params.new_total_cents, 72000);

  const invoice = await docs.create("tpl_invoice_default", "invoice");
  assert.deepEqual(invoice.params.account.bill_options.map((option: any) => option.value), ["custom"]);
  await docs.patch(invoice.id, { bill: "custom", line_items: [{ id: "r", name: "Emergency roof repair", quantity: 1, unit: "ea", unit_price: 450 }] });
  assert.equal((await docs.resolve(invoice.id)).scope.params.amount_due_cents, 45000);

  const certificate = await docs.create("tpl_roofing_completion_certificate", "completion_certificate");
  assert.equal(certificate.params.amount_due_cents, 0);

  const report = await docs.create("tpl_money_report_default", "report");
  const reportData = Object.values((await docs.resolve(report.id)).widget_data) as any[];
  assert.equal(reportData.length, 3);
  assert.ok(reportData.every((data) => data !== null), "an empty project gets empty tables, not missing widgets");
  assert.deepEqual(reportData.filter((data) => Array.isArray(data.rows)).map((data) => data.rows.length), [0, 0]);
});

test("system templates are marked, and paper intake stays an upload template", async () => {
  const client = createSessionClient();
  const orgId = await registerOrg(client);
  const { templates } = await client.request("GET", `/v1/documents/organizations/${orgId}/templates`);
  const meta = (id: string) => templates.find((template: any) => template.id === id).metadata;
  assert.equal(meta("tpl_payment_receipt_default").system, true);
  assert.equal(meta("tpl_payroll_report_default").system, true);
  for (const id of ["tpl_change_order_default", "tpl_invoice_default", "tpl_roofing_completion_certificate", "tpl_money_report_default", "tpl_roofing_paper_upload"]) {
    assert.notEqual(meta(id).system, true, `${id} can be started by hand`);
  }
  assert.equal(meta("tpl_roofing_paper_upload").intake, "upload");
  assert.equal(meta("tpl_change_order_default").default_workflow_id, "wfl_change_order");
  assert.equal(meta("tpl_invoice_default").default_workflow_id, "wfl_invoice");
  assert.equal(meta("tpl_roofing_completion_certificate").default_workflow_id, "wfl_roofing_completion_signoff");
});
