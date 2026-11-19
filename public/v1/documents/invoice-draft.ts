import type { JsonObject } from "../platform/storage.js";
import { readDocument } from "../platform/storage.js";
import { notFound } from "../platform/errors.js";
import { deriveAccountParams } from "./account.js";
import { documentCapabilityState, filterDocumentDefinitionByCapabilities, filterParamDefinitionsByCapabilities } from "./capability_policy.js";
import { ensureDefaultDocumentAssets } from "./library-copies.js";
import { FMDocModel } from "./schemas.js";
import { documentScopeEntities, resolveDocumentInstance, resolveDocumentParams, typeDefinitionFor } from "./service.js";
import { readDefaultDocumentThemeId } from "./settings.js";
import { readDocumentTemplate, readDocumentTemplateVersion, readDocumentThemeVersion, readDocumentWorkflow, readDocumentWorkflowVersion } from "./storage.js";

/**
 * The invoice document's workflow outside Docs (GP-104). Finances › Generate invoice runs the same one-step workflow
 * (wfl_invoice) over the same template (tpl_invoice_default) as an invoice made in Docs, with its live preview; the
 * invoice it then makes is the Finances invoice (payments/invoices.ts), which has its own document. So the draft here
 * is an invoice document that is never saved: built from the template and workflow, its params kept by the caller,
 * and resolved as a saved one would be. Started (`start`), it takes a new invoice's numbers, dates and sales tax.
 * It is styled as the Finances invoice's PDF is: the organization's style for invoices, with the page refitted.
 */
export const INVOICE_DRAFT_TEMPLATE_ID = "tpl_invoice_default";
export const INVOICE_DRAFT_WORKFLOW_ID = "wfl_invoice";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

export async function resolveInvoiceDraft(orgId: string, projectId: string, input: { params?: JsonObject; start?: boolean }) {
  const project = asObject(asObject(await readDocument(orgId, "projects", projectId).catch(() => null)).data);
  if (!Object.keys(project).length) throw notFound("project_not_found", "Project was not found.");
  await ensureDefaultDocumentAssets(orgId).catch(() => null);
  const capabilityState = await documentCapabilityState(orgId);
  const template = await readDocumentTemplate(orgId, INVOICE_DRAFT_TEMPLATE_ID);
  const templateVersion = Number(template.current_version || 0);
  const definition = filterDocumentDefinitionByCapabilities(asObject(asObject(await readDocumentTemplateVersion(orgId, INVOICE_DRAFT_TEMPLATE_ID, templateVersion)).definition), capabilityState);
  const workflow = await readDocumentWorkflow(orgId, INVOICE_DRAFT_WORKFLOW_ID);
  const workflowVersion = Number(workflow.current_version || 0);
  const workflowDefinition = asObject(asObject(await readDocumentWorkflowVersion(orgId, INVOICE_DRAFT_WORKFLOW_ID, workflowVersion)).definition);
  const typeDef = typeDefinitionFor("invoice");
  const paramDefs = filterParamDefinitionsByCapabilities({ ...typeDef.param_schema, ...asObject(definition.params) }, capabilityState);
  const themeId = await readDefaultDocumentThemeId(orgId, "invoice").catch(() => null);
  const theme = themeId ? asObject(asObject(await readDocumentThemeVersion(orgId, themeId).catch(() => null)).definition) : {};
  const styled = !!themeId && Object.keys(theme).length > 0 && themeId !== cleanText(asObject(definition.theme_ref).theme_id);
  const document: JsonObject = {
    id: `invoice_draft_${projectId}`,
    organization_id: orgId,
    branch_id: cleanText(project.branch_id || "default") || "default",
    project_id: projectId,
    document_type: "invoice",
    title: "Invoice",
    template_ref: { template_id: INVOICE_DRAFT_TEMPLATE_ID, version: templateVersion },
    workflow_ref: { workflow_id: INVOICE_DRAFT_WORKFLOW_ID, version: workflowVersion },
    theme_ref: styled ? { theme_id: themeId } : (cleanText(asObject(definition.theme_ref).theme_id) ? asObject(definition.theme_ref) : null),
    overrides: styled ? FMDocModel.pageSetupOverrides(definition, theme) : [],
    param_defs: paramDefs,
    params: {},
    outputs: {},
    status: "draft"
  };
  let params = asObject(input.params);
  if (input.start === true) {
    const entities = await documentScopeEntities(orgId, { project_id: projectId }, params);
    params = await deriveAccountParams(orgId, document, resolveDocumentParams(paramDefs, params, entities), { creating: true });
  }
  document.params = params;
  const resolved = await resolveDocumentInstance(orgId, document);
  return {
    workflow: workflowDefinition,
    // What the workflow edits; the figures derived from it (billing, the amount due) are in resolved.scope.params.
    params,
    resolved: {
      resolved_definition: resolved.resolved_definition,
      widget_data: resolved.widget_data,
      sources: resolved.sources,
      theme: resolved.theme,
      theme_vars: resolved.theme_vars,
      scope: resolved.scope
    }
  };
}
