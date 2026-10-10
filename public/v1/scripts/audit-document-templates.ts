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
    row.source = meta.instant_roofing_pack ? "roofing sandbox pack" : meta.intake === "upload" ? "paper intake preset" : meta.preset || meta.preset_revision ? "default preset" : meta.scope_preset || meta.industry ? `industry preset (${meta.industry || meta.scope_preset})` : "other";
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
} finally {
  console.log(JSON.stringify(rows, null, 1));
  await (await import("../tests/helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  process.exit(0);
}
