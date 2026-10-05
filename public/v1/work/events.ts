// Central event catalog. Every work event emitted anywhere on the platform
// should be registered here. Registration is intentionally loose — an
// unregistered event still flows through the engine (its visibility is
// inferred from its name) — but registering gives it a description for the
// automation UI, an explicit visibility, and a documented payload shape.
//
// Visibility:
//   "activity" — human-relevant; shows up in project/org activity timelines.
//   "system"   — machinery (work.node.status_changed, timers, projections);
//                stored and automatable, hidden from activity feeds.
//
// Naming: domain.entity.action (e.g. "material.delivery.completed"). Payload
// evolution must be additive — every event is a public contract for every
// scope set ever authored.

export type WorkEventVisibility = "activity" | "system";

/**
 * Customer-facing descriptor for an event.
 *
 * PRESENCE — and only presence — makes an event visible in the customer portal
 * activity feed. This is deliberately NOT a third value on WorkEventVisibility:
 * unregistered events infer their visibility from their name (see
 * inferVisibility below), so a naming coincidence could silently expose an
 * internal event to a customer. Requiring an explicit block makes the portal
 * feed default-deny by construction.
 *
 * `label` is the copy the customer sees. It may interpolate `{placeholders}`
 * naming keys listed in `fields` — and ONLY those keys. The raw event payload is
 * never rendered, because it routinely carries user ids, costs, and margins.
 *
 * Contract: docs/customer-portal-v2-spec.md §7.
 */
export type WorkEventCustomerDescriptor = {
  label: string;
  icon?: string;
  /** Payload keys the label is allowed to interpolate. Anything else is dropped. */
  fields?: string[];
};

/** Stable presentation groups shared across apps. These do not affect dispatch or authorization. */
export const notificationEventGroups = {
  miscellaneous: { id: "miscellaneous", label: "Miscellaneous" },
  signatures: { id: "signatures", label: "Signatures" },
  payments: { id: "payments", label: "Payments" },
  documents: { id: "documents", label: "Documents" },
  scopes: { id: "scopes", label: "Scope progress" },
  tasks: { id: "tasks", label: "Tasks" },
  scheduling: { id: "scheduling", label: "Scheduling" },
  projects: { id: "projects", label: "Projects & contacts" },
  messages: { id: "messages", label: "Messages" },
  mentions: { id: "mentions", label: "Mentions" },
  websites: { id: "websites", label: "Websites" },
  expenses: { id: "expenses", label: "Expenses & receipts" },
  payroll: { id: "payroll", label: "Payroll & commissions" },
  materials: { id: "materials", label: "Materials" },
  field_work: { id: "field_work", label: "Field work" },
  checklists: { id: "checklists", label: "Checklists & punch lists" },
  leads: { id: "leads", label: "Leads" },
  measurements: { id: "measurements", label: "Measurements" },
  files: { id: "files", label: "Files & media" },
  notes: { id: "notes", label: "Notes" },
  portal: { id: "portal", label: "Customer portal" },
  feedback: { id: "feedback", label: "Feedback & reviews" },
  organization: { id: "organization", label: "Company & team" }
} as const;

/** Picker sources are separate from semantic groups: document and invoice payments share Payments. */
export const notificationEventSources = {
  general: { id: "general", label: "General" },
  scopes: { id: "scopes", label: "Scopes" },
  flows: { id: "flows", label: "Flows & schedules" },
  projects: { id: "projects", label: "Projects" },
  documents: { id: "documents", label: "Documents" },
  websites: { id: "websites", label: "Websites" },
  billing: { id: "billing", label: "Payments & billing" },
  payroll: { id: "payroll", label: "Payroll" },
  materials: { id: "materials", label: "Materials" },
  crew: { id: "crew", label: "Field crew" },
  checklists: { id: "checklists", label: "Checklists" },
  portal: { id: "portal", label: "Customer portal" },
  messaging: { id: "messaging", label: "Communications" },
  channels: { id: "channels", label: "Team channels" },
  chat: { id: "chat", label: "Live chat" },
  crm: { id: "crm", label: "Leads & CRM" },
  canvassing: { id: "canvassing", label: "Canvassing" },
  measurements: { id: "measurements", label: "Measurements" },
  media: { id: "media", label: "Photos & files" },
  feedback: { id: "feedback", label: "Feedback" },
  organization: { id: "organization", label: "Company" }
} as const;

export type WorkEventNotification = {
  group: keyof typeof notificationEventGroups;
  source: keyof typeof notificationEventSources;
  tab: "general" | "messaging" | "flows" | "scopes" | "documents";
};
const miscellaneousNotification: WorkEventNotification = { group: "miscellaneous", source: "general", tab: "general" };

export type WorkEventDefinition = {
  name: string;
  description: string;
  visibility: WorkEventVisibility;
  notification: WorkEventNotification;
  // Documentation of notable payload fields, not a validation schema.
  payload?: Record<string, string>;
  /** Present only for events the customer may see. See WorkEventCustomerDescriptor. */
  customer?: WorkEventCustomerDescriptor;
};

const catalog = new Map<string, WorkEventDefinition>();

export function registerWorkEvents(definitions: Array<Partial<WorkEventDefinition> & Pick<WorkEventDefinition, "name" | "notification">>) {
  for (const definition of definitions) {
    const name = String(definition.name || "").trim();
    if (!name) continue;
    const notification = definition.notification;
    if (!notification || !Object.hasOwn(notificationEventGroups, notification.group)
      || !Object.hasOwn(notificationEventSources, notification.source)
      || !["general", "messaging", "flows", "scopes", "documents"].includes(notification.tab)) {
      throw new Error(`Event ${name} must declare a valid notification group, source and tab (use miscellaneous explicitly when needed).`);
    }
    catalog.set(name, {
      notification: { ...notification },
      name,
      description: String(definition.description || "").trim(),
      visibility: definition.visibility === "activity" ? "activity" : definition.visibility === "system" ? "system" : inferVisibility(name),
      ...(definition.payload ? { payload: definition.payload } : {}),
      // Only a well-formed descriptor counts: a truthy-but-shapeless `customer`
      // value must not turn an internal event customer-visible.
      ...(definition.customer && typeof definition.customer === "object" && String(definition.customer.label || "").trim()
        ? {
          customer: {
            label: String(definition.customer.label).trim(),
            ...(definition.customer.icon ? { icon: String(definition.customer.icon).trim() } : {}),
            ...(Array.isArray(definition.customer.fields) ? { fields: definition.customer.fields.map((field) => String(field).trim()).filter(Boolean) } : {})
          }
        }
        : {})
    });
  }
}

/**
 * The customer-facing descriptor for an event, or null when the event is not
 * customer-visible. Unregistered events always return null.
 */
export function workEventCustomerDescriptor(name: string): WorkEventCustomerDescriptor | null {
  const key = String(name || "").trim();
  return catalog.get(key)?.customer || null;
}

/**
 * Render an event's customer-facing label, interpolating ONLY the payload keys
 * the descriptor allowlisted. An unknown or disallowed placeholder resolves to
 * an empty string rather than leaking the raw value.
 */
export function renderCustomerEventLabel(name: string, payload: Record<string, unknown> = {}) {
  const descriptor = workEventCustomerDescriptor(name);
  if (!descriptor) return "";
  const allowed = new Set(descriptor.fields || []);
  return descriptor.label.replace(/\{([a-z0-9_]+)\}/gi, (_match, key: string) => {
    if (!allowed.has(key)) return "";
    const value = payload?.[key];
    if (value === null || value === undefined || typeof value === "object") return "";
    return String(value).trim();
  }).replace(/\s{2,}/g, " ").trim();
}

function inferVisibility(name: string): WorkEventVisibility {
  // Engine machinery and timer plumbing default to system; everything else is
  // presumed human-relevant until registered otherwise.
  if (name.startsWith("work.") || name.startsWith("time.")) return "system";
  if (name.endsWith(".updated") || name.endsWith(".snapshot_created") || name.endsWith(".pdf_rendered")) return "system";
  return "activity";
}

export function workEventDefinition(name: string): WorkEventDefinition {
  const key = String(name || "").trim();
  return catalog.get(key) || { name: key, description: "", visibility: inferVisibility(key), notification: { ...miscellaneousNotification } };
}

export function workEventNotification(name: string): WorkEventNotification {
  return { ...workEventDefinition(name).notification };
}

export function workEventVisibility(name: string): WorkEventVisibility {
  return workEventDefinition(name).visibility;
}

export function listWorkEventDefinitions() {
  return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name));
}

registerWorkEvents([
  { name: "connection.resource.updated", notification: { group: "organization", source: "organization", tab: "general" }, description: "A complete external data revision became available.", visibility: "system", payload: { connection_id: "Connection identity.", resource: "Published resource.", revision: "Immutable completed snapshot.", previous_revision: "Previous complete snapshot, if any." } },
  // ── Work engine ─────────────────────────────────────────────────────────
  { name: "work.plan.created", notification: { group: "scopes", source: "scopes", tab: "scopes" }, description: "A scope instance (work plan) was created on a project.", visibility: "system" },
  { name: "work.plan.started", notification: { group: "scopes", source: "scopes", tab: "scopes" }, description: "A scope instance started.", visibility: "activity" },
  { name: "work.plan.completed", notification: { group: "scopes", source: "scopes", tab: "scopes" }, description: "A scope instance finished — every stage reached a terminal state.", visibility: "activity" },
  { name: "work.plan.stage_manually_set", notification: { group: "scopes", source: "scopes", tab: "scopes" }, description: "A project manager manually moved a project to another board stage.", visibility: "activity", payload: { from_stage_id: "The prior displayed stage.", to_stage_id: "The manually selected stage." } },
  { name: "work.node.ready", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A work item became ready to start.", visibility: "system" },
  { name: "work.node.started", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A work item became active.", visibility: "system" },
  { name: "work.node.completed", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A work item was completed.", visibility: "activity" },
  { name: "work.node.skipped", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A work item was skipped.", visibility: "system" },
  { name: "work.node.canceled", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A work item was canceled.", visibility: "system" },
  { name: "work.node.blocked", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A work item became blocked by its dependencies.", visibility: "system" },
  { name: "work.node.status_changed", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "Any work item status transition (machinery).", visibility: "system" },
  { name: "work.node.due", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A work item passed its due time.", visibility: "system" },
  { name: "work.node.timer", notification: { group: "tasks", source: "scopes", tab: "scopes" }, description: "A declared node timer elapsed.", visibility: "system", payload: { timer_id: "The timer's template id." } },
  { name: "time.cron", notification: { group: "scheduling", source: "flows", tab: "flows" }, description: "A scheduled automation rule's cron expression fired.", visibility: "system", payload: { rule_id: "The automation rule that owns the schedule." } },

  // ── Projects & CRM ──────────────────────────────────────────────────────
  { name: "project.created", notification: { group: "projects", source: "projects", tab: "general" }, description: "A project (or lead) was created.", visibility: "activity", payload: { source_kind: "How the project arrived (manual_lead, email_lead, canvassing, ...)." } },
  { name: "project.updated", notification: { group: "projects", source: "projects", tab: "general" }, description: "Project fields were edited.", visibility: "system" },
  { name: "project.deleted", notification: { group: "projects", source: "projects", tab: "general" }, description: "A project was deleted.", visibility: "activity" },
  { name: "project.contact.attached", notification: { group: "projects", source: "projects", tab: "general" }, description: "A contact was attached to the project.", visibility: "activity" },
  { name: "project.event_scheduled", notification: { group: "scheduling", source: "projects", tab: "general" }, description: "A calendar event was scheduled on the project.", visibility: "activity", payload: { event_type_default_id: "Calendar event type (sales_appointment, project_work, ...)." } },
  { name: "project.event.started", notification: { group: "scheduling", source: "projects", tab: "general" }, description: "A scheduled project event's start time arrived.", visibility: "activity" },
  { name: "project.event.completed", notification: { group: "scheduling", source: "projects", tab: "general" }, description: "A scheduled project event's window ended.", visibility: "activity" },
  { name: "tagging.mentioned", notification: { group: "mentions", source: "projects", tab: "messaging" }, description: "A user was @mentioned.", visibility: "activity" },

  // ── Proposals ───────────────────────────────────────────────────────────
  { name: "proposal.created", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A proposal was created.", visibility: "activity" },
  { name: "proposal.updated", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A proposal draft was edited.", visibility: "system" },
  { name: "proposal.sent", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A proposal was sent to the customer.", visibility: "activity", customer: { label: "Your proposal is ready to review", icon: "fa-file-signature" } },
  { name: "proposal.viewed", notification: { group: "documents", source: "documents", tab: "documents" }, description: "The customer viewed the proposal.", visibility: "activity" },
  { name: "proposal.esign.signature_adopted", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "The signer adopted a signature style.", visibility: "system" },
  { name: "proposal.esign.slot_signed", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "One signature slot was completed.", visibility: "system" },
  { name: "proposal.esign.completed", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "The e-sign ceremony finished.", visibility: "system" },
  { name: "proposal.choice.selected", notification: { group: "documents", source: "documents", tab: "documents" }, description: "The customer selected a proposal option.", visibility: "activity" },
  { name: "proposal.pdf_generated", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A proposal PDF was generated.", visibility: "system" },
  { name: "proposal.snapshot_created", notification: { group: "documents", source: "documents", tab: "documents" }, description: "An immutable proposal snapshot was recorded.", visibility: "system" },
  { name: "proposal.archived", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A proposal was archived.", visibility: "activity" },
  { name: "proposal.duplicated", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A proposal was duplicated.", visibility: "system" },
  { name: "proposal.payment.pay_later", notification: { group: "payments", source: "documents", tab: "documents" }, description: "The customer chose to pay later after signing.", visibility: "activity" },
  { name: "proposal.payment.mock_succeeded", notification: { group: "payments", source: "documents", tab: "documents" }, description: "A mock portal deposit was recorded (development).", visibility: "system" },
  { name: "proposal.payment.received", notification: { group: "payments", source: "documents", tab: "documents" }, description: "A payment tied to a specific proposal settled.", visibility: "activity" },

  // ── Documents (document engine) ─────────────────────────────────────────
  { name: "document.issued", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A document was created from a template.", visibility: "system", payload: { document_type: "proposal | invoice | change_order | contract | work_order | generic" } },
  { name: "document.sent", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A document was sent to the customer.", visibility: "activity", payload: { document_type: "The registered document type.", document_tags: "Tags inherited by the signed document.", document_id: "The signed document.", snapshot_id: "The accepted immutable snapshot.", document_source: "documents or proposals (compatibility storage)." }, customer: { label: "A document was shared with you", icon: "fa-file-lines" } },
  { name: "document.viewed", notification: { group: "documents", source: "documents", tab: "documents" }, description: "The customer viewed a document.", visibility: "activity" },
  { name: "document.output.recorded", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A document output (signature, form value, selection, payment) was recorded.", visibility: "system", payload: { output_key: "The output key on the document.", output_type: "signature | payment | select | form_values | value" } },
  { name: "document.signed", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "All required signatures on a document were completed.", visibility: "activity", payload: { document_type: "The registered document type.", document_tags: "Tags inherited by the signed document.", document_id: "The signed document.", snapshot_id: "The accepted immutable snapshot.", document_source: "documents or proposals (compatibility storage)." }, customer: { label: "Document signed", icon: "fa-signature" } },
  { name: "document.signature.accepted", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "An assigned signer accepted one immutable signature field.", visibility: "activity", payload: { signer_id: "Assigned role", output_key: "Stable field key", receipt_id: "Durable signature receipt", package_id: "Retained signing package" } },
  { name: "document.signing.superseded", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "An unsigned signing package was replaced by a new revision.", visibility: "system" },
  { name: "document.signing.void", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "A signing package stopped accepting signatures; existing evidence remains retained.", visibility: "system" },
  { name: "document.signing.invitation_reissued", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "An issuer revoked and replaced one signer's invitation.", visibility: "system" },
  { name: "document.signing.expired", notification: { group: "signatures", source: "documents", tab: "documents" }, description: "The signing deadline passed; existing evidence remains retained.", visibility: "activity" },
  { name: "document.completed", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A document satisfied all of its required outputs.", visibility: "activity", payload: { document_type: "The registered document type.", document_tags: "Tags inherited by the signed document.", document_id: "The signed document.", snapshot_id: "The accepted immutable snapshot.", document_source: "documents or proposals (compatibility storage)." } },
  { name: "document.declined", notification: { group: "documents", source: "documents", tab: "documents" }, description: "The customer declined a document.", visibility: "activity" },
  { name: "document.expired", notification: { group: "documents", source: "documents", tab: "documents" }, description: "A document passed its expiration without completion.", visibility: "system" },
  { name: "document.ingested", notification: { group: "documents", source: "documents", tab: "documents" }, description: "An uploaded file was ingested and classified as a document.", visibility: "activity", payload: { document_type: "Detected document type." } },
  { name: "document.payment.received", notification: { group: "payments", source: "documents", tab: "documents" }, description: "A payment tied to a document settled.", visibility: "activity" },

  // ── Websites (web builder) ──────────────────────────────────────────────
  { name: "website.site.created", notification: { group: "websites", source: "websites", tab: "general" }, description: "A website was created.", visibility: "system", payload: { site_kind: "public | customer_portal" } },
  { name: "website.page.published", notification: { group: "websites", source: "websites", tab: "general" }, description: "A website page draft was published as a new immutable version.", visibility: "system", payload: { version: "The published version number." } },
  { name: "website.page.restored", notification: { group: "websites", source: "websites", tab: "general" }, description: "An old website page version was restored into the draft.", visibility: "system", payload: { version: "The version restored into the draft." } },
  { name: "website.page.deleted", notification: { group: "websites", source: "websites", tab: "general" }, description: "A website page was deleted along with its version history.", visibility: "system" },
  { name: "website.page.enabled", notification: { group: "websites", source: "websites", tab: "general" }, description: "A published website page was toggled visible on the live site.", visibility: "system" },
  { name: "website.page.disabled", notification: { group: "websites", source: "websites", tab: "general" }, description: "A website page was hidden from the live site.", visibility: "system" },

  // ── Money ───────────────────────────────────────────────────────────────
  { name: "payment.received", notification: { group: "payments", source: "billing", tab: "general" }, description: "A payment settled on the project.", visibility: "activity", payload: { payment_kind: "deposit | progress | final | deposit_partial | ..." }, customer: { label: "Payment received - thank you", icon: "fa-circle-check" } },
  { name: "payment.refunded", notification: { group: "payments", source: "billing", tab: "general" }, description: "A payment was refunded.", visibility: "activity" },
  { name: "invoice.created", notification: { group: "payments", source: "billing", tab: "general" }, description: "An invoice was generated.", visibility: "activity" },
  { name: "invoice.sent", notification: { group: "payments", source: "billing", tab: "general" }, description: "An invoice was emailed to the customer.", visibility: "activity", customer: { label: "An invoice is ready for you", icon: "fa-file-invoice-dollar" } },
  { name: "receipt.uploaded", notification: { group: "expenses", source: "billing", tab: "general" }, description: "A receipt was uploaded.", visibility: "activity" },
  { name: "receipt.extracted", notification: { group: "expenses", source: "billing", tab: "general" }, description: "Receipt data was extracted (AI OCR).", visibility: "system" },
  { name: "expense.recorded", notification: { group: "expenses", source: "billing", tab: "general" }, description: "An expense or payable was recorded.", visibility: "activity" },
  { name: "payroll.commission.accrued", notification: { group: "payroll", source: "payroll", tab: "general" }, description: "A commission installment accrued.", visibility: "activity" },
  { name: "payroll.batch.run", notification: { group: "payroll", source: "payroll", tab: "general" }, description: "A payroll batch was run.", visibility: "activity" },
  { name: "payroll.batch.paid", notification: { group: "payroll", source: "payroll", tab: "general" }, description: "A payroll batch was marked paid.", visibility: "activity" },

  // ── Materials & field ───────────────────────────────────────────────────
  { name: "material.delivery.completed", notification: { group: "materials", source: "materials", tab: "general" }, description: "A material delivery was marked delivered.", visibility: "activity", customer: { label: "Materials delivered to your job site", icon: "fa-truck" } },
  { name: "material.delivery.updated", notification: { group: "materials", source: "materials", tab: "general" }, description: "A material delivery changed.", visibility: "system" },
  { name: "material.order.placed", notification: { group: "materials", source: "materials", tab: "general" }, description: "A material order was placed.", visibility: "activity" },
  { name: "crew.clock.in", notification: { group: "field_work", source: "crew", tab: "general" }, description: "A worker clocked in.", visibility: "activity" },
  { name: "crew.clock.out", notification: { group: "field_work", source: "crew", tab: "general" }, description: "A worker clocked out.", visibility: "activity", payload: { worked_seconds: "Total worked seconds for the shift." } },
  { name: "crew.checklist.item_completed", notification: { group: "checklists", source: "crew", tab: "general" }, description: "A checklist item was completed or rated.", visibility: "system" },
  { name: "crew.checklist.completed", notification: { group: "checklists", source: "crew", tab: "general" }, description: "An entire project checklist was completed.", visibility: "activity", payload: { checklist_kind: "todo | quality", audience: "crew | supervisor" } },
  { name: "crew.change_order.created", notification: { group: "field_work", source: "crew", tab: "general" }, description: "A crew member drafted a change order in the field.", visibility: "activity" },

  // ── Punch lists (customer-authored closeout lists) ──────────────────────
  // The customer writes the list and signs off on both ends; the company works
  // it in between. See docs/customer-portal-v2-spec.md §8.2.
  { name: "punch_list.requested", notification: { group: "checklists", source: "checklists", tab: "general" }, description: "The customer was asked to create a punch list in their portal.", visibility: "activity", payload: { checklist_id: "The punch list.", source_key: "Idempotency key for the requesting node.", required: "Whether the list gates closeout.", noun: "The org's term for this list." }, customer: { label: "We have asked you to put together your {noun}", icon: "fa-clipboard-list", fields: ["noun"] } },
  { name: "punch_list.submitted", notification: { group: "checklists", source: "checklists", tab: "general" }, description: "The customer submitted their punch list — the list of remaining items is now fixed.", visibility: "activity", payload: { checklist_id: "The punch list.", item_count: "How many items the customer listed.", signed: "Whether a signature was captured." }, customer: { label: "You submitted your list", icon: "fa-paper-plane" } },
  { name: "punch_list.reopened", notification: { group: "checklists", source: "checklists", tab: "general" }, description: "A punch list was reopened for further customer edits.", visibility: "activity", payload: { checklist_id: "The punch list." }, customer: { label: "Your list was reopened so you can add more", icon: "fa-rotate-left" } },
  { name: "punch_list.work_completed", notification: { group: "checklists", source: "checklists", tab: "general" }, description: "The team marked every punch list item complete and asked the customer to confirm.", visibility: "activity", payload: { checklist_id: "The punch list." }, customer: { label: "We finished your list — please review", icon: "fa-circle-check" } },
  { name: "punch_list.accepted", notification: { group: "checklists", source: "checklists", tab: "general" }, description: "The customer signed off that the punch list is complete.", visibility: "activity", payload: { checklist_id: "The punch list.", signed: "Whether a signature was captured." }, customer: { label: "You confirmed the work is complete", icon: "fa-thumbs-up" } },

  // ── Project completion sign-off ─────────────────────────────────────────
  { name: "project.completion.requested", notification: { group: "projects", source: "projects", tab: "general" }, description: "The customer was asked to sign off on project completion.", visibility: "activity", customer: { label: "We have asked you to confirm the project is complete", icon: "fa-flag-checkered" } },
  { name: "project.completion.signed", notification: { group: "signatures", source: "projects", tab: "general" }, description: "The customer signed off on project completion.", visibility: "activity", payload: { signed: "Whether a signature was captured.", document_id: "The completion document, when one was used." }, customer: { label: "You signed off on project completion", icon: "fa-flag-checkered" } },

  // ── Customer portal (customer-authored) ─────────────────────────────────
  // Everything a portal visitor can author. All are internal-activity by
  // default; the ones carrying a `customer` block also echo back into the
  // customer's own feed.
  { name: "customer.upload.added", notification: { group: "files", source: "portal", tab: "general" }, description: "A customer uploaded a photo or document through the portal.", visibility: "activity", payload: { media_id: "The stored media id.", media_kind: "photo | video | document" }, customer: { label: "You shared a file with us", icon: "fa-arrow-up-from-bracket" } },
  { name: "customer.upload.withdrawn", notification: { group: "files", source: "portal", tab: "general" }, description: "A customer withdrew one of their own portal uploads.", visibility: "activity", payload: { media_id: "The withdrawn media id." } },
  { name: "customer.comment.added", notification: { group: "messages", source: "portal", tab: "messaging" }, description: "A customer commented on a shared photo.", visibility: "activity", payload: { media_id: "The media the comment is attached to." }, customer: { label: "You left a comment", icon: "fa-comment" } },

  // ── Communications ──────────────────────────────────────────────────────
  { name: "call.completed", notification: { group: "messages", source: "crm", tab: "messaging" }, description: "A team member completed and dispositioned a customer call.", visibility: "activity", payload: { disposition: "answered | voicemail | no_answer | skipped", contact_name: "The person called." } },
  { name: "communication.sent", notification: { group: "messages", source: "messaging", tab: "messaging" }, description: "An SMS or email was sent.", visibility: "activity" },
  { name: "communication.received", notification: { group: "messages", source: "messaging", tab: "messaging" }, description: "An inbound customer message arrived.", visibility: "activity" },
  { name: "communication.queued", notification: { group: "messages", source: "messaging", tab: "messaging" }, description: "An outbound message was queued for delivery.", visibility: "system" },
  { name: "communication.scheduled", notification: { group: "messages", source: "messaging", tab: "messaging" }, description: "An outbound message was scheduled for later delivery.", visibility: "system" },
  { name: "communication.delivery_updated", notification: { group: "messages", source: "messaging", tab: "messaging" }, description: "Delivery status changed for an outbound message.", visibility: "system" },
  { name: "communication.auto_replied", notification: { group: "messages", source: "messaging", tab: "messaging" }, description: "The comms AI agent automatically replied to an inbound customer message.", visibility: "activity", payload: { auto_reply_id: "comms_auto_replies row id", mode: "send" } },

  // ── Intake & measurement ────────────────────────────────────────────────
  { name: "lead.form.submitted", notification: { group: "leads", source: "crm", tab: "general" }, description: "A website form was submitted and created a lead. Payload carries form_id, template, submission_id and any appointment_status.", visibility: "activity" },
  { name: "lead.instant_estimate.generated", notification: { group: "leads", source: "crm", tab: "general" }, description: "A form submission produced a price estimate. Payload carries low_cents, high_cents, currency and the priced quantity with its unit.", visibility: "activity" },
  { name: "canvassing.pin.created", notification: { group: "leads", source: "canvassing", tab: "general" }, description: "A canvassing pin was dropped.", visibility: "system" },
  { name: "canvassing.pin.promoted", notification: { group: "leads", source: "canvassing", tab: "general" }, description: "A canvassing pin was promoted to a lead.", visibility: "activity" },
  { name: "measurement.report.ordered", notification: { group: "measurements", source: "measurements", tab: "general" }, description: "A measurement report was ordered.", visibility: "activity" },
  { name: "measurement.report.completed", notification: { group: "measurements", source: "measurements", tab: "general" }, description: "A measurement report finished — measurements are available.", visibility: "activity" },

  // ── Media, notes & portal ───────────────────────────────────────────────
  { name: "media.uploaded", notification: { group: "files", source: "media", tab: "general" }, description: "A photo or video was added to the project.", visibility: "activity" },
  { name: "media.tags_updated", notification: { group: "files", source: "media", tab: "general" }, description: "Tags on a photo, video, or file were updated.", visibility: "system" },
  { name: "media.shared", notification: { group: "files", source: "media", tab: "general" }, description: "Media was shared to the customer portal.", visibility: "activity" },
  { name: "note.created", notification: { group: "notes", source: "projects", tab: "general" }, description: "A note was added to the project.", visibility: "activity" },
  { name: "portal.visited", notification: { group: "portal", source: "portal", tab: "general" }, description: "The customer opened their portal.", visibility: "activity" },
  { name: "portal.media_viewed", notification: { group: "portal", source: "portal", tab: "general" }, description: "The customer viewed shared media.", visibility: "system" },

  // ── Feedback & reviews ──────────────────────────────────────────────────
  { name: "feedback.request.created", notification: { group: "feedback", source: "feedback", tab: "general" }, description: "A customer feedback request was created for the project.", visibility: "system", payload: { request_id: "The feedback request record." } },
  { name: "feedback.request.sent", notification: { group: "feedback", source: "feedback", tab: "general" }, description: "A feedback / review invitation was sent to the customer.", visibility: "activity", payload: { request_id: "The feedback request record.", channels: "Delivery channels used (sms, email).", link: "The public rating page URL." } },
  { name: "feedback.request.opened", notification: { group: "feedback", source: "feedback", tab: "general" }, description: "The customer opened their feedback page.", visibility: "system", payload: { request_id: "The feedback request record." } },
  { name: "feedback.rating.recorded", notification: { group: "feedback", source: "feedback", tab: "general" }, description: "The customer submitted a rating. The score is written to project.custom_fields.feedback_rating.", visibility: "activity", payload: { rating: "The submitted rating.", scale: "The rating scale (e.g. 5).", comment: "Optional customer comment.", met_review_threshold: "Whether the rating met the configured review threshold." } },
  { name: "feedback.review.link_clicked", notification: { group: "feedback", source: "feedback", tab: "general" }, description: "The customer clicked through to a public review destination.", visibility: "activity", payload: { destination_id: "The configured destination.", destination_label: "Destination display name.", rating: "The rating they gave." } },

  // ── Recurrence ──────────────────────────────────────────────────────────
  { name: "recurrence.occurrence.completed", notification: { group: "scheduling", source: "flows", tab: "flows" }, description: "A recurring visit was completed.", visibility: "activity" },
  { name: "recurrence.occurrence.skipped", notification: { group: "scheduling", source: "flows", tab: "flows" }, description: "A recurring visit was skipped.", visibility: "activity" },
  { name: "recurrence.series.created", notification: { group: "scheduling", source: "flows", tab: "flows" }, description: "A recurring series was created.", visibility: "activity" },
  { name: "recurrence.series.canceled", notification: { group: "scheduling", source: "flows", tab: "flows" }, description: "A recurring series was canceled.", visibility: "activity" },

  // ── Organization lifecycle (org-scoped, no project) ─────────────────────
  { name: "organization.created", notification: { group: "organization", source: "organization", tab: "general" }, description: "The organization was created.", visibility: "activity" },
  { name: "organization.user.invited", notification: { group: "organization", source: "organization", tab: "general" }, description: "A user was invited to the organization.", visibility: "activity" },
  { name: "organization.user.joined", notification: { group: "organization", source: "organization", tab: "general" }, description: "A user activated their account.", visibility: "activity" }
]);
