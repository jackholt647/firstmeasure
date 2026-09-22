import { createHash, randomUUID } from "node:crypto";

import { badRequest, notFound } from "../platform/errors.js";
import { listDocuments, readDocument, upsertDocument } from "../platform/storage.js";
import { listScopeTemplates } from "../scopes/storage.js";
import { normalizeAssignmentPolicy } from "../workforce/assignability.js";
import { resolveAssignableSubjects } from "../workforce/service.js";
import { readWorkConfiguration } from "./config.js";
import {
  createDependencyRecord,
  createNodeRecord,
  createPlanRecord,
  getWorkDatabase,
  listDependenciesForNode,
  listNodeRecords,
  listPlanRecords,
  nodeStatusCounts,
  readNodeRecord,
  readPlanRecord,
  replaceDependencyRecords,
  terminalNodeStatus,
  transitionTimestampPatch,
  updateNodeRecord,
  updatePlanRecord,
  type JsonObject
} from "./storage.js";
import { createWorkPlanSchema, workNodeStatusSchema, type WorkNodeDefinition, type WorkNodeStatus } from "./schemas.js";
import { emitWorkEvent } from "./engine.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function eventNameForStatus(status: string) {
  if (status === "active") return "work.node.started";
  return `work.node.${status}`;
}

function defaultCompletionMode(definition: WorkNodeDefinition) {
  const children = asArray(definition.children);
  if (cleanText(definition.completion_mode)) return cleanText(definition.completion_mode);
  return children.length ? "all_children" : "manual";
}

function dueAtForDefinition(definition: WorkNodeDefinition, start = Date.now()) {
  if (!Number.isFinite(Number(definition.due_offset_minutes))) return "";
  return new Date(start + Number(definition.due_offset_minutes) * 60_000).toISOString();
}

export function validateDefinitionIds(rootNodes: WorkNodeDefinition[]) {
  const ids = new Set<string>();
  const visit = (node: WorkNodeDefinition) => {
    if (ids.has(node.id)) throw badRequest("duplicate_work_node_id", `Work node template id '${node.id}' is duplicated.`);
    ids.add(node.id);
    asArray(node.children).forEach((child) => visit(child as WorkNodeDefinition));
  };
  rootNodes.forEach(visit);
  const checkDependencies = (node: WorkNodeDefinition) => {
    for (const dependency of asArray(node.depends_on).map(cleanText)) {
      if (!ids.has(dependency)) throw badRequest("unknown_work_dependency", `Work node '${node.id}' depends on unknown node '${dependency}'.`);
      if (dependency === node.id) throw badRequest("self_work_dependency", `Work node '${node.id}' cannot depend on itself.`);
    }
    asArray(node.children).forEach((child) => checkDependencies(child as WorkNodeDefinition));
  };
  rootNodes.forEach(checkDependencies);
}

async function validateWorkNodeAssignment(orgId: string, branchId: string, nodeValue: JsonObject) {
  const metadata = asObject(nodeValue.metadata);
  const hasPolicy = Object.prototype.hasOwnProperty.call(nodeValue, "assignment_policy")
    || Object.prototype.hasOwnProperty.call(metadata, "assignment_policy");
  if (!hasPolicy) return;
  const policy = normalizeAssignmentPolicy(nodeValue.assignment_policy ?? metadata.assignment_policy);
  const assignedUserIds = asArray(nodeValue.assigned_user_ids).map(cleanText).filter(Boolean);
  const assignedRoleIds = asArray(nodeValue.assigned_role_ids).map(cleanText).filter(Boolean);
  const assignedGroupIds = asArray(nodeValue.assigned_resource_group_ids).map(cleanText).filter(Boolean);
  if (!assignedUserIds.length && !assignedRoleIds.length && !assignedGroupIds.length) {
    if (!policy.allow_unassigned) {
      throw badRequest("work_assignment_required", "This work item requires an assignment.", { policy });
    }
    return;
  }

  const resolved = await resolveAssignableSubjects(orgId, branchId || "default", policy);
  const allowed = new Set(resolved.subjects.map((subject) => `${cleanText(subject.subject_type)}:${cleanText(subject.id)}`));
  const rejected = [
    ...assignedUserIds.map((id) => `organization_user:${id}`),
    ...assignedGroupIds.map((id) => `resource_group:${id}`)
  ].filter((key) => !allowed.has(key));

  const broadRoleRules = policy.rules.filter((rule) => (
    (!rule.subject_types.length || rule.subject_types.includes("organization_user"))
    && !rule.subject_ids.length
    && !rule.assignment_tag_ids.length
    && !rule.capability_scope_ids.length
    && !rule.group_kind_ids.length
    && !rule.kind_ids.length
  ));
  rejected.push(...assignedRoleIds
    .filter((roleId) => !broadRoleRules.some((rule) => !rule.role_ids.length || rule.role_ids.includes(roleId)))
    .map((roleId) => `organization_user_role:${roleId}`));

  if (rejected.length) {
    throw badRequest("work_assignment_not_allowed", "One or more work-item assignees do not satisfy this assignment policy.", {
      rejected,
      policy
    });
  }
}

export async function createWorkPlan(inputValue: JsonObject) {
  const input = createWorkPlanSchema.parse(inputValue);
  validateDefinitionIds(input.root_nodes);
  const orgId = cleanText(inputValue.organization_id);
  if (!orgId) throw badRequest("missing_organization_id", "An organization id is required.");
  const validateDefinitions = async (nodes: WorkNodeDefinition[]) => {
    for (const definition of nodes) {
      await validateWorkNodeAssignment(orgId, cleanText(input.branch_id || "default"), definition as JsonObject);
      await validateDefinitions(asArray(definition.children) as WorkNodeDefinition[]);
    }
  };
  await validateDefinitions(input.root_nodes);
  const planId = cleanText(input.id) || stableId("work_plan", `${orgId}:${cleanText(input.source_key) || randomUUID()}`);
  const db = getWorkDatabase();
  const nodeIds = new Map<string, string>();
  const definitions: WorkNodeDefinition[] = [];
  const createdPlan = await db.transaction(async () => {
    const createdPlan = (await createPlanRecord({ ...input, id: planId, organization_id: orgId, status: "pending" }));
    if (!createdPlan.plan) throw new Error("Work plan storage did not return the created plan.");
    if (createdPlan.created) {
      const insert = async (definition: WorkNodeDefinition, parentId: string | null, depth: number, index: number) => {
        const nodeId = stableId("work_node", `${planId}:${definition.id}`);
        nodeIds.set(definition.id, nodeId);
        definitions.push(definition);
        (await createNodeRecord({
          id: nodeId,
          organization_id: orgId,
          branch_id: input.branch_id || "default",
          plan_id: planId,
          project_id: input.project_id,
          parent_id: parentId,
          template_node_id: definition.id,
          scope_piece_id: input.scope_piece_id,
          terminology_key: definition.terminology_key,
          title: definition.title,
          description: definition.description,
          sort_order: definition.sort_order ?? index,
          depth,
          status: "pending",
          completion_mode: defaultCompletionMode(definition),
          actionable: definition.actionable === true,
          show_in_todo_list: definition.show_in_todo_list ?? definition.actionable === true,
          priority: Number(definition.priority || 0),
          assigned_user_ids: definition.assigned_user_ids || [],
          assigned_role_ids: definition.assigned_role_ids || [],
          assigned_resource_group_ids: definition.assigned_resource_group_ids || [],
          automation_bindings: definition.automation_bindings || {},
          external_triggers: definition.external_triggers || [],
          due_at: dueAtForDefinition(definition),
          metadata: {
            ...(definition.metadata || {}),
            ...(Object.prototype.hasOwnProperty.call(definition, "assignment_policy")
              ? { assignment_policy:(definition as JsonObject).assignment_policy }
              : {}),
            // Declared timers ride on node metadata; the scheduler fires
            // `work.node.timer` when anchor + offset elapses.
            ...(Array.isArray((definition as JsonObject).timers) && ((definition as JsonObject).timers as unknown[]).length
              ? { timers: (definition as JsonObject).timers }
              : {})
          }
        }));
        for (const [childIndex, child] of asArray(definition.children).entries()) {(await insert(child as WorkNodeDefinition, nodeId, depth + 1, childIndex));}
      };
      for (const [index, node] of input.root_nodes.entries()) {(await insert(node, null, 0, index));}
      for (const definition of definitions) {
        const nodeId = nodeIds.get(definition.id) || "";
        for (const dependencyTemplateId of asArray(definition.depends_on).map(cleanText)) {
          (await createDependencyRecord(nodeId, nodeIds.get(dependencyTemplateId) || ""));
        }
      }
      const rootId = input.root_nodes.length === 1 ? nodeIds.get(input.root_nodes[0].id) || "" : "";
      (await updatePlanRecord(orgId, planId, { root_node_id: rootId }));
    }
  
    return createdPlan;
  });
  if (!createdPlan?.plan) throw new Error("Work plan storage did not return the created plan.");
  if (!createdPlan.created) return { plan: createdPlan.plan, tree: (await workPlanTree(orgId, cleanText(createdPlan.plan.id))), created: false };

  await emitWorkEvent({
    organization_id: orgId,
    branch_id: input.branch_id || "default",
    project_id: input.project_id,
    plan_id: planId,
    type: "work.plan.created",
    idempotency_key: `${planId}:created`,
    payload: { source_type: input.source_type, source_id: input.source_id }
  });
  if (input.start_immediately !== false) await startWorkPlan(orgId, planId);
  return { plan: (await readPlanRecord(orgId, planId)), tree: (await workPlanTree(orgId, planId)), created: true };
}

export async function startWorkPlan(orgId: string, planId: string) {
  const plan = (await readPlanRecord(orgId, planId));
  if (!plan) throw notFound("work_plan_not_found", "Work plan was not found.");
  if (cleanText(plan.status) === "pending") {
    const now = new Date().toISOString();
    (await updatePlanRecord(orgId, planId, { status: "active", started_at: now }));
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: plan.branch_id,
      project_id: plan.project_id,
      plan_id: planId,
      type: "work.plan.started",
      idempotency_key: `${planId}:started`,
      payload: {}
    });
  }
  await recalculateWorkPlan(orgId, planId);
  return (await workPlanTree(orgId, planId));
}

async function dependenciesSatisfied(node: JsonObject) {
  const dependencies = (await listDependenciesForNode(cleanText(node.id)));
  return dependencies.every((dependency) => {
    const condition = cleanText(dependency.condition || "completed");
    const status = cleanText(dependency.depends_on_status);
    if (condition === "started" || condition === "activated") return ["active", "completed", "skipped"].includes(status);
    return ["completed", "skipped"].includes(status);
  });
}

function lastTransitionReason(node: JsonObject) {
  const history = asArray(asObject(node.metadata).history).map(asObject);
  return cleanText(history[history.length - 1]?.reason);
}

async function setNodeStatus(orgId: string, node: JsonObject, status: WorkNodeStatus, input: JsonObject = {}) {
  const current = cleanText(node.status);
  if (current === status) return node;
  const reopening = terminalNodeStatus(current) && status !== current;
  if (reopening && input.allow_reopen !== true) throw badRequest("work_node_terminal", "Completed, skipped, or canceled work cannot be reopened by a normal transition.");
  const now = new Date().toISOString();
  const history = asArray(asObject(node.metadata).history).map(asObject);
  const next = (await updateNodeRecord(orgId, cleanText(node.id), {
    status,
    ...(reopening ? { completed_at: "", skipped_at: "", canceled_at: "" } : {}),
    ...transitionTimestampPatch(status, now),
    metadata: {
      ...asObject(node.metadata),
      history: [...history, {
        from: current,
        to: status,
        reason: cleanText(input.reason),
        actor_user_id: cleanText(input.actor_user_id),
        at: now,
        payload: asObject(input.payload)
      }]
    }
  })) || node;
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: next.branch_id,
    project_id: next.project_id,
    plan_id: next.plan_id,
    node_id: next.id,
    type: eventNameForStatus(status),
    idempotency_key: `${next.id}:${status}:${cleanText(next[`${status === "active" ? "started" : status}_at`] || now)}`,
    payload: { from_status: current, to_status: status, reason: cleanText(input.reason), ...asObject(input.payload) },
    context: { actor_user_id: cleanText(input.actor_user_id), actor_email: cleanText(input.actor_email) }
  });
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: next.branch_id,
    project_id: next.project_id,
    plan_id: next.plan_id,
    node_id: next.id,
    type: "work.node.status_changed",
    idempotency_key: `${next.id}:status_changed:${current}:${status}:${now}`,
    payload: { from_status: current, to_status: status }
  });
  return next;
}

export async function transitionWorkNode(orgId: string, nodeId: string, statusValue: string, input: JsonObject = {}) {
  const status = workNodeStatusSchema.parse(statusValue);
  const node = (await readNodeRecord(orgId, nodeId));
  if (!node) throw notFound("work_node_not_found", "Work node was not found.");
  const owningPlan = (await readPlanRecord(orgId, cleanText(node.plan_id)));
  if (owningPlan && Object.keys(manualPlanStageOverride(owningPlan)).length) {
    (await updatePlanRecord(orgId, cleanText(node.plan_id), {
      metadata: { ...asObject(owningPlan.metadata), manual_stage_override: {} }
    }));
  }
  const metadata = asObject(node.metadata);
  const typeTags = Array.isArray(metadata.type_tags) ? metadata.type_tags.map(cleanText) : [];
  const isFollowUp = cleanText(metadata.kind) === "follow_up" || typeTags.includes("follow_up");
  const reason = cleanText(input.reason);
  if (status === "completed" && isFollowUp && !cleanText(input.follow_up_outcome) && !reason.startsWith("external_event:")) {
    throw badRequest("follow_up_outcome_required", "Choose a follow-up outcome before completing this to-do.");
  }
  const reopening = terminalNodeStatus(node.status) && cleanText(node.status) !== status;
  if (reopening && input.allow_reopen === true) {
    const plan = (await readPlanRecord(orgId, cleanText(node.plan_id)));
    if (plan && cleanText(plan.status) === "completed") {
      (await updatePlanRecord(orgId, cleanText(plan.id), { status:"active", completed_at:"" }));
    }
  }
  const next = await setNodeStatus(orgId, node, status, input);
  if (reopening && input.allow_reopen === true) {
    let parentId = cleanText(next.parent_id);
    while (parentId) {
      const parent = (await readNodeRecord(orgId, parentId));
      if (!parent) break;
      if (cleanText(parent.status) === "completed" && lastTransitionReason(parent) === "child_rollup") {
        await setNodeStatus(orgId, parent, "active", { allow_reopen:true, reason:"undo_child_rollup" });
      }
      parentId = cleanText(parent.parent_id);
    }

    for (let pass = 0; pass < 100; pass += 1) {
      let changed = false;
      const nodes = (await listNodeRecords(orgId, { plan_id:cleanText(next.plan_id) }));
      const byId = new Map(nodes.map((entry) => [cleanText(entry.id), entry]));
      for (const entry of nodes) {
        const entryStatus = cleanText(entry.status);
        if (!['ready', 'active'].includes(entryStatus) || cleanText(entry.id) === cleanText(next.id)) continue;
        const parent = cleanText(entry.parent_id) ? byId.get(cleanText(entry.parent_id)) : null;
        if ((!parent || cleanText(parent.status) === 'active') && (await dependenciesSatisfied(entry))) continue;
        await setNodeStatus(orgId, entry, 'blocked', { reason:'dependency_reopened' });
        changed = true;
      }
      if (!changed) break;
    }
  }
  await recalculateWorkPlan(orgId, cleanText(next.plan_id));
  return (await readNodeRecord(orgId, nodeId)) || next;
}

export async function patchWorkNode(orgId: string, nodeId: string, patch: JsonObject) {
  const node = (await readNodeRecord(orgId, nodeId));
  if (!node) throw notFound("work_node_not_found", "Work node was not found.");
  const assignmentPolicy = Object.prototype.hasOwnProperty.call(patch, "assignment_policy")
    ? patch.assignment_policy
    : asObject(node.metadata).assignment_policy;
  const nextMetadata = {
    ...asObject(node.metadata),
    ...asObject(patch.metadata),
    ...(Object.prototype.hasOwnProperty.call(patch, "assignment_policy") ? { assignment_policy:assignmentPolicy } : {})
  };
  await validateWorkNodeAssignment(orgId, cleanText(node.branch_id || "default"), {
    ...node,
    ...patch,
    metadata:nextMetadata,
    ...(assignmentPolicy !== undefined ? { assignment_policy:assignmentPolicy } : {})
  });
  const next = (await updateNodeRecord(orgId, nodeId, {
    ...patch,
    metadata: nextMetadata
  }));
  if (cleanText(patch.status) && cleanText(patch.status) !== cleanText(node.status)) {
    return await transitionWorkNode(orgId, nodeId, cleanText(patch.status), patch);
  }
  return next;
}

export async function recalculateWorkPlan(orgId: string, planId: string) {
  const plan = (await readPlanRecord(orgId, planId));
  if (!plan || cleanText(plan.status) !== "active") return plan;
  for (let pass = 0; pass < 100; pass += 1) {
    let changed = false;
    const nodes = (await listNodeRecords(orgId, { plan_id: planId }));
    const byId = new Map(nodes.map((node) => [cleanText(node.id), node]));
    const children = new Map<string, JsonObject[]>();
    for (const node of nodes) {
      const parentId = cleanText(node.parent_id);
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId)?.push(node);
    }
    for (const node of nodes) {
      const status = cleanText(node.status);
      const nodeChildren = children.get(cleanText(node.id)) || [];
      if (["pending", "blocked"].includes(status)) {
        const parent = cleanText(node.parent_id) ? byId.get(cleanText(node.parent_id)) : null;
        const parentActive = !parent || cleanText(parent.status) === "active";
        if (parentActive && (await dependenciesSatisfied(node))) {
          await setNodeStatus(orgId, node, nodeChildren.length ? "active" : "ready", { reason: "dependencies_satisfied" });
          changed = true;
          continue;
        }
        if (status !== "blocked") {
          (await updateNodeRecord(orgId, cleanText(node.id), { status: "blocked" }));
          changed = true;
        }
      }
      if (status === "active" && nodeChildren.length) {
        const mode = cleanText(node.completion_mode);
        const allTerminal = nodeChildren.every((child) => terminalNodeStatus(child.status));
        const anyCompleted = nodeChildren.some((child) => ["completed", "skipped"].includes(cleanText(child.status)));
        if ((mode === "all_children" && allTerminal) || (mode === "any_child" && anyCompleted)) {
          await setNodeStatus(orgId, node, "completed", { reason: "child_rollup" });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const roots = (await listNodeRecords(orgId, { plan_id: planId, parent_id: "__root__" }));
  if (roots.length && roots.every((node) => terminalNodeStatus(node.status))) {
    const now = new Date().toISOString();
    (await updatePlanRecord(orgId, planId, { status: "completed", completed_at: now }));
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: plan.branch_id,
      project_id: plan.project_id,
      plan_id: planId,
      type: "work.plan.completed",
      idempotency_key: `${planId}:completed`,
      payload: { status_counts: (await nodeStatusCounts(planId)) }
    });
  }
  const nextPlan = (await readPlanRecord(orgId, planId));
  if (cleanText(nextPlan?.project_id)) await syncProjectWorkProjection(orgId, cleanText(nextPlan?.project_id));
  return nextPlan;
}

export async function workPlanTree(orgId: string, planId: string) {
  const plan = (await readPlanRecord(orgId, planId));
  if (!plan) throw notFound("work_plan_not_found", "Work plan was not found.");
  const nodes = (await listNodeRecords(orgId, { plan_id: planId }));
  const byParent = new Map<string, JsonObject[]>();
  for (const node of nodes) {
    const key = cleanText(node.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)?.push(node);
  }
  const build = async (node: JsonObject): Promise<JsonObject> => ({
    ...node,
    dependencies: (await listDependenciesForNode(cleanText(node.id))),
    children: (await Promise.all((byParent.get(cleanText(node.id)) || []).map(build)))
  });
  return { ...plan, status_counts: (await nodeStatusCounts(planId)), root_nodes: (await Promise.all((byParent.get("") || []).map(build))) };
}

export async function listWorkPlans(orgId: string, options: JsonObject = {}) {
  return (await Promise.all((await listPlanRecords(orgId, options)).map(async (plan) => ({
    ...plan,
    status_counts: (await nodeStatusCounts(cleanText(plan.id)))
  }))));
}

function todoContactScope(options: JsonObject) {
  const contactId = cleanText(options.contact_id || options.contactId);
  const contactEmail = cleanText(options.contact_email || options.contactEmail).toLowerCase();
  const contactPhone = cleanText(options.contact_phone || options.contactPhone).replace(/\D+/g, "");
  const projectIds = new Set(
    (Array.isArray(options.project_ids) ? options.project_ids : cleanText(options.project_ids).split(","))
      .map(cleanText)
      .filter(Boolean)
  );
  const active = !!(contactId || contactEmail || contactPhone.length >= 7 || projectIds.size);
  return { active, contactId, contactEmail, contactPhone, projectIds };
}

function nodeMatchesContactScope(node: JsonObject, scope: ReturnType<typeof todoContactScope>) {
  if (scope.projectIds.has(cleanText(node.project_id))) return true;
  return asArray(asObject(node.metadata).contact_refs).some((entry) => {
    const ref = asObject(entry);
    if (scope.contactId && cleanText(ref.contact_id || ref.id) === scope.contactId) return true;
    if (scope.contactEmail && cleanText(ref.email).toLowerCase() === scope.contactEmail) return true;
    if (scope.contactPhone.length >= 7 && cleanText(ref.phone).replace(/\D+/g, "") === scope.contactPhone) return true;
    return false;
  });
}

export async function listWorkTodos(orgId: string, options: JsonObject = {}) {
  // Contact scope unions "any of the contact's projects" with "nodes that
  // carry a matching metadata.contact_refs entry", so the single project_id
  // pushdown cannot be used and the filter runs over the org's todo nodes.
  const contactScope = todoContactScope(options);
  let nodes = (await listNodeRecords(orgId, {
    project_id: contactScope.active ? undefined : options.project_id,
    actionable: true,
    show_in_todo_list: true,
    open_only: options.include_completed !== true
  }));
  if (contactScope.active) nodes = nodes.filter((node) => nodeMatchesContactScope(node, contactScope));
  const branchId = cleanText(options.branch_id || options.branchId);
  if (branchId) nodes = nodes.filter((node) => cleanText(node.branch_id) === branchId);
  if (options.include_future !== true) {
    const visibleStatuses = new Set(["ready", "active", ...(options.include_completed === true ? ["completed", "skipped"] : [])]);
    nodes = nodes.filter((node) => visibleStatuses.has(cleanText(node.status)));
  }
  const dueAfter = Date.parse(cleanText(options.due_after || options.dueAfter));
  const dueBefore = Date.parse(cleanText(options.due_before || options.dueBefore));
  if (Number.isFinite(dueAfter) || Number.isFinite(dueBefore)) {
    nodes = nodes.filter((node) => {
      const due = Date.parse(cleanText(node.due_at));
      if (!Number.isFinite(due)) return true;
      if (Number.isFinite(dueAfter) && due < dueAfter) return false;
      if (Number.isFinite(dueBefore) && due > dueBefore) return false;
      return true;
    });
  }
  const userId = cleanText(options.user_id);
  const roles = new Set(asArray(options.role_ids).map(cleanText));
  const resourceGroupIds = new Set(asArray(options.resource_group_ids).map(cleanText));
  if (userId || roles.size || resourceGroupIds.size) {
    nodes = nodes.filter((node) => {
      const users = asArray(node.assigned_user_ids).map(cleanText);
      const assignedRoles = asArray(node.assigned_role_ids).map(cleanText);
      const assignedResourceGroups = asArray(node.assigned_resource_group_ids).map(cleanText);
      if (!users.length && !assignedRoles.length && !assignedResourceGroups.length) return options.include_unassigned === true;
      return users.includes(userId)
        || assignedRoles.some((role) => roles.has(role))
        || assignedResourceGroups.some((groupId) => resourceGroupIds.has(groupId));
    });
  }
  return nodes.sort((a, b) => {
    // Priority items always rank above normal items; within a priority band
    // the soonest-due item wins.
    const priorityDelta = Number(b.priority || 0) - Number(a.priority || 0);
    if (priorityDelta) return priorityDelta;
    const dueA = Date.parse(cleanText(a.due_at)) || Number.MAX_SAFE_INTEGER;
    const dueB = Date.parse(cleanText(b.due_at)) || Number.MAX_SAFE_INTEGER;
    return dueA - dueB || cleanText(a.created_at).localeCompare(cleanText(b.created_at));
  });
}

function manualPlanStageOverride(plan: JsonObject) {
  const override = asObject(asObject(plan.metadata).manual_stage_override);
  return cleanText(override.stage_id) ? override : {};
}

async function workflowPlanStageSnapshot(orgId: string, plan: JsonObject) {
  const stages = (await listNodeRecords(orgId, { plan_id: plan.id }))
    .filter((node) => cleanText(node.terminology_key).endsWith("stage"));
  const active = stages.find((stage) => cleanText(stage.status) === "active")
    || stages.find((stage) => cleanText(stage.status) === "ready")
    || [...stages].reverse().find((stage) => ["completed", "skipped"].includes(cleanText(stage.status)))
    || stages[0];
  return active ? {
    stage_id: cleanText(active.template_node_id),
    stage_title: cleanText(active.title),
    stage_color: cleanText(asObject(active.metadata).color)
  } : { stage_id: "", stage_title: "", stage_color: "" };
}

async function planStageSnapshot(orgId: string, plan: JsonObject) {
  const manual = manualPlanStageOverride(plan);
  if (cleanText(manual.stage_id)) {
    return {
      stage_id: cleanText(manual.stage_id),
      stage_title: cleanText(manual.stage_title),
      stage_color: cleanText(manual.stage_color),
      manual_override: true,
      manually_set_at: cleanText(manual.set_at),
      manually_set_by_user_id: cleanText(manual.set_by_user_id)
    };
  }
  return (await workflowPlanStageSnapshot(orgId, plan));
}

export async function setManualPlanStage(orgId: string, planId: string, stageIdValue: string, input: JsonObject = {}) {
  const plan = (await readPlanRecord(orgId, planId));
  if (!plan) throw notFound("work_plan_not_found", "Work plan was not found.");
  if (cleanText(plan.status) !== "active") throw badRequest("work_plan_not_active", "Only an active project board can be moved manually.");
  const stageId = cleanText(stageIdValue);
  const stages = (await listNodeRecords(orgId, { plan_id: planId }))
    .filter((node) => cleanText(node.terminology_key).endsWith("stage"));
  const planBranchId = cleanText(plan.branch_id || "default") || "default";
  const template = (await Promise.all([...new Set([planBranchId, "default"])]
    .map(async (branchId) => (await listScopeTemplates(orgId, branchId, { include_disabled: true, include_archived: true })).map(asObject)))).flat()
    .find((item) => cleanText(item.id) === cleanText(plan.template_id));
  const blueprint = asObject(asObject(asObject(template).definition).work_plan);
  const configuredRoot = asObject(asArray(blueprint.root_nodes)[0]);
  const canceledColumn = {
    ...asObject(asObject(blueprint.metadata).canceled_column),
    ...asObject(asObject(plan.metadata).canceled_column)
  };
  const configuredStage = asArray(configuredRoot.children).map(asObject)
    .find((node) => cleanText(node.id) === stageId && cleanText(node.terminology_key).endsWith("stage"));
  // Boards intentionally retain columns represented by older live plans even
  // after a template revision changes. Match that board aggregation here so a
  // card can be moved into every column the user can actually see.
  const boardStage = (await Promise.all((await listPlanRecords(orgId, {}))
    .filter((candidate) => cleanText(candidate.template_id) === cleanText(plan.template_id)
      || (cleanText(plan.template_id) === "sales_pipeline"
        && cleanText(candidate.source_type) === "project_sales"
        && ["", "sales"].includes(cleanText(candidate.template_id))))
    .map(async (candidate) => (await listNodeRecords(orgId, { plan_id: candidate.id }))))).flat()
    .find((node) => cleanText(node.template_node_id) === stageId && cleanText(node.terminology_key).endsWith("stage"));
  const stage = stages.find((node) => cleanText(node.template_node_id) === stageId) || configuredStage || boardStage;
  const isCanceledColumn = cleanText(canceledColumn.id) === stageId;
  if (!stage && !isCanceledColumn) throw badRequest("work_stage_not_found", "That stage does not belong to this project board.");
  const stageTitle = cleanText(stage?.title || canceledColumn.title || stageId.replace(/[_-]+/g, " "));
  const stageColor = cleanText(asObject(stage?.metadata).color || canceledColumn.color || asObject(plan.metadata).board_color || "#667085");
  const workflowStage = (await workflowPlanStageSnapshot(orgId, plan));
  const existingManual = manualPlanStageOverride(plan);
  if (stageId === cleanText(workflowStage.stage_id)) {
    if (cleanText(existingManual.stage_id)) {
      const { manual_stage_override: _removed, ...metadata } = asObject(plan.metadata);
      (await updatePlanRecord(orgId, planId, { metadata }));
      if (cleanText(plan.project_id)) await syncProjectWorkProjection(orgId, cleanText(plan.project_id));
    }
    return {
      plan: (await readPlanRecord(orgId, planId)),
      stage: { ...workflowStage, manual_override: false },
      projection: cleanText(plan.project_id) ? (await projectWorkProjection(orgId, cleanText(plan.project_id))) : null
    };
  }
  if (stageId === cleanText(existingManual.stage_id)) {
    return {
      plan,
      stage: { stage_id: stageId, stage_title: stageTitle, stage_color: stageColor, manual_override: true },
      projection: cleanText(plan.project_id) ? (await projectWorkProjection(orgId, cleanText(plan.project_id))) : null
    };
  }
  const now = new Date().toISOString();
  const previous = (await planStageSnapshot(orgId, plan));
  (await updatePlanRecord(orgId, planId, {
    metadata: {
      ...asObject(plan.metadata),
      manual_stage_override: {
        stage_id: stageId,
        stage_title: stageTitle,
        stage_color: stageColor,
        set_at: now,
        set_by_user_id: cleanText(input.actor_user_id),
        set_by_email: cleanText(input.actor_email)
      }
    }
  }));
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: plan.branch_id,
    project_id: plan.project_id,
    plan_id: planId,
    type: "work.plan.stage_manually_set",
    idempotency_key: `${planId}:manual_stage:${stageId}:${now}`,
    payload: {
      from_stage_id: cleanText(previous.stage_id),
      from_stage_title: cleanText(previous.stage_title),
      to_stage_id: stageId,
      to_stage_title: stageTitle
    },
    context: { actor_user_id: cleanText(input.actor_user_id), actor_email: cleanText(input.actor_email) }
  });
  if (cleanText(plan.project_id)) await syncProjectWorkProjection(orgId, cleanText(plan.project_id));
  return {
    plan: (await readPlanRecord(orgId, planId)),
    stage: { stage_id: stageId, stage_title: stageTitle, stage_color: stageColor, manual_override: true },
    projection: cleanText(plan.project_id) ? (await projectWorkProjection(orgId, cleanText(plan.project_id))) : null
  };
}

function planIsProductionKind(plan: JsonObject) {
  const kind = cleanText(asObject(plan.metadata).scope_template_kind);
  if (kind) return kind === "production";
  return cleanText(plan.source_type) === "signed_proposal_scope";
}

function planIsPipelineKind(plan: JsonObject) {
  const kind = cleanText(asObject(plan.metadata).scope_template_kind);
  if (kind) return kind === "pipeline";
  return cleanText(plan.source_type) === "pipeline";
}

// Derives the project-level lifecycle facts consumers use instead of the
// removed `project.stage`: open/completed/canceled/lost plus the sold and
// completion timestamps, all computed from scope-instance state.
export function projectLifecycleFacts(plans: JsonObject[]) {
  const visible = plans.filter((plan) => asObject(plan.metadata).hide_from_boards !== true);
  const considered = visible.length ? visible : plans;
  const production = considered.filter(planIsProductionKind);
  const soldAt = production
    .map((plan) => cleanText(plan.started_at || plan.created_at))
    .filter(Boolean)
    .sort()[0] || "";
  const allTerminal = considered.length > 0 && considered.every((plan) => ["completed", "canceled"].includes(cleanText(plan.status)));
  const anyCompleted = considered.some((plan) => cleanText(plan.status) === "completed");
  const lost = considered.some((plan) => planIsPipelineKind(plan)
    && cleanText(plan.status) === "canceled"
    && cleanText(asObject(plan.metadata).canceled_reason) === "lost")
    && !considered.some((plan) => !["completed", "canceled"].includes(cleanText(plan.status)));
  const terminalAt = allTerminal
    ? considered.map((plan) => cleanText(plan.completed_at || plan.canceled_at)).filter(Boolean).sort().reverse()[0] || ""
    : "";
  const status = lost ? "lost" : !allTerminal ? "open" : anyCompleted ? "completed" : "canceled";
  return {
    status,
    sold_at: soldAt,
    completed_at: status === "completed" ? terminalAt : "",
    canceled_at: status === "canceled" || status === "lost" ? terminalAt : ""
  };
}

export async function projectWorkProjection(orgId: string, projectId: string) {
  const plans = (await listPlanRecords(orgId, { project_id: projectId }));
  const activePlans = plans.filter((plan) => cleanText(plan.status) === "active");
  const phases = (await Promise.all(activePlans.map(async (plan) => (await listNodeRecords(orgId, { plan_id: plan.id, parent_id: "__root__" }))))).flat()
    .filter((node) => !terminalNodeStatus(node.status));
  const stages = (await Promise.all(activePlans.map(async (plan) => (await listNodeRecords(orgId, { plan_id: plan.id }))))).flat()
    .filter((node) => cleanText(node.terminology_key).endsWith("stage") && cleanText(node.status) === "active");
  // One entry per scope instance: what the list view and pills render instead
  // of a single project-wide stage.
  const instances = (await Promise.all(plans
    .filter((plan) => asObject(plan.metadata).hide_from_boards !== true)
    .map(async (plan) => ({
      plan_id: cleanText(plan.id),
      template_id: cleanText(plan.template_id),
      kind: planIsPipelineKind(plan) ? "pipeline" : "production",
      source_type: cleanText(plan.source_type),
      status: cleanText(plan.status),
      title: cleanText(plan.title),
      color: cleanText(asObject(plan.metadata).board_color),
      started_at: cleanText(plan.started_at),
      completed_at: cleanText(plan.completed_at),
      canceled_at: cleanText(plan.canceled_at),
      ...(await planStageSnapshot(orgId, plan))
    }))));
  return {
    project_id: projectId,
    plans,
    instances,
    active_instances: instances.filter((instance) => !["completed", "canceled"].includes(instance.status)),
    lifecycle: projectLifecycleFacts(plans),
    active_phases: phases,
    active_stages: stages,
    primary_phase: phases[0] || null,
    primary_stage: stages[0] || null,
    completed: plans.length > 0 && plans.every((plan) => cleanText(plan.status) === "completed")
  };
}

export async function syncProjectWorkProjection(orgId: string, projectId: string) {
  if (!projectId) return null;
  const document = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!document) return null;
  const data = asObject(document.data);
  const projection = (await projectWorkProjection(orgId, projectId));
  const saved = await upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      ...data,
      work_projection: projection,
      lifecycle: projection.lifecycle,
      updated_at: new Date().toISOString()
    },
    metadata: document.metadata
  }, { replace: true });
  return { id: projectId, ...asObject(saved.data) };
}

// Cancels the project's live pipeline scope instances (e.g. when a follow-up
// resolves as lost). The reason lands on the plan metadata so lifecycle facts
// can distinguish lost from ordinary cancellation.
export async function cancelPipelinePlansForProject(orgId: string, projectId: string, reason = "canceled") {
  const plans = (await listPlanRecords(orgId, { project_id: projectId }))
    .filter((plan) => cleanText(asObject(plan.metadata).scope_template_kind) === "pipeline"
      || cleanText(plan.source_type) === "pipeline")
    .filter((plan) => !["completed", "canceled"].includes(cleanText(plan.status)));
  for (const plan of plans) {
    for (const node of (await listNodeRecords(orgId, { plan_id: plan.id })).filter((entry) => !terminalNodeStatus(entry.status))) {
      await transitionWorkNode(orgId, cleanText(node.id), "canceled", { reason });
    }
    (await updatePlanRecord(orgId, cleanText(plan.id), {
      status: "canceled",
      canceled_at: new Date().toISOString(),
      metadata: { ...asObject(plan.metadata), canceled_reason: reason }
    }));
  }
  await syncProjectWorkProjection(orgId, projectId);
  return plans.map((plan) => cleanText(plan.id));
}

export async function listWorkBoards(orgId: string, options: JsonObject = {}) {
  const plans = (await listPlanRecords(orgId, {}));
  const projectDocuments = await listDocuments(orgId, "projects");
  const projects = new Map(projectDocuments.map((document) => [cleanText(document.id), { id: document.id, ...asObject(document.data) }]));
  const boards = new Map<string, JsonObject>();
  const scopeTemplateByBranchAndId = new Map<string, JsonObject>();
  const enabledScopeTemplateKeys = new Set<string>();
  const branchIds = new Set<string>([
    "default",
    ...plans.map((plan) => cleanText(plan.branch_id || "default") || "default"),
    ...projectDocuments.map((document) => cleanText(asObject(document.data).branch_id || "default") || "default")
  ]);
  for (const branchId of branchIds) {
    const templates = (await listScopeTemplates(orgId, branchId, { include_disabled: true, include_archived: true }));
    for (const templateValue of templates) {
      const template = asObject(templateValue);
      const templateId = cleanText(template.id);
      if (!templateId) continue;
      const templateKey = `${branchId}:${templateId}`;
      scopeTemplateByBranchAndId.set(templateKey, template);
      if (template.enabled === false || cleanText(template.status) === "archived") continue;
      enabledScopeTemplateKeys.add(templateKey);
      if (boards.has(templateId)) continue;
      const definition = asObject(template.definition);
      const blueprint = asObject(definition.work_plan);
      const root = asObject(asArray(blueprint.root_nodes)[0]);
      const metadata = asObject(blueprint.metadata);
      const color = cleanText(template.color || definition.color || metadata.board_color || "#1769aa");
      const stages = asArray(root.children).map(asObject).filter((node) => cleanText(node.terminology_key).endsWith("stage"));
      const columns = stages.map((stage, index) => ({
        id: cleanText(stage.id),
        template_node_id: cleanText(stage.id),
        title: cleanText(stage.title || `Stage ${index + 1}`),
        description: cleanText(stage.description),
        color: cleanText(stage.color || asObject(stage.metadata).color || color),
        sort_order: index,
        cards: []
      }));
      const canceledColumn = asObject(metadata.canceled_column);
      const canceledColumnId = cleanText(canceledColumn.id);
      if (canceledColumnId && !columns.some((column) => cleanText(column.id) === canceledColumnId)) {
        columns.push({
          id: canceledColumnId,
          template_node_id: canceledColumnId,
          title: cleanText(canceledColumn.title || "Cancelled"),
          description: cleanText(canceledColumn.description),
          color: cleanText(canceledColumn.color || "#667085"),
          sort_order: Number(canceledColumn.sort_order || 10_000),
          cards: []
        });
      }
      boards.set(templateId, {
        id: templateId,
        title: cleanText(template.name || definition.name || root.title || templateId.replace(/[_-]+/g, " ")),
        description: cleanText(template.description || definition.description),
        kind: cleanText(definition.kind || "production"),
        color,
        terminology: asObject(blueprint.terminology),
        columns,
        cards: []
      });
    }
  }
  const projectsWithCurrentSalesPipeline = new Set(plans
    .filter((plan) => cleanText(plan.template_id) === "sales_pipeline" && cleanText(plan.source_type) === "pipeline")
    .map((plan) => cleanText(plan.project_id))
    .filter(Boolean));
  for (const plan of plans) {
    if (options.include_completed !== true && cleanText(plan.status) === "canceled") continue;
    if (asObject(plan.metadata).hide_from_boards === true) continue;
    const tree = (await workPlanTree(orgId, cleanText(plan.id)));
    const root = asObject(asArray(tree.root_nodes)[0]);
    const planMetadata = asObject(plan.metadata);
    const legacySalesPlan = cleanText(plan.source_type) === "project_sales"
      && ["", "sales"].includes(cleanText(plan.template_id));
    if (legacySalesPlan && projectsWithCurrentSalesPipeline.has(cleanText(plan.project_id))) continue;
    const boardId = legacySalesPlan
      ? "sales_pipeline"
      : cleanText(plan.template_id || plan.source_type || root.template_node_id || "general");
    const branchId = cleanText(plan.branch_id || "default") || "default";
    const templateKey = `${branchId}:${boardId}`;
    const scopeTemplate = scopeTemplateByBranchAndId.get(templateKey) || {};
    if ((cleanText(plan.template_id) || legacySalesPlan)
      && Object.keys(scopeTemplate).length
      && !enabledScopeTemplateKeys.has(templateKey)) continue;
    const scopeDefinition = asObject(scopeTemplate.definition);
    const scopeBlueprint = asObject(scopeDefinition.work_plan);
    const scopeRoot = asObject(asArray(scopeBlueprint.root_nodes)[0]);
    const scopeStages = asArray(scopeRoot.children).map(asObject).filter((node) => cleanText(node.terminology_key).endsWith("stage"));
    const scopeMetadata = asObject(scopeBlueprint.metadata);
    const boardMetadata = { ...scopeMetadata, ...planMetadata };
    const canceledColumn = asObject(boardMetadata.canceled_column);
    const legacyStageAliases = asObject(scopeMetadata.legacy_stage_aliases);
    const canonicalStageId = (stageId: unknown) => cleanText(legacyStageAliases[cleanText(stageId)] || stageId);
    const configuredBoard = {
      title: cleanText(scopeTemplate.name || scopeDefinition.name || scopeRoot.title),
      description: cleanText(scopeTemplate.description || scopeDefinition.description),
      color: cleanText(scopeTemplate.color || scopeDefinition.color || scopeMetadata.board_color),
      kind: cleanText(scopeDefinition.kind) || (cleanText(plan.source_type) === "pipeline" ? "pipeline" : "production"),
      stages: scopeStages
    };
    const configuredStages = asArray(configuredBoard.stages).map(asObject);
    if (!boards.has(boardId)) {
      boards.set(boardId, {
        id: boardId,
        title: cleanText(configuredBoard.title || root.title || plan.title || boardId.replace(/[_-]+/g, " ")),
        description: cleanText(configuredBoard.description),
        kind: configuredBoard.kind,
        color: cleanText(configuredBoard.color || asObject(root.metadata).color || boardMetadata.board_color || "#1769aa"),
        terminology: asObject(plan.terminology),
        columns: configuredStages.map((stage, index) => ({
          id: cleanText(stage.id),
          template_node_id: cleanText(stage.id),
          title: cleanText(stage.title || `Stage ${index + 1}`),
          description: cleanText(stage.description),
          color: cleanText(stage.color || asObject(stage.metadata).color || configuredBoard.color || "#1769aa"),
          sort_order: index,
          cards: []
        })),
        cards: []
      });
    }
    const board = boards.get(boardId) || {};
    const columns = asArray(board.columns).map(asObject);
    const canceledColumnId = cleanText(canceledColumn.id);
    if (canceledColumnId && !columns.some((column) => cleanText(column.id) === canceledColumnId)) {
      columns.push({
        id: canceledColumnId,
        template_node_id: canceledColumnId,
        title: cleanText(canceledColumn.title || "Cancelled"),
        description: cleanText(canceledColumn.description),
        color: cleanText(canceledColumn.color || "#667085"),
        sort_order: Number(canceledColumn.sort_order || 10_000),
        cards: []
      });
    }
    const stages = (await listNodeRecords(orgId, { plan_id: plan.id }))
      .filter((node) => cleanText(node.terminology_key).endsWith("stage"));
    for (const stage of stages) {
      const stageId = canonicalStageId(stage.template_node_id);
      const configuredStage = configuredStages.find((item) => cleanText(item.id) === stageId);
      if (!columns.some((column) => cleanText(column.template_node_id) === stageId)) {
        columns.push({
          id: stageId,
          template_node_id: stageId,
          title: cleanText(configuredStage?.title || stage.title || "Stage"),
          description: cleanText(configuredStage?.description || stage.description),
          color: cleanText(configuredStage?.color || asObject(stage.metadata).color || board.color || "#1769aa"),
          sort_order: Number(stage.sort_order || columns.length),
          cards: []
        });
      }
    }
    columns.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
    const project: JsonObject = projects.get(cleanText(plan.project_id)) || {};
    const projectState = cleanText(asObject(project.lifecycle).status || project.workflow_state || project.status).toLowerCase();
    const planIsCanceled = cleanText(plan.status) === "canceled"
      || cleanText(root.status) === "canceled"
      || ["canceled", "cancelled", "lost"].includes(projectState);
    const manualStage = manualPlanStageOverride(plan);
    const rawActiveStage = stages.find((stage) => cleanText(stage.status) === "active")
        || stages.find((stage) => cleanText(stage.status) === "ready")
        || [...stages].reverse().find((stage) => ["completed", "skipped"].includes(cleanText(stage.status)))
        || stages[0];
    const activeStage = cleanText(manualStage.stage_id)
      ? { template_node_id: canonicalStageId(manualStage.stage_id), title: manualStage.stage_title, metadata: { color: manualStage.stage_color }, manual_override: true }
      : planIsCanceled && canceledColumnId
      ? { template_node_id: canceledColumnId }
      : rawActiveStage
        ? { ...rawActiveStage, template_node_id: canonicalStageId(rawActiveStage.template_node_id) }
        : undefined;
    const card = {
      id: `${cleanText(plan.id)}:${cleanText(project.id || plan.project_id)}`,
      plan_id: plan.id,
      project_id: cleanText(project.id || plan.project_id),
      title: cleanText(project.title || project.customer_name || project.address || plan.title),
      address: cleanText(project.address),
      scope_piece_id: plan.scope_piece_id,
      status: plan.status,
      stage_id: activeStage ? cleanText(activeStage.template_node_id) : "unassigned",
      manual_stage_override: activeStage?.manual_override === true
    };
    const column = columns.find((entry) => cleanText(entry.template_node_id) === cleanText(activeStage?.template_node_id));
    if (column) column.cards = [...asArray(column.cards), card];
    board.columns = columns;
    board.cards = [...asArray(board.cards), card];
    boards.set(boardId, board);
  }
  return [...boards.values()].sort((a, b) => cleanText(a.title).localeCompare(cleanText(b.title)));
}
