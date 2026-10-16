import { publishScopeMaterialArtifact } from "../materials/calculus.js";
import { createHash } from "node:crypto";

import { initializeProjectMaterialListsFromScope } from "../materials/storage.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { enrichedProposalScopePieces } from "../proposals/scope.js";
import { readWorkConfiguration } from "../work/config.js";
import { createWorkPlan, projectWorkProjection, syncProjectWorkProjection, transitionWorkNode, workPlanTree } from "../work/service.js";
import { initializeProjectChecklistsFromScope } from "../workforce/crew_storage.js";
import { listNodeRecords, listPlanRecords, readPlanRecord, updateNodeRecord, updatePlanRecord } from "../work/storage.js";
import { listScopeTemplates, readScopeTemplate, readScopeTemplateVersion } from "./storage.js";
import { conflict } from "../platform/errors.js";
import { INTAKE_CATEGORY, SALES_CATEGORY, templateCategoryIds } from "./categories.js";
const TERMINAL_PLAN_STATUSES = ["completed", "canceled"];

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
// (materials, checklists) is now ordinary onStarted bindings
// derived from what the template declares. Templates override a default by
// declaring a binding with the same id (merge keeps the template's copy).
export function defaultInstantiationBindings(definition: JsonObject) {
  const bindings: JsonObject[] = [];
  const customFields = asObject(definition.custom_fields || definition.project_custom_fields);
  if (asArray(customFields.fields || customFields.definitions).length || Object.keys(asObject(asObject(definition.communications).email_forwarding)).length) {
    bindings.push({ id: "default_initialize_scope_custom_fields", automation: "customFields.initializeFromScope.v1", input: {} });
  }
  const hasResources = asArray(asObject(definition.resources).lists).length > 0
    || asArray(asObject(definition.materials).lists).length > 0
    || asArray(definition.materials_deliverables).length > 0;
  if (hasResources) {
    bindings.push({ id: "default_initialize_scope_resources", automation: "materials.initializeFromScope.v1", input: {} });
  }
  if (asArray(definition.checklists).length) {
    bindings.push({ id: "default_initialize_scope_checklists", automation: "checklists.initializeFromScope.v1", input: {} });
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
  if (!projectId) return null;
  const branchId = cleanText(plan.branch_id || "default") || "default";
  const templateId = cleanText(plan.template_id);
  const requestedVersion = Number(plan.template_version || 0);
  const version = requestedVersion ? (await readScopeTemplateVersion(orgId, branchId, templateId, requestedVersion)) : null;
  const template: JsonObject = version
    ? { definition: version.definition, version: version.version, version_id: version.id }
    : (await readScopeTemplate(orgId, branchId, templateId));
  const artifacts = [];
  for (const deliverable of asArray(asObject(template.definition).materials_deliverables)) {
    artifacts.push(await publishScopeMaterialArtifact(orgId,projectId,planId,deliverable,{work_plan_id:planId,template_id:templateId,template_version:requestedVersion,branch_id:branchId}));
  }
  if (!snapshotId) return { material_artifacts:artifacts };
  const snapshotDoc = await readDocument(orgId,"proposal_snapshots",snapshotId).catch(()=>null);
  if (!snapshotDoc) return { material_artifacts:artifacts };
  const snapshot:JsonObject={id:snapshotId,...asObject(snapshotDoc.data)};
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
  return await reconcileProjectScopeResources(orgId, projectId);
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
  const sourceKey = cleanText(options.source_key) || `scope_template:${projectId}:${templateId}`;
  const categoryIds = templateCategoryIds(definition), intake = categoryIds.includes(INTAKE_CATEGORY), sales = !intake && categoryIds.includes(SALES_CATEGORY);
  if (sales && projectId) {
    // How many opportunities a project may have open at once is the organization's setting (default: no limit).
    const limit = (await (await import("./router.js")).readIntakeRouting(orgId, branchId)).max_open_opportunities;
    const open = (await listPlanRecords(orgId, { project_id: projectId, sales: true }))
      .filter((plan) => plan.outcome === "open" && !TERMINAL_PLAN_STATUSES.includes(cleanText(plan.status)) && cleanText(plan.source_key) !== sourceKey);
    if (limit > 0 && open.length >= limit) throw conflict("opportunity_limit", `This project already has ${open.length} open ${open.length === 1 ? "opportunity" : "opportunities"}; close one before starting another sales scope.`);
  }
  const planResult = await createWorkPlan({
    sales,
    department_ids: blueprint.department_ids ?? definition.department_ids ?? [],
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    source_type: cleanText(options.source_type) || "scope_transition",
    source_id: cleanText(options.source_id) || templateId,
    source_key: sourceKey,
    template_id: templateId,
    template_version: Number(template.version || 1),
    title: cleanText(options.title || template.name || definition.name || blueprint.title) || templateId,
    terminology: { ...asObject(blueprint.terminology), ...asObject(workConfiguration.terminology) },
    automation_bindings: mergeAutomationBindings(blueprint.automation_bindings, defaultInstantiationBindings(definition)),
    root_nodes: asArray(blueprint.root_nodes),
    context: asObject(options.context),
    metadata: {
      ...asObject(blueprint.metadata),
      scope_category_ids: categoryIds,
      scope_template_version_id: template.version_id,
      // Intake runs before the project has a scope: never a board of its own.
      ...(intake ? { hide_from_boards: true } : {})
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
  const project = rawProject;
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
    const sectionName = cleanText(rawPiece.sectionName || rawPiece.section_name || rawPiece.name || definition.name || "Project Work");
    const planResult = await createWorkPlan({
    department_ids: blueprint.department_ids ?? definition.department_ids ?? [],
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
      // Setup (materials, checklists) runs through the default
      // onStarted bindings — ordinary automations the template can override.
      automation_bindings: mergeAutomationBindings(blueprint.automation_bindings, defaultInstantiationBindings(definition)),
      root_nodes: asArray(blueprint.root_nodes).map(asObject).map((node) => {
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
    }, { replace: true, mustExist: true });
  }
  return { plans: results, count: results.length };
}

// The work-plan content a scope definition produces when it is instantiated:
// plan-level bindings (the template's own, for
// signed proposals, and the default setup bindings) plus the node tree. Used to
// bring running instances onto a newer template version; see ./instances.ts.
export function composeScopeWorkPlan(definitionValue: JsonObject, options: { signedProposal?: boolean } = {}) {
  const definition = asObject(definitionValue);
  const blueprint = asObject(definition.work_plan);
  if (!options.signedProposal) {
    return {
      automation_bindings: mergeAutomationBindings(blueprint.automation_bindings, defaultInstantiationBindings(definition)),
      root_nodes: asArray(blueprint.root_nodes).map(asObject)
    };
  }
  return {
    automation_bindings: mergeAutomationBindings(blueprint.automation_bindings, defaultInstantiationBindings(definition)),
    root_nodes: asArray(blueprint.root_nodes).map(asObject)
  };
}
