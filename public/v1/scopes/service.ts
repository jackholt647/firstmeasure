import { createHash } from "node:crypto";

import { initializeProjectMaterialListsFromScope } from "../materials/storage.js";
import { assignmentPayeesFromCustomField } from "../custom_fields/service.js";
import { compileScopeCommissionBindings, evaluateScopeCommissionRule } from "../payroll/commission_rules.js";
import { accruePayrollProjection, triggerCommissionEvent } from "../payroll/service.js";
import { listPayrollLedgerEntries, listProjectPayees, saveProjectPayeeRole } from "../payroll/storage.js";
import { projectMoneySummary } from "../payments/storage.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { enrichedProposalScopePieces } from "../proposals/scope.js";
import { readWorkConfiguration } from "../work/config.js";
import { createWorkPlan, projectWorkProjection, syncProjectWorkProjection, transitionWorkNode, workPlanTree } from "../work/service.js";
import { initializeProjectChecklistsFromScope } from "../workforce/crew_storage.js";
import { listNodeRecords, listPlanRecords, readPlanRecord, updateNodeRecord, updatePlanRecord } from "../work/storage.js";
import { listScopeTemplates, readScopeTemplate, readScopeTemplateVersion } from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stablePieceId(proposalId: string, index: number, piece: JsonObject) {
  return cleanText(piece.id || piece.pieceId || piece.scope_piece_id)
    || `scope_piece_${createHash("sha256").update(`${proposalId}:${index}:${JSON.stringify(piece)}`).digest("hex").slice(0, 18)}`;
}

// Resolves proposal piece types to templates from template data: each
// template's `proposal.piece_types` (plus its own id and proposal kind) claims
// the piece vocabulary it owns, and a template with `proposal.fallback: true`
// catches anything unclaimed. No trade names live in this code.
function createPieceTemplateResolver(orgId: string, branchId: string) {
  let byPieceType: Map<string, string> | null = null;
  let fallbackTemplateId = "manual";
  return async (piece: JsonObject) => {
    if (!byPieceType) {
      byPieceType = new Map();
      for (const template of (await listScopeTemplates(orgId, branchId, { include_disabled: true, include_archived: true }))) {
        const templateId = cleanText(asObject(template).id);
        if (!templateId) continue;
        const proposal = asObject(asObject(asObject(template).definition).proposal);
        if (proposal.fallback === true) fallbackTemplateId = templateId;
        const pieceTypes = [templateId, cleanText(proposal.kind), ...asArray(proposal.piece_types).map(cleanText)];
        for (const pieceType of pieceTypes) {
          if (pieceType && !byPieceType.has(pieceType)) byPieceType.set(pieceType, templateId);
        }
      }
    }
    const raw = cleanText(piece.template_id || piece.templateId || piece.scope_template_id || piece.type);
    return byPieceType.get(raw) || fallbackTemplateId;
  };
}

function signedScopePieces(snapshot: JsonObject) {
  const scope = asObject(asObject(snapshot.content).scope);
  const pieces = enrichedProposalScopePieces(scope);
  if (pieces.length) return pieces;
  const grouped = new Map<string, JsonObject>();
  for (const itemValue of asArray(scope.root_items)) {
    const item = asObject(itemValue);
    const templateId = cleanText(item.scope_template_id || item.template_id || "manual");
    const pieceId = cleanText(item.scope_piece_id || item.id) || `scope_piece_${grouped.size + 1}`;
    const current = grouped.get(pieceId);
    grouped.set(pieceId, {
      ...current,
      id: pieceId,
      template_id: templateId,
      section_name: cleanText(current?.section_name || item.name || item.display_name),
      root_items: [...asArray(current?.root_items), item],
      measurements: asObject(scope.measurements)
    });
  }
  return [...grouped.values()];
}

function mergeAutomationBindings(baseValue: unknown, extraValue: unknown) {
  const base = asObject(baseValue);
  const extra = asObject(extraValue);
  const keys = new Set([...Object.keys(base), ...Object.keys(extra)]);
  return Object.fromEntries([...keys].map((key) => {
    const bindings = [...asArray(base[key]), ...asArray(extra[key])].map(asObject);
    const seen = new Set<string>();
    return [key, bindings.filter((binding, index) => {
      const identity = cleanText(binding.id) || `${cleanText(binding.automation)}:${JSON.stringify(binding.input)}:${index}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })];
  }));
}

function attachCommissionNodeBindings(nodesValue: unknown, nodeBindings: Record<string, Record<string, JsonObject[]>>): JsonObject[] {
  return asArray(nodesValue).map(asObject).map((node) => ({
    ...node,
    automation_bindings: mergeAutomationBindings(node.automation_bindings, nodeBindings[cleanText(node.id)]),
    children: attachCommissionNodeBindings(node.children, nodeBindings)
  }));
}

function projectSalesAppointment(projectValue: JsonObject) {
  return asArray(projectValue.events).map(asObject)
    .filter((event) => cleanText(event.event_type_default_id || event.type_id || event.type) === "sales_appointment")
    .sort((left, right) => cleanText(right.updated_at || right.created_at || right.start_at).localeCompare(cleanText(left.updated_at || left.created_at || left.start_at)))[0] || {};
}

function organizationUserPayee(idValue: unknown, sourceValue: unknown = {}) {
  const id = cleanText(idValue || asObject(sourceValue).id || asObject(sourceValue).user_id);
  if (!id) return null;
  const source = asObject(sourceValue);
  return {
    type: "organization_user",
    id,
    name: cleanText(source.name || source.display_name || source.email || id),
    worker_type: "employee"
  };
}

function automaticCommissionRolePayees(role: JsonObject, project: JsonObject) {
  const appointment = projectSalesAppointment(project);
  const source = cleanText(role.assignment_source || "manual");
  if (source === "project_custom_field") {
    return assignmentPayeesFromCustomField(project, role.custom_field_path || `assignments.${cleanText(role.key)}`);
  }
  if (source === "sales_appointment_assignee") {
    const assigned = asArray(appointment.assigned_users).map(asObject);
    const byId = new Map<string, JsonObject>();
    for (const user of assigned) {
      const payee = organizationUserPayee(user.id || user.user_id, user);
      if (payee) byId.set(cleanText(payee.id), payee);
    }
    for (const id of asArray(appointment.assigned_user_ids)) {
      const payee = organizationUserPayee(id);
      if (payee && !byId.has(cleanText(payee.id))) byId.set(cleanText(payee.id), payee);
    }
    if (byId.size) return [...byId.values()];
    const fallback = asObject(project.commission_fallback_sales_user);
    const payee = organizationUserPayee(fallback.id || fallback.user_id, fallback);
    return payee ? [payee] : [];
  }
  if (source === "sales_appointment_scheduler") {
    const payee = organizationUserPayee(
      appointment.scheduled_by_user_id || appointment.created_by_user_id,
      { name: appointment.scheduled_by_name, email: appointment.scheduled_by_email }
    );
    return payee ? [payee] : [];
  }
  return [];
}

async function projectWithCommissionFallback(orgId: string, projectValue: JsonObject, proposalIdValue: unknown) {
  const proposalId = cleanText(proposalIdValue);
  if (!proposalId) return projectValue;
  const proposalDocument = await readDocument(orgId, "proposals", proposalId).catch(() => null);
  const proposal = asObject(proposalDocument?.data);
  const userId = cleanText(proposal.created_by_user_id || proposal.updated_by_user_id);
  if (!userId) return projectValue;
  const userDocument = await readDocument(orgId, "users", userId).catch(() => null);
  const user = asObject(userDocument?.data);
  return {
    ...projectValue,
    commission_fallback_sales_user: {
      id: userId,
      name: cleanText(user.name || user.display_name || user.email || userId),
      email: cleanText(user.email)
    }
  };
}

async function initializeScopeCommissionRoles(orgId: string, projectId: string, templateId: string, definition: JsonObject, project: JsonObject) {
  const roles = asArray(asObject(definition.commissions).roles).map(asObject);
  if (!roles.length) return [];
  const existing = new Map((await listProjectPayees(orgId, projectId)).map((role) => [cleanText(role.role_key), role]));
  return (await Promise.all(roles.map(async (role) => {
    const roleKey = cleanText(role.key);
    if (!roleKey) return null;
    const current = existing.get(roleKey);
    const currentPayees = asArray(current?.payees);
    const automaticPayees = automaticCommissionRolePayees(role, project);
    const label = cleanText(role.label || roleKey);
    const explicitlySet = asObject(current?.metadata).payees_explicitly_set === true;
    const payees = current && (currentPayees.length || explicitlySet) ? currentPayees : automaticPayees;
    const metadata = {
      ...asObject(current?.metadata),
      default_role: true,
      assignment_source: cleanText(role.assignment_source || "manual"),
      scope_template_id: templateId
    };
    if (current
      && cleanText(current.label) === label
      && JSON.stringify(currentPayees) === JSON.stringify(payees)
      && JSON.stringify(asObject(current.metadata)) === JSON.stringify(metadata)) return current;
    return (await saveProjectPayeeRole(orgId, projectId, roleKey, {
      label,
      payees,
      metadata,
      ...(current ? { expected_revision: Number(current.revision || 0) } : {})
    }));
  }))).filter(Boolean);
}

async function initializeScopeResourcesForPlan(
  orgId: string,
  projectId: string,
  snapshot: JsonObject,
  rawPiece: JsonObject,
  pieceId: string,
  templateId: string,
  template: JsonObject,
  planId: string
) {
  const definition = asObject(template.definition);
  const resources = asObject(definition.resources);
  const materials = asObject(definition.materials);
  const configuredLists = asArray(resources.lists).length ? asArray(resources.lists) : asArray(materials.lists);
  if (!configuredLists.length) return null;
  const planNodes = (await listNodeRecords(orgId, { plan_id: planId }));
  const sourceNodes = Object.fromEntries(planNodes
    .map((node) => [cleanText(node.template_node_id), cleanText(node.id)])
    .filter(([key]) => key));
  try {
    return await initializeProjectMaterialListsFromScope(orgId, projectId, {
      proposal_id: cleanText(snapshot.proposal_id),
      snapshot_id: cleanText(snapshot.id),
      scope_piece_id: pieceId,
      scope_template_id: templateId,
      scope_template_version: Number(template.version || 1),
      scope_piece: { ...rawPiece, id: pieceId, template_id: templateId },
      work_plan_id: planId,
      source_nodes: sourceNodes
    });
  } catch (error) {
    if (cleanText(asObject(error).code) !== "app_flag_disabled") throw error;
    return null;
  }
}

// Default instantiation bindings: what used to be imperative "blessed" setup
// (materials, checklists, commissions) is now ordinary onStarted bindings
// derived from what the template declares. Templates override a default by
// declaring a binding with the same id (merge keeps the template's copy).
export function defaultInstantiationBindings(definition: JsonObject) {
  const bindings: JsonObject[] = [];
  const customFields = asObject(definition.custom_fields || definition.project_custom_fields);
  if (asArray(customFields.fields || customFields.definitions).length || Object.keys(asObject(asObject(definition.communications).email_forwarding)).length) {
    bindings.push({ id: "default_initialize_scope_custom_fields", automation: "customFields.initializeFromScope.v1", input: {} });
  }
  const hasResources = asArray(asObject(definition.resources).lists).length > 0
    || asArray(asObject(definition.materials).lists).length > 0;
  if (hasResources) {
    bindings.push({ id: "default_initialize_scope_resources", automation: "materials.initializeFromScope.v1", input: {} });
  }
  if (asArray(definition.checklists).length) {
    bindings.push({ id: "default_initialize_scope_checklists", automation: "checklists.initializeFromScope.v1", input: {} });
  }
  if (asArray(asObject(definition.commissions).rules).length) {
    bindings.push({ id: "default_reconcile_scope_commissions", automation: "payroll.reconcileScopeCommissions.v1", input: {} });
  }
  return bindings.length ? { onStarted: bindings } : {};
}

// Reconstructs the resource-initialization context from a plan record so the
// `materials.initializeFromScope.v1` automation can run it. Plans without a
// signed-proposal context have no selector source and are skipped.
export async function initializeScopeResourcesForPlanRecord(orgId: string, planId: string) {
  const plan = (await readPlanRecord(orgId, planId));
  if (!plan) return null;
  const context = asObject(plan.context);
  const proposal = asObject(context.proposal);
  const piece = asObject(context.scope_piece);
  const projectId = cleanText(plan.project_id);
  const snapshotId = cleanText(proposal.snapshot_id);
  if (!projectId || !snapshotId) return null;
  const snapshotDoc = await readDocument(orgId, "proposal_snapshots", snapshotId).catch(() => null);
  if (!snapshotDoc) return null;
  const snapshot: JsonObject = { id: snapshotId, ...asObject(snapshotDoc.data) };
  const branchId = cleanText(plan.branch_id || "default") || "default";
  const templateId = cleanText(plan.template_id);
  const requestedVersion = Number(plan.template_version || 0);
  const version = requestedVersion ? (await readScopeTemplateVersion(orgId, branchId, templateId, requestedVersion)) : null;
  const template: JsonObject = version
    ? { definition: version.definition, version: version.version, version_id: version.id }
    : (await readScopeTemplate(orgId, branchId, templateId));
  return await initializeScopeResourcesForPlan(
    orgId,
    projectId,
    snapshot,
    piece,
    cleanText(piece.id || plan.scope_piece_id),
    templateId,
    template,
    planId
  );
}

function commissionRules(definitionValue: JsonObject) {
  const commissions = asObject(definitionValue.commissions);
  return commissions.enabled === false ? [] : asArray(commissions.rules).map(asObject).filter((rule) => rule.enabled !== false);
}

async function commissionDefinitionForPlan(orgId: string, plan: JsonObject) {
  const branchId = cleanText(plan.branch_id || "default") || "default";
  const templateId = cleanText(plan.template_id);
  const version = Number(plan.template_version || 0);
  const frozen = version ? (await readScopeTemplateVersion(orgId, branchId, templateId, version)) : null;
  const frozenDefinition = asObject(frozen?.definition);
  if (commissionRules(frozenDefinition).length) return { definition: frozenDefinition, backfilled: false };
  let current: JsonObject;
  try {
    current = (await readScopeTemplate(orgId, branchId, templateId));
  } catch {
    return { definition: frozenDefinition, backfilled: false };
  }
  const currentDefinition = asObject(current.definition);
  if (asObject(current.metadata).preset === true && commissionRules(currentDefinition).length) {
    return {
      definition: { ...frozenDefinition, commissions: currentDefinition.commissions },
      backfilled: true
    };
  }
  return { definition: frozenDefinition, backfilled: false };
}

function automationTriggerReached(plan: JsonObject, nodes: JsonObject[], triggerValue: unknown) {
  const trigger = asObject(triggerValue);
  const hook = cleanText(trigger.hook || "onStarted") || "onStarted";
  const nodeId = cleanText(trigger.node_id);
  const source = nodeId ? nodes.find((node) => cleanText(node.template_node_id) === nodeId) : plan;
  if (!source) return false;
  const status = cleanText(source.status);
  if (hook === "onCompleted") return status === "completed";
  if (hook === "onStarted") return !!cleanText(source.started_at) || ["active", "in_progress", "completed"].includes(status);
  if (hook === "onReady") return !!cleanText(source.ready_at) || ["ready", "active", "in_progress", "completed"].includes(status);
  return hook === "onCreated";
}

function commissionEntriesForInstallment(entries: JsonObject[], planId: string, ruleId: string, installmentId: string) {
  return entries.filter((entry) => cleanText(entry.state) !== "void")
    .filter((entry) => cleanText(asObject(entry.metadata).work_plan_id) === planId)
    .filter((entry) => cleanText(asObject(entry.metadata).commission_rule_id) === ruleId)
    .filter((entry) => cleanText(asObject(entry.metadata).commission_installment_id) === installmentId);
}

export async function reconcileProjectScopeCommissions(orgId: string, projectId: string) {
  const projectDocument = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!projectDocument) return { plans: [], projected_count: 0, accrued_count: 0, errors: [] };
  const baseProject: JsonObject = { id: projectId, ...asObject(projectDocument.data) };
  const plans = (await listPlanRecords(orgId, { project_id: projectId, source_type: "signed_proposal_scope" }));
  const reconciled: JsonObject[] = [];
  const errors: JsonObject[] = [];
  let projectedCount = 0;
  let accruedCount = 0;

  for (const plan of plans) {
    const planId = cleanText(plan.id);
    const templateId = cleanText(plan.template_id);
    const { definition, backfilled } = (await commissionDefinitionForPlan(orgId, plan));
    const rules = commissionRules(definition);
    if (!rules.length) continue;
    const project = await projectWithCommissionFallback(orgId, baseProject, plan.source_id);
    (await initializeScopeCommissionRoles(orgId, projectId, templateId, definition, project));

    const bindings = compileScopeCommissionBindings(definition);
    (await updatePlanRecord(orgId, planId, {
      automation_bindings: mergeAutomationBindings(plan.automation_bindings, bindings.plan),
      metadata: {
        ...asObject(plan.metadata),
        ...(backfilled ? { commission_rules_backfilled_from_system_preset: true } : {})
      }
    }));
    const nodes = (await listNodeRecords(orgId, { plan_id: planId }));
    for (const node of nodes) {
      const nodeBindings = bindings.nodes[cleanText(node.template_node_id)];
      if (!nodeBindings) continue;
      (await updateNodeRecord(orgId, cleanText(node.id), {
        automation_bindings: mergeAutomationBindings(node.automation_bindings, nodeBindings)
      }));
    }

    const context = asObject(plan.context);
    const money = await projectMoneySummary(orgId, projectId).catch(() => ({}));
    let ledger = (await listPayrollLedgerEntries(orgId, { project_id: projectId, kind: "commission", limit: 5000 }));
    for (const rule of rules) {
      const ruleId = cleanText(rule.id);
      if (!automationTriggerReached(plan, nodes, rule.trigger)) continue;
      try {
        const awards = evaluateScopeCommissionRule(rule, {
          project,
          scope: asObject(context.scope || context.scope_piece),
          proposal: asObject(context.proposal),
          money,
          plan,
          now: new Date().toISOString()
        });
        for (const [index, award] of awards.entries()) {
          const installmentId = cleanText(award.installment_id) || String(index + 1);
          let installmentEntries = commissionEntriesForInstallment(ledger, planId, ruleId, installmentId);
          if (!installmentEntries.length) {
            const sourceEventId = `scope-commission-plan:${planId}:${ruleId}`;
            const result = (await triggerCommissionEvent(orgId, projectId, {
              source_event_id: sourceEventId,
              trigger_id: `${ruleId}:${installmentId}`,
              state: cleanText(award.entry_state) === "projected" ? "projected" : "accrued",
              payee_role: cleanText(award.payee_role || rule.payee_role),
              payees: asArray(award.payees),
              amount_cents: Math.round(Number(award.amount_cents || 0)),
              allocation: cleanText(award.allocation || rule.allocation) === "each" ? "each" : "split_evenly",
              currency: cleanText(award.currency || rule.currency || "USD"),
              occurred_at: cleanText(plan.started_at || plan.created_at || new Date().toISOString()),
              completed_at: cleanText(plan.started_at || plan.created_at || new Date().toISOString()),
              project_title: cleanText(project.title || project.project_title || plan.title),
              description: cleanText(award.description || rule.title || "Scope commission"),
              metadata: {
                work_plan_id: planId,
                scope_template_id: templateId,
                scope_template_version: Number(plan.template_version || 0),
                commission_rule_id: ruleId,
                commission_installment_id: installmentId,
                commission_installment_title: cleanText(award.installment_title),
                commission_installment_share_bps: Number(award.installment_share_bps || 0),
                commission_recognition: asObject(award.recognition),
                commission_calculation_mode: cleanText(asObject(rule.calculation).mode || "preset"),
                commission_breakdown: asArray(award.breakdown),
                commission_basis_cents: Number(award.basis_cents || 0),
                commission_rate_bps: Number(award.rate_bps || 0),
                commission_rules_backfilled: backfilled,
                ...asObject(rule.metadata),
                ...asObject(award.metadata)
              }
            }));
            projectedCount += asArray(result.entries).filter((entry) => cleanText(asObject(entry).state) === "projected").length;
            ledger = (await listPayrollLedgerEntries(orgId, { project_id: projectId, kind: "commission", limit: 5000 }));
            installmentEntries = commissionEntriesForInstallment(ledger, planId, ruleId, installmentId);
          }
          if (automationTriggerReached(plan, nodes, award.recognition)) {
            for (const entry of installmentEntries.filter((candidate) => cleanText(candidate.state) === "projected")) {
              (await accruePayrollProjection(orgId, cleanText(entry.id), {
                occurred_at: cleanText(nodes.find((node) => cleanText(node.template_node_id) === cleanText(asObject(award.recognition).node_id))?.completed_at)
                  || new Date().toISOString()
              }));
              accruedCount += 1;
            }
            ledger = (await listPayrollLedgerEntries(orgId, { project_id: projectId, kind: "commission", limit: 5000 }));
          }
        }
      } catch (error) {
        const code = cleanText(asObject(error).code);
        if (code !== "commission_payees_empty") {
          errors.push({ plan_id: planId, rule_id: ruleId, code, message: cleanText(asObject(error).message || error) });
        }
      }
    }
    reconciled.push({ plan_id: planId, template_id: templateId, backfilled, rule_count: rules.length });
  }
  return { plans: reconciled, projected_count: projectedCount, accrued_count: accruedCount, errors };
}

export async function reconcileProjectScopeResources(orgId: string, projectId: string) {
  const snapshots = (await listDocuments(orgId, "proposal_snapshots"))
    .map((document): JsonObject => ({ id: cleanText(document.id), ...asObject(document.data) }))
    .filter((snapshot) => cleanText(snapshot.project_id) === projectId && (
      cleanText(snapshot.status) === "signed"
      || !!cleanText(snapshot.signed_at)
      || !!cleanText(asObject(snapshot.delivery).signed_at)
    ));
  const plans = (await listPlanRecords(orgId, { project_id: projectId, source_type: "signed_proposal_scope" }));
  const initialized: JsonObject[] = [];
  for (const snapshot of snapshots) {
    const proposalId = cleanText(snapshot.proposal_id);
    const templateIdForPiece = createPieceTemplateResolver(orgId, cleanText(snapshot.branch_id || "default") || "default");
    for (const [index, rawPiece] of signedScopePieces(snapshot).entries()) {
      const pieceId = stablePieceId(proposalId, index, rawPiece);
      const templateId = (await templateIdForPiece(rawPiece));
      const plan = plans.find((candidate) => cleanText(candidate.source_version_id) === cleanText(snapshot.id)
        && cleanText(candidate.scope_piece_id) === pieceId
        && cleanText(candidate.template_id) === templateId);
      if (!plan) continue;
      const requestedVersion = Number(rawPiece.template_version || rawPiece.scope_template_version || plan.template_version || 0);
      const version = requestedVersion ? (await readScopeTemplateVersion(orgId, cleanText(plan.branch_id || "default"), templateId, requestedVersion)) : null;
      const template: JsonObject = version
        ? { definition: version.definition, version: version.version, version_id: version.id }
        : (await readScopeTemplate(orgId, cleanText(plan.branch_id || "default"), templateId));
      const result = await initializeScopeResourcesForPlan(
        orgId,
        projectId,
        snapshot,
        rawPiece,
        pieceId,
        templateId,
        template,
        cleanText(plan.id)
      );
      if (result) initialized.push(result);
    }
  }
  return { initialized, count: initialized.reduce((total, result) => total + Number(result.count || 0), 0) };
}

export async function activateProjectScopeResourcesAfterDeposit(orgId: string, projectId: string) {
  const resources = await reconcileProjectScopeResources(orgId, projectId);
  const commissions = await reconcileProjectScopeCommissions(orgId, projectId);
  return { ...resources, commissions };
}

// Instantiates a scope template's work plan onto a project. Shared by the
// intake router (pipeline entry) and the scope-transition automations
// (`scopes.activateTemplate.v1`). Idempotent through `source_key`.
export async function instantiateScopeTemplateWorkPlan(orgId: string, optionsValue: JsonObject) {
  const options = asObject(optionsValue);
  const projectId = cleanText(options.project_id);
  const branchId = cleanText(options.branch_id || "default") || "default";
  const template = asObject(options.template);
  const templateId = cleanText(template.id);
  const definition = asObject(template.definition);
  const blueprint = asObject(definition.work_plan);
  const workConfiguration = await readWorkConfiguration(orgId, branchId);
  const planResult = await createWorkPlan({
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    source_type: cleanText(options.source_type) || "scope_transition",
    source_id: cleanText(options.source_id) || templateId,
    source_key: cleanText(options.source_key) || `scope_template:${projectId}:${templateId}`,
    template_id: templateId,
    template_version: Number(template.version || 1),
    title: cleanText(options.title || template.name || definition.name || blueprint.title) || templateId,
    terminology: { ...asObject(blueprint.terminology), ...asObject(workConfiguration.terminology) },
    automation_bindings: mergeAutomationBindings(blueprint.automation_bindings, defaultInstantiationBindings(definition)),
    root_nodes: asArray(blueprint.root_nodes),
    context: asObject(options.context),
    metadata: {
      ...asObject(blueprint.metadata),
      scope_template_kind: cleanText(definition.kind) || "production",
      scope_template_version_id: template.version_id
    },
    start_immediately: true
  });
  if (projectId) await syncProjectWorkProjection(orgId, projectId);
  return planResult;
}

export async function startWorkPlansForSignedProposal(orgId: string, proposalId: string, snapshotId: string) {
  const snapshotDoc = await readDocument(orgId, "proposal_snapshots", snapshotId);
  const snapshot: JsonObject = { id: snapshotId, ...asObject(snapshotDoc.data) };
  const projectId = cleanText(snapshot.project_id);
  const branchId = cleanText(snapshot.branch_id || "default") || "default";
  const projectDocument = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
  const rawProject: JsonObject = projectDocument ? { id: projectId, ...asObject(projectDocument.data) } : { id: projectId };
  const project = await projectWithCommissionFallback(orgId, rawProject, proposalId);
  const workConfiguration = await readWorkConfiguration(orgId, branchId);
  const pieces = signedScopePieces(snapshot);
  const templateIdForPiece = createPieceTemplateResolver(orgId, branchId);
  const results = [];
  for (const [index, rawPiece] of pieces.entries()) {
    const pieceId = stablePieceId(proposalId, index, rawPiece);
    const templateId = (await templateIdForPiece(rawPiece));
    const requestedVersion = Number(rawPiece.template_version || rawPiece.scope_template_version || 0);
    const version = requestedVersion
      ? (await readScopeTemplateVersion(orgId, branchId, templateId, requestedVersion))
      : null;
    const template: JsonObject = version
      ? { definition: version.definition, version: version.version, version_id: version.id }
      : (await readScopeTemplate(orgId, branchId, templateId));
    const definition = asObject(template.definition);
    const blueprint = asObject(definition.work_plan);
    const commissionBindings = compileScopeCommissionBindings(definition);
    const sectionName = cleanText(rawPiece.sectionName || rawPiece.section_name || rawPiece.name || definition.name || "Project Work");
    const planResult = await createWorkPlan({
      organization_id: orgId,
      branch_id: branchId,
      project_id: projectId,
      source_type: "signed_proposal_scope",
      source_id: proposalId,
      source_version_id: snapshotId,
      source_key: `proposal_signed:${proposalId}:${snapshotId}:${pieceId}`,
      template_id: templateId,
      template_version: Number(template.version || 1),
      scope_piece_id: pieceId,
      title: sectionName,
      terminology: { ...asObject(blueprint.terminology), ...asObject(workConfiguration.terminology) },
      // Setup (materials, checklists, commissions) runs through the default
      // onStarted bindings — ordinary automations the template can override.
      automation_bindings: mergeAutomationBindings(
        mergeAutomationBindings(blueprint.automation_bindings, commissionBindings.plan),
        defaultInstantiationBindings(definition)
      ),
      root_nodes: attachCommissionNodeBindings(blueprint.root_nodes, commissionBindings.nodes).map((node) => {
        const value = asObject(node);
        return { ...value, title: cleanText(value.title) === cleanText(definition.name) ? sectionName : value.title };
      }),
      context: {
        scope_piece: { ...rawPiece, id: pieceId, template_id: templateId, section_name: sectionName },
        proposal: {
          id: proposalId,
          snapshot_id: snapshotId,
          signed_at: snapshot.signed_at || asObject(snapshot.delivery).signed_at,
          content: asObject(snapshot.content),
          pricing: asObject(asObject(snapshot.content).pricing),
          scope: asObject(asObject(snapshot.content).scope)
        }
      },
      metadata: { ...asObject(blueprint.metadata), scope_template_version_id: template.version_id },
      start_immediately: true
    });
    const planId = cleanText(asObject(planResult.plan).id);
    const planNodes = (await listNodeRecords(orgId, { plan_id: planId }));
    const signNodes = planNodes.filter((node) => cleanText(node.template_node_id) === "sign_proposal");
    for (const node of signNodes) {
      if (!['completed', 'skipped'].includes(cleanText(node.status))) {
        await transitionWorkNode(orgId, cleanText(node.id), "completed", { reason: "proposal_signed" });
      }
    }
    results.push({ ...planResult, tree: (await workPlanTree(orgId, planId)) });
  }
  if (projectId) {
    const projectDoc = await readDocument(orgId, "projects", projectId);
    const project = asObject(projectDoc.data);
    const planIds = [...new Set([...asArray(project.work_plan_ids).map(cleanText), ...results.map((result) => cleanText(asObject(result.plan).id))])].filter(Boolean);
    await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { ...project, work_plan_ids: planIds, work_projection: (await projectWorkProjection(orgId, projectId)), updated_at: new Date().toISOString() },
      metadata: projectDoc.metadata
    }, { replace: true });
  }
  return { plans: results, count: results.length };
}
