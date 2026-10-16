import type { ScopeTemplateDefinition } from "../schemas.js";
import { ASSIGNMENTS_GROUP, SALES_PIPELINE_STAGES, salesAssignmentConfiguration } from "./index.js";

// Industry sales scopes (docs/architecture/crm.md, "Building blocks"). These are not
// installed in every organization: the CRM setup adds the ones its industry pack names
// (crm/presets.ts). Everything industry-specific here is ordinary scope data — custom
// field groups, stages, triggers and bindings — so another industry builds its own the
// same way.

type Node = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stage = (id: string) => clone(SALES_PIPELINE_STAGES.find((entry) => entry.id === id) as Node);

/**
 * The cancellation window: a step that sets its due date to the end of the window the
 * organization's rescission rules give this sale (sales.startRescission.v1), and finishes
 * by itself when the window ends. A customer who cancels inside it cancels the sale from the
 * CRM, which stops this scope, so production never starts. With no rule for the sale the
 * step is skipped at once. Either way, finishing it starts the production scopes the signed
 * proposal carries.
 */
export function rescissionStage(dependsOn: string): Node {
  const activate = (id: string) => ({
    id,
    automation: "scopes.activateFromProposal.v1",
    explainer: "Production starts once the customer can no longer cancel.",
    input: { proposal_id: "{{node.metadata.rescission.proposal_id}}" }
  });
  return {
    id: "rescission_stage",
    title: "Cancellation window",
    description: "The customer may still cancel. Production starts when the window ends.",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: [dependsOn],
    metadata: { color: "#b54708" },
    children: [{
      id: "rescission_window",
      title: "Cancellation window",
      description: "Closes by itself at the end of the window. If the customer cancels, use Customer cancelled on the sale.",
      terminology_key: "work.task",
      actionable: false,
      show_in_todo_list: false,
      timers: [{ id: "window_closed", anchor: "due", offset_minutes: 0, explainer: "The end of the cancellation window." }],
      automation_bindings: {
        onReady: [{ id: "start_rescission", automation: "sales.startRescission.v1", explainer: "Works out when the customer can no longer cancel, from your cancellation rules.", input: {} }],
        onTimer: [{ id: "close_window", automation: "work.finishItem.v1", explainer: "The window ended and the sale stands.", conditions: { "payload.timer_id": "window_closed" }, input: { transition: "completed", reason: "The cancellation window ended." } }],
        onCompleted: [activate("activate_after_window")],
        onSkipped: [activate("activate_without_window")]
      },
      metadata: { kind: "rescission_window" }
    }]
  };
}

/** The closing stage without starting production at signing: the cancellation window does that. */
function closingWithoutActivation(): Node {
  const closing = stage("closing_stage");
  for (const child of closing.children as Node[]) {
    const bindings = child.automation_bindings as Node | undefined;
    if (bindings?.onCompleted) bindings.onCompleted = (bindings.onCompleted as Node[]).filter((entry) => entry.automation !== "scopes.activateFromProposal.v1");
  }
  return closing;
}

const CLAIM_GROUP = { path: "claim", label: "Insurance claim", description: "The homeowner's claim with their carrier.", order: 20, location: "project_left" as const, icon: "fa-file-contract" };
const claimField = (key: string, label: string, type: string, order: number, extra: Node = {}) => ({ path: `claim.${key}`, label, type, group_path: "claim", order, ...extra });

export const CLAIM_STATUSES = [
  { value: "not_filed", label: "Not filed" }, { value: "filed", label: "Filed" }, { value: "adjuster_scheduled", label: "Adjuster scheduled" },
  { value: "approved", label: "Approved" }, { value: "partial", label: "Partly approved" }, { value: "denied", label: "Denied" }, { value: "supplement", label: "Supplement requested" }
];

/** Insurance roofing: inspect, sign a contingency agreement, file the claim, meet the adjuster, then sell the approved scope. */
export function insuranceRoofSaleTemplate(): ScopeTemplateDefinition {
  const lead = stage("new_lead_stage");
  const inspection = stage("appointment_stage");
  inspection.id = "inspection_stage"; inspection.title = "Inspection"; inspection.description = "Inspect the roof and document the damage.";
  const contingency: Node = {
    id: "claim_stage",
    title: "Claim",
    description: "The homeowner signs the contingency agreement and files the claim.",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["inspection_stage"],
    metadata: { color: "#0e7090" },
    children: [
      {
        id: "sign_contingency",
        title: "Get the contingency agreement signed",
        description: "Signing a document tagged contingency completes this.",
        terminology_key: "work.task",
        actionable: true,
        show_in_todo_list: true,
        assigned_role_ids: ["sales_appointments"],
        external_triggers: [{ event: "document.signed", transition: "completed", explainer: "Signing a contingency agreement checks this off.", conditions: { match: "all", rules: [{ field: "payload.document_tags", operator: "contains", value: "contingency" }] } }],
        metadata: { kind: "sign_contingency" }
      },
      {
        id: "file_claim",
        title: "File the claim",
        description: "Record the carrier and claim number in the claim fields.",
        terminology_key: "work.task",
        actionable: true,
        show_in_todo_list: true,
        depends_on: ["sign_contingency"],
        assigned_role_ids: ["sales_appointments"],
        metadata: { kind: "file_claim" }
      }
    ]
  };
  const adjuster: Node = {
    id: "adjuster_stage",
    title: "Adjuster",
    description: "Meet the adjuster and record the carrier's decision.",
    terminology_key: "work.stage",
    completion_mode: "all_children",
    depends_on: ["claim_stage"],
    metadata: { color: "#6172f3" },
    children: [
      { id: "meet_adjuster", title: "Meet the adjuster", terminology_key: "work.task", actionable: true, show_in_todo_list: true, assigned_role_ids: ["sales_appointments"], metadata: { kind: "meet_adjuster" } },
      { id: "claim_decision", title: "Record the claim decision", description: "Approved, partly approved or denied, with the approved amounts.", terminology_key: "work.task", actionable: true, show_in_todo_list: true, depends_on: ["meet_adjuster"], metadata: { kind: "claim_decision" } }
    ]
  };
  const proposal = stage("proposal_stage"); proposal.depends_on = ["adjuster_stage"];
  const closing = closingWithoutActivation();
  const sales = salesAssignmentConfiguration();
  return {
    schema_version: 1,
    id: "insurance_roof_sale",
    category_ids: ["sales"],
    name: "Insurance roof sale",
    description: "Inspection, contingency, claim and adjuster through the signed sale.",
    details: "For storm and insurance work: inspect, sign a contingency agreement, file the claim, meet the adjuster, then sell the approved scope. The claim's carrier, number, adjuster and amounts are fields on the project. Production starts after any cancellation window.",
    color: "#0e7090",
    icon: "fa-house-chimney-crack",
    status: "active",
    proposal: { kind: "sales_pipeline", selectable: false },
    fields: [],
    ...sales,
    custom_fields: {
      groups: [ASSIGNMENTS_GROUP, CLAIM_GROUP],
      fields: [
        ...sales.custom_fields.fields,
        claimField("status", "Claim status", "select", 10, { options: CLAIM_STATUSES, ui: { project_tag: true } }),
        claimField("carrier", "Carrier", "text", 20),
        claimField("number", "Claim number", "text", 30),
        claimField("date_of_loss", "Date of loss", "date", 40),
        claimField("cause", "Cause", "select", 50, { options: ["hail", "wind", "storm", "fire", "water", "other"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) }),
        claimField("adjuster_name", "Adjuster", "text", 60),
        claimField("adjuster_phone", "Adjuster phone", "phone", 70),
        claimField("adjuster_email", "Adjuster email", "email", 80),
        claimField("adjuster_meeting_at", "Adjuster meeting", "datetime", 90),
        claimField("deductible", "Deductible", "currency", 100),
        claimField("rcv", "Replacement cost (RCV)", "currency", 110),
        claimField("acv", "Actual cash value (ACV)", "currency", 120),
        claimField("mortgage_company", "Mortgage company", "text", 130, { show_in_overview: false })
      ]
    },
    work_plan: {
      title: "Insurance roof sale",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#0e7090", canceled_column: { id: "lost", title: "Lost", color: "#f04438" } },
      root_nodes: [{
        id: "insurance_sales_phase",
        title: "Insurance sale",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        metadata: { color: "#0e7090", board_id: "insurance_roof_sale" },
        children: [lead, inspection, contingency, adjuster, proposal, closing, rescissionStage("closing_stage")]
      }]
    },
    metadata: { preset: true, preset_revision: 1, industry_preset: "roofing" }
  } as unknown as ScopeTemplateDefinition;
}

/** In-home sales (windows, siding, baths, solar): one visit, signed at the table, production after the cancellation window. */
export function inHomeSaleTemplate(): ScopeTemplateDefinition {
  const lead = stage("new_lead_stage");
  const appointment = stage("appointment_stage");
  const proposal = stage("proposal_stage");
  const closing = closingWithoutActivation();
  return {
    schema_version: 1,
    id: "in_home_sale",
    category_ids: ["sales"],
    name: "In-home sale",
    description: "Set, sit and sign at the table, then a cancellation window before production.",
    details: "For in-home sales: contact the lead, run the appointment, sign at the table or follow up on the proposal, and collect the deposit. Production starts once the customer's cancellation window ends.",
    color: "#7a5af8",
    icon: "fa-house-user",
    status: "active",
    proposal: { kind: "sales_pipeline", selectable: false },
    fields: [],
    ...salesAssignmentConfiguration(),
    work_plan: {
      title: "In-home sale",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#7a5af8", canceled_column: { id: "lost", title: "Lost", color: "#f04438" } },
      root_nodes: [{
        id: "in_home_sales_phase",
        title: "In-home sale",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        metadata: { color: "#7a5af8", board_id: "in_home_sale" },
        children: [lead, appointment, proposal, closing, rescissionStage("closing_stage")]
      }]
    },
    metadata: { preset: true, preset_revision: 1, industry_preset: "in_home" }
  } as unknown as ScopeTemplateDefinition;
}

export const INDUSTRY_SCOPE_TEMPLATES: Record<string, () => ScopeTemplateDefinition> = {
  insurance_roof_sale: insuranceRoofSaleTemplate,
  in_home_sale: inHomeSaleTemplate
};
