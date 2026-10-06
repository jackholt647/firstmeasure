import { notifyWorkEvent, workflowNotificationInput } from "../platform/notification_events.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { env } from "../src/config/env.js";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { readDocument, type JsonObject } from "../platform/storage.js";
import {
  beginExecutionRecord,
  claimNextEvent,
  createEventRecord,
  finishEventRecord,
  renewEventLease,
  finishExecutionRecord,
  listNodeRecords,
  readNodeRecord,
  readPlanRecord
} from "./storage.js";
import { workAutomation, type WorkAutomationContext } from "./registry.js";
import { createWorkDataResolver, registerBuiltinContextProviders, type WorkContextScope } from "./context.js";
import { expandAutomationRules, readAutomationRules } from "./rules.js";
import { evaluateConditions } from "./conditions.js";
import { bindingExecutionId, bindingsForEvent } from "./bindings.js";
const deferredEvents=new AsyncLocalStorage<boolean>();
/** Record events during domain transactions; dispatch only after their commit. */
export function withDeferredWorkEvents<T>(operation:()=>Promise<T>){return deferredEvents.run(true,operation);}
export async function dispatchDeferredWorkEvents(){
  if(deferredEvents.getStore()||!(env.deploymentTopology==="single"||process.env.PLATFORM_PROCESS_ROLE==="worker"))return;
  if(env.isTest||process.env.NODE_ENV==="test")await drainWorkEvents();else scheduleWorkEventDrain();
}
import {
  createProjectScheduleRequirement,
  createWorkNotification,
  patchProjectDocument,
  registerBuiltinWorkAutomations
} from "./automations/builtins.js";

const workerId = `work_worker_${process.pid}_${randomUUID().slice(0, 8)}`;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// Conditions are evaluated over the full condition context: event, payload,
// context, project, plan, and node. The contract — the original equality map
// ({ "project.claims.welcome_call": "" } reads as "not yet claimed") and
// operator groups — lives in ./conditions.ts and is shared by every surface.
export function conditionMatches(conditions: JsonObject, context: JsonObject) {
  return evaluateConditions(conditions, context);
}

/**
 * `proposal.signed` subscriptions remain readable; only document.signed is
 * emitted. They match a signed proposal from either path: the retired proposal
 * link (`document_source: "proposals"`) or a proposal signed through Documents
 * (`document_type: "proposal"` or a `proposal` tag).
 */
export function matchesWorkEvent(subscription: string, event: JsonObject) {
  if (subscription === event.type) return true;
  if (subscription !== "proposal.signed" || event.type !== "document.signed") return false;
  const payload = asObject(event.payload);
  return payload.document_source === "proposals" || payload.document_type === "proposal"
    || asArray(payload.document_tags).map(cleanText).includes("proposal");
}

function eventTargetsNode(event: JsonObject, node: JsonObject) {
  const payload = asObject(event.payload);
  const entity = asObject(payload.event || payload.delivery || payload.payment);
  const metadata = asObject(entity.metadata);
  const targetPlanId = cleanText(payload.work_plan_id || entity.work_plan_id || metadata.work_plan_id);
  const targetScopePieceId = cleanText(payload.scope_piece_id || entity.scope_piece_id || metadata.scope_piece_id);
  if (targetPlanId && targetPlanId !== cleanText(node.plan_id)) return false;
  if (targetScopePieceId && targetScopePieceId !== cleanText(node.scope_piece_id)) return false;
  return true;
}

async function projectForEvent(event: JsonObject, plan: JsonObject): Promise<JsonObject> {
  const orgId = cleanText(event.organization_id);
  const projectId = cleanText(event.project_id || plan.project_id);
  if (!orgId || !projectId) return {};
  const document = await readDocument(orgId, "projects", projectId).catch(() => null);
  return document ? { id: projectId, ...asObject(document.data) } : { id: projectId };
}

function automationBindingsForEvent(event: JsonObject, plan: JsonObject, node: JsonObject) {
  // A lifecycle hook means this container's own work event and nothing else;
  // see ./bindings.ts.
  return cleanText(event.node_id)
    ? bindingsForEvent(node.automation_bindings, cleanText(event.type), "node")
    : bindingsForEvent(plan.automation_bindings, cleanText(event.type), "plan");
}

async function applyExternalTriggers(event: JsonObject, project: JsonObject) {
  const type = cleanText(event.type);
  if (type.startsWith("work.")) return;
  const orgId = cleanText(event.organization_id);
  const nodes = (await listNodeRecords(orgId, {
    ...(cleanText(event.project_id) ? { project_id: cleanText(event.project_id) } : {}),
    open_only: true
  }));
  for (const node of nodes) {
    if (!eventTargetsNode(event, node)) continue;
    const triggers = asArray(node.external_triggers).map(asObject);
    for (const trigger of triggers) {
      if (!matchesWorkEvent(cleanText(trigger.event), event)) continue;
      const conditionContext = {
        event,
        payload: asObject(event.payload),
        context: asObject(event.context),
        project,
        plan: {},
        node
      };
      if (!conditionMatches(asObject(trigger.conditions), conditionContext)) continue;
      const { transitionWorkNode } = await import("./service.js");
      await transitionWorkNode(orgId, cleanText(node.id), cleanText(trigger.transition || "completed"), {
        reason: `external_event:${type}`,
        payload: asObject(event.payload),
        actor_user_id: cleanText(asObject(event.context).actor_user_id)
      });
    }
  }
}

type ExecutableBinding = {
  binding: JsonObject;
  bindingId: string;
  plan: JsonObject;
  node: JsonObject;
};

async function assertEventLease(event: JsonObject) {
  if (!(await renewEventLease(cleanText(event.id), cleanText(event.lease_owner)))) throw new Error("Work event lease lost.");
}

async function executeBinding(event: JsonObject, executable: ExecutableBinding, project: JsonObject) {
  await assertEventLease(event);
  const orgId = cleanText(event.organization_id);
  const { binding, bindingId, plan, node } = executable;
  const automationId = cleanText(binding.automation);
  const execution = (await beginExecutionRecord({
    organization_id: orgId,
    event_id: event.id,
    lease_owner: event.lease_owner,
    binding_id: bindingId,
    automation: automationId,
    input: asObject(binding.input)
  }));
  if (!execution.execute) return { executed: false };
  try {
    const handler = workAutomation(automationId);
    if (!handler) throw new Error(`Unknown work automation '${automationId}'.`);
    const idempotencyKey = `${cleanText(event.idempotency_key)}:${bindingId}`;
    const dataScope: WorkContextScope = {
      organization_id: orgId,
      branch_id: cleanText(event.branch_id || "default") || "default",
      project_id: cleanText(project.id || plan.project_id || event.project_id),
      event,
      plan,
      node
    };
    const planContext = asObject(plan.context);
    const automationContext: WorkAutomationContext = {
      event,
      plan,
      node,
      project,
      scope: asObject(planContext.scope_piece || planContext.scope),
      proposal: asObject(planContext.proposal),
      now: new Date().toISOString(),
      idempotencyKey,
      data: createWorkDataResolver(dataScope),
      services: {
        patchProject: async (patch) => (await assertEventLease(event), await patchProjectDocument(orgId, cleanText(project.id || plan.project_id), patch)),
        createScheduleRequirement: async (input) => await createProjectScheduleRequirement(orgId, cleanText(project.id || plan.project_id), input),
        createNotification: async (input) => await createWorkNotification(orgId, cleanText(event.branch_id), cleanText(project.id || plan.project_id), await workflowNotificationInput(event,plan,node,binding,bindingId,input)),
        transitionNode: async (nodeId, status, input = {}) => {
          const { transitionWorkNode } = await import("./service.js");
          await assertEventLease(event);
          return await transitionWorkNode(orgId, nodeId, status, input) || {};
        },
        emit: async (type, payload = {}, context = {}) => (await emitWorkEvent({
          organization_id: orgId,
          branch_id: event.branch_id,
          project_id: event.project_id,
          plan_id: event.plan_id,
          node_id: event.node_id,
          type,
          payload,
          context,
          idempotency_key: `${idempotencyKey}:${type}`
        })) || {}
      }
    };
    await assertEventLease(event);
    const output = await handler(automationContext, asObject(binding.input));
    (await finishExecutionRecord(cleanText(event.id), bindingId, cleanText(event.lease_owner), output));
    return { executed: true };
  } catch (error) {
    (await finishExecutionRecord(cleanText(event.id), bindingId, cleanText(event.lease_owner), {}, error));
    await assertEventLease(event);
    if (binding.continue_on_error !== true) throw error;
    return { executed: true };
  }
}

async function executeEvent(event: JsonObject) {
  await assertEventLease(event);
  // Feedback runs under the durable event claim, including events enqueued
  // by HTTP replicas with process:false. Its service owns delivery deduplication.
  if (["work.plan.completed", "payment.received", "crew.checklist.completed"].includes(cleanText(event.type))) {
    const { handleFeedbackDeliveryEvent } = await import("../feedback/service.js");
    await handleFeedbackDeliveryEvent(event);
    await assertEventLease(event);
  }
  registerBuiltinWorkAutomations();
  registerBuiltinContextProviders();
  const orgId = cleanText(event.organization_id);
  const branchId = cleanText(event.branch_id || "default") || "default";
  const plan: JsonObject = cleanText(event.plan_id) ? (await readPlanRecord(orgId, cleanText(event.plan_id))) || {} : {};
  const node: JsonObject = cleanText(event.node_id) ? (await readNodeRecord(orgId, cleanText(event.node_id))) || {} : {};
  let project = await projectForEvent(event, plan);

  await notifyWorkEvent(event);
  await (await import('../integrations/jobs.js')).enqueueConnectionEvent(event);
  await assertEventLease(event);

  // 1. Organization automation rules — the always-on layer above every scope
  //    set. Evaluated first so org policy supersedes scope behavior.
  const { rules } = await readAutomationRules(orgId, branchId).catch(() => ({ rules: [] as JsonObject[] }));
  const type = cleanText(event.type);
  // A rule may carry several actions; each runs as its own execution, in order.
  for (const rule of expandAutomationRules(rules)) {
    if (rule.enabled === false || !cleanText(rule.automation)) continue;
    if (!matchesWorkEvent(cleanText(rule.event), event)) continue;
    const conditionContext = { event, payload: asObject(event.payload), context: asObject(event.context), project, plan, node };
    if (!conditionMatches(asObject(rule.conditions), conditionContext)) continue;
    const result = await executeBinding(event, {
      binding: { id: cleanText(rule.id), automation: rule.automation, input: asObject(rule.input), continue_on_error: rule.continue_on_error === true },
      bindingId: `org_rule:${cleanText(rule.id)}`,
      plan,
      node
    }, project);
    if (result.executed) project = await projectForEvent(event, plan);
  }

  // 2. Declarative node transitions (external triggers) across the project.
  await applyExternalTriggers(event, project);

  // 3. Scope bindings on the targeted plan or node. Project state is
  //    refreshed after each executed binding so later bindings (and their
  //    conditions) observe earlier writes — e.g. a claim taken by a sibling
  //    binding in the same cascade.
  const bindings = automationBindingsForEvent(event, plan, node);
  for (const [index, binding] of bindings.entries()) {
    if (binding.enabled === false) continue;
    const conditionContext = { event, payload: asObject(event.payload), context: asObject(event.context), project, plan, node };
    if (!conditionMatches(asObject(binding.conditions), conditionContext)) continue;
    const bindingId = bindingExecutionId(binding, type, index);
    const result = await executeBinding(event, { binding, bindingId, plan, node }, project);
    if (result.executed && index < bindings.length - 1) project = await projectForEvent(event, plan);
  }
}

let draining = false;
// A drain requested while one runs (an event emitted after that pass last
// looked at the queue) runs again right after it instead of waiting a tick.
let drainRequested = false;
export async function drainWorkEvents(limit = 100) {
  if (draining) { drainRequested = true; return 0; }
  draining = true;
  let processed = 0;
  try {
    while (processed < limit) {
      const event = await claimNextEvent(workerId);
      if (!event) break;
      let leaseLost = false;
      const heartbeat = setInterval(() => {
        void renewEventLease(cleanText(event.id), cleanText(event.lease_owner)).then(owned => { if (!owned) leaseLost = true; }).catch(() => { leaseLost = true; });
      }, 15000);
      heartbeat.unref();
      try {
        try { await (await import("../channels/feed.js")).recordFeedEvent(event); } catch { console.warn("Unable to materialize Feed event", cleanText(event.id)); }
        if (await isCapabilityEnabled(cleanText(event.organization_id), "platform.expanded_access")) await executeEvent(event);
        if (!leaseLost) await finishEventRecord(cleanText(event.id), cleanText(event.lease_owner));
      } catch (error) {
        if (!leaseLost) await finishEventRecord(cleanText(event.id), cleanText(event.lease_owner), error);
      } finally { clearInterval(heartbeat); }
      processed++;
    }
    return processed;
  } finally {
    draining = false;
    if (drainRequested) { drainRequested = false; scheduleWorkEventDrain(); }
  }
}

/* R4-RAIL-2: the event record is durable once createEventRecord returns, so
 * the HTTP request that emitted it must not wait while this process drains
 * the whole queue (every organization's pending events, up to 100 per pass —
 * 16–90 s under load). The drain is scheduled right after the response
 * instead; an event it cannot reach is claimed by the next scheduler tick
 * (single topology) or the platform worker (cluster), exactly as before. */
let drainScheduled = false;
export function scheduleWorkEventDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    void drainWorkEvents().then((processed) => {
      // A full pass may have left more work: keep going in the background.
      if (processed >= 100) scheduleWorkEventDrain();
    }).catch((error) => console.warn("Background work event drain failed", error));
  });
}

/* process: false only records the event; "inline" drains before returning
 * (deterministic test suites and callers that need the effects applied);
 * "background" (the runtime default) schedules the drain. */
export async function emitWorkEvent(input: JsonObject, options: { process?: boolean | "inline" | "background" } = {}) {
  if (!(await isCapabilityEnabled(cleanText(input.organization_id), "platform.expanded_access"))) {
    return { ...input, status: "disabled" };
  }
  const result = (await createEventRecord({
    ...input,
    type: cleanText(input.type || input.event) === "proposal.signed" ? "document.signed" : cleanText(input.type || input.event),
    ...(cleanText(input.type || input.event) === "proposal.signed" ? { payload: { ...asObject(input.payload), document_type: "proposal", document_tags: ["proposal"], document_source: "proposals", document_id: asObject(input.payload).proposal_id } } : {}),
    idempotency_key: cleanText(input.idempotency_key) || `${cleanText(input.type || input.event)}:${randomUUID()}`
  }));
  if (!deferredEvents.getStore() && options.process !== false && (env.deploymentTopology === "single" || process.env.PLATFORM_PROCESS_ROLE === "worker")) {
    // Test runs drain inline so assertions see automation effects; NODE_ENV is
    // read at call time because suites set it after importing the config.
    const testRuntime = env.isTest || process.env.NODE_ENV === "test";
    const inline = options.process === "inline" || (options.process !== "background" && testRuntime);
    if (inline) await drainWorkEvents();
    else scheduleWorkEventDrain();
  }
  return result.event;
}
