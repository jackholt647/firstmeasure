import { createHash } from "node:crypto";

import { sendCommunication } from "../../messaging/communications_service.js";
import { sendCommunicationSchema, type CommunicationChannel } from "../../messaging/schemas.js";
import { removeCallListEntry, upsertCallListEntry } from "../../internal/crm/call_lists.js";
import { readDocument, upsertDocument, type JsonObject } from "../../platform/storage.js";
import { registerWorkAutomation, type WorkAutomationContext } from "../registry.js";
import { registerScopeCodeAutomation } from "./code.js";
import { listNodeRecords } from "../storage.js";

let registered = false;

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
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function paymentContext(context: WorkAutomationContext): JsonObject {
  const payload = asObject(context.event.payload);
  const payment = asObject(payload.payment);
  const metadata = asObject(payment.metadata);
  const amountCents = Math.round(Number(payload.amount_cents ?? payment.amount_cents ?? 0));
  const currency = cleanText(payment.currency || payload.currency || "USD").toUpperCase() || "USD";
  const paymentKind = cleanText(payload.payment_kind || payment.kind).toLowerCase();
  const label = cleanText(metadata.payment_label)
    || (paymentKind.includes("deposit") ? "Deposit" : paymentKind.includes("final") ? "Final payment" : paymentKind.includes("progress") ? "Progress payment" : "Payment");
  let formattedAmount = amountCents ? `${(amountCents / 100).toFixed(2)} ${currency}` : "";
  try {
    if (amountCents) formattedAmount = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
  } catch {}
  return {
    ...payment,
    id: cleanText(payment.id || payload.payment_id),
    amount_cents: amountCents,
    currency,
    label,
    formatted_amount: formattedAmount
  };
}

async function contextValue(context: WorkAutomationContext, path: string): Promise<unknown> {
  const source: JsonObject = {
    event: context.event,
    plan: context.plan,
    node: context.node,
    project: context.project,
    scope: context.scope,
    proposal: context.proposal,
    payment: paymentContext(context)
  };
  const segments = path.split(".");
  // Core execution context wins; any other head namespace falls through to
  // the registered data providers ({{organization.name}}, {{users.count}},
  // {{pricebook.default.manifest.title}}, {{branch.scheduling....}}, ...).
  if (Object.prototype.hasOwnProperty.call(source, segments[0] ?? "")) {
    return segments.reduce<unknown>((value, key) => (
      value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject)[key] : undefined
    ), source);
  }
  return await context.data.resolve(segments);
}

async function resolveValue(value: unknown, context: WorkAutomationContext): Promise<unknown> {
  if (typeof value === "string") {
    const matches = [...value.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)];
    if (!matches.length) return value;
    let resolved = value;
    for (const match of matches) {
      const replacement = String((await contextValue(context, match[1] ?? "")) ?? "");
      resolved = resolved.replace(match[0], replacement);
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    const resolved = [];
    for (const entry of value) resolved.push(await resolveValue(entry, context));
    return resolved;
  }
  if (value && typeof value === "object") {
    const resolved: JsonObject = {};
    for (const [key, entry] of Object.entries(value as JsonObject)) resolved[key] = await resolveValue(entry, context);
    return resolved;
  }
  return value;
}

async function patchProject(context: WorkAutomationContext, input: JsonObject) {
  const values = asObject(await resolveValue(input.values || input.patch || input, context));
  return await context.services.patchProject(values);
}

async function createNotification(context: WorkAutomationContext, input: JsonObject) {
  return await context.services.createNotification(asObject(await resolveValue(input, context)));
}

async function createScheduleRequirement(context: WorkAutomationContext, input: JsonObject) {
  return await context.services.createScheduleRequirement(asObject(await resolveValue(input, context)));
}

async function createScheduleRequirements(context: WorkAutomationContext, input: JsonObject) {
  const projectId = cleanText(context.project.id || context.plan.project_id);
  const nodes = (await listNodeRecords(cleanText(context.event.organization_id), { plan_id: context.plan.id }));
  const created = [];
  for (const [index, rawRequirement] of asArray(input.requirements).map(asObject).entries()) {
    const requirement = asObject(await resolveValue(rawRequirement, context));
    const key = cleanText(requirement.key || requirement.id || requirement.event_type_default_id || `requirement_${index + 1}`);
    const sourceNodeTemplateId = cleanText(requirement.source_node_template_id);
    const sourceNodeId = cleanText(nodes.find((node) => cleanText(node.template_node_id) === sourceNodeTemplateId)?.id || context.node.id);
    created.push(await context.services.createScheduleRequirement({
      ...requirement,
      id: cleanText(requirement.id) || stableId("event", `${context.idempotencyKey}:${projectId}:${key}`),
      title: cleanText(requirement.title || context.scope.section_name || context.plan.title || key.replace(/[_-]+/g, " ")),
      status: cleanText(requirement.status || "unscheduled") || "unscheduled",
      work_plan_id: context.plan.id,
      scope_piece_id: context.plan.scope_piece_id,
      scope_template_id: context.plan.template_id,
      source_node_id: sourceNodeId,
      metadata: {
        automation: "scheduling.createRequirements.v1",
        idempotency_key: context.idempotencyKey,
        ...asObject(requirement.metadata)
      }
    }));
  }
  return { created };
}

async function sendWorkCommunication(channel: CommunicationChannel, automation: string, context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const to = cleanText(resolved.to);
  const recipients = asArray(resolved.recipients).map(asObject);
  const content = asObject(resolved.content);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  const parsed = sendCommunicationSchema.parse({
    ...resolved,
    channel,
    branch_id: cleanText(resolved.branch_id || context.plan.branch_id || context.event.branch_id || "default") || "default",
    recipients: recipients.length ? recipients : (to ? [{ address: to }] : []),
    content: Object.keys(content).length ? content : {
      subject: cleanText(resolved.subject),
      text: cleanText(resolved.text || resolved.body),
      html: cleanText(resolved.html)
    },
    context: {
      project_id: projectId,
      work_plan_id: context.plan.id,
      work_node_id: context.node.id,
      ...asObject(resolved.context)
    },
    source: {
      type: "automation",
      automation_id: automation,
      trigger_event_id: context.event.id,
      ...asObject(resolved.source)
    },
    idempotency_key: cleanText(resolved.idempotency_key || `${context.idempotencyKey}:${automation}`)
  });
  return await sendCommunication(cleanText(context.event.organization_id), parsed, {
    branchId: cleanText(context.plan.branch_id || context.event.branch_id || "default") || "default"
  });
}

async function sendSms(context: WorkAutomationContext, input: JsonObject) {
  return await sendWorkCommunication("sms", "communications.sendSms.v1", context, input);
}

async function sendEmail(context: WorkAutomationContext, input: JsonObject) {
  return await sendWorkCommunication("email", "communications.sendEmail.v1", context, input);
}

async function createTodo(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const organizationId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  const title = cleanText(resolved.title || "Follow up");
  const metadata = asObject(resolved.metadata);
  const followUp = cleanText(metadata.kind) === "follow_up" || asArray(metadata.type_tags).map(cleanText).includes("follow_up");
  const { createWorkPlan } = await import("../service.js");
  return await createWorkPlan({
    organization_id: organizationId,
    branch_id: cleanText(context.plan.branch_id || context.event.branch_id || "default") || "default",
    project_id: projectId,
    source_type: "automation_todo",
    source_id: cleanText(context.event.id),
    source_key: `automation_todo:${context.idempotencyKey}`,
    title,
    root_nodes: [{
      id: "task",
      title,
      description: cleanText(resolved.message || resolved.description),
      terminology_key: "work.task",
      actionable: true,
      show_in_todo_list: true,
      assigned_role_ids: asArray(resolved.assigned_role_ids).map(cleanText).filter(Boolean),
      assigned_user_ids: asArray(resolved.assigned_user_ids).map(cleanText).filter(Boolean),
      assigned_resource_group_ids: asArray(resolved.assigned_resource_group_ids).map(cleanText).filter(Boolean),
      priority: Math.max(0, Math.round(Number(resolved.priority) || 0)),
      ...(Number(resolved.due_offset_minutes || 0) > 0 ? { due_offset_minutes: Number(resolved.due_offset_minutes) } : {}),
      ...(followUp ? { external_triggers: [{ event:"project.event_scheduled", transition:"completed", conditions:{ "payload.event_type_default_id":"sales_appointment" } }] } : {}),
      metadata: { automation: "work.createTodo.v1", ...metadata, ...(followUp ? { kind:"follow_up", type_tags:[...new Set([...asArray(metadata.type_tags).map(cleanText).filter(Boolean), "follow_up"])] } : {}) }
    }],
    context: { project_id: projectId, parent_work_plan_id: context.plan.id, parent_work_node_id: context.node.id },
    metadata: { hide_from_boards: true, automation: "work.createTodo.v1" },
    start_immediately: true
  });
}

async function addCallListEntry(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const list = asObject(resolved.list);
  const listKey = cleanText(resolved.list_key || list.key || list.id);
  const organizationId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  // Project-keyed by default: parallel scope instances (roof + gutters) or an
  // intake rule plus a pipeline node all converge on ONE entry per project per
  // list. Pass an explicit source_key to opt out.
  const sourceKey = cleanText(resolved.source_key) || (projectId ? `project:${projectId}` : cleanText(context.node.id));
  return await upsertCallListEntry(organizationId, listKey, {
    list: { create_only: list.overwrite === true ? false : true, ...list },
    source_key: sourceKey,
    subject_type: cleanText(resolved.subject_type || "project"),
    subject_id: cleanText(resolved.subject_id || projectId),
    project_id: projectId,
    work_plan_id: context.plan.id,
    work_node_id: context.node.id,
    title: cleanText(resolved.title || context.node.title),
    priority: Number(resolved.priority || 0),
    due_at: cleanText(resolved.due_at || context.node.due_at),
    payload: asObject(resolved.payload),
    metadata: {
      automation: "crm.callLists.add.v1",
      idempotency_key: context.idempotencyKey,
      scope_template_id: context.plan.template_id,
      scope_piece_id: context.plan.scope_piece_id,
      ...asObject(resolved.metadata)
    }
  });
}

async function removeCallListEntryForNode(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const organizationId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  const listKey = cleanText(resolved.list_key || asObject(context.node.metadata).call_list_key);
  const results: JsonObject[] = [];
  if (cleanText(resolved.entry_id) || cleanText(resolved.source_key)) {
    results.push(await removeCallListEntry(organizationId, {
      entry_id: cleanText(resolved.entry_id),
      source_key: cleanText(resolved.source_key),
      list_key: listKey
    }));
  } else {
    // The shared project-keyed entry (scoped to this node's list)...
    if (projectId && listKey) {
      results.push(await removeCallListEntry(organizationId, { source_key: `project:${projectId}`, list_key: listKey }));
    }
    // ...plus any entry keyed directly to this node.
    if (cleanText(context.node.id)) {
      results.push(await removeCallListEntry(organizationId, { work_node_id: cleanText(context.node.id) }));
    }
  }
  return { ok: true, removed: results.reduce((total, result) => total + Number(result.removed || 0), 0) };
}

// Instantiates the production scopes carried by a signed proposal. Bound in
// pipeline templates (e.g. the sales preset's `sign_sales_proposal` node) so
// the sale-to-production transition is template data, not engine code.
async function activateScopesFromProposal(context: WorkAutomationContext, input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const payload = asObject(context.event.payload);
  const resolved = asObject(await resolveValue(input, context));
  const proposalId = cleanText(resolved.proposal_id || payload.proposal_id || context.proposal.id);
  let snapshotId = cleanText(resolved.snapshot_id || payload.snapshot_id || context.proposal.snapshot_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  if (proposalId && !snapshotId) {
    const proposalDocument = await readDocument(orgId, "proposals", proposalId).catch(() => null);
    snapshotId = cleanText(asObject(asObject(proposalDocument?.data).delivery).signed_snapshot_id
      || asObject(proposalDocument?.data).current_snapshot_id);
  }
  if (!proposalId || !snapshotId) {
    return { skipped: true, reason: "missing_signed_proposal_reference", project_id: projectId };
  }
  const { startWorkPlansForSignedProposal } = await import("../../scopes/service.js");
  const result = await startWorkPlansForSignedProposal(orgId, proposalId, snapshotId);
  return { activated: result.count, proposal_id: proposalId, snapshot_id: snapshotId };
}

// Activates a fixed scope template on the project — the generic
// scope-to-scope transition. Any node or plan binding can chain into another
// pipeline or production scope with `input.template_id`.
async function activateScopeTemplate(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const templateId = cleanText(resolved.template_id);
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  if (!templateId || !projectId) return { skipped: true, reason: "missing_template_or_project" };
  const branchId = cleanText(resolved.branch_id || context.plan.branch_id || context.event.branch_id || "default") || "default";
  const { readScopeTemplate } = await import("../../scopes/storage.js");
  const { instantiateScopeTemplateWorkPlan } = await import("../../scopes/service.js");
  const template = (await readScopeTemplate(orgId, branchId, templateId));
  return await instantiateScopeTemplateWorkPlan(orgId, {
    project_id: projectId,
    branch_id: branchId,
    template,
    source_type: cleanText(resolved.source_type) || "scope_transition",
    source_id: cleanText(context.plan.id) || templateId,
    source_key: `scope_transition:${projectId}:${templateId}:${cleanText(resolved.instance_key)}`,
    title: cleanText(resolved.title),
    context: {
      activated_by_plan_id: cleanText(context.plan.id),
      activated_by_node_id: cleanText(context.node.id),
      activated_by_event: cleanText(context.event.type),
      ...asObject(resolved.context)
    }
  });
}

async function createStructureAppointments(context: WorkAutomationContext, input: JsonObject) {
  const structures = asArray(context.scope.structures || context.scope.measurements || asObject(context.scope).structureMeasurements)
    .map(asObject);
  const created = [];
  for (const [index, structure] of structures.entries()) {
    const structureId = cleanText(structure.id || structure.structure_id || `structure_${index + 1}`);
    created.push(await context.services.createScheduleRequirement({
      id: stableId("event", `${context.idempotencyKey}:structure:${structureId}`),
      event_type_default_id: cleanText(input.event_type_default_id || "project_work"),
      title: cleanText(structure.name || structure.label || `${context.plan.title} - Structure ${index + 1}`),
      status: "unscheduled",
      work_plan_id: context.plan.id,
      scope_piece_id: context.plan.scope_piece_id,
      structure_id: structureId,
      metadata: { idempotency_key: context.idempotencyKey }
    }));
  }
  return { created };
}

// Atomically claims a named key on the project so parallel scope instances
// can coordinate (e.g. only one of two active scopes creates the welcome
// call). Claims live at project.claims[key]; later bindings condition on them
// with e.g. { "project.claims.welcome_call.holder": "{{plan.id}}" } or gate
// on absence with { "project.claims.welcome_call": "" }.
async function claimProjectKey(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  const key = cleanText(resolved.key);
  if (!orgId || !projectId || !key) return { skipped: true, reason: "missing_project_or_key" };
  const holder = cleanText(resolved.holder) || cleanText(context.plan.id) || cleanText(context.node.id) || "organization";
  // Optimistic-concurrency test-and-set: the revision check makes the claim
  // atomic across parallel bindings in the same cascade.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const document = await readDocument(orgId, "projects", projectId);
    const data = asObject(document.data);
    const claims = asObject(data.claims);
    const existing = asObject(claims[key]);
    if (cleanText(existing.holder)) {
      return { claimed: cleanText(existing.holder) === holder, holder: cleanText(existing.holder), key, existing: true };
    }
    try {
      await upsertDocument(orgId, "projects", {
        id: projectId,
        expected_revision: document.revision,
        data: {
          ...data,
          claims: { ...claims, [key]: { holder, claimed_at: context.now, event_id: cleanText(context.event.id) } },
          updated_at: new Date().toISOString()
        },
        metadata: document.metadata
      }, { replace: true });
      return { claimed: true, holder, key, existing: false };
    } catch (error) {
      if (cleanText(asObject(error).code) !== "document_revision_conflict" && Number(asObject(error).statusCode) !== 409) throw error;
    }
  }
  return { claimed: false, holder: "", key, reason: "claim_contention" };
}

// ── Scope-instantiation automations ─────────────────────────────────────────
// These used to be imperative "blessed" calls inside scope instantiation.
// They are now ordinary automations bound (by default) to onStarted of every
// scope instance, so templates can reorder, condition, or replace them.

async function initializeScopeResources(context: WorkAutomationContext, _input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const planId = cleanText(context.plan.id);
  if (!planId) return { skipped: true, reason: "missing_plan" };
  const { initializeScopeResourcesForPlanRecord } = await import("../../scopes/service.js");
  return await initializeScopeResourcesForPlanRecord(orgId, planId) || { skipped: true, reason: "no_resource_context" };
}

async function initializeScopeChecklists(context: WorkAutomationContext, _input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  const templateId = cleanText(context.plan.template_id);
  if (!projectId || !templateId) return { skipped: true, reason: "missing_project_or_template" };
  const { readScopeTemplateVersion, readScopeTemplate } = await import("../../scopes/storage.js");
  const branchId = cleanText(context.plan.branch_id || "default") || "default";
  const version = Number(context.plan.template_version || 0);
  const frozen = version ? (await readScopeTemplateVersion(orgId, branchId, templateId, version)) : null;
  const definition = asObject(frozen?.definition || asObject((await readScopeTemplate(orgId, branchId, templateId))).definition);
  if (!asArray(definition.checklists).length) return { skipped: true, reason: "no_checklists" };
  const { initializeProjectChecklistsFromScope } = await import("../../workforce/crew_storage.js");
  (await initializeProjectChecklistsFromScope(orgId, projectId, definition, templateId));
  return { initialized: true, checklist_count: asArray(definition.checklists).length };
}

/**
 * Ask the customer to create a punch list.
 *
 * Bindable at ANY node in a scope template, which is what makes punch lists
 * data-driven rather than a hardcoded end-of-project step: a template can
 * request one at each phase boundary, several concurrently, or none at all.
 *
 * Idempotent through `source_key` — a node that re-fires (retry, reopened
 * stage) reuses the existing list rather than stacking duplicates. Pass an
 * explicit `instance_key` when a template genuinely wants more than one.
 *
 * docs/customer-portal-v2-spec.md §8.2
 */
async function requestPunchList(context: WorkAutomationContext, input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  if (!projectId) return { skipped: true, reason: "missing_project" };

  const { ensureProjectChecklists } = await import("../../workforce/crew_storage.js");
  const { normalizePunchConfig, resolvePunchLabels } = await import("../../workforce/punch_lists.js");
  const { readPortalPunchDefaults } = await import("../../platform/portal_punch.js");

  const orgDefaults = await readPortalPunchDefaults(orgId).catch(() => ({}));
  const config = normalizePunchConfig({
    ...asObject(input.config),
    state: "requested",
    requested_at: new Date().toISOString(),
    ...(cleanText(input.terminology_key) ? { terminology_key: cleanText(input.terminology_key) } : {}),
    ...(asObject(input.labels) && Object.keys(asObject(input.labels)).length ? { labels: asObject(input.labels) } : {})
  }, orgDefaults);
  const labels = resolvePunchLabels(config as unknown as JsonObject, orgDefaults);

  const instanceKey = cleanText(input.instance_key)
    || cleanText(context.plan.template_id)
    || "punch";
  const nodeKey = cleanText(context.node?.id || context.node?.template_node_id);
  const sourceKey = `punch:${instanceKey}${nodeKey ? `:${nodeKey}` : ""}`;

  const result = (await ensureProjectChecklists(orgId, projectId, {
    definitions: [{
      id: `checklist_${createHash("sha256").update(`${orgId}:${projectId}:${sourceKey}`).digest("hex").slice(0, 24)}`,
      title: cleanText(input.title) || labels.request_title,
      description: cleanText(input.description) || labels.request_body,
      // Punch items are worked by the crew, so the list lives in the crew
      // audience; `customer_access` is what exposes it in the portal.
      audience: "crew",
      icon: cleanText(input.icon) || "fa-clipboard-check",
      source: "scope",
      source_key: sourceKey,
      items: [],
      metadata: { punch: config },
      customer_access: {
        visible: true,
        can_complete: false,
        can_edit_items: config.customer_can_add || config.customer_can_edit
      }
    }] as any,
    actorUserId: "system"
  }));

  const created = Array.isArray(result?.created) ? result.created : [];
  if (!created.length) return { skipped: true, reason: "already_requested", source_key: sourceKey };

  // Dynamic import: the engine imports the automation registry, so a static
  // import back into the engine would close a cycle.
  const { emitWorkEvent } = await import("../engine.js");
  await emitWorkEvent({
    organization_id: orgId,
    project_id: projectId,
    type: "punch_list.requested",
    payload: {
      checklist_id: cleanText(asObject(created[0]).id),
      source_key: sourceKey,
      required: config.required,
      noun: labels.noun
    },
    context: { source: "scope_automation" }
  }).catch(() => null);

  return { requested: true, checklist_id: cleanText(asObject(created[0]).id), source_key: sourceKey };
}

async function initializeScopeCustomFields(context: WorkAutomationContext, _input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  const templateId = cleanText(context.plan.template_id);
  if (!projectId || !templateId) return { skipped: true, reason: "missing_project_or_template" };
  const { readScopeTemplateVersion, readScopeTemplate } = await import("../../scopes/storage.js");
  const branchId = cleanText(context.plan.branch_id || "default") || "default";
  const version = Number(context.plan.template_version || 0);
  const frozen = version ? (await readScopeTemplateVersion(orgId, branchId, templateId, version)) : null;
  const definition = asObject(frozen?.definition || asObject((await readScopeTemplate(orgId, branchId, templateId))).definition);
  const { materializeScopeCustomFields } = await import("../../custom_fields/service.js");
  return await materializeScopeCustomFields(orgId, projectId, definition, {
    kind: "scope",
    scope_template_id: templateId,
    scope_template_version: version,
    work_plan_id: cleanText(context.plan.id),
    proposal_id: cleanText(asObject(context.plan.context).proposal_id || asObject(asObject(context.plan.context).proposal).id || context.plan.source_id)
  });
}

async function reconcileScopeCommissions(context: WorkAutomationContext, _input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  if (!projectId) return { skipped: true, reason: "missing_project" };
  const { reconcileProjectScopeCommissions } = await import("../../scopes/service.js");
  return await reconcileProjectScopeCommissions(orgId, projectId);
}

async function reconcileProjectResources(context: WorkAutomationContext, _input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id);
  if (!projectId) return { skipped: true, reason: "missing_project" };
  const { activateProjectScopeResourcesAfterDeposit } = await import("../../scopes/service.js");
  return await activateProjectScopeResourcesAfterDeposit(orgId, projectId);
}

async function ensureProposalReceivables(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const orgId = cleanText(context.event.organization_id);
  const payload = asObject(context.event.payload);
  const proposalId = cleanText(resolved.proposal_id || payload.proposal_id || context.proposal.id);
  const snapshotId = cleanText(resolved.snapshot_id || payload.snapshot_id || context.proposal.snapshot_id);
  if (!proposalId || !snapshotId) return { skipped: true, reason: "missing_signed_proposal_reference" };
  const { ensureReceivablesForSignedProposal } = await import("../../payments/storage.js");
  try {
    return await ensureReceivablesForSignedProposal(orgId, proposalId, snapshotId, {
      signed_at: cleanText(payload.signed_at) || context.now,
      source: cleanText(resolved.source) || "automation"
    });
  } catch (error) {
    if (cleanText(asObject(error).code) === "app_flag_disabled") return { skipped: true, reason: "app_flag_disabled" };
    throw error;
  }
}

// Stamps due dates onto milestone-bound payment obligations (due_rule
// project_completion / node recognition) and resolves expression-priced
// obligations when the bound work completes. Bound as default org rules on
// work.node.completed / work.plan.completed / project.completion.signed.
async function reconcilePaymentRecognition(context: WorkAutomationContext, _input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id || context.event.project_id);
  if (!projectId) return { skipped: true, reason: "missing_project" };
  const { reconcileObligationRecognition } = await import("../../payments/recognition.js");
  try {
    return await reconcileObligationRecognition(orgId, projectId, {
      completion_signed: cleanText(context.event.type) === "project.completion.signed"
    });
  } catch (error) {
    if (cleanText(asObject(error).code) === "app_flag_disabled") return { skipped: true, reason: "app_flag_disabled" };
    throw error;
  }
}

// Runs the document type's declared behaviors.on_signed list when a
// document-engine document is signed. The registry declares WHAT happens on
// signature (types/registry.ts `behaviors`); this automation is the engine
// side that makes the declaration real — bound as a default org rule on
// `document.signed`, so it inherits engine idempotency and execution records.
async function dispatchDocumentSignedBehaviors(context: WorkAutomationContext, _input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const payload = asObject(context.event.payload);
  const documentId = cleanText(payload.document_id);
  if (!documentId) return { skipped: true, reason: "missing_document_id" };
  const { documentType } = await import("../../documents/types/registry.js");
  const type = documentType(cleanText(payload.document_type));
  const behaviors = (type?.behaviors?.on_signed || []).map(cleanText).filter(Boolean);
  if (!behaviors.length) return { skipped: true, reason: "no_on_signed_behaviors" };
  const results: JsonObject = {};
  for (const behavior of behaviors) {
    if (behavior === "payments.ensureReceivables.v1") {
      const { ensureReceivablesForSignedDocument } = await import("../../documents/receivables.js");
      try {
        results[behavior] = await ensureReceivablesForSignedDocument(orgId, documentId, cleanText(payload.snapshot_id), {
          signed_at: cleanText(payload.signed_at) || context.now
        });
      } catch (error) {
        if (cleanText(asObject(error).code) === "app_flag_disabled") {
          results[behavior] = { skipped: true, reason: "app_flag_disabled" };
        } else {
          throw error;
        }
      }
    } else if (behavior === "projects.recordCompletionSigned.v1") {
      const { emitWorkEvent } = await import("../engine.js");
      await emitWorkEvent({
        organization_id: orgId,
        project_id: cleanText(payload.project_id || context.event.project_id),
        type: "project.completion.signed",
        payload: {
          document_id: documentId,
          snapshot_id: cleanText(payload.snapshot_id),
          signed_at: cleanText(payload.signed_at) || context.now
        },
        context: { source: "completion_certificate" }
      });
      results[behavior] = { emitted: true };
    } else if (behavior === "scopes.activateFromProposal.v1") {
      // Document-engine equivalent of the legacy proposal scope activation:
      // activate every scope template the signed document references — either
      // declared on the instance (metadata.on_signed_scope_template_ids) or
      // carried by its selected scope items (scope_template_id per row).
      const { readDocumentInstance } = await import("../../documents/storage.js");
      const document = await readDocumentInstance(orgId, documentId).catch(() => null);
      if (!document) {
        results[behavior] = { skipped: true, reason: "document_not_found" };
        continue;
      }
      const metadata = asObject(document.metadata);
      const params = asObject(document.params);
      const fromMetadata = asArray(metadata.on_signed_scope_template_ids).map(cleanText).filter(Boolean);
      const fromItems = asArray(params.scope_items)
        .map(asObject)
        .filter((item) => item.selected !== false)
        .map((item) => cleanText(item.scope_template_id || asObject(item.piece).template_id))
        .filter(Boolean);
      const templateIds = [...new Set([...fromMetadata, ...fromItems])];
      if (!templateIds.length) {
        results[behavior] = { skipped: true, reason: "no_scope_template_references" };
        continue;
      }
      const branchId = cleanText(document.branch_id || context.event.branch_id || "default") || "default";
      const projectId = cleanText(document.project_id || payload.project_id || context.event.project_id);
      const { readScopeTemplate } = await import("../../scopes/storage.js");
      const { instantiateScopeTemplateWorkPlan } = await import("../../scopes/service.js");
      const activated: JsonObject[] = [];
      for (const templateId of templateIds) {
        const template = (await readScopeTemplate(orgId, branchId, templateId));
        const result = await instantiateScopeTemplateWorkPlan(orgId, {
          project_id: projectId,
          branch_id: branchId,
          template,
          source_type: "document_signed",
          source_id: documentId,
          source_key: `document_signed:${documentId}:${cleanText(payload.snapshot_id)}:${templateId}`,
          context: {
            document: {
              id: documentId,
              snapshot_id: cleanText(payload.snapshot_id),
              document_type: cleanText(payload.document_type),
              template_id: cleanText(payload.template_id)
            }
          }
        });
        activated.push({ template_id: templateId, plan_id: cleanText(asObject(asObject(result).plan).id) });
      }
      results[behavior] = { activated: activated.length, plans: activated };
    } else {
      // Unknown behavior ids record the skip so the execution log stays
      // honest instead of silently dropping the declaration.
      results[behavior] = { skipped: true, reason: "behavior_not_implemented_for_documents" };
    }
  }
  return results;
}

// Issues a document (proposal, invoice, change order, contract, ...) from the
// document engine. Bound in scope templates so "when the job reaches this
// node, send the contract / issue a change order" is template data. Params
// support {{...}} interpolation against the work context before they reach
// the document engine's own param resolution.
async function issueDocument(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(resolved.project_id || context.project.id || context.plan.project_id);
  const documentType = cleanText(resolved.document_type);
  const templateId = cleanText(resolved.template_id);
  if (!orgId || !projectId) return { skipped: true, reason: "missing_project" };
  if (!documentType && !templateId) return { skipped: true, reason: "missing_document_type_or_template" };
  const { issueDocumentFromAutomation } = await import("../../documents/service.js");
  return await issueDocumentFromAutomation(orgId, {
    document_type: documentType || undefined,
    template_id: templateId || undefined,
    ...(Object.prototype.hasOwnProperty.call(resolved, "workflow_id") ? { workflow_id: resolved.workflow_id as string | null } : {}),
    project_id: projectId,
    params: asObject(resolved.params),
    deliver: (cleanText(resolved.deliver) || "none") as "portal" | "email" | "none",
    title: cleanText(resolved.title) || undefined,
    customer_presentation: asObject(resolved.customer_presentation),
    source: {
      type: "automation",
      automation_id: "documents.issue.v1",
      trigger_event_id: cleanText(context.event.id),
      work_plan_id: cleanText(context.plan.id),
      work_node_id: cleanText(context.node.id),
      idempotency_key: `${context.idempotencyKey}:documents.issue.v1`
    }
  });
}

async function requestCompletionSignoff(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const mode = cleanText(resolved.mode || "hybrid").toLowerCase();
  const tabId = cleanText(asObject(resolved.tab).id || resolved.tab_id || "sign_off") || "sign_off";
  return issueDocument(context, {
    ...resolved,
    document_type: "completion_certificate",
    template_id: cleanText(resolved.template_id) || "tpl_roofing_completion_certificate",
    workflow_id: mode === "document" ? null : (cleanText(resolved.workflow_id) || "wfl_roofing_completion_signoff"),
    deliver: cleanText(resolved.deliver) || "portal",
    title: cleanText(resolved.title) || "Project Completion Sign-Off",
    customer_presentation: {
      tab: {
        id: tabId,
        label: cleanText(asObject(resolved.tab).label || resolved.tab_label || "Sign-Off") || "Sign-Off",
        icon: cleanText(asObject(resolved.tab).icon || "fa-flag-checkered") || "fa-flag-checkered",
        order: Number(asObject(resolved.tab).order || 70) || 70
      },
      mode: ["document", "workflow", "hybrid"].includes(mode) ? mode : "hybrid",
      workflow_cta: cleanText(resolved.workflow_cta) || "Complete project sign-off"
    }
  });
}

// Creates (idempotently) and sends a customer feedback / review request for
// the project, using the org's Feedback System settings for channels, message
// templates, and review destinations. Bind to work.plan.completed, the final
// payment.received, crew.checklist.completed, or any other closeout signal.
async function requestCustomerFeedback(context: WorkAutomationContext, input: JsonObject) {
  const resolved = asObject(await resolveValue(input, context));
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(resolved.project_id || context.project.id || context.plan.project_id);
  if (!orgId || !projectId) return { skipped: true, reason: "missing_project" };
  const { isCapabilityEnabled } = await import("../../platform/capabilities.js");
  if (!(await isCapabilityEnabled(orgId, "feedback.review_requests").catch(() => false))) {
    return { skipped: true, reason: "app_flag_disabled" };
  }
  const { requestProjectFeedback } = await import("../../feedback/service.js");
  return await requestProjectFeedback(orgId, {
    project_id: projectId,
    branch_id: cleanText(resolved.branch_id || context.plan.branch_id || context.event.branch_id || "default") || "default",
    source_key: cleanText(resolved.source_key) || `project:${projectId}`,
    channels: asArray(resolved.channels).map(cleanText).filter(Boolean),
    message_overrides: asObject(resolved.message_overrides),
    resend: resolved.resend === true,
    source: {
      type: "automation",
      automation_id: "feedback.requestReview.v1",
      trigger_event_id: cleanText(context.event.id)
    }
  });
}

export function registerBuiltinWorkAutomations() {
  if (registered) return;
  registered = true;
  registerScopeCodeAutomation();
  registerWorkAutomation("project.patch.v1", patchProject, {
    description: "Writes fields onto the project document.",
    input: { values: "Object of fields to set; values support {{template}} interpolation." }
  });
  registerWorkAutomation("notification.create.v1", createNotification, {
    description: "Creates an in-app notification (or celebration) for users or roles.",
    input: { id: "Stable id for dedupe.", title: "Headline.", body: "Body text.", target_role_ids: "Roles to notify.", target_user_ids: "Specific users.", kind: "passive | celebration.", celebration: "Celebration payload {size, reason, text}.", frontend_action: "Click-through action {kind, ...}." }
  });
  registerWorkAutomation("communications.sendSms.v1", sendSms, {
    description: "Sends an SMS through the org's messaging service (respects consent and compliance).",
    input: { to: "Destination phone.", text: "Message body.", recipients: "Alternative recipient list." }
  });
  registerWorkAutomation("communications.sendEmail.v1", sendEmail, {
    description: "Sends an email through the org's messaging service.",
    input: { to: "Destination address.", subject: "Subject line.", text: "Body text.", html: "Optional HTML body." }
  });
  registerWorkAutomation("work.createTodo.v1", createTodo, {
    description: "Creates a standalone to-do (a hidden one-node work plan) assigned to users, roles, or resource groups.",
    input: { title: "To-do title.", message: "Description.", assigned_role_ids: "Roles.", assigned_user_ids: "Users.", assigned_resource_group_ids: "Crews/resource groups.", priority: "0-9.", due_offset_minutes: "Due offset from creation.", metadata: "kind, type_tags, frontend_action." }
  });
  registerWorkAutomation("crm.callLists.add.v1", addCallListEntry, {
    description: "Adds this work item to an org-wide call queue (creates the list if needed).",
    input: { list: "List definition {key, title, kind, icon, tone, assigned_role_ids...}.", title: "Entry title." }
  });
  registerWorkAutomation("crm.callLists.remove.v1", removeCallListEntryForNode, {
    description: "Removes this work item's pending call-queue entry."
  });
  registerWorkAutomation("scheduling.createRequirement.v1", createScheduleRequirement, {
    description: "Creates one unscheduled calendar requirement on the project.",
    input: {
      event_type_default_id: "Calendar event type.",
      title: "Event title.",
      kind: "project_work | material_delivery | ...",
      resource_refs: "Optional concrete assignments: [{kind:'equipment_unit', id, name, role:'equipment'}]. Multiple units are supported.",
      resource_requirements: "Optional type-only requirements: [{kind:'equipment_type', equipment_type_id, label, quantity}]. A unit is chosen later."
    }
  });
  registerWorkAutomation("scheduling.createRequirements.v1", createScheduleRequirements, {
    description: "Creates multiple unscheduled calendar requirements in one shot.",
    input: { requirements: "Array of requirement objects (see scheduling.createRequirement.v1)." }
  });
  registerWorkAutomation("scheduling.createPerStructure.v1", createStructureAppointments, {
    description: "Creates one unscheduled work event per structure in the scope piece.",
    input: { event_type_default_id: "Calendar event type for each structure." }
  });
  registerWorkAutomation("scopes.activateFromProposal.v1", activateScopesFromProposal, {
    description: "Instantiates the production scopes carried by the signed proposal (the sale-to-production transition)."
  });
  registerWorkAutomation("scopes.activateTemplate.v1", activateScopeTemplate, {
    description: "Activates a specific scope template on the project — chain into another pipeline or production scope.",
    input: { template_id: "The scope template to activate.", instance_key: "Optional key to allow repeated activations." }
  });
  registerWorkAutomation("project.claim.v1", claimProjectKey, {
    description: "Atomically claims a named key on the project so parallel scope instances can coordinate (first caller wins). Later bindings can condition on project.claims.<key>.holder.",
    input: { key: "Claim name (e.g. welcome_call).", holder: "Holder identity; defaults to the plan id." }
  });
  registerWorkAutomation("materials.initializeFromScope.v1", initializeScopeResources, {
    description: "Generates the template's material/labor/equipment lists onto the project (default scope setup)."
  });
  registerWorkAutomation("checklists.initializeFromScope.v1", initializeScopeChecklists, {
    description: "Instantiates the template's crew/supervisor checklists on the project (default scope setup)."
  });
  registerWorkAutomation("punchlist.request.v1", requestPunchList, {
    description: "Asks the customer to create a punch list in their portal. Bind at any node — a template can request one per phase, several at once, or none. Idempotent per node.",
    input: {
      title: "Optional heading shown to the customer (defaults to the resolved request copy).",
      description: "Optional body copy (defaults to the resolved request copy).",
      instance_key: "Distinguishes multiple lists on one project; defaults to the scope template id + node.",
      terminology_key: "Terminology key for the noun (default 'punch_list' — override for trades that call it something else).",
      labels: "Per-instance copy overrides: noun, request_title, request_body, submit_cta, accept_cta, ...",
      config: "Gates: required, customer_can_add, customer_can_edit, max_items, require_photo, require_comment, allow_empty, require_submit_signature, require_accept_signature."
    }
  });
  registerWorkAutomation("customFields.initializeFromScope.v1", initializeScopeCustomFields, {
    description: "Adds the scope template's durable custom-field definitions to the project and applies empty defaults."
  });
  registerWorkAutomation("payroll.reconcileScopeCommissions.v1", reconcileScopeCommissions, {
    description: "Initializes commission roles and reconciles commission projections/accruals for the project."
  });
  registerWorkAutomation("scopes.reconcileProjectResources.v1", reconcileProjectResources, {
    description: "Re-reconciles the project's scope resources and commissions (typically bound to the deposit)."
  });
  registerWorkAutomation("payments.ensureReceivables.v1", ensureProposalReceivables, {
    description: "Creates the payment schedule (deposit/completion obligations) from a signed proposal snapshot."
  });
  registerWorkAutomation("documents.dispatchOnSigned.v1", dispatchDocumentSignedBehaviors, {
    description: "Runs the signed document type's declared on_signed behaviors (receivables minting, change-order appends)."
  });
  registerWorkAutomation("payments.reconcileRecognition.v1", reconcilePaymentRecognition, {
    description: "Recognizes milestone-due payment obligations (project completion / work-node bindings) and resolves expression-priced amounts."
  });
  registerWorkAutomation("documents.issue.v1", issueDocument, {
    description: "Issues a document (contract, change order, invoice, ...) from a document template, optionally delivering it by portal link or email.",
    input: { document_type: "Registered document type (falls back to the org default template for the type).", template_id: "Explicit document template id (overrides document_type resolution).", params: "Param values for the document; values support {{template}} interpolation.", deliver: "portal | email | none (default none — the document is issued as a draft).", title: "Optional document title." }
  });
  registerWorkAutomation("completion.request.v1", requestCompletionSignoff, {
    description: "Issues the optional customer completion sign-off as a document, workflow, or hybrid portal experience.",
    input: { mode: "document | workflow | hybrid", deliver: "portal | email | none", params: "Completion date, work summary, warranty summary, and final payment.", tab: "Optional data-driven customer portal tab descriptor." }
  });
  registerWorkAutomation("feedback.requestReview.v1", requestCustomerFeedback, {
    description: "Creates and delivers the project's customer feedback invitation from any workflow or scope-set trigger. One request per project by default.",
    input: {
      project_id: "Optional project override; defaults to the workflow project.",
      branch_id: "Optional branch override; defaults to the work plan or event branch.",
      channels: "Optional delivery override containing any combination of sms, email, and portal; defaults to Feedback settings.",
      message_overrides: "Optional per-run copy overrides: sms_text, email_subject, email_body, portal_title, portal_body, and portal_cta.",
      source_key: "Stable request key. Change it to create a separate request for the same project.",
      resend: "Set true to deliver the existing request again."
    }
  });
}

export async function patchProjectDocument(orgId: string, projectId: string, patch: JsonObject) {
  const document = await readDocument(orgId, "projects", projectId);
  const current = asObject(document.data);
  const next = await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...current, ...patch, updated_at: new Date().toISOString() },
    metadata: document.metadata
  }, { replace: true });
  return { id: projectId, ...asObject(next.data) };
}

export async function createProjectScheduleRequirement(orgId: string, projectId: string, input: JsonObject) {
  const document = await readDocument(orgId, "projects", projectId);
  const project = asObject(document.data);
  const requirements = asArray(project.events).map(asObject);
  const id = cleanText(input.id) || stableId("event", `${projectId}:${JSON.stringify(input)}`);
  const now = new Date().toISOString();
  const event = {
    ...input,
    id,
    project_id: projectId,
    status: cleanText(input.status || "unscheduled") || "unscheduled",
    start_at: cleanText(input.start_at),
    end_at: cleanText(input.end_at),
    created_at: cleanText(input.created_at || now),
    updated_at: now
  };
  const index = requirements.findIndex((entry) => cleanText(entry.id) === id);
  if (index >= 0) requirements[index] = { ...requirements[index], ...event };
  else requirements.push(event);
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...project, events: requirements, updated_at: now },
    metadata: document.metadata
  }, { replace: true });
  return event;
}

export async function createWorkNotification(orgId: string, branchId: string, projectId: string, input: JsonObject) {
  const now = new Date().toISOString();
  const id = cleanText(input.id) || stableId("notification", `${projectId}:${JSON.stringify(input)}`);
  const data = {
    id,
    title: cleanText(input.title || "Work item updated"),
    body: cleanText(input.body || input.message),
    status: "active",
    channel: cleanText(input.channel || "passive"),
    kind: cleanText(input.kind || "passive"),
    push: input.push === true,
    passive: input.passive !== false,
    manual_dismissible: input.manual_dismissible !== false,
    target_user_ids: asArray(input.target_user_ids).map(cleanText).filter(Boolean),
    target_role_ids: asArray(input.target_role_ids).map(cleanText).filter(Boolean),
    branch_id: branchId || "default",
    source: cleanText(input.source || "work.automation"),
    celebration: asObject(input.celebration),
    celebration_size: cleanText(input.celebration_size || input.celebrationSize || asObject(input.celebration).size),
    frontend_action: asObject(input.frontend_action || input.frontendAction || input.action),
    context: { project_id: projectId, ...asObject(input.context) },
    created_at: now,
    updated_at: now
  };
  const { createPlatformNotification } = await import("../../platform/api.js");
  const saved = await createPlatformNotification(orgId, data);
  return { ...data, revision: saved.revision };
}
