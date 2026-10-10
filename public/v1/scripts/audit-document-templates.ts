// Audits every document template a new organization gets: where it comes
// from, and whether a document can be made from it with nothing but a project.
//   node --experimental-sqlite --import tsx scripts/audit-document-templates.ts
// Runs against a throwaway sandbox organization in a temp directory.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const root = await mkdtemp(path.join(os.tmpdir(), "template-audit-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: root, PRICEBOOK_STORAGE_ROOT: path.join(root, "pricebook"), PLATFORM_HEARTBEAT_DISABLED: "1", SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"), FIRSTMEASURE_DATA_ENVIRONMENT: "development", EMAIL_OUTBOUND_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", V1_LOG_LEVEL: "error" });
const rows: Row[] = [];
const production: Row[] = [];
const sales: Row[] = [];
try {
  const storage = await import("../platform/storage.js");
  const signup = await import("../signup-sandbox/service.js");
  await signup.ensureSeedData();
  const { authContext: ctx } = await signup.createTestInstance("swf_instant_full_org");
  const documents = await import("../documents/service.js");
  const store = await import("../documents/storage.js");
  const { FMDocModel } = await import("../documents/schemas.js");
  const { documentType } = await import("../documents/types/registry.js");
  const { ensureDefaultDocumentAssets } = await import("../documents/seeds.js");
  await ensureDefaultDocumentAssets(ctx.orgId, ctx);
  const project = await storage.upsertDocument(ctx.orgId, "projects", { id: "project_template_audit", data: { title: "Audit project", branch_id: "default", address: "1 Ridge Road", contacts: [{ name: "Pat Homeowner", email: "pat@example.test", primary: true }] } });
  const templates = (await store.listDocumentTemplates(ctx.orgId)).map(object).filter(template => String(template.status) !== "archived");
  for (const template of templates) {
    const id = String(template.id), meta = object(template.metadata), kind = String(template.document_type);
    const row: Row = { id, name: template.name, kind, status: template.status };
    row.source = meta.instant_roofing_pack ? "roofing sales pack" : meta.intake === "upload" ? "paper intake preset" : meta.preset || meta.preset_revision ? "default preset" : meta.scope_preset || meta.industry ? `industry preset (${meta.industry || meta.scope_preset})` : "other";
    const problems: string[] = [];
    try {
      const version = object(await store.readDocumentTemplateVersion(ctx.orgId, id, Number(template.current_version || 1)));
      const definition = object(version.definition);
      const valid = FMDocModel.validateDocument(definition);
      if (!valid.ok) problems.push(`invalid layout: ${valid.errors.slice(0, 2).map(error => error.message).join("; ")}`);
      row.pages = list(definition.pages).length;
      row.params = Object.keys(object(definition.params)).length;
      row.outputs = Object.keys(object(definition.outputs)).join(",");
      const workflowId = String(meta.default_workflow_id || (meta.disable_default_workflow === true ? "" : documentType(kind)?.default_workflow_id || ""));
      row.workflow = workflowId || "none";
      if (workflowId) {
        const workflow = await store.readDocumentWorkflow(ctx.orgId, workflowId).catch(() => null);
        if (!workflow) problems.push(`names workflow ${workflowId}, which does not exist`);
        else {
          const steps = list(object(object(await store.readDocumentWorkflowVersion(ctx.orgId, workflowId, Number(object(workflow).current_version || 1))).definition).steps).map(object);
          row.steps = steps.map(step => `${step.id}[${list(step.items).map(item => object(item).kind).join("+")}]`).join(" ");
        }
      }
      if (meta.intake === "upload") { row.result = "paper intake (no layout to fill)"; rows.push(row); continue; }
      // Can a document be made from it for a project, with defaults only?
      const created = object(await documents.createDocumentInstance(ctx.orgId, String(project.id), { document_type: kind, template_id: id }, ctx));
      const document = object(created.document);
      const resolved = object(await documents.resolveDocumentInstance(ctx.orgId, document as never, { target: "static" }));
      const text = JSON.stringify(resolved.resolved_definition || {});
      const unresolved = (text.match(/\{\{[^}]{1,80}\}\}/g) || []);
      if (unresolved.length) problems.push(`${unresolved.length} unfilled bindings, e.g. ${[...new Set(unresolved)].slice(0, 3).join(" ")}`);
      const missing = list(resolved.missing_params || object(resolved.scope).missing_params);
      if (missing.length) problems.push(`needs inputs: ${missing.slice(0, 6).join(", ")}`);
      const widgetData = object(resolved.widget_data);
      const emptyWidgets = Object.entries(widgetData).filter(([, data]) => data === null || (Array.isArray(object(data).rows) && !list(object(data).rows).length));
      row.widgets = Object.keys(widgetData).length;
      if (emptyWidgets.length) problems.push(`${emptyWidgets.length} of ${Object.keys(widgetData).length} data widgets have nothing to show without input`);
      const totals = object(object(resolved.scope).params);
      row.total = list(totals.scope_items).length ? "priced lines" : "";
      row.result = problems.length ? "opens, incomplete" : "opens clean";
    } catch (error) {
      problems.push(`cannot create: ${error instanceof Error ? error.message : String(error)}`.slice(0, 220));
      row.result = "fails";
    }
    row.problems = problems.join(" | ");
    rows.push(row);
  }
  // The production documents against a signed agreement: $20,000, 30% paid
  // at signing. Each line is what the document would tell the customer.
  await (await import("../tests/helpers/platform-fixture.js")).enableExpandedPlatformFixture(ctx.orgId);
  await storage.saveGlobal(ctx.orgId, { data: { app_flags: { platform: { expanded_access: true, money: true, documents: true } } } }, { replace: false });
  const payments = await import("../payments/storage.js");
  const terms = await import("../payments/schedule_terms.js");
  const projectId = String(project.id);
  await payments.ensureReceivablesFromSchedule(ctx.orgId, {
    project_id: projectId, title: "Roof replacement agreement", source: { type: "document", id: "doc_signed_agreement", snapshot_id: "signed" },
    items: terms.resolveScheduleItems(terms.normalizeScheduleRows([
      { id: "deposit", label: "Deposit", kind: "percent", percent: 30, payment_kind: "deposit", due_rule: "on_signature" },
      { id: "final", label: "Final payment", kind: "percent", percent: 70, payment_kind: "final", due_rule: "project_completion" }
    ]), { total_cents: 2000000, signed_at: new Date().toISOString() }),
    total_cents: 2000000, mode: "replace"
  });
  await payments.createPayment(ctx.orgId, { project_id: projectId, amount_cents: 600000, method: { type: "check" } }, ctx);
  const money = (cents: unknown) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
  const make = async (kind: string, templateId: string, params: Row) => {
    const created = object((await documents.createDocumentInstance(ctx.orgId, projectId, { document_type: kind, template_id: templateId, params }, ctx)).document);
    const resolved = object(await documents.resolveDocumentInstance(ctx.orgId, created as never, { target: "static" }));
    return { document: created, params: object(object(resolved.scope).params) };
  };
  const change = await make("change_order", "tpl_change_order_default", { source_document_id: "doc_signed_agreement", reason: "Rotted decking", scope_items: [{ id: "deck", name: "Replace roof decking", quantity: 12, unit: "sheet", unit_price: 95 }] });
  production.push({ document: "change order", workflow: object(change.document.workflow_ref).workflow_id, original_contract: money(object(change.params.account).contract_cents), this_change: money(change.params.change_cents), new_total: money(change.params.new_total_cents), due_on_approval: money(change.params.due_now_cents) });
  const final = list(object((await make("invoice", "tpl_invoice_default", {})).params.account).schedule).map(object).find(item => item.label === "Final payment");
  const invoice = await make("invoice", "tpl_invoice_default", { bill: object(final).id, line_items: [{ id: "permit", name: "Building permit", quantity: 1, unit_price: 150 }] });
  production.push({ document: "invoice", workflow: object(invoice.document.workflow_ref).workflow_id, number: invoice.params.invoice_number, lines: list(object(invoice.params.billing).lines).map(object).map(line => `${line.label} ${money(line.amount_cents)}`).join(" + "), paid_so_far: money(object(invoice.params.account).paid_cents), amount_due: money(invoice.params.amount_due_cents) });
  const certificate = await make("completion_certificate", "tpl_roofing_completion_certificate", {});
  production.push({ document: "completion certificate", workflow: object(certificate.document.workflow_ref).workflow_id, completed: certificate.params.completed_at, warranty_starts: certificate.params.warranty_start, final_payment: money(certificate.params.amount_due_cents) });
  production.push({ document: "new document picker", hidden_system_templates: templates.filter(template => object(template.metadata).system === true).map(template => template.id).join(", ") });
  // The sales proposals with a scope generated from one roof (29.6 squares,
  // 197 ft of eaves): what the customer is quoted, option by option.
  {
    const { ROOFING_ESTIMATES } = await import("../signup-sandbox/roofing-documents.js");
    const { generatePieceScope } = await import("../pricebook/scope-generation.js");
    const { getOrganizationPricebook } = await import("../pricebook/storage.js");
    const { documentCompletion } = await import("../documents/modules/presentation-service.js");
    const catalog = (await getOrganizationPricebook(ctx.orgId)).catalog;
    const dollars = (cents: unknown) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
    const roof = { roofSquares: 29.6, wastePercent: 10, eavesLf: 197.25, rakesLf: 208.6, ridgesLf: 93.4, hipsLf: 0, valleyLf: 16.2, sideWallLf: 82.8, headWallLf: 4.5 };
    for (const spec of ROOFING_ESTIMATES) {
      if (!spec.scope) continue;
      const root = generatePieceScope(catalog, spec.scope, spec.scope === "gutters" ? { gutterLf: 180, downspoutLf: 60 } : roof, spec.variant);
      const created = object(await documents.createDocumentInstance(ctx.orgId, String(project.id), { document_type: "proposal", template_id: `tpl_instant_roofing_${spec.key}`, params: { scope_items: [root] } }, ctx));
      const resolved = object(await documents.resolveDocumentInstance(ctx.orgId, object(created.document) as never, { target: "static" }));
      const params = object(object(resolved.scope).params);
      const printed = list(params.scope_rows).map(object);
      const completion = await documentCompletion(ctx.orgId, object(created.document));
      sales.push({
        document: spec.title, template: `tpl_instant_roofing_${spec.key}`, workflow: object(object(created.document).workflow_ref).workflow_id, presentation: completion.presentation?.moduleId || "none",
        pages: list(object(resolved.resolved_definition).pages).length,
        total: dollars(list(params.scope_items).map(object).reduce((sum, item) => sum + Number(item.amount_cents || 0), 0)),
        printed_lines: printed.filter(row => Number(row.depth) > 0).length,
        lines_add_up: printed.filter(row => Number(row.depth) === 1).reduce((sum, row) => sum + Number(row.amount_cents || 0), 0) === list(params.scope_items).map(object).reduce((sum, item) => sum + Number(item.amount_cents || 0), 0),
        zero_quantity_lines: printed.filter(row => Number(row.depth) > 0 && !(Number(row.quantity) > 0)).length,
        ...(list(params.scope_packages).length ? { options: list(params.scope_packages).map(object).map(option => `${option.name} ${dollars(option.price_cents)}${option.selected ? " (selected)" : ""}`).join(", ") } : {}),
        optional_lines: list(root.children).map(object).filter(line => object(line.selection).mode === "optional").map(line => `${line.name} ${dollars(Math.round(Number(line.quantity) * Number(line.unit_price) * 100))}`).join(", ")
      });
    }
  }
} finally {
  console.log(JSON.stringify(rows, null, 1));
  console.log(JSON.stringify({ production }, null, 1));
  console.log(JSON.stringify({ sales }, null, 1));
  await (await import("../tests/helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  process.exit(0);
}
