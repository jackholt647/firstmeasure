import { randomUUID } from "node:crypto";

import { badRequest, notFound } from "../platform/errors.js";
import { readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { readWorkConfiguration } from "./config.js";
import { cancelPipelinePlansForProject, createWorkPlan, patchWorkNode, transitionWorkNode } from "./service.js";
import { readNodeRecord } from "./storage.js";

export const FOLLOW_UP_TAG = "follow_up";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map(cleanText).filter(Boolean))] : [];
}

export function workNodeTypeTags(node: JsonObject) {
  const metadata = asObject(node.metadata);
  return stringArray(metadata.type_tags || metadata.tags);
}

export function isFollowUpWorkNode(node: JsonObject | null | undefined) {
  if (!node) return false;
  const metadata = asObject(node.metadata);
  return cleanText(metadata.kind) === FOLLOW_UP_TAG || workNodeTypeTags(node).includes(FOLLOW_UP_TAG);
}

function addPolicyInterval(date: Date, amountValue: unknown, unitValue: unknown) {
  const amount = Math.max(1, Math.round(Number(amountValue) || 1));
  const unit = cleanText(unitValue) || "days";
  if (unit === "months") date.setMonth(date.getMonth() + amount);
  else date.setDate(date.getDate() + (unit === "weeks" ? amount * 7 : amount));
}

function localDateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function nextFollowUpPolicySchedule(configurationValue: unknown, node: JsonObject | null, triggerValue: unknown, nowValue: Date = new Date()) {
  const configuration = asObject(configurationValue);
  const policy = asObject(configuration.retry_policy);
  const trigger = cleanText(triggerValue);
  const triggers = stringArray(policy.triggers);
  const steps = Array.isArray(policy.steps) ? policy.steps.map(asObject) : [];
  if (policy.enabled === false || !triggers.includes(trigger) || !steps.length) return null;
  const followUp = asObject(asObject(node?.metadata).follow_up);
  const currentIndex = Number.isInteger(Number(followUp.policy_step_index)) ? Number(followUp.policy_step_index) : -1;
  let policyStepIndex = currentIndex + 1;
  if (policyStepIndex >= steps.length) {
    if (cleanText(policy.after_last) === "stop") return null;
    policyStepIndex = steps.length - 1;
  }
  const step = steps[policyStepIndex] || steps[steps.length - 1] || {};
  const due = new Date(nowValue);
  addPolicyInterval(due, step.amount, step.unit);
  const defaultTime = cleanText(configuration.default_time);
  if (defaultTime) {
    const timeParts = defaultTime.split(":").map(Number);
    due.setHours(Number(timeParts[0]), Number(timeParts[1]), 0, 0);
  }
  return {
    due_at: defaultTime ? due.toISOString() : localDateValue(due),
    policy_step_index: policyStepIndex,
    policy_step_id: cleanText(step.id),
    policy_step_label: cleanText(step.label),
    policy_trigger: trigger
  };
}

export async function createFollowUpTodo(orgIdValue: unknown, inputValue: JsonObject = {}) {
  const orgId = cleanText(orgIdValue);
  const input = asObject(inputValue);
  const branchId = cleanText(input.branch_id || input.branchId || "default") || "default";
  const projectId = cleanText(input.project_id || input.projectId);
  const configuration = await readWorkConfiguration(orgId, branchId);
  const followUps = asObject(configuration.follow_ups);
  const id = cleanText(input.id) || `follow_up_${randomUUID()}`;
  const sourceKey = cleanText(input.source_key || input.sourceKey) || `follow_up:${id}`;
  const assignedUserIds = stringArray(input.assigned_user_ids);
  const assignedRoleIds = stringArray(input.assigned_role_ids);
  const assignedResourceGroupIds = stringArray(input.assigned_resource_group_ids);
  const metadata = asObject(input.metadata);
  const result = await createWorkPlan({
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    source_type: "follow_up",
    source_id: id,
    source_key: sourceKey,
    title: cleanText(input.title || followUps.default_title || "Follow-up call"),
    root_nodes: [{
      id: "follow_up",
      title: cleanText(input.title || followUps.default_title || "Follow-up call"),
      description: cleanText(input.body || input.description),
      terminology_key: "work.task",
      actionable: true,
      show_in_todo_list: true,
      priority: Math.max(0, Math.round(Number(input.priority) || 0)),
      assigned_user_ids: assignedUserIds,
      assigned_role_ids: assignedRoleIds,
      assigned_resource_group_ids: assignedResourceGroupIds,
      external_triggers: asObject(metadata.follow_up).completion_policy === "explicit" ? [] : [{
        event: "project.event_scheduled",
        transition: "completed",
        conditions: { "payload.event_type_default_id": "sales_appointment" }
      }],
      metadata: {
        ...metadata,
        kind: FOLLOW_UP_TAG,
        type_tags: [...new Set([...stringArray(metadata.type_tags), FOLLOW_UP_TAG])],
        follow_up: {
          channel: cleanText(asObject(metadata.follow_up).channel || input.channel || "call") || "call",
          origin: cleanText(asObject(metadata.follow_up).origin || input.origin || "manual") || "manual",
          parent_follow_up_id: cleanText(asObject(metadata.follow_up).parent_follow_up_id || input.parent_follow_up_id),
          ...asObject(metadata.follow_up)
        },
        frontend_action: Object.keys(asObject(metadata.frontend_action)).length
          ? asObject(metadata.frontend_action)
          : cleanText(asObject(metadata.follow_up).channel||input.channel||'call')==='call'
            ? {kind:'open_customer_call',project_id:projectId,contact_id:cleanText(asObject(metadata.follow_up).contact_id),customer_number:cleanText(asObject(metadata.follow_up).phone),purpose:cleanText(input.title||'Follow-up call')}
            : { kind: "open_project", project_id: projectId, tab: "comms" },
        payload: { project_id: projectId, ...asObject(metadata.payload), ...asObject(input.payload) }
      }
    }],
    context: { project_id: projectId, follow_up: true, ...asObject(input.context) },
    metadata: { hide_from_boards: true, kind: FOLLOW_UP_TAG },
    start_immediately: true
  });
  const roots = Array.isArray(asObject(result.tree).root_nodes) ? asObject(result.tree).root_nodes as unknown[] : [];
  let node = asObject(roots[0]);
  const dueAt = cleanText(input.due_at || input.dueAt);
  if (dueAt && cleanText(node.id)) node = asObject(await patchWorkNode(orgId, cleanText(node.id), { due_at: dueAt }));
  return { ...result, node };
}

async function markProjectLost(orgId: string, projectId: string) {
  if (!projectId) return null;
  // Losing a lead cancels the live pipeline scope instances; lifecycle facts
  // (status "lost") are derived from the canceled plans by the projection.
  await cancelPipelinePlansForProject(orgId, projectId, "lost");
  const document = await readDocument(orgId, "projects", projectId);
  const project = asObject(document.data);
  const now = new Date().toISOString();
  return await upsertDocument(orgId, "projects", {
    id: projectId,
    expected_revision: document.revision,
    data: { ...project, lead_status: "lost", updated_at: now },
    metadata: document.metadata
  }, { replace: true });
}

export async function resolveFollowUpOutcome(orgIdValue: unknown, nodeIdValue: unknown, inputValue: JsonObject = {}, configuredOutcomes?:JsonObject[]) {
  const orgId = cleanText(orgIdValue);
  const nodeId = cleanText(nodeIdValue);
  const input = asObject(inputValue);
  const node = (await readNodeRecord(orgId, nodeId));
  if (!node) throw notFound("follow_up_not_found", "This follow-up was not found.");
  if (!isFollowUpWorkNode(node)) throw badRequest("not_a_follow_up", "Only tagged follow-up to-dos use follow-up outcomes.");
  const configuration = await readWorkConfiguration(orgId, cleanText(node.branch_id || "default") || "default");
  const followUps = asObject(configuration.follow_ups);
  const outcomeId = cleanText(input.outcome_id || input.outcome || input.id);
  const outcomes = configuredOutcomes || (Array.isArray(followUps.outcomes) ? followUps.outcomes.map(asObject) : []);
  const outcome = outcomes.find((entry) => cleanText(entry.id) === outcomeId || cleanText(entry.action) === outcomeId);
  if (!outcome) throw badRequest("invalid_follow_up_outcome", "Choose one of the configured follow-up outcomes.");
  const action = cleanText(outcome.action);
  const commonTransition = {
    reason: `follow_up_outcome:${outcomeId}`,
    follow_up_outcome: outcomeId,
    actor_user_id: cleanText(input.actor_user_id),
    actor_email: cleanText(input.actor_email),
    payload: { outcome_id: outcomeId, action }
  };

  if (action === "reschedule") {
    const policySchedule = nextFollowUpPolicySchedule(followUps, node, cleanText(input.policy_trigger || "manual_follow_up"));
    const dueAt = cleanText(input.due_at || input.dueAt || (input.use_policy === true ? policySchedule?.due_at : ""));
    if (!dueAt || !Number.isFinite(Date.parse(dueAt))) throw badRequest("follow_up_due_at_required", "Choose when the next follow-up is due.");
    const metadata = asObject(node.metadata);
    const policyMetadata = policySchedule && (input.use_policy === true || cleanText(input.policy_trigger)) ? policySchedule : {};
    const successor = await createFollowUpTodo(orgId, {
      branch_id: node.branch_id,
      project_id: node.project_id,
      source_key: `follow_up:successor:${nodeId}:${dueAt}`,
      title: node.title,
      body: node.description,
      due_at: dueAt,
      priority: node.priority,
      assigned_user_ids: node.assigned_user_ids,
      assigned_role_ids: node.assigned_role_ids,
      assigned_resource_group_ids: node.assigned_resource_group_ids,
      parent_follow_up_id: nodeId,
      origin: "rescheduled_follow_up",
      channel: cleanText(asObject(metadata.follow_up).channel || "call"),
      metadata: {
        ...metadata,
        follow_up: { ...asObject(metadata.follow_up), ...policyMetadata, parent_follow_up_id: nodeId, origin: "rescheduled_follow_up" }
      }
    });
    const completed = await transitionWorkNode(orgId, nodeId, "completed", commonTransition);
    return { outcome, completed, successor: successor.node };
  }

  if (action === "scheduled") {
    const projectId = cleanText(node.project_id);
    const document = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
    const events = document && Array.isArray(asObject(document.data).events) ? asObject(document.data).events as unknown[] : [];
    const appointmentExists = events.map(asObject).some((event) => {
      const type = cleanText(event.event_type_default_id || event.kind || event.type_id);
      return type === "sales_appointment" && cleanText(event.status).toLowerCase() !== "canceled" && !!cleanText(event.start_at);
    });
    if (!appointmentExists && input.appointment_scheduled !== true) {
      throw badRequest("follow_up_appointment_required", "Schedule the appointment before completing this follow-up.");
    }
  }

  if (action === "lost") {
    await markProjectLost(orgId, cleanText(node.project_id));
  }
  const completed = await transitionWorkNode(orgId, nodeId, "completed", commonTransition);
  return { outcome, completed, successor: null };
}
