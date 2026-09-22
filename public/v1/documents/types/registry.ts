import type { JsonObject } from "../../platform/storage.js";

/**
 * Document type registry — the "what kind of thing is this" layer.
 * Types are code registered under stable ids and referenced from data,
 * exactly like registerWorkAutomation in the work engine.
 */
export type DocumentTypeDefinition = {
  id: string;
  label: string;
  icon: string;
  param_schema: JsonObject;
  output_schema: JsonObject;
  default_theme_id?: string;
  /** Workflow attached to new instances when neither the caller nor the template picks one (types are bundles: contract + template + workflow). */
  default_workflow_id?: string;
  seeded_templates?: string[];
  behaviors?: { on_signed?: string[] };
};

const registry = new Map<string, DocumentTypeDefinition>();

export function registerDocumentType(id: string, definition: Omit<DocumentTypeDefinition, "id">) {
  const cleaned = String(id || "").trim().toLowerCase();
  if (!cleaned) throw new Error("registerDocumentType requires an id.");
  registry.set(cleaned, { ...definition, id: cleaned });
}

export function documentType(id: string): DocumentTypeDefinition | null {
  return registry.get(String(id || "").trim().toLowerCase()) || null;
}

export function listDocumentTypes(): DocumentTypeDefinition[] {
  return [...registry.values()];
}

// ---------------------------------------------------------------------------
// Built-in types (v1)
// ---------------------------------------------------------------------------

registerDocumentType("proposal", {
  label: "Proposal",
  icon: "fa-file-signature",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    scope_items: { type: "list", items: { type: "pricebook_line" } },
    // Measurements come from the project/scope by default — the creation flow
    // interpolates this at issue time so users never hand-enter them.
    measurements: { type: "measurements", label: "Measurements", default: "{{project.measurements}}" },
    payment_schedule: { type: "payment_schedule", label: "Payment schedule" },
    deposit_cents: { type: "currency", label: "Deposit" },
    hero_photo: { type: "media", kinds: ["image"], label: "Hero photo" },
    tax_percent: { type: "percent", label: "Tax percent" }
  },
  output_schema: {
    sig_customer: { type: "signature", required: true, signer: "customer" },
    selections: { type: "select", from_widget: "doc.line_items" },
    deposit_payment: { type: "payment", obligation: "deposit", required_for: "completed" }
  },
  default_theme_id: "thm_margin",
  default_workflow_id: "wfl_roofing_proposal_intake",
  seeded_templates: ["tpl_proposal_default"],
  behaviors: { on_signed: ["scopes.activateFromProposal.v1", "payments.ensureReceivables.v1"] }
});

registerDocumentType("invoice", {
  label: "Invoice",
  icon: "fa-file-invoice-dollar",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    invoice_number: { type: "string" },
    issue_date: { type: "date" },
    due_date: { type: "date" },
    line_items: { type: "list", items: { type: "pricebook_line" } },
    tax_percent: { type: "percent" },
    amount_due_cents: { type: "currency" }
  },
  output_schema: {
    payment: { type: "payment", required_for: "completed" }
  },
  default_theme_id: "thm_clean",
  seeded_templates: ["tpl_invoice_default"]
});

registerDocumentType("change_order", {
  label: "Change Order",
  icon: "fa-file-pen",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    source_document_id: { type: "string" },
    reason: { type: "text" },
    scope_items: { type: "list", items: { type: "pricebook_line" } },
    amount_cents: { type: "currency" },
    payment_schedule: { type: "payment_schedule" }
  },
  output_schema: {
    sig_customer: { type: "signature", required: true, signer: "customer" },
    payment: { type: "payment", required_for: "completed" }
  },
  default_theme_id: "thm_margin",
  seeded_templates: ["tpl_change_order_default"],
  // Signed change orders APPEND obligations to the project's receivables —
  // contract total becomes base + change orders without touching the base
  // schedule (documents/receivables.ts picks append mode for this type).
  behaviors: { on_signed: ["payments.ensureReceivables.v1"] }
});

registerDocumentType("contract", {
  label: "Contract",
  icon: "fa-file-contract",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    body: { type: "text" },
    effective_date: { type: "date" }
  },
  output_schema: {
    sig_customer: { type: "signature", required: true, signer: "customer" },
    sig_company: { type: "signature", required: false, signer: "internal" }
  },
  default_theme_id: "thm_clean",
  // Showcase one-page roofing agreement (spec §10.5); its rep-driven fill
  // workflow rides in via the template's metadata.default_workflow_id.
  seeded_templates: ["tpl_one_page_legal"]
});

registerDocumentType("work_order", {
  label: "Work Order",
  icon: "fa-clipboard-list",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    scope_items: { type: "list", items: { type: "pricebook_line" } },
    scheduled_date: { type: "date" },
    crew_notes: { type: "text" }
  },
  output_schema: {
    sig_crew: { type: "signature", required: false, signer: "internal" }
  },
  default_theme_id: "thm_clean"
});

registerDocumentType("completion_certificate", {
  label: "Completion Certificate",
  icon: "fa-flag-checkered",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    completed_at: { type: "date", label: "Completion date" },
    work_summary: { type: "text", label: "Completed work" },
    warranty_summary: { type: "text", label: "Warranty summary" },
    final_payment_cents: { type: "currency", label: "Final payment" }
  },
  output_schema: {
    completion_ack: { type: "select", required: true },
    sig_customer: { type: "signature", required: true, signer: "customer" },
    final_payment: { type: "payment", obligation: "final", required_for: "completed" }
  },
  default_theme_id: "thm_clean",
  default_workflow_id: "wfl_roofing_completion_signoff",
  seeded_templates: ["tpl_roofing_completion_certificate"],
  behaviors: { on_signed: ["projects.recordCompletionSigned.v1", "payments.ensureReceivables.v1"] }
});

// Internal-facing money/job-cost reports generated from the Money tab. Built
// on the same template/snapshot/PDF pipeline as customer documents so future
// customization rides for free, but with no outputs — a report is never
// signed, and nothing surfaces it in the customer portal or media editor.
registerDocumentType("report", {
  label: "Report",
  icon: "fa-chart-column",
  param_schema: {
    project: { type: "entity", entity: "project" },
    report_title: { type: "string", label: "Report title" },
    period_from: { type: "date", label: "Period start" },
    period_to: { type: "date", label: "Period end" },
    notes: { type: "text", label: "Notes" }
  },
  output_schema: {},
  default_theme_id: "thm_clean",
  seeded_templates: ["tpl_money_report_default"]
});

registerDocumentType("payroll_report", {
  label: "Payroll Report",
  icon: "fa-file-invoice-dollar",
  param_schema: {
    report_title: { type: "string", label: "Report title" },
    coverage_label: { type: "string", label: "Coverage" },
    generated_at: { type: "date", label: "Generated" },
    columns: { type: "list", items: { type: "object" } },
    rows: { type: "list", items: { type: "object" } }
  },
  output_schema: {},
  default_theme_id: "thm_clean",
  seeded_templates: ["tpl_payroll_report_default"]
});

registerDocumentType("payment_receipt", {
  label: "Payment Receipt",
  icon: "fa-receipt",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    receipt_number: { type: "string" },
    payment_date: { type: "date" },
    amount_cents: { type: "currency" },
    payment_method: { type: "string" },
    status: { type: "string" }
  },
  output_schema: {},
  default_theme_id: "thm_clean",
  seeded_templates: ["tpl_payment_receipt_default"]
});

registerDocumentType("generic", {
  label: "Document",
  icon: "fa-file-lines",
  param_schema: {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    title: { type: "string" },
    body: { type: "text" }
  },
  output_schema: {},
  default_theme_id: "thm_clean"
});
