import type { JsonObject } from "../platform/storage.js";
import { PROJECT_ACCOUNT_SOURCE } from "./account.js";
import { lineItemStyles, proposalLineItemComponents, startFlowTemplate } from "./seeds.js";
import { addFlowPage, componentRow, flowBlocks, flowColumn, flowComponent, flowLogo, flowRepeater, flowRow, flowSpacer, flowText, flowWidget, labeledText, type RunSpec } from "./template-kit.js";

/**
 * The production documents: what a contractor sends after the sale. A change
 * order amends the signed agreement, an invoice bills what is owed, and a
 * completion certificate closes the job. Each reads the project's account
 * (documents/account.ts) so it can say what was agreed, what has been paid
 * and what this document asks for, and each has a short workflow that ends
 * with the customer's own steps.
 */

const BODY_FONT = { family: "var(--fm-body-font)", size_pt: 10.5, color: "var(--fm-text)" };
const MUTED_FONT = { family: "var(--fm-body-font)", size_pt: 9.5, color: "var(--fm-color-muted)" };
const TITLE_FONT = { family: "var(--fm-display-font)", size_pt: 22, weight: 800, color: "var(--fm-text)" };
const AMOUNT_WIDTH = 110;
const PANEL_FILL = "color-mix(in srgb, var(--fm-primary) 6%, var(--fm-color-paper))";
const ACCOUNT_PARAM = { type: "object", source: PROJECT_ACCOUNT_SOURCE };

/** Shown only while `condition` holds. */
function when(node: JsonObject, condition: string): JsonObject {
  node.bind = { ...(node.bind as JsonObject | undefined), if: condition };
  return node;
}

/** A label with its amount at the right edge. */
function amountRow(label: RunSpec[], amount: RunSpec[], options: { strong?: boolean } = {}): JsonObject {
  const font = options.strong
    ? { family: "var(--fm-display-font)", size_pt: 12.5, weight: 800, color: "var(--fm-text)" }
    : BODY_FONT;
  return flowRow([
    flowText(label, { font, grow: 1 }),
    flowText(amount, { font, align: "right", w: AMOUNT_WIDTH })
  ], { gap: 8 });
}

function panel(children: JsonObject[]): JsonObject {
  return flowColumn(children, { gap: 5, padding: [12, 14, 12, 14], fill: PANEL_FILL });
}

/** Project and customer, as every production document names them. */
function partiesRow(extra: JsonObject[] = []): JsonObject {
  return flowRow([
    labeledText("Project", [
      { bind: "coalesce(params.project.title, project.title, 'Project')" },
      { text: "\n" },
      { bind: "coalesce(params.project.address, project.address, '')", font: { size_pt: 9.5, weight: 400, color: "var(--fm-color-muted)" } }
    ], { grow: 1 }),
    labeledText("Customer", [{ bind: "coalesce(params.customer.name, customer.name, 'Customer')" }], { grow: 1 }),
    ...extra
  ], { gap: 20 });
}

// ---------------------------------------------------------------------------
// Change order
// ---------------------------------------------------------------------------

export function changeOrderTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_margin", "change_order");
  addFlowPage(doc, theme, "body", "Change Order", [
    flowLogo(),
    flowRow([
      flowText([{ text: "Change Order" }], { font: TITLE_FONT, grow: 1 }),
      labeledText("Date", [{ bind: "params.change_date | date" }], { w: 130, align: "right" })
    ], { align: "end" }),
    partiesRow(),
    when(flowText([{ text: "This change order amends " }, { bind: "params.account.contract_title", weight: 700 }, { text: ". Everything else in that agreement stays as signed." }], { font: MUTED_FONT }),
      "not_empty(params.account.contract_title)"),
    flowSpacer(6),
    flowText([{ text: "What is changing" }], { style_ref: "h2" }),
    flowText([{ bind: "coalesce(params.reason, '')" }], { font: BODY_FONT }),
    flowSpacer(4),
    flowComponent("li_header"),
    flowRepeater({
      source: "{{coalesce(params.scope_rows, params.scope_items)}}",
      component: "li_row",
      as: "row",
      layout: { direction: "column", columns: 1, gap_pt: 2 },
      break_rules: { repeat_header: true, header_component: "li_header", min_rows_per_segment: 2, keep_with_next: [] },
      empty_text: "Add the work this change order covers."
    }),
    flowSpacer(6),
    panel([
      when(amountRow([{ text: "Original contract" }], [{ bind: "params.account.contract_cents | money" }]), "params.account.has_contract == true"),
      when(amountRow([{ text: "Change orders already approved" }], [{ bind: "params.account.change_orders_cents | money" }]), "coalesce(params.account.change_orders_cents, 0) > 0"),
      amountRow([{ text: "This change order" }, { bind: "coalesce(params.tax_percent, 0) > 0 ? concat(' (includes ', params.tax_percent, '% tax)') : ''" }], [{ bind: "params.change_cents | money" }]),
      when(amountRow([{ text: "New contract total" }], [{ bind: "params.new_total_cents | money" }], { strong: true }), "params.account.has_contract == true")
    ]),
    flowSpacer(4),
    flowText([{ text: "How this change is paid" }], { style_ref: "h2" }),
    flowWidget("doc.payment_schedule@1", { source: "params.payment_schedule", show_status: false }),
    when(flowText([{ text: "The payments already scheduled on your agreement do not change." }], { font: MUTED_FONT }), "params.account.has_contract == true"),
    flowSpacer(4),
    // One block, so the signature never lands on a page without what it approves.
    flowColumn([
      flowText([{ text: "Approval" }], { style_ref: "h2" }),
      flowText([{ text: "By signing, you approve the work and price above as a change to your agreement and authorize us to proceed." }], { font: BODY_FONT }),
      flowRow([
        flowWidget("doc.signature@1", { output: "sig_customer", label: "Customer approval", signer: "customer" }, { grow: 1, h: 76 }),
        when(flowWidget("doc.pay_now@1", { output_key: "payment", source: "params.due_now_cents", amount_label: "Due on approval" }, { w: 180, h: 76 }), "coalesce(params.due_now_cents, 0) > 0")
      ], { gap: 24, align: "end" })
    ], { gap: 6 })
  ], { gap: 6 });
  doc.components = proposalLineItemComponents();
  doc.styles = lineItemStyles();
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    source_document_id: { type: "string" },
    change_date: { type: "date", label: "Date" },
    reason: { type: "text", label: "What is changing and why", required: true },
    scope_items: { type: "list", items: { type: "pricebook_line" }, required: true, label: "Added or changed work" },
    show_line_prices: { type: "boolean", default: true },
    tax_percent: { type: "percent", label: "Tax percent" },
    // One payment for the whole change, due with the final payment, until the workflow says otherwise.
    payment_schedule: { type: "payment_schedule", label: "Payment", default: [
      { id: "change_order", label: "Change order", kind: "percent", percent: 100, payment_kind: "change_order", due_rule: "project_completion" }
    ] },
    account: ACCOUNT_PARAM,
    change_cents: { type: "currency" },
    new_total_cents: { type: "currency" },
    due_now_cents: { type: "currency" },
    // Workflow bookkeeping (see the itemized proposal): a payment falls due at signing.
    deposit_at_signing: { type: "boolean", default: false },
    customer_choice_count: { type: "number", default: 0 }
  };
  doc.outputs = {
    sig_customer: { type: "signature", required: true, signer: "customer" },
    payment: { type: "payment" }
  };
  doc.computed = {
    subtotal_cents: "sum(params.scope_items[].amount_cents)",
    tax_cents: "round(computed.subtotal_cents * coalesce(params.tax_percent, 0) / 100)",
    total_cents: "computed.subtotal_cents + computed.tax_cents"
  };
  return doc;
}

export function changeOrderWorkflowDefinition(): JsonObject {
  const template = changeOrderTemplateDefinition();
  return {
    schema_version: 1,
    name: "Change order",
    contract: { params: template.params, outputs: template.outputs },
    steps: [
      { id: "change", title: "What is changing", audience: ["internal"], items: [
        { kind: "text", writes: "params.reason", label: "What is changing and why", required: true, presentation: { multiline: true }, placeholder: "During tear-off we found rotted decking along the back eave.",
          description: "The customer reads this first. Say what was found or asked for, in plain words." },
        { kind: "line_items_review", writes: "params.scope_items", label: "Added or changed work", required: true, generate: false,
          description: "Only what this change adds. The original agreement is not repeated here." }
      ] },
      { id: "payment", title: "Payment", description: "When the customer pays for this change. The payments already scheduled on their agreement stay as they are.", audience: ["internal"], items: [
        { kind: "payment_schedule", writes: "params.payment_schedule", label: "Payment for this change", required: true, presets: [
          { label: "With the final payment", title: "Added to what is due when the job is complete", parts: [{ label: "Change order", percent: 100, due_rule: "project_completion" }] },
          { label: "Due on approval", title: "Paid in full when the customer signs", parts: [{ label: "Change order", percent: 100, due_rule: "on_signature" }] },
          { label: "Half now, half at completion", title: "50% when the customer signs, 50% when the job is complete", parts: [{ label: "Change order deposit", percent: 50, due_rule: "on_signature" }, { label: "Change order balance", percent: 50, due_rule: "project_completion" }] }
        ] }
      ] },
      { id: "review", title: "Review & send", audience: ["internal"], items: [{ kind: "review", label: "Before you send", total_label: "Change order total" }], preview: { template_ref: "tpl_change_order_default", live: true } },
      { id: "sign", title: "Approve the change", audience: ["customer"], items: [
        { kind: "signature", writes: "outputs.sig_customer", required: true, label: "Approve this change order", description: "Sign to approve the added work and its price as a change to your agreement." }
      ] },
      { id: "pay", title: "Pay", audience: ["customer"], when: "{{params.deposit_at_signing == true}}", items: [
        { kind: "payment", writes: "outputs.payment", required: true, label: "Payment due on approval", config: { source: "params.due_now_cents", amount_label: "Due on approval" } }
      ] }
    ],
    audiences: { internal: {}, customer: { theme: "portal" } }
  };
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

function invoiceComponents(): JsonObject {
  const header = (label: string, align: string, size: { w?: number; grow?: number }) => flowText([{ text: label }], {
    align, font: { family: "var(--fm-body-font)", size_pt: 8.5, weight: 800, color: "#ffffff", transform: "uppercase" }, ...size
  });
  return {
    inv_header: { params: {}, root: componentRow([header("Description", "left", { grow: 1 }), header("Amount", "right", { w: AMOUNT_WIDTH })], { gap: 8, padding: [5, 8, 5, 8], fill: "var(--fm-primary)", align: "center" }) },
    inv_row: {
      params: { item: { type: "object" } },
      root: componentRow([
        flowBlocks([
          { runs: [{ bind: "item.label" }], style_ref: "li_name" },
          { runs: [{ bind: "coalesce(item.detail, '')" }], style_ref: "li_meta", collapse_empty: true }
        ], { grow: 1 }),
        flowText([{ bind: "item.amount_cents | money" }], { style_ref: "li_amount", align: "right", w: AMOUNT_WIDTH })
      ], { gap: 8, padding: [6, 8, 6, 8] })
    }
  };
}

export function invoiceTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "invoice");
  addFlowPage(doc, theme, "body", "Invoice", [
    flowLogo({ w: 150, h: 32 }),
    flowRow([
      flowText([{ text: "Invoice" }], { font: TITLE_FONT, grow: 1 }),
      labeledText("Invoice no.", [{ bind: "coalesce(params.invoice_number, '')" }], { w: 170, align: "right" })
    ], { align: "end" }),
    partiesRow([
      labeledText("Issued", [{ bind: "params.issue_date | date" }], { w: 86 }),
      labeledText("Due", [{ bind: "params.due_date | date" }], { w: 86 })
    ]),
    flowSpacer(8),
    flowComponent("inv_header"),
    flowRepeater({
      source: "{{params.billing.lines}}",
      component: "inv_row",
      as: "row",
      layout: { direction: "column", columns: 1, gap_pt: 2 },
      break_rules: { repeat_header: true, header_component: "inv_header", min_rows_per_segment: 2, keep_with_next: [] },
      empty_text: "Choose what this invoice bills."
    }),
    flowRow([
      flowText([{ bind: "params.status == 'Paid in full' ? 'Paid in full' : 'Amount due'" }], { font: { family: "var(--fm-display-font)", size_pt: 12.5, weight: 800, color: "var(--fm-text)" }, grow: 1 }),
      flowText([{ bind: "params.amount_due_cents | money" }], { font: { family: "var(--fm-display-font)", size_pt: 12.5, weight: 800, color: "var(--fm-text)" }, align: "right", w: AMOUNT_WIDTH })
    ], { gap: 8, padding: [8, 8, 8, 8], fill: PANEL_FILL }),
    when(flowText([{ bind: "coalesce(params.notes, '')" }], { font: BODY_FONT }), "not_empty(params.notes)"),
    flowSpacer(10),
    flowRow([
      when(flowColumn([
        flowText([{ text: "Your account" }], { style_ref: "h2" }),
        amountRow([{ text: "Contract total" }, { bind: "coalesce(params.account.change_orders_cents, 0) > 0 ? concat(' (includes ', (params.account.change_orders_cents | money), ' in change orders)') : ''", font: { size_pt: 8.5, color: "var(--fm-color-muted)" } }], [{ bind: "params.account.total_cents | money" }]),
        amountRow([{ text: "Payments received" }], [{ bind: "params.account.paid_cents | money" }]),
        amountRow([{ text: "Balance before this invoice" }], [{ bind: "params.account.balance_cents | money" }])
      ], { grow: 1, gap: 5 }), "params.account.has_contract == true"),
      // Once sent, the pay card carries the QR code to the customer's portal.
      when(flowWidget("doc.pay_now@1", { output_key: "payment", source: "params.amount_due_cents", amount_label: "Amount due" }, { w: 190, h: 92 }), "coalesce(params.amount_due_cents, 0) > 0")
    ], { gap: 28 })
  ], { gap: 6 });
  doc.components = invoiceComponents();
  doc.styles = lineItemStyles();
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    invoice_number: { type: "string", label: "Invoice number" },
    issue_date: { type: "date", label: "Issued" },
    due_date: { type: "date", label: "Due" },
    // What is billed: one open payment of the contract (its id), "balance" for all of them, or "custom" for only the charges below.
    bill: { type: "string", label: "What to bill" },
    line_items: { type: "list", items: { type: "pricebook_line" }, label: "Other charges" },
    tax_percent: { type: "percent", label: "Tax on other charges" },
    notes: { type: "text", label: "Note to the customer" },
    status: { type: "string" },
    account: ACCOUNT_PARAM,
    billing: { type: "object" },
    amount_due_cents: { type: "currency", label: "Amount due" }
  };
  doc.outputs = {
    payment: { type: "payment", required_for: "completed" }
  };
  return doc;
}

export function invoiceWorkflowDefinition(): JsonObject {
  const template = invoiceTemplateDefinition();
  return {
    schema_version: 1,
    name: "Invoice",
    contract: { params: template.params, outputs: template.outputs },
    steps: [
      { id: "bill", title: "What to bill", description: "Bill a payment from the signed agreement, everything that is still open, or charges that were never in it.", audience: ["internal"], items: [
        { kind: "select", writes: "params.bill", label: "Bill the customer for", required: true, options_from: "params.account.bill_options", presentation: { style: "cards" } },
        { kind: "line_item_editor", writes: "params.line_items", label: "Other charges", description: "Anything owed that is not in the agreement: a permit, a dump fee, extra material. Leave empty when there is nothing to add." }
      ] },
      { id: "terms", title: "Dates & note", audience: ["internal"], items: [
        { kind: "date", writes: "params.issue_date", label: "Issued", required: true },
        { kind: "date", writes: "params.due_date", label: "Due", required: true, description: "The billed payments become due on this date when the invoice is sent." },
        { kind: "text", writes: "params.notes", label: "Note to the customer", presentation: { multiline: true }, placeholder: "Thank you for your business." }
      ] },
      { id: "review", title: "Review & send", audience: ["internal"], items: [{ kind: "review", label: "Before you send", total_label: "Other charges" }], preview: { template_ref: "tpl_invoice_default", live: true } },
      { id: "pay", title: "Pay invoice", audience: ["customer"], items: [
        { kind: "payment", writes: "outputs.payment", required: true, label: "Pay this invoice", config: { source: "params.amount_due_cents", amount_label: "Amount due" } }
      ] }
    ],
    audiences: { internal: {}, customer: { theme: "portal" } }
  };
}

// ---------------------------------------------------------------------------
// Completion certificate
// ---------------------------------------------------------------------------

export function completionCertificateTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "completion_certificate");
  addFlowPage(doc, theme, "body", "Completion certificate", [
    flowLogo({ w: 150, h: 32 }),
    flowText([{ text: "Certificate of Completion" }], { font: TITLE_FONT }),
    partiesRow([labeledText("Completed", [{ bind: "params.completed_at | date" }], { w: 110 })]),
    flowSpacer(6),
    flowText([{ text: "Work completed" }], { style_ref: "h2" }),
    flowText([{ bind: "coalesce(params.work_summary, '')" }], { font: BODY_FONT }),
    flowSpacer(4),
    flowText([{ text: "Items still to finish" }], { style_ref: "h2" }),
    flowText([{ bind: "not_empty(params.punch_list) ? params.punch_list : 'None. Everything in the agreement has been completed.'" }], { font: BODY_FONT }),
    flowSpacer(4),
    flowText([{ text: "Warranty" }], { style_ref: "h2" }),
    flowText([
      { text: "Warranty coverage begins " }, { bind: "params.warranty_start | date", weight: 700 }, { text: ". " },
      { bind: "coalesce(params.warranty_summary, '')" }
    ], { font: BODY_FONT }),
    flowSpacer(6),
    when(panel([
      amountRow([{ text: "Contract total" }, { bind: "coalesce(params.account.change_orders_cents, 0) > 0 ? concat(' (includes ', (params.account.change_orders_cents | money), ' in change orders)') : ''", font: { size_pt: 8.5, color: "var(--fm-color-muted)" } }], [{ bind: "params.account.total_cents | money" }]),
      amountRow([{ text: "Payments received" }], [{ bind: "params.account.paid_cents | money" }]),
      amountRow([{ bind: "coalesce(params.account.balance_cents, 0) > 0 ? 'Final payment due' : 'Paid in full'" }], [{ bind: "params.account.balance_cents | money" }], { strong: true })
    ]), "params.account.has_contract == true"),
    flowSpacer(4),
    flowColumn([
      flowText([{ text: "Customer acceptance" }], { style_ref: "h2" }),
      flowText([
        { text: "By signing, you confirm that the work described above has been completed and reviewed with you" },
        { bind: "not_empty(params.punch_list) ? ', other than the items still to finish listed above' : ''" },
        { text: ". Signing does not waive your warranty or any rights under your agreement." }
      ], { font: BODY_FONT }),
      flowRow([
        flowWidget("doc.signature@1", { output: "sig_customer", label: "Customer sign-off", signer: "customer" }, { grow: 1, h: 76 }),
        when(flowWidget("doc.pay_now@1", { output_key: "final_payment", source: "params.amount_due_cents", amount_label: "Final payment" }, { w: 180, h: 76 }), "coalesce(params.amount_due_cents, 0) > 0")
      ], { gap: 24, align: "end" })
    ], { gap: 6 })
  ], { gap: 6 });
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    completed_at: { type: "date", label: "Completion date" },
    work_summary: { type: "text", label: "Work completed", default: "All work in your signed agreement and its approved change orders has been completed, and the property has been cleaned up." },
    punch_list: { type: "text", label: "Items still to finish" },
    warranty_start: { type: "date", label: "Warranty starts" },
    warranty_summary: { type: "text", label: "Warranty", default: "Our workmanship is warranted as described in your agreement, and the manufacturer's warranty applies to the materials installed." },
    collect_final_payment: { type: "boolean", label: "Collect the remaining balance", default: true },
    account: ACCOUNT_PARAM,
    amount_due_cents: { type: "currency", label: "Final payment" }
  };
  doc.outputs = {
    completion_ack: { type: "select", required: true },
    sig_customer: { type: "signature", required: true, signer: "customer" },
    final_payment: { type: "payment", obligation: "final" }
  };
  return doc;
}

export function completionSignoffWorkflowDefinition(): JsonObject {
  const template = completionCertificateTemplateDefinition();
  const accepted = "outputs.completion_ack != 'needs_follow_up'";
  return {
    schema_version: 1,
    name: "Completion sign-off",
    contract: { params: template.params, outputs: template.outputs },
    steps: [
      { id: "st_completion_details", title: "Completed work", audience: ["internal"], items: [
        { kind: "date", writes: "params.completed_at", label: "Completion date", required: true },
        { kind: "text", writes: "params.work_summary", label: "Work completed", required: true, presentation: { multiline: true } },
        { kind: "text", writes: "params.punch_list", label: "Items still to finish", presentation: { multiline: true }, placeholder: "Touch up paint on the front fascia",
          description: "Anything agreed at the walk-through that is still open, one per line. Leave empty when there is nothing." }
      ] },
      { id: "st_completion_terms", title: "Warranty & final payment", audience: ["internal"], items: [
        { kind: "date", writes: "params.warranty_start", label: "Warranty starts", required: true },
        { kind: "text", writes: "params.warranty_summary", label: "Warranty", presentation: { multiline: true } },
        { kind: "boolean", writes: "params.collect_final_payment", label: "Collect the remaining balance", description: "After signing, the customer is asked to pay what is left on the contract. The certificate shows the amount." }
      ] },
      { id: "st_completion_send", title: "Review & send", audience: ["internal"], items: [{ kind: "review", label: "Before you send" }], preview: { template_ref: "tpl_roofing_completion_certificate", live: true } },
      { id: "st_completion_review", title: "Walk-through", audience: ["customer"], items: [{
        kind: "choice_group", writes: "outputs.completion_ack", required: true, label: "Is the work complete?",
        options: [
          { id: "accepted", label: "Yes, the work is complete", description: "Everything in my agreement is done, apart from any items still to finish listed on the certificate." },
          { id: "needs_follow_up", label: "Not yet", description: "Something else needs attention before I sign. The project team will be told and will contact me." }
        ],
        presentation: { style: "cards" }
      }] },
      { id: "st_completion_sign", title: "Sign", audience: ["customer"], when: `{{${accepted}}}`, items: [
        { kind: "signature", writes: "outputs.sig_customer", required: true, label: "Sign the completion certificate", description: "Your signature confirms the work is complete. It does not waive your warranty." }
      ] },
      { id: "st_completion_pay", title: "Final payment", audience: ["customer"], when: `{{${accepted} && params.collect_final_payment != false && coalesce(params.amount_due_cents, 0) > 0}}`, items: [
        { kind: "payment", writes: "outputs.final_payment", label: "Final payment", description: "Pay the balance now, or later from your portal.", config: { source: "params.amount_due_cents", amount_label: "Final payment" } }
      ] }
    ],
    audiences: { internal: {}, customer: { theme: "portal" } }
  };
}
