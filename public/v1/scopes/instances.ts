import { inheritWorkDepartments } from "../work/department-inheritance.js";
// Bringing running scope instances onto the current template version.
//
// A work plan is created from one immutable template version and keeps running
// it. Editing a template therefore affects only instances started afterwards —
// unless the change is explicitly pushed here. Pushing is always a choice: the
// caller previews what would change and then applies it to every open
// instance or to chosen ones.
//
// What an update does, per instance:
//   - work items that still exist take the new version's automations
//     (bindings, external triggers, timers, sequences), dependencies and
//     completion mode. Their status, history, assignments and notes are kept.
//     Title and description follow the template only where the instance still
//     shows the previous version's text.
//   - work items new in this version are added as pending and become ready
//     through the normal dependency rules, which runs their automations.
//   - work items that no longer exist are kept as they are by default
//     (`removed_work: "keep"`), or skipped (`"skip"`), which runs their
//     skip automations.
//   - scope-level automations are replaced and the instance records the
//     version it now runs.
// Finished and canceled instances are never changed.

import { createHash } from "node:crypto";

import { badRequest, notFound } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { normalizeWorkPlanBindingKeys } from "../work/bindings.js";
import { compileSequences } from "../work/sequences.js";
import { recalculateWorkPlan, transitionWorkNode } from "../work/service.js";
import {
  createNodeRecord, getWorkDatabase, listDependenciesForNode, listNodeRecords, listPlanRecords, readPlanRecord,
  replaceDependencyRecords, terminalNodeStatus, updateNodeRecord, updatePlanRecord
} from "../work/storage.js";
import { composeScopeWorkPlan } from "./service.js";
import { readScopeTemplate, readScopeTemplateVersion } from "./storage.js";

const text = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
// Matches the node identity work/service.ts gives a template node in a plan.
const nodeRecordId = (planId: string, templateNodeId: string) => `work_node_${createHash("sha256").update(`${planId}:${templateNodeId}`).digest("hex").slice(0, 24)}`;

type FlatNode = { definition: JsonObject; parent: string; depth: number; index: number };

function flatten(rootNodes: unknown[]) {
  const nodes = new Map<string, FlatNode>();
  const visit = (value: unknown, parent: string, depth: number, index: number) => {
    const definition = asObject(value);
    nodes.set(text(definition.id), { definition, parent, depth, index });
    asArray(definition.children).forEach((child, childIndex) => visit(child, text(definition.id), depth + 1, childIndex));
  };
  rootNodes.forEach((root, index) => visit(root, "", 0, index));
  return nodes;
}

function compose(definition: JsonObject, plan: JsonObject) {
  const composed = composeScopeWorkPlan(definition, { signedProposal: text(plan.source_type) === "signed_proposal_scope" });
  return normalizeWorkPlanBindingKeys({ automation_bindings: composed.automation_bindings, root_nodes: compileSequences(inheritWorkDepartments(composed.root_nodes, asObject(definition.work_plan).department_ids ?? definition.department_ids)) });
}

function completionMode(definition: JsonObject) {
  return text(definition.completion_mode) || (asArray(definition.children).length ? "all_children" : "manual");
}

export type ScopeInstanceUpdateOptions = {
  mode?: "preview" | "apply";
  plan_ids?: string[];
  project_ids?: string[];
  removed_work?: "keep" | "skip";
  actor_user_id?: string;
};

export async function updateScopeInstances(orgId: string, branchIdValue: string, templateId: string, options: ScopeInstanceUpdateOptions = {}) {
  const branchId = text(branchIdValue) || "default";
  const mode = options.mode === "apply" ? "apply" : "preview";
  if (options.removed_work && !["keep", "skip"].includes(options.removed_work)) throw badRequest("scope_instances_removed_work", 'removed_work must be "keep" or "skip".');
  const removedWork = options.removed_work === "skip" ? "skip" : "keep";
  const template = await readScopeTemplate(orgId, branchId, templateId);
  if (!template) throw notFound("scope_template_not_found", "Scope template was not found.");
  const targetVersion = Number(template.version || 0);
  const targetDefinition = asObject(template.definition);
  const planFilter = new Set((options.plan_ids || []).map(text).filter(Boolean));
  const projectFilter = new Set((options.project_ids || []).map(text).filter(Boolean));

  const candidates = (await listPlanRecords(orgId)).filter((plan) => text(plan.template_id) === templateId
    && (text(plan.branch_id) || "default") === branchId
    && ["pending", "active", "paused"].includes(text(plan.status))
    && (!planFilter.size || planFilter.has(text(plan.id)))
    && (!projectFilter.size || projectFilter.has(text(plan.project_id))));

  const previousDefinitions = new Map<number, JsonObject>();
  const results: JsonObject[] = [];
  for (const plan of candidates) {
    const planId = text(plan.id);
    const fromVersion = Number(plan.template_version || 0);
    if (fromVersion === targetVersion) { results.push({ plan_id: planId, project_id: plan.project_id, from_version: fromVersion, to_version: targetVersion, up_to_date: true }); continue; }
    if (!previousDefinitions.has(fromVersion)) {
      const previous = fromVersion ? await readScopeTemplateVersion(orgId, branchId, templateId, fromVersion) : null;
      previousDefinitions.set(fromVersion, asObject(previous?.definition));
    }
    const previousNodes = flatten(compose(previousDefinitions.get(fromVersion)!, plan).root_nodes as unknown[]);
    const target = compose(targetDefinition, plan);
    const targetNodes = flatten(target.root_nodes as unknown[]);
    const records = await listNodeRecords(orgId, { plan_id: planId });
    const byTemplateId = new Map(records.map((record) => [text(record.template_node_id), record]));

    const updated: JsonObject[] = [];
    const added: JsonObject[] = [];
    const removed: JsonObject[] = [];
    const patches: { record: JsonObject; patch: JsonObject; depends_on: string[] | null }[] = [];
    for (const [id, entry] of targetNodes) {
      const record = byTemplateId.get(id);
      const definition = entry.definition;
      if (!record) {
        const parentRecord = entry.parent ? byTemplateId.get(entry.parent) : null;
        added.push({ id, title: text(definition.title), ...(parentRecord && terminalNodeStatus(parentRecord.status) ? { note: "Its stage is already finished on this instance, so it will not become active." } : {}) });
        continue;
      }
      const previous = previousNodes.get(id)?.definition || {};
      const metadata = asObject(record.metadata);
      const nextMetadata = { ...metadata };
      if (asArray(definition.timers).length) nextMetadata.timers = definition.timers; else delete nextMetadata.timers;
      const patch: JsonObject = {};
      if (!same(record.department_ids || [], definition.department_ids || [])) patch.department_ids = definition.department_ids || [];
      const fields: string[] = patch.department_ids ? ["departments"] : [];
      if (!same(record.automation_bindings || {}, definition.automation_bindings || {})) { patch.automation_bindings = definition.automation_bindings || {}; fields.push("automations"); }
      if (!same(record.external_triggers || [], definition.external_triggers || [])) { patch.external_triggers = definition.external_triggers || []; fields.push("triggers"); }
      if (!same(metadata.timers || [], definition.timers || [])) { patch.metadata = nextMetadata; fields.push("timers"); }
      if (text(record.completion_mode) !== completionMode(definition)) { patch.completion_mode = completionMode(definition); fields.push("completion"); }
      // Text follows the template only where nobody changed it on the instance.
      if (text(record.title) === text(previous.title) && text(definition.title) && text(record.title) !== text(definition.title)) { patch.title = text(definition.title); fields.push("title"); }
      if (text(record.description) === text(previous.description) && text(record.description) !== text(definition.description)) { patch.description = text(definition.description); fields.push("description"); }
      const currentDependencies = (await listDependenciesForNode(text(record.id))).map((row) => text(asObject(row).depends_on_node_id)).sort();
      const nextDependencies = asArray(definition.depends_on).map((dependency) => nodeRecordId(planId, text(dependency))).sort();
      const dependenciesChanged = !same(currentDependencies, nextDependencies);
      if (dependenciesChanged) fields.push("dependencies");
      if (!fields.length) continue;
      updated.push({ id, title: text(record.title), status: record.status, changed: fields });
      patches.push({ record, patch, depends_on: dependenciesChanged ? nextDependencies : null });
    }
    for (const record of records) {
      const id = text(record.template_node_id);
      // Work added on the instance itself is never touched.
      if (!id || targetNodes.has(id) || !previousNodes.has(id)) continue;
      removed.push({ id, title: text(record.title), status: record.status, action: terminalNodeStatus(record.status) || removedWork === "keep" ? "kept" : "skipped" });
    }
    const planBindingsChanged = !same(plan.automation_bindings || {}, target.automation_bindings || {});
    const summary: JsonObject = {
      plan_id: planId, project_id: plan.project_id, title: plan.title, status: plan.status, from_version: fromVersion, to_version: targetVersion,
      changes: { updated, added, removed, scope_automations_changed: planBindingsChanged }
    };
    if (mode === "preview") { results.push(summary); continue; }

    for (const { record, patch, depends_on } of patches) {
      if (Object.keys(patch).length) await updateNodeRecord(orgId, text(record.id), patch);
      if (depends_on) await replaceDependencyRecords(text(record.id), depends_on.map((node_id) => ({ node_id })));
    }
    // Parents precede children in targetNodes, so a new parent exists before its new children.
    const addedIds = new Set(added.map((node) => text(node.id)));
    for (const [id, entry] of targetNodes) {
      if (!addedIds.has(id)) continue;
      const definition = entry.definition;
      await createNodeRecord({
        id: nodeRecordId(planId, id), organization_id: orgId, branch_id: plan.branch_id || "default", plan_id: planId, project_id: plan.project_id,
        parent_id: entry.parent ? nodeRecordId(planId, entry.parent) : null, template_node_id: id, scope_piece_id: plan.scope_piece_id,
        department_ids: definition.department_ids || [],
        terminology_key: definition.terminology_key, title: definition.title, description: definition.description,
        sort_order: definition.sort_order ?? entry.index, depth: entry.depth, status: "pending", completion_mode: completionMode(definition),
        actionable: definition.actionable === true, show_in_todo_list: definition.show_in_todo_list ?? definition.actionable === true,
        priority: Number(definition.priority || 0), assigned_user_ids: definition.assigned_user_ids || [], assigned_role_ids: definition.assigned_role_ids || [],
        assigned_resource_group_ids: definition.assigned_resource_group_ids || [], automation_bindings: definition.automation_bindings || {},
        external_triggers: definition.external_triggers || [],
        due_at: Number.isFinite(Number(definition.due_offset_minutes)) ? new Date(Date.now() + Number(definition.due_offset_minutes) * 60_000).toISOString() : "",
        metadata: { ...asObject(definition.metadata), ...(definition.assignment_policy !== undefined ? { assignment_policy: definition.assignment_policy } : {}), ...(asArray(definition.timers).length ? { timers: definition.timers } : {}) }
      });
    }
    for (const id of addedIds) {
      const dependencies = asArray(targetNodes.get(id)!.definition.depends_on).map((dependency) => ({ node_id: nodeRecordId(planId, text(dependency)) }));
      if (dependencies.length) await replaceDependencyRecords(nodeRecordId(planId, id), dependencies);
    }
    const history = asArray(asObject(plan.metadata).template_updates);
    await updatePlanRecord(orgId, planId, {
      department_ids: asObject(targetDefinition.work_plan).department_ids ?? targetDefinition.department_ids ?? [],
      automation_bindings: target.automation_bindings,
      metadata: { ...asObject(plan.metadata), scope_template_version_id: template.version_id,
        template_updates: [...history, { from_version: fromVersion, to_version: targetVersion, at: new Date().toISOString(), actor_user_id: text(options.actor_user_id), removed_work: removedWork }] }
    });
    await getWorkDatabase().prepare("UPDATE work_plans SET template_version = ? WHERE organization_id = ? AND id = ?").run(targetVersion, orgId, planId);
    for (const node of removed) {
      if (node.action !== "skipped") continue;
      const record = byTemplateId.get(text(node.id));
      if (record) await transitionWorkNode(orgId, text(record.id), "skipped", { reason: "template_update", actor_user_id: text(options.actor_user_id) });
    }
    await recalculateWorkPlan(orgId, planId);
    results.push({ ...summary, applied: true, status: (await readPlanRecord(orgId, planId))?.status });
  }
  const changed = results.filter((result) => result.up_to_date !== true);
  return {
    template_id: templateId, version: targetVersion, mode,
    open_instances: results.length,
    needing_update: mode === "preview" ? changed.length : 0,
    updated: mode === "apply" ? changed.length : 0,
    instances: results
  };
}
