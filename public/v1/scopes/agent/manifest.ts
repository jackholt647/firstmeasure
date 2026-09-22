// The scope-manager agent's knowledge base: a prose description of every app
// on the platform and how the scope/automation engine ties them together,
// plus dynamically assembled catalogs (events, automations, context
// providers). This is the "app manifest" context the agent reasons from —
// keep it accurate when subsystems change.

import { listWorkEventDefinitions } from "../../work/events.js";
import { listWorkAutomationDefinitions } from "../../work/registry.js";
import { listWorkContextProviders, registerBuiltinContextProviders } from "../../work/context.js";
import { registerBuiltinWorkAutomations } from "../../work/automations/builtins.js";

export const PLATFORM_OVERVIEW = `
FirstMate is a configurable CRM/operations platform for service companies. The
central concept is the SCOPE TEMPLATE (called an "automation set" or "board"
to customers): a versioned JSON definition that describes a workflow as a tree
of work nodes plus the automations around them.

## Scope templates
- kind "pipeline" (e.g. the Sales board — projects enter here via intake
  routing) or "production" (e.g. Roof Replacement — usually instantiated when
  a proposal containing that scope is signed).
- The definition contains: name/color/icon/description; proposal config
  (piece_types the template claims, supports_structures, fallback);
  work_plan.root_nodes — the node tree; optional materials/resources
  (pricebook-selector-driven material lists, labor with piece rates,
  equipment); commissions (roles + rules with preset or custom-code
  calculations, installments recognized on node hooks); checklists (crew and
  supervisor); custom_fields (durable typed project fields, nested groups,
  workforce assignment references, event-assignment defaults, and project-tag
  presentation); communications (including project email forwarding targets);
  metadata (board_color, canceled_column, ...).
- Nodes: {id, title, terminology_key ("work.stage" children of the root phase
  become kanban columns; "work.task" are to-dos when actionable), completion_mode
  (manual | all_children | any_child), depends_on [node ids], actionable,
  show_in_todo_list, assigned_role_ids, due_offset_minutes, children}.
- A project holds one or more scope INSTANCES (work plans). Stages of active
  instances drive board columns; project.work_projection and
  project.lifecycle {status, sold_at, completed_at} are derived projections.

## Automations (three attachment points, all inside the template JSON)
1. external_triggers on a node: {event, transition (completed|skipped|...),
   conditions, explainer, customer_visible} — a platform event moves the node.
2. automation_bindings on a node or the work_plan: keyed by lifecycle hook
   (onReady/onStarted/onCompleted/onSkipped/onCanceled/onTimer) or by a raw
   event name; each entry {id, automation, input, conditions, explainer,
   customer_visible, enabled}. The automation id must be one of the registered
   automations listed below. Inputs support {{path}} interpolation over the
   execution context AND the data providers.
3. timers on a node: {id, anchor: created|ready|started|due, offset_minutes,
   explainer} — fires the node's onTimer bindings once the time elapses.

Conditions are dot-path equality objects evaluated over
{event, payload, context, project, plan, node} — e.g.
{"payload.payment_kind": "deposit"} or {"project.claims.welcome_call": ""}.
Values may be arrays ("any of"). project.claim.v1 provides atomic
cross-instance coordination via project.claims.

## Customer-facing rules (IMPORTANT)
- Customers NEVER see raw JSON, event names, automation ids, or node ids.
  They see only the natural-language "explainer" strings. Every automation a
  customer should see MUST have a clear, friendly explainer written in the
  company's voice ("When materials are delivered, we create a crew to-do to
  confirm the delivery"). Entries without an explainer are hidden.
- Always keep explainers in sync with what the automation actually does.
- Speak to the customer in plain language. Never mention JSON, schemas,
  node ids, bindings, or events by name in chat replies.

## Around the templates
- Project scope configuration (branch module intake_routing): the data-driven
  scope buckets shown in Settings, the guaranteed default entry scope, and
  optional ordered field-formula rules for routing new projects.
- Intake automations ("when a new lead comes in, before it lands on any
  board"): organization automation rules on the project.created event. This is
  where pre-pipeline behavior belongs — queueing the first call, notifying
  people, texting an auto-reply to the lead, tagging by source.
- Organization automation rules (branch module automation_rules): org-wide
  {event|schedule.cron, conditions, automation, input} evaluated on EVERY
  event before scope bindings.
- Default instantiation bindings are injected automatically from template
  content: customFields.initializeFromScope.v1,
  materials.initializeFromScope.v1, checklists.initializeFromScope.v1,
  payroll.reconcileScopeCommissions.v1 (override by declaring a binding with
  the same id). Scope custom fields are additive by dotted path and remain on
  the project after that scope instance completes. Use assignable_subject,
  organization_user, resource_group, or organization_connection fields with
  the same assignment_policy format used by scheduling.

## Apps (what emits events and consumes scope data)
- Projects/CRM: leads and projects with contacts, kanban boards derived from
  scope stages, to-do lists from actionable nodes, follow-up call system with
  retry policies.
- Call lists: FULLY data-driven call queues. A list is just a record
  {key, title, kind, icon, tone, assignment, settings}; the Calls tab renders
  whatever active lists exist. Entries are added/removed ONLY by automations
  (crm.callLists.add.v1 / crm.callLists.remove.v1 — entries are deduped per
  project per list) or by call dispositions. Per-list workflow behavior
  (disposition options, outcomes, follow-up policy overrides) lives in the
  list's "settings". To create a new call queue, just have an automation add
  to it (the list is created from the binding's "list" definition) or use
  save_call_list. The default wiring: an org rule queues new leads on
  project.created (before any board), the sales pipeline's contact_lead node
  clears that entry when contact is made, and production scopes queue welcome
  calls when their welcome_call node goes ready.
- Proposals: WYSIWYG proposal editor, e-signature portal, PDF generation,
  customer choice options. Signing emits proposal.signed which (via the
  pipeline's signature node binding) instantiates the production scopes and
  creates the payment schedule.
- Payments/Money: obligations (deposit/progress/final), payments, invoices
  with PDF + email, expense tracking with projected vs actual, receipts with
  AI extraction, recurring billing summaries.
- Materials: template-defined material/labor/equipment lists resolved against
  the org pricebook, ordering, delivery scheduling with a client-evaluated
  schedule-rule DSL, delivery tracking (material.delivery.completed).
- Scheduling: calendar events (sales_appointment, project_work,
  material_delivery...), role-based availability for sales, crew assignment
  via work_resource_ref for production.
- Crew app (field): mobile view for crews — assigned work, time clock,
  checklists, materials confirmation, change orders, payments (cash/check).
- Payroll: compensation profiles (hourly/salary/piece-rate), commission
  engine driven by template commissions, pay schedules and batches.
- Pricebook: org catalog of items/assemblies with measurement-driven
  quantity formulas feeding proposals and material lists.
- FirstMeasure: roof measurement reports; measurements feed pricebook
  formulas and labor quantities.
- Messaging: SMS (Telnyx, consent-aware) and transactional email;
  communications.sendSms/sendEmail automations; inbound messages emit
  communication.received.
- Canvassing, Lead intake (public forms + instant estimates), Customer
  portal (proposal viewing/signing, payments, shared media; portal.visited).
- Recurrence: recurring visit series materializing calendar events plus
  per-occurrence billing.

## Safety rails for editing
- Save through the provided tools only; they validate and version templates.
- Node ids referenced by depends_on, commissions recognition, and material
  schedule source_node_template_id must exist in the tree.
- Prefer ADDING nodes/bindings over restructuring; never silently delete
  work the customer did not ask to remove.
- After a failed save, fix the reported errors and retry; if you cannot make
  a change work after several attempts, revert (the runner does this for you
  when you report failure) and tell the customer plainly that the change
  could not be applied.
`;

let prepared = false;

function ensureRegistries() {
  if (prepared) return;
  prepared = true;
  registerBuiltinWorkAutomations();
  registerBuiltinContextProviders();
}

export function buildPlatformManifest() {
  ensureRegistries();
  const events = listWorkEventDefinitions()
    .map((event) => `- ${event.name} [${event.visibility}]: ${event.description}`)
    .join("\n");
  const automations = listWorkAutomationDefinitions()
    .map((automation) => {
      const inputs = Object.entries(automation.input || {}).map(([key, doc]) => `    - ${key}: ${doc}`).join("\n");
      return `- ${automation.id}: ${automation.description || "(no description)"}${inputs ? `\n${inputs}` : ""}`;
    })
    .join("\n");
  const providers = listWorkContextProviders().join(", ");
  return `${PLATFORM_OVERVIEW}
## Event catalog (usable in external_triggers, bindings by raw event name, org rules)
${events}

## Registered automations (usable as \`automation\` in bindings and org rules)
${automations}

## Data context namespaces (usable in {{...}} interpolation and readable via the read_data tool)
${providers} — plus the execution context namespaces event, payload, plan, node, project, scope, proposal, payment.
`;
}
