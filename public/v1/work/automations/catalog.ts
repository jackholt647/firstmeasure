// Authoring contract for registered work automations ("actions").
//
// The registry holds the handlers; this file holds what an editor or an agent
// needs to build a valid binding without reading handler source: a title, a
// category, and a JSON Schema for the binding's `input`.
//
// Schema conventions:
//   - Text inputs accept {{template}} interpolation, so numeric inputs are
//     typed ["number","string"].
//   - `x-control` names the editor widget for a property. It is a hint only;
//     the runtime ignores it.
//   - `additionalProperties` stays true: handlers tolerate extra fields and
//     saved definitions carry them.
//   - `internal: true` marks setup/machinery actions that run from defaults
//     and are not offered in an action picker.
//
// Runtime input validation for published actions stays in
// platform/publication/work-actions.ts. tests/automation-contracts.test.ts
// keeps the two in step.

import type { JsonSchema } from "../../platform/publication/contracts.js";

export type ActionCategory = "communication" | "tasks" | "project" | "scheduling" | "documents" | "pipeline" | "payments" | "payroll" | "code" | "setup";

export type ActionCatalogEntry = {
  title: string;
  category: ActionCategory;
  internal?: boolean;
  input_schema: JsonSchema;
};

type Property = Record<string, unknown>;
const template = (title: string, description: string, extra: Property = {}): Property => ({ type: "string", title, description, "x-control": "template_text", ...extra });
const longText = (title: string, description: string): Property => template(title, description, { "x-control": "template_long_text" });
const idList = (title: string, description: string, control: string): Property => ({ type: "array", items: { type: "string" }, title, description, "x-control": control });
const choice = (title: string, description: string, values: string[], fallback?: string): Property => ({ type: "string", enum: values, title, description, ...(fallback ? { default: fallback } : {}) });
const json = (title: string, description: string): Property => ({ type: "object", additionalProperties: true, title, description, "x-control": "json" });
const numeric = (title: string, description: string, extra: Property = {}): Property => ({ type: ["number", "string"], title, description, ...extra });
const schema = (properties: Record<string, Property> = {}, required: string[] = []): JsonSchema => ({
  type: "object", additionalProperties: true, properties, ...(required.length ? { required } : {})
}) as JsonSchema;

const roles = idList("Roles", "Everyone holding one of these roles.", "role_ids");
const users = idList("People", "Specific organization users.", "user_ids");
const groups = idList("Crews and groups", "Resource groups such as crews.", "resource_group_ids");
const recipients: Property = { type: "array", title: "Recipients", description: "Alternative to a single destination: a list of addresses or recipient objects.", items: {}, "x-control": "recipients" };
const deliver = choice("Delivery", "How the customer receives it.", ["portal", "email", "none"], "none");

export const ACTION_CATALOG: Record<string, ActionCatalogEntry> = {
  "communications.sendSms.v1": { title: "Send a text message", category: "communication", input_schema: schema({
    to: template("To", "Destination phone number, usually {{project.contacts.0.phone}}."),
    text: longText("Message", "The text to send."),
    recipients
  }, ["text"]) },
  "communications.sendEmail.v1": { title: "Send an email", category: "communication", input_schema: schema({
    to: template("To", "Destination email address, usually {{project.contacts.0.email}}."),
    subject: template("Subject", "Subject line."),
    text: longText("Message", "Plain-text body."),
    html: longText("HTML body", "Optional HTML version of the body."),
    recipients
  }, ["subject"]) },
  "notification.create.v1": { title: "Notify the team", category: "communication", input_schema: schema({
    id: template("Dedupe id", "Stable id; a repeat with the same id updates rather than duplicates."),
    notification_id: { type: "string", title: "Declared notification", description: "Required from scope code: the id of a notification declared on the scope." },
    title: template("Title", "Headline."),
    body: longText("Message", "Body text."),
    target_role_ids: roles, target_user_ids: users,
    kind: choice("Style", "A quiet notification or a celebration.", ["passive", "celebration"], "passive"),
    push: { type: "boolean", title: "Send push", description: "Also deliver as a push notification.", default: false },
    celebration: json("Celebration", "Celebration payload: {size, reason, text}."),
    frontend_action: json("When clicked", "Click-through action, for example {kind:\"open_project\", project_id:\"{{project.id}}\"}.")
  }, ["title"]) },
  "feedback.requestReview.v1": { title: "Ask the customer for feedback", category: "communication", input_schema: schema({
    channels: { type: "array", items: { type: "string", enum: ["sms", "email", "portal"] }, title: "Channels", description: "Defaults to the Feedback settings." },
    message_overrides: json("Wording overrides", "Per-run copy: sms_text, email_subject, email_body, portal_title, portal_body, portal_cta."),
    source_key: template("Request key", "Change it to create a separate request for the same project."),
    resend: { type: "boolean", title: "Send again", description: "Deliver the existing request again.", default: false },
    project_id: template("Project", "Defaults to the workflow project."),
    branch_id: template("Branch", "Defaults to the workflow branch.")
  }) },

  "work.createTodo.v1": { title: "Create a to-do", category: "tasks", input_schema: schema({
    title: template("Title", "What needs doing."),
    message: longText("Details", "Description shown on the to-do."),
    assigned_role_ids: roles, assigned_user_ids: users, assigned_resource_group_ids: groups,
    priority: numeric("Priority", "0 (normal) to 9 (highest).", { minimum: 0, maximum: 9 }),
    due_offset_minutes: numeric("Due after (minutes)", "Minutes from creation until it is due.", { "x-control": "duration_minutes" }),
    metadata: json("Advanced", "kind, type_tags, frontend_action.")
  }, ["title"]) },
  "crm.callLists.add.v1": { title: "Add to a call list", category: "tasks", input_schema: schema({
    list: { type: "object", additionalProperties: true, title: "Call list", description: "The list is created if it does not exist.", "x-control": "call_list", required: ["key"],
      properties: { key: { type: "string", title: "Key" }, title: { type: "string", title: "Name" }, description: { type: "string", title: "Description" }, kind: { type: "string", title: "Kind" }, icon: { type: "string", title: "Icon" }, tone: { type: "string", title: "Tone" }, sort_order: { type: "number", title: "Order" }, assigned_role_ids: roles, assigned_user_ids: users, metadata: json("Advanced", "List metadata.") } },
    title: template("Entry title", "What the caller sees for this entry.")
  }, ["list"]) },
  "crm.callLists.remove.v1": { title: "Remove from call lists", category: "tasks", input_schema: schema() },
  "punchlist.request.v1": { title: "Ask the customer for a punch list", category: "tasks", input_schema: schema({
    title: template("Heading", "Shown to the customer."), description: longText("Message", "Body copy shown to the customer."),
    instance_key: template("List key", "Distinguishes several lists on one project."),
    terminology_key: { type: "string", title: "Terminology key", description: "The noun to use; defaults to punch_list." },
    labels: json("Wording overrides", "noun, request_title, request_body, submit_cta, accept_cta."),
    config: json("Rules", "required, customer_can_add, customer_can_edit, max_items, require_photo, require_comment, allow_empty, require_submit_signature, require_accept_signature.")
  }) },

  "project.patch.v1": { title: "Update project fields", category: "project", input_schema: schema({
    values: { type: "object", additionalProperties: true, title: "Fields", description: "Field names and the values to write. Values support {{template}} interpolation.", "x-control": "field_values" }
  }, ["values"]) },
  "project.claim.v1": { title: "Claim a one-time key", category: "project", input_schema: schema({
    key: template("Key", "Claim name, for example welcome_call. The first caller wins; later steps can condition on project.claims.<key>.holder."),
    holder: template("Holder", "Defaults to this scope instance.")
  }, ["key"]) },

  "scheduling.createRequirement.v1": { title: "Add an appointment to schedule", category: "scheduling", input_schema: schema({
    event_type_default_id: { type: "string", title: "Appointment type", description: "Calendar event type.", "x-control": "event_type" },
    title: template("Title", "Event title."),
    kind: { type: "string", title: "Kind", description: "project_work, material_delivery, ..." },
    resource_refs: { type: "array", items: {}, title: "Assigned resources", description: "Concrete assignments: [{kind:\"equipment_unit\", id, name, role}].", "x-control": "json" },
    resource_requirements: { type: "array", items: {}, title: "Required resources", description: "Type-only requirements: [{kind:\"equipment_type\", equipment_type_id, label, quantity}].", "x-control": "json" }
  }, ["event_type_default_id"]) },
  "scheduling.createRequirements.v1": { title: "Add several appointments to schedule", category: "scheduling", input_schema: schema({
    requirements: { type: "array", items: { type: "object", additionalProperties: true }, title: "Appointments", description: "A list of appointment requirements (same fields as a single one).", "x-control": "json" }
  }, ["requirements"]) },
  "scheduling.createPerStructure.v1": { title: "Add one appointment per structure", category: "scheduling", input_schema: schema({
    event_type_default_id: { type: "string", title: "Appointment type", description: "Calendar event type used for each structure.", "x-control": "event_type" }
  }, ["event_type_default_id"]) },

  "documents.issue.v1": { title: "Issue a document", category: "documents", input_schema: schema({
    document_type: { type: "string", title: "Document type", description: "Uses the organization's default template for the type.", "x-control": "document_type" },
    template_id: { type: "string", title: "Template", description: "A specific document template; overrides the type.", "x-control": "document_template" },
    title: template("Title", "Optional document title."),
    params: { type: "object", additionalProperties: true, title: "Document values", description: "Values for the document's parameters; support {{template}} interpolation.", "x-control": "field_values" },
    deliver,
    recipients,
    consent_contact: template("Consent contact", "Contact whose messaging consent applies."),
    workflow_id: { type: "string", title: "Workflow", description: "Optional workflow document to attach." }
  }) },
  "completion.request.v1": { title: "Request completion sign-off", category: "documents", input_schema: schema({
    mode: choice("Experience", "Document, guided workflow, or both.", ["document", "workflow", "hybrid"], "document"),
    deliver,
    params: json("Details", "Completion date, work summary, warranty summary and final payment."),
    tab: json("Portal tab", "Optional customer portal tab descriptor.")
  }) },

  "scopes.activateTemplate.v1": { title: "Start another scope", category: "pipeline", input_schema: schema({
    template_id: { type: "string", title: "Scope", description: "The scope template to start on this project.", "x-control": "scope_template" },
    instance_key: template("Instance key", "Set to allow the same scope to start more than once.")
  }, ["template_id"]) },
  "scopes.activateFromProposal.v1": { title: "Start the scopes sold on the proposal", category: "pipeline", input_schema: schema() },

  "payments.ensureReceivables.v1": { title: "Create the payment schedule", category: "payments", internal: true, input_schema: schema() },
  "payments.reconcileRecognition.v1": { title: "Recognize milestone payments", category: "payments", internal: true, input_schema: schema() },
  "documents.dispatchOnSigned.v1": { title: "Run a signed document's behaviors", category: "documents", internal: true, input_schema: schema() },

  "payroll.commission.post.v1": { title: "Post a commission", category: "payroll", input_schema: schema({
    payee_role: { type: "string", title: "Recipient role", description: "Commission role key on the project." },
    payees: { type: "array", items: {}, title: "Recipients", description: "Explicit payees; overrides the role.", "x-control": "json" },
    amount: json("Amount", "Amount definition, for example {cents: 25000} or a calculation."),
    allocation: choice("Allocation", "Split one pool or pay each recipient in full.", ["split_evenly", "each"], "split_evenly"),
    entry_state: choice("State", "Projected or accrued immediately.", ["projected", "accrued"], "projected")
  }, ["amount"]) },
  "payroll.projectPayees.set.v1": { title: "Set commission recipients", category: "payroll", input_schema: schema({
    role_key: { type: "string", title: "Role key", description: "Commission role key." },
    label: template("Label", "Role name shown on the project."),
    payees: { type: "array", items: {}, title: "Recipients", description: "The people or groups paid under this role.", "x-control": "json" }
  }, ["role_key"]) },
  "payroll.commission.rule.v1": { title: "Apply a commission rule", category: "payroll", internal: true, input_schema: schema({ rule: json("Rule", "Compiled from the scope's commission settings.") }, ["rule"]) },
  "payroll.commission.accrue.v1": { title: "Accrue a commission installment", category: "payroll", internal: true, input_schema: schema({
    rule_id: { type: "string", title: "Rule" }, installment_id: { type: "string", title: "Installment" }
  }, ["rule_id"]) },
  "payroll.reconcileScopeCommissions.v1": { title: "Set up commissions", category: "setup", internal: true, input_schema: schema() },

  "customFields.initializeFromScope.v1": { title: "Add the scope's project fields", category: "setup", internal: true, input_schema: schema() },
  "materials.initializeFromScope.v1": { title: "Generate the scope's resource lists", category: "setup", internal: true, input_schema: schema() },
  "checklists.initializeFromScope.v1": { title: "Create the scope's checklists", category: "setup", internal: true, input_schema: schema() },
  "scopes.reconcileProjectResources.v1": { title: "Reconcile resources and commissions", category: "setup", internal: true, input_schema: schema() },

  "scope.code.run.v1": { title: "Run custom code", category: "code", input_schema: {
    type: "object", additionalProperties: false, required: ["id", "source", "inputSchema", "outputSchema"],
    properties: {
      id: { type: "string", title: "Program id", description: "Stable id for this program within the scope." },
      source: { type: "string", title: "Code", description: "JavaScript run in the bounded sandbox.", "x-control": "code" },
      policy: { type: "string", enum: ["live", "frozen"], default: "frozen", title: "Code version", description: "Frozen pins the code a running instance started with." },
      mode: { type: "string", enum: ["evaluate", "command"], default: "evaluate", title: "Mode", description: "Evaluate only reads; command may invoke declared actions." },
      inputs: { type: "object", title: "Inputs", description: "Values passed to the program.", "x-control": "json" },
      inputSchema: { type: "object", title: "Input schema", "x-control": "json" },
      outputSchema: { type: "object", title: "Output schema", "x-control": "json" },
      bindings: { type: "object", title: "Data and actions", description: "The published data sources and actions this program may use.", "x-control": "json" }
    }
  } as JsonSchema }
};

export function actionCatalogEntry(id: string): ActionCatalogEntry | null {
  return ACTION_CATALOG[String(id || "").trim()] || null;
}
