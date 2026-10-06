// The authoring catalog: everything an editor or an agent needs to build a
// valid automation without reading engine source — the events that can start
// one, the fields conditions can test, the operators, the actions with typed
// inputs, the lifecycle hooks, and the sequence shape.

import { registerBuiltinWorkAutomations } from "./automations/builtins.js";
import { eventForBindingKey } from "./bindings.js";
import { CONDITION_OPERATORS } from "./conditions.js";
import { listWorkContextProviders, registerBuiltinContextProviders } from "./context.js";
import { listWorkEventDefinitions, notificationEventGroups } from "./events.js";
import { listWorkAutomationDefinitions } from "./registry.js";

const HOOKS: [string, string][] = [
  ["onReady", "becomes ready (its dependencies are done)"],
  ["onStarted", "starts"],
  ["onCompleted", "is completed"],
  ["onSkipped", "is skipped"],
  ["onCanceled", "is canceled"],
  ["onBlocked", "becomes blocked"],
  ["onDue", "passes its due time"],
  ["onTimer", "reaches one of its timers (test payload.timer_id)"]
];
const PLAN_HOOKS: [string, string][] = [
  ["onCreated", "is created on a project"],
  ["onStarted", "starts"],
  ["onCompleted", "finishes"]
];
// Fields every condition can read, whatever the event.
const COMMON_FIELDS = [
  { field: "project.<field>", description: "Any field on the project, including custom fields and project.lifecycle.status." },
  { field: "project.claims.<key>.holder", description: "Who holds a one-time claim; empty when unclaimed." },
  { field: "payload.<field>", description: "A field carried by the event (the payload. prefix may be omitted)." },
  { field: "node.status", description: "Status of the work item the automation is attached to." },
  { field: "plan.status", description: "Status of the scope instance." },
  { field: "context.actor_user_id", description: "The user who caused the event, when there is one." }
];
const words = (value: string) => value.replace(/\.v\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());

export function automationCatalog(options: { includeInternal?: boolean } = {}) {
  registerBuiltinWorkAutomations();
  registerBuiltinContextProviders();
  return {
    events: listWorkEventDefinitions().map((event) => ({
      name: event.name, label: words(event.name), description: event.description, visibility: event.visibility,
      group: notificationEventGroups[event.notification.group]?.label || "Miscellaneous",
      // Work events drive hooks; every other event can be an external trigger.
      usable_as: event.name.startsWith("work.") ? ["binding", "organization_rule"] : ["external_trigger", "binding", "organization_rule"],
      fields: Object.entries(event.payload || {}).map(([key, description]) => ({ field: `payload.${key}`, description }))
    })),
    actions: listWorkAutomationDefinitions()
      .filter((action) => !/^(test\.|scope-test\.)/.test(action.id) && (options.includeInternal || !action.internal))
      .map((action) => ({ id: action.id, title: action.title || words(action.id), category: action.category, description: action.description || "", internal: action.internal, input_schema: action.input_schema })),
    conditions: {
      operators: CONDITION_OPERATORS,
      common_fields: COMMON_FIELDS,
      forms: {
        map: { "payload.payment_kind": "deposit", "project.claims.welcome_call": "" },
        group: { match: "all", rules: [{ field: "project.proposal_total_cents", operator: "greater_than", value: 1000000 }, { field: "payload.received_at", operator: "after", value: "now-3d" }] }
      }
    },
    hooks: {
      work_item: HOOKS.map(([key, when]) => ({ key, event: eventForBindingKey(key, "node"), when: `When this work item ${when}` })),
      scope: PLAN_HOOKS.map(([key, when]) => ({ key, event: eventForBindingKey(key, "plan"), when: `When the scope ${when}` }))
    },
    sequence: {
      description: "Ordered steps on a work item. Each step waits after the previous one, then runs its actions. The sequence ends when the work item is completed, skipped or canceled.",
      example: { start: "ready", steps: [
        { id: "text_now", actions: [{ automation: "communications.sendSms.v1", input: { to: "{{project.contacts.0.phone}}", text: "Thanks for reaching out!" } }] },
        { id: "email_in_two_days", wait: { days: 2 }, actions: [{ automation: "communications.sendEmail.v1", input: { to: "{{project.contacts.0.email}}", subject: "Still interested?", text: "Just checking in." } }] }
      ] }
    },
    organization_rule: {
      description: "Runs for every project. One trigger (event, or schedule.cron), optional conditions, and one or more actions run in order.",
      example: { id: "deposit_thanks", title: "Thank the customer for a deposit", event: "payment.received", conditions: { "payload.payment_kind": "deposit" }, actions: [
        { id: "text", automation: "communications.sendSms.v1", input: { to: "{{project.contacts.0.phone}}", text: "We received your deposit. Thank you!" } },
        { id: "todo", automation: "work.createTodo.v1", input: { title: "Order materials", assigned_role_ids: ["production"] } }
      ] }
    },
    data_namespaces: [...listWorkContextProviders(), "event", "payload", "plan", "node", "project", "scope", "proposal", "payment"]
  };
}
