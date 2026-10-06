// Automation dry run: "what would happen if…", without doing any of it.
//
// A dry run takes a scope definition (saved or not), organization rules (saved
// or not) and a list of steps — events, manual transitions and the passing of
// time — and replays them through the same matching the engine uses: rule and
// trigger matching, binding resolution, conditions, sequence timers, dependency
// unlocking and parent roll-up. Actions are resolved (their inputs are
// interpolated and checked against the action catalog) but never executed, and
// nothing is written.
//
// Two things are deliberately approximated and reported in `notes`:
//   - Effects are not performed, so only `project.patch.v1` and
//     `project.claim.v1` change the simulated project that later conditions see.
//   - Custom code (`scope.code.run.v1`) is reported, not run.
//
// This is infrastructure for agents and tests. It is not offered in the product UI.

import { Ajv } from "ajv";

import { badRequest } from "../platform/errors.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { registerBuiltinWorkAutomations, resolveAutomationInput } from "../work/automations/builtins.js";
import { bindingExecutionId, bindingsForEvent, normalizeBindingKeys } from "../work/bindings.js";
import { explainConditions, validateConditions, type ConditionTrace } from "../work/conditions.js";
import { createWorkDataResolver, registerBuiltinContextProviders } from "../work/context.js";
import { matchesWorkEvent } from "../work/engine.js";
import { workEventDefinition } from "../work/events.js";
import { hasWorkAutomation, listWorkAutomationDefinitions, type WorkAutomationContext } from "../work/registry.js";
import { expandAutomationRules, readAutomationRules } from "../work/rules.js";
import { createWorkPlanSchema } from "../work/schemas.js";
import { compileSequences, waitMinutes } from "../work/sequences.js";
import { listDependenciesForNode, listNodeRecords, readPlanRecord } from "../work/storage.js";
import { compileScopeCommissionBindings } from "../payroll/commission_rules.js";
import { scopeTemplateDefinitionSchema } from "./schemas.js";
import { defaultInstantiationBindings } from "./service.js";
import { readScopeTemplate } from "./storage.js";

const text = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const TERMINAL = new Set(["completed", "skipped", "canceled"]);
const MAX_EVENTS = 500;

type SimNode = {
  id: string; record_id: string; title: string; parent: string; children: string[]; depends_on: string[];
  status: string; completion_mode: string; actionable: boolean; terminology: string;
  bindings: JsonObject; triggers: JsonObject[]; timers: JsonObject[]; metadata: JsonObject;
  times: Record<string, number>; due_at: number; fired: Set<string>;
};
type SimEvent = { type: string; node_id: string; payload: JsonObject; context: JsonObject; cause: string };

export type DryRunActionTrace = {
  source: "organization_rule" | "scope" | "work_item";
  id: string; automation: string; label: string; location: string;
  would_run: boolean; reason: string;
  conditions: ConditionTrace | null;
  input: JsonObject | null; input_issues: string[]; note?: string;
};

function eventForStatus(status: string) {
  return status === "active" ? "work.node.started" : `work.node.${status}`;
}

function mergeBindings(...sources: unknown[]) {
  const merged: Record<string, unknown[]> = {};
  for (const source of sources) for (const [key, list] of Object.entries(asObject(source))) merged[key] = [...(merged[key] || []), ...asArray(list)];
  return normalizeBindingKeys(merged, "plan");
}

function durationMinutes(value: unknown) {
  return typeof value === "number" ? Math.max(0, value) : waitMinutes(value);
}

const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map<string, ReturnType<Ajv["compile"]>>();
function inputIssues(automation: string, input: JsonObject, schemas: Map<string, unknown>) {
  const schema = schemas.get(automation);
  if (!schema) return [];
  if (!validators.has(automation)) {
    try { validators.set(automation, ajv.compile(schema as object)); } catch { return []; }
  }
  const validate = validators.get(automation)!;
  if (validate(input)) return [];
  return (validate.errors || []).slice(0, 10).map((error) => `${error.instancePath ? `input${error.instancePath.replace(/\//g, ".")}` : "input"} ${error.message}${error.params && "missingProperty" in error.params ? ` (${String(error.params.missingProperty)})` : ""}`);
}

/** Problems in a definition's automations that would not stop a save but would misbehave at run time. */
export function reviewScopeAutomations(definition: JsonObject) {
  registerBuiltinWorkAutomations();
  const issues: { level: "error" | "warning"; kind: "action" | "condition" | "event"; where: string; message: string }[] = [];
  const checkBindings = (bindings: unknown, where: string) => {
    for (const [key, list] of Object.entries(asObject(bindings))) for (const [index, value] of asArray(list).entries()) {
      const binding = asObject(value);
      const label = `${where} › ${key}[${text(binding.id) || index}]`;
      if (!hasWorkAutomation(text(binding.automation))) issues.push({ level: "error", kind: "action", where: label, message: `Unknown action "${text(binding.automation)}".` });
      for (const message of validateConditions(binding.conditions)) issues.push({ level: "error", kind: "condition", where: label, message });
    }
  };
  const walk = (nodes: unknown[], path: string) => {
    for (const value of nodes) {
      const node = asObject(value);
      const where = `${path}${text(node.title) || text(node.id)}`;
      checkBindings(node.automation_bindings, where);
      for (const [index, value] of asArray(node.external_triggers).entries()) {
        const trigger = asObject(value);
        const label = `${where} › trigger[${text(trigger.id) || index}]`;
        const event = text(trigger.event);
        if (event.startsWith("work.")) issues.push({ level: "error", kind: "event", where: label, message: "Work events cannot be used as external triggers; use a dependency or a binding." });
        else if (event !== "proposal.signed" && !workEventDefinition(event).description) issues.push({ level: "warning", kind: "event", where: label, message: `"${event}" is not a registered event.` });
        for (const message of validateConditions(trigger.conditions)) issues.push({ level: "error", kind: "condition", where: label, message });
      }
      for (const step of asArray(asObject(node.sequence).steps).map(asObject)) {
        for (const message of validateConditions(step.conditions)) issues.push({ level: "error", kind: "condition", where: `${where} › sequence step ${text(step.id)}`, message });
      }
      walk(asArray(node.children), `${where} / `);
    }
  };
  const workPlan = asObject(definition.work_plan);
  checkBindings(workPlan.automation_bindings, "Scope");
  walk(compileSequences(asArray(workPlan.root_nodes)), "");
  return issues;
}

export async function dryRunAutomations(orgId: string, branchIdValue: string, inputValue: JsonObject) {
  registerBuiltinWorkAutomations();
  registerBuiltinContextProviders();
  const input = asObject(inputValue);
  const branchId = text(branchIdValue) || "default";
  const notes: string[] = [];
  let clock = Number.isFinite(Date.parse(text(input.now))) ? Date.parse(text(input.now)) : Date.now();

  // ── What is being simulated ────────────────────────────────────────────────
  const planId = text(input.plan_id);
  const livePlan = planId ? await readPlanRecord(orgId, planId) : null;
  if (planId && !livePlan) throw badRequest("dry_run_plan_not_found", "That scope instance was not found.");
  const templateId = text(input.template_id) || text(livePlan?.template_id);
  let definition: JsonObject | null = input.definition ? asObject(input.definition) : null;
  if (!definition && templateId && !livePlan) definition = asObject(asObject(await readScopeTemplate(orgId, branchId, templateId)).definition);
  if (definition) {
    const parsed = scopeTemplateDefinitionSchema.safeParse(definition);
    if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`), issues: [], steps: [], notes };
    const compile = createWorkPlanSchema.safeParse({ title: text(definition.name) || "Dry run", root_nodes: asObject(definition.work_plan).root_nodes });
    if (!compile.success) return { ok: false, errors: compile.error.issues.map((issue) => `work_plan.${issue.path.join(".")}: ${issue.message}`), issues: [], steps: [], notes };
  }
  const issues = definition ? reviewScopeAutomations(definition) : [];

  const projectId = text(input.project_id) || text(livePlan?.project_id);
  const stored = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
  if (projectId && !stored) notes.push(`Project ${projectId} was not found; using only the sample project fields supplied.`);
  let project: JsonObject = { id: projectId || "dry_run_project", ...asObject(stored?.data), ...asObject(input.project) };
  const initialProject = project;

  const rulesSource = Array.isArray(input.rules) ? { rules: asArray(input.rules).map(asObject) } : input.include_organization_rules === false ? { rules: [] } : await readAutomationRules(orgId, branchId).catch(() => ({ rules: [] as JsonObject[] }));
  const rules = expandAutomationRules(rulesSource.rules as JsonObject[]);
  const actionSchemas = new Map(listWorkAutomationDefinitions().map((action) => [action.id, action.input_schema as unknown]));
  const actionTitles = new Map(listWorkAutomationDefinitions().map((action) => [action.id, action.title || action.id]));

  // ── Simulated plan state ───────────────────────────────────────────────────
  const nodes = new Map<string, SimNode>();
  const order: string[] = [];
  let planBindings: JsonObject = {};
  let planStatus = "none";
  const plan: JsonObject = { id: planId || "dry_run_plan", project_id: project.id, branch_id: branchId, template_id: templateId, title: text(definition?.name || livePlan?.title), context: asObject(livePlan?.context) };
  const queue: SimEvent[] = [];
  const emit = (type: string, nodeId = "", payload: JsonObject = {}, cause = "", context: JsonObject = {}) => queue.push({ type, node_id: nodeId, payload, context, cause });

  if (livePlan) {
    planStatus = text(livePlan.status);
    planBindings = asObject(livePlan.automation_bindings);
    const records = await listNodeRecords(orgId, { plan_id: planId });
    const templateIdByRecord = new Map(records.map((record) => [text(record.id), text(record.template_node_id) || text(record.id)]));
    for (const record of records) {
      const id = templateIdByRecord.get(text(record.id))!;
      const dependencies = (await listDependenciesForNode(text(record.id))).map((row) => templateIdByRecord.get(text(asObject(row).depends_on_node_id)) || "").filter(Boolean);
      nodes.set(id, {
        id, record_id: text(record.id), title: text(record.title), parent: templateIdByRecord.get(text(record.parent_id)) || "", children: [], depends_on: dependencies,
        status: text(record.status), completion_mode: text(record.completion_mode), actionable: record.actionable === true, terminology: text(record.terminology_key),
        bindings: asObject(record.automation_bindings), triggers: asArray(record.external_triggers).map(asObject), timers: asArray(asObject(record.metadata).timers).map(asObject), metadata: asObject(record.metadata),
        times: { created: Date.parse(text(record.created_at)), ready: Date.parse(text(record.ready_at)), started: Date.parse(text(record.started_at)), due: Date.parse(text(record.due_at)) },
        due_at: Date.parse(text(record.due_at)), fired: new Set()
      });
      order.push(id);
    }
    notes.push("Simulating against this scope instance's current state. Timers that have already fired on the live instance may be reported again.");
  } else if (definition) {
    const workPlan = asObject(definition.work_plan);
    planBindings = mergeBindings(workPlan.automation_bindings, input.signed_proposal === true ? compileScopeCommissionBindings(definition).plan : {}, defaultInstantiationBindings(definition));
    const insert = (value: unknown, parent: string) => {
      const node = asObject(value);
      const id = text(node.id);
      const children = asArray(node.children);
      nodes.set(id, {
        id, record_id: id, title: text(node.title), parent, children: [], depends_on: asArray(node.depends_on).map(text),
        status: "pending", completion_mode: text(node.completion_mode) || (children.length ? "all_children" : "manual"), actionable: node.actionable === true, terminology: text(node.terminology_key),
        bindings: normalizeBindingKeys(node.automation_bindings, "node"), triggers: asArray(node.external_triggers).map(asObject), timers: asArray(node.timers).map(asObject), metadata: asObject(node.metadata),
        times: { created: clock }, due_at: Number.isFinite(Number(node.due_offset_minutes)) ? clock + Number(node.due_offset_minutes) * 60_000 : NaN, fired: new Set()
      });
      order.push(id);
      children.forEach((child) => insert(child, id));
    };
    compileSequences(asArray(workPlan.root_nodes)).forEach((root) => insert(root, ""));
    planStatus = "pending";
  }
  for (const node of nodes.values()) if (node.parent) nodes.get(node.parent)?.children.push(node.id);

  const nodeView = (node: SimNode | undefined): JsonObject => node ? { id: node.record_id, template_node_id: node.id, title: node.title, status: node.status, plan_id: plan.id, metadata: node.metadata } : {};
  const setStatus = (node: SimNode, status: string, reason: string, payload: JsonObject = {}) => {
    if (node.status === status) return;
    const from = node.status;
    node.status = status;
    if (status === "ready" || status === "active") node.times[status === "active" ? "started" : "ready"] = clock;
    if (status === "active" && !Number.isFinite(node.times.ready)) node.times.ready = clock;
    emit(eventForStatus(status), node.id, { from_status: from, to_status: status, reason, ...payload }, reason);
  };
  const dependenciesSatisfied = (node: SimNode) => node.depends_on.every((id) => ["completed", "skipped"].includes(nodes.get(id)?.status || "completed"));
  const recalculate = () => {
    if (planStatus !== "active") return;
    for (let pass = 0; pass < 100; pass += 1) {
      let changed = false;
      for (const id of order) {
        const node = nodes.get(id)!;
        if (["pending", "blocked"].includes(node.status)) {
          const parent = node.parent ? nodes.get(node.parent) : null;
          if ((!parent || parent.status === "active") && dependenciesSatisfied(node)) { setStatus(node, node.children.length ? "active" : "ready", "dependencies_satisfied"); changed = true; continue; }
          if (node.status !== "blocked") { node.status = "blocked"; changed = true; }
        }
        if (node.status === "active" && node.children.length) {
          const children = node.children.map((child) => nodes.get(child)!);
          const allTerminal = children.every((child) => TERMINAL.has(child.status));
          const anyCompleted = children.some((child) => ["completed", "skipped"].includes(child.status));
          if ((node.completion_mode === "all_children" && allTerminal) || (node.completion_mode === "any_child" && anyCompleted)) { setStatus(node, "completed", "child_rollup"); changed = true; }
        }
      }
      if (!changed) break;
    }
    const roots = order.map((id) => nodes.get(id)!).filter((node) => !node.parent);
    if (roots.length && roots.every((node) => TERMINAL.has(node.status))) { planStatus = "completed"; emit("work.plan.completed", "", {}, "all_work_finished"); }
  };

  // ── Event processing (mirrors work/engine.ts executeEvent) ─────────────────
  let processed = 0;
  const describeAction = async (source: DryRunActionTrace["source"], binding: JsonObject, id: string, location: string, event: SimEvent, node: SimNode | undefined): Promise<DryRunActionTrace> => {
    const automation = text(binding.automation);
    const eventRecord: JsonObject = { id: "dry_run_event", organization_id: orgId, branch_id: branchId, project_id: project.id, plan_id: nodes.size ? plan.id : "", node_id: node?.record_id || "", type: event.type, payload: event.payload, context: event.context };
    const conditionContext = { event: eventRecord, payload: event.payload, context: event.context, project, plan: { ...plan, status: planStatus }, node: nodeView(node) };
    const base = { source, id, automation, label: text(binding.explainer || binding.title) || actionTitles.get(automation) || automation, location };
    if (binding.enabled === false) return { ...base, would_run: false, reason: "disabled", conditions: null, input: null, input_issues: [] };
    const conditions = Object.keys(asObject(binding.conditions)).length ? explainConditions(binding.conditions, conditionContext, { now: clock }) : null;
    if (conditions && !conditions.matched) return { ...base, would_run: false, reason: "conditions_not_met", conditions, input: null, input_issues: [] };
    if (!hasWorkAutomation(automation)) return { ...base, would_run: false, reason: "unknown_action", conditions, input: null, input_issues: [`Unknown action "${automation}".`] };
    const planContext = asObject(plan.context);
    const context: WorkAutomationContext = {
      event: eventRecord, plan: { ...plan, status: planStatus }, node: nodeView(node), project,
      scope: asObject(planContext.scope_piece || planContext.scope), proposal: asObject(planContext.proposal),
      now: new Date(clock).toISOString(), idempotencyKey: `dry_run:${id}`,
      data: createWorkDataResolver({ organization_id: orgId, branch_id: branchId, project_id: text(project.id), event: eventRecord, plan, node: nodeView(node) }),
      services: {
        patchProject: async () => ({}), createScheduleRequirement: async () => ({}), createNotification: async () => ({}),
        transitionNode: async () => ({}), emit: async () => ({})
      }
    };
    let note: string | undefined;
    let resolved: JsonObject = asObject(binding.input);
    if (automation === "scope.code.run.v1") note = "Custom code is not executed in a dry run.";
    else resolved = asObject(await resolveAutomationInput(binding.input || {}, context));
    // The two actions whose effect later conditions most often read.
    if (automation === "project.patch.v1") project = { ...project, ...asObject(resolved.values || resolved.patch || resolved) };
    if (automation === "project.claim.v1" && text(resolved.key)) {
      const claims = asObject(project.claims);
      const holder = text(resolved.holder) || text(plan.id);
      if (text(asObject(claims[text(resolved.key)]).holder)) note = `Already claimed by ${text(asObject(claims[text(resolved.key)]).holder)}.`;
      else project = { ...project, claims: { ...claims, [text(resolved.key)]: { holder } } };
    }
    return { ...base, would_run: true, reason: "would_run", conditions, input: resolved, input_issues: automation === "scope.code.run.v1" ? [] : inputIssues(automation, resolved, actionSchemas), ...(note ? { note } : {}) };
  };

  const processQueue = async () => {
    const results: JsonObject[] = [];
    while (queue.length) {
      if (processed++ >= MAX_EVENTS) { notes.push(`Stopped after ${MAX_EVENTS} events; the definition may loop.`); queue.length = 0; break; }
      const event = queue.shift()!;
      const node = event.node_id ? nodes.get(event.node_id) : undefined;
      const record: JsonObject = { event: event.type, ...(node ? { work_item: { id: node.id, title: node.title } } : {}), ...(event.cause ? { cause: event.cause } : {}), ...(Object.keys(event.payload).length ? { payload: event.payload } : {}) };
      const actions: DryRunActionTrace[] = [];
      const eventJson: JsonObject = { type: event.type, payload: event.payload };
      for (const rule of rules) {
        if (!text(rule.automation) || !matchesWorkEvent(text(rule.event), eventJson)) continue;
        actions.push(await describeAction("organization_rule", rule, `org_rule:${text(rule.id)}`, `Organization rule “${text(rule.title) || text(rule.rule_id)}”`, event, node));
      }
      const transitions: JsonObject[] = [];
      if (!event.type.startsWith("work.")) {
        for (const id of order) {
          const candidate = nodes.get(id)!;
          if (TERMINAL.has(candidate.status)) continue;
          for (const trigger of candidate.triggers) {
            if (!matchesWorkEvent(text(trigger.event), eventJson)) continue;
            const trace = explainConditions(trigger.conditions || {}, { event: eventJson, payload: event.payload, context: event.context, project, plan: {}, node: nodeView(candidate) }, { now: clock });
            const to = text(trigger.transition) || "completed";
            transitions.push({ work_item: { id: candidate.id, title: candidate.title }, to, applied: trace.matched && planStatus === "active", conditions: Object.keys(asObject(trigger.conditions)).length ? trace : null, ...(planStatus !== "active" ? { reason: `scope is ${planStatus}` } : {}) });
            if (trace.matched && planStatus === "active") setStatus(candidate, to, `external_event:${event.type}`, event.payload);
          }
        }
        recalculate();
      }
      const bindings = node ? bindingsForEvent(node.bindings, event.type, "node") : nodes.size || Object.keys(planBindings).length ? bindingsForEvent(planBindings, event.type, "plan") : [];
      for (const [index, binding] of bindings.entries()) {
        if (planStatus === "canceled" && !["work.node.canceled", "work.plan.canceled"].includes(event.type)) break;
        actions.push(await describeAction(node ? "work_item" : "scope", binding, bindingExecutionId(binding, event.type, index), node ? `“${node.title}”` : "Scope", event, node));
      }
      if (actions.length || transitions.length || !event.type.startsWith("work.")) results.push({ ...record, ...(transitions.length ? { transitions } : {}), actions });
    }
    return results;
  };

  const steps: JsonObject[] = [];
  if (!livePlan && definition) {
    emit("work.plan.created", "", {}, "scope_started");
    planStatus = "active";
    emit("work.plan.started", "", {}, "scope_started");
    recalculate();
    steps.push({ step: "start", description: "A new instance of this scope starts.", events: await processQueue() });
  }

  for (const [index, value] of asArray(input.steps).entries()) {
    const step = asObject(value);
    if (step.advance !== undefined) {
      const minutes = durationMinutes(step.advance);
      clock += minutes * 60_000;
      if (planStatus === "active") for (const id of order) {
        const node = nodes.get(id)!;
        if (TERMINAL.has(node.status)) continue;
        for (const timer of node.timers) {
          const timerId = text(timer.id);
          const anchor = text(timer.anchor) || "ready";
          const fireAt = Number(node.times[anchor === "due" ? "due" : anchor]) + Math.max(0, Number(timer.offset_minutes || 0)) * 60_000;
          if (!timerId || node.fired.has(`timer:${timerId}`) || !Number.isFinite(fireAt) || fireAt > clock) continue;
          node.fired.add(`timer:${timerId}`);
          emit("work.node.timer", node.id, { timer_id: timerId, anchor, fire_at: new Date(fireAt).toISOString() }, "timer");
        }
        if (Number.isFinite(node.due_at) && node.due_at <= clock && !node.fired.has("due") && ["ready", "active"].includes(node.status)) { node.fired.add("due"); emit("work.node.due", node.id, {}, "due"); }
      }
      steps.push({ step: index + 1, description: `Time passes: ${minutes} minutes.`, now: new Date(clock).toISOString(), events: await processQueue() });
      continue;
    }
    if (step.transition !== undefined) {
      const transition = asObject(step.transition);
      const node = nodes.get(text(transition.node_id));
      if (!node) throw badRequest("dry_run_node_not_found", `Step ${index + 1}: no work item "${text(transition.node_id)}" in this scope.`);
      setStatus(node, text(transition.status) || "completed", text(transition.reason) || "manual");
      recalculate();
      steps.push({ step: index + 1, description: `“${node.title}” is marked ${node.status}.`, events: await processQueue() });
      continue;
    }
    const type = text(step.event);
    if (!type) throw badRequest("dry_run_step_invalid", `Step ${index + 1} needs "event", "transition" or "advance".`);
    if (text(step.node_id) && !nodes.has(text(step.node_id))) throw badRequest("dry_run_node_not_found", `Step ${index + 1}: no work item "${text(step.node_id)}" in this scope.`);
    emit(type === "proposal.signed" ? "document.signed" : type, text(step.node_id),
      type === "proposal.signed" ? { ...asObject(step.payload), document_source: "proposals" } : asObject(step.payload), "", asObject(step.context));
    steps.push({ step: index + 1, description: `Event ${type}${workEventDefinition(type).description ? "" : " (not a registered event)"}.`, events: await processQueue() });
  }

  const pendingTimers = order.flatMap((id) => {
    const node = nodes.get(id)!;
    if (TERMINAL.has(node.status)) return [];
    return node.timers.filter((timer) => !node.fired.has(`timer:${text(timer.id)}`)).map((timer) => {
      const anchor = text(timer.anchor) || "ready";
      const fireAt = Number(node.times[anchor]) + Math.max(0, Number(timer.offset_minutes || 0)) * 60_000;
      return { work_item: node.id, timer_id: text(timer.id), anchor, offset_minutes: Number(timer.offset_minutes || 0), fires_at: Number.isFinite(fireAt) ? new Date(fireAt).toISOString() : null };
    });
  });
  const stage = order.map((id) => nodes.get(id)!).find((node) => node.terminology.endsWith("stage") && ["active", "ready"].includes(node.status));
  return {
    ok: !issues.some((issue) => issue.level === "error"),
    errors: issues.filter((issue) => issue.level === "error").map((issue) => `${issue.where}: ${issue.message}`),
    issues, steps,
    final: {
      now: new Date(clock).toISOString(), scope_status: planStatus, ...(stage ? { current_stage: { id: stage.id, title: stage.title } } : {}),
      work_items: order.map((id) => { const node = nodes.get(id)!; return { id: node.id, title: node.title, status: node.status }; }),
      pending_timers: pendingTimers, project_changes: Object.fromEntries(Object.entries(project).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(initialProject[key])))
    },
    notes: [...notes, "Nothing was executed or saved. Messages, documents, notifications and other effects are listed, not performed."]
  };
}
