import { createHash, randomUUID } from "node:crypto";

import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { checklistAudioProcessor, reconcileChecklistAudioOperations } from "../audio-structure/checklist.js";
import { processStructuredAudio } from "../audio-structure/processor.js";
import {
  createMaterialList,
  createMaterialVersion,
  listMaterialDeliveries,
  listMaterialOrders,
  listProjectMaterialLists,
  readMaterialList
} from "../materials/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { listDocuments, readDocument, storeMediaUpload, upsertDocument, type JsonObject } from "../platform/storage.js";
import { sendProjectSms } from "../comms/service.js";
import { projectExpenseSummary, readReceipt } from "../payments/expenses.js";
import { associateReceiptWithProject, receiptView } from "../payments/receipts.js";
import {
  createPayment,
  listPayables,
  projectMoneySummary
} from "../payments/storage.js";
import {
  createProposal,
  createProposalSnapshot,
  listProjectProposals,
  patchProposal,
  readProposal,
  sendProposal
} from "../proposals/storage.js";
import { proposalScopeTotalCents } from "../proposals/scope.js";
import { instantiateScopeTemplateWorkPlan } from "../scopes/service.js";
import { listScopeTemplates, readScopeTemplate } from "../scopes/storage.js";
import { emitWorkEvent } from "../work/engine.js";
import { createFollowUpTodo } from "../work/followups.js";
import { listWorkTodos, transitionWorkNode } from "../work/service.js";
import { listNodeRecords, listPlanRecords, readNodeRecord } from "../work/storage.js";
import { hasHourlyCompensation, resolveAccessProfile } from "./access.js";
import {
  documentWorkflowDetail,
  filterWorkflowForAudience,
  listProjectDocuments,
  patchDocumentInstance,
  readDocumentInstance,
  recordDocumentOutput,
  resolveDocumentInstance,
  sendDocument,
  updateDocumentWorkflowState,
  voidDocumentInstance
} from "../documents/service.js";
import { documentRequirementsStatus, documentSignatureRequirement } from "../documents/presentation.js";
import { documentCapabilityState, filterOutputDefinitionsByCapabilities } from "../documents/capability_policy.js";
import { assignableMatchesPolicy, normalizeAssignmentPolicy } from "./assignability.js";
import { activeResourceGroupsForUser, assignedProjectWorkEvents, assignedSalesAppointmentEvents, projectWorkEvents } from "./assignment_scope.js";
import { listResourceGroups } from "./storage.js";
import { resolveAssignableSubjects } from "./service.js";
import {
  createCrewChecklistItem,
  addProjectChecklistItemAttachment,
  createProjectChecklist,
  createProjectChecklistItem,
  deleteCrewChecklistItem,
  deleteProjectChecklist,
  ensureProjectChecklists,
  listCrewChecklistItems,
  listDeletedProjectChecklists,
  listProjectChecklists,
  patchCrewChecklistItem,
  patchProjectChecklist,
  patchProjectChecklistItem,
  performCrewTimeClockAction,
  readCrewTimeClock,
  readProjectChecklist,
  readProjectChecklistItem
} from "./crew_storage.js";

type CrewActor = {
  ctx: PlatformAuthContext;
  accessProfile: JsonObject;
  management: boolean;
  groupIds: Set<string>;
  groupSubjects: JsonObject[];
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function requestBody(request: FastifyRequest) {
  return asObject(request.body);
}

function requestQuery(request: FastifyRequest) {
  return asObject(request.query);
}

function clockActionMetadata(request: FastifyRequest, value: unknown) {
  const input = asObject(value);
  const rawLocation = asObject(input.location || input.geolocation || input.geo);
  const latitude = Number(rawLocation.latitude ?? rawLocation.lat);
  const longitude = Number(rawLocation.longitude ?? rawLocation.lng ?? rawLocation.lon);
  const accuracy = Number(rawLocation.accuracy_meters ?? rawLocation.accuracy);
  const status = ["captured", "denied", "unavailable"].includes(cleanText(rawLocation.status))
    ? cleanText(rawLocation.status)
    : (Number.isFinite(latitude) && Number.isFinite(longitude) ? "captured" : "unavailable");
  const validCoordinates = status === "captured" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  return {
    project_id: cleanText(input.project_id).slice(0, 180),
    timezone: cleanText(input.timezone).slice(0, 120),
    client_path: cleanText(input.client_path).slice(0, 500),
    location: {
      status: validCoordinates ? "captured" : status === "captured" ? "unavailable" : status,
      ...(validCoordinates ? { latitude, longitude } : {}),
      ...(validCoordinates && Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy_meters: Math.min(100_000, accuracy) } : {}),
      captured_at: cleanText(rawLocation.captured_at).slice(0, 80),
      reason: cleanText(rawLocation.reason).slice(0, 120)
    },
    request: {
      ip: cleanText(request.ip),
      user_agent: cleanText(request.headers["user-agent"]).slice(0, 500)
    },
    source: "crew_app"
  };
}

// Work events are emitted after the storage layer has committed (the crew
// storage helpers run their SQLite transactions synchronously), so nothing
// here executes inside an open transaction.
async function emitTimeClockWorkEvent(orgId: string, actorUserId: string, action: string, result: JsonObject) {
  if (!["clock_in", "clock_out"].includes(action)) return;
  const shift = asObject(result.shift || result.current_shift);
  const shiftId = cleanText(shift.id);
  if (!shiftId) return;
  const projectId = cleanText(asObject(shift.metadata).project_id);
  const type = action === "clock_in" ? "crew.clock.in" : "crew.clock.out";
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: "default",
    ...(projectId ? { project_id: projectId } : {}),
    type,
    idempotency_key: `${type}:${shiftId}`,
    payload: {
      shift_id: shiftId,
      user_id: cleanText(shift.user_id) || actorUserId,
      ...(projectId ? { project_id: projectId } : {}),
      ...(action === "clock_out" ? { worked_seconds: Math.max(0, Number(shift.worked_seconds || 0)) } : {})
    },
    context: { actor_user_id: actorUserId }
  });
}

async function emitChecklistWorkEvents(
  orgId: string,
  projectId: string,
  actorUserId: string,
  before: JsonObject,
  after: JsonObject
) {
  const becameCompleted = after.completed === true && before.completed !== true;
  const ratingChanged = !!cleanText(after.rating) && cleanText(after.rating) !== cleanText(before.rating);
  if (!becameCompleted && !ratingChanged) return;
  const itemId = cleanText(after.id);
  const status = cleanText(after.item_type) === "rating" ? cleanText(after.rating) : cleanText(after.status);
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: "default",
    project_id: projectId,
    type: "crew.checklist.item_completed",
    idempotency_key: `crew.checklist.item_completed:${itemId}:${status}`,
    payload: {
      item_id: itemId,
      checklist_id: cleanText(after.checklist_id),
      title: cleanText(after.title),
      item_type: cleanText(after.item_type),
      status,
      ...(cleanText(after.rating) ? { rating: cleanText(after.rating) } : {})
    },
    context: { actor_user_id: actorUserId }
  });
  const checklistId = cleanText(after.checklist_id);
  if (!checklistId) return;
  const checklist = asObject((await listProjectChecklists(orgId, projectId))
    .find((entry) => cleanText(asObject(entry).id) === checklistId));
  const totalItems = Number(checklist.total_items || 0);
  if (!totalItems || Number(checklist.completed_items || 0) !== totalItems) return;
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: "default",
    project_id: projectId,
    type: "crew.checklist.completed",
    idempotency_key: `crew.checklist.completed:${checklistId}:${itemId}`,
    payload: {
      checklist_id: checklistId,
      checklist_kind: cleanText(checklist.kind),
      audience: cleanText(checklist.audience),
      title: cleanText(checklist.title)
    },
    context: { actor_user_id: actorUserId }
  });
}

function managementAuthority(ctx: PlatformAuthContext) {
  const role = cleanText(ctx.role).toLowerCase();
  const permissions = asObject(ctx.permissions);
  return permissions["*"] === true
    || permissions.manage_projects === true
    || permissions.manage_company_settings === true
    || ["owner", "admin", "super_admin"].includes(role);
}

function fieldPermissions(ctx: PlatformAuthContext, accessProfile: JsonObject) {
  const resolvedAccess = asObject(accessProfile.application_access || accessProfile.applicationAccess);
  const resolvedField = asObject(resolvedAccess.field);
  const contextField = asObject(ctx.applicationAccess.field);
  return {
    enabled: resolvedField.enabled === true || contextField.enabled === true,
    permissions: {
      ...asObject(contextField.permissions),
      ...asObject(resolvedField.permissions),
      ...asObject(accessProfile.permissions)
    }
  };
}

function hasCrewPermission(actor: CrewActor, permission: string) {
  if (actor.management) return true;
  const field = fieldPermissions(actor.ctx, actor.accessProfile);
  if (!field.enabled) return false;
  return cleanText(permission).split("|").some((key) => {
    const item = key.trim();
    return field.permissions[item] === true || (field.permissions[item] !== false && field.permissions["*"] === true);
  });
}

async function requireCrewActor(
  request: FastifyRequest,
  orgId: string,
  permission = "",
  csrf = false
): Promise<CrewActor> {
  const capability = cleanText(permission).split("|").map((key) => key.trim()).includes("crew.signatures.present")
    ? "documents.esign"
    : undefined;
  const ctx = await requirePlatformAuth(request, {
    orgId,
    csrf,
    application: ["management", "field"],
    ...(capability ? { capability } : {})
  });
  const contextProfile = asObject((ctx as unknown as { accessProfile?: JsonObject }).accessProfile);
  const accessProfile = Object.keys(contextProfile).length ? contextProfile : (await resolveAccessProfile(orgId, ctx.user));
  const activeGroups = await activeResourceGroupsForUser(orgId, ctx.userId);
  const actor: CrewActor = {
    ctx,
    accessProfile,
    management: managementAuthority(ctx),
    groupIds: new Set(activeGroups.map((group) => cleanText(group.id)).filter(Boolean)),
    groupSubjects: activeGroups.map((group) => ({
      subject_type: "resource_group",
      id: cleanText(group.id),
      group_kind_id: cleanText(group.kind_id),
      kind_ids: cleanText(group.kind_id) ? [cleanText(group.kind_id)] : [],
      assignment_tag_ids: asArray(group.assignment_tag_ids)
    }))
  };
  if (permission && !hasCrewPermission(actor, permission)) {
    throw forbidden("crew_permission_denied", "This user does not have access to this Crew action.", { permission });
  }
  return actor;
}

function projectData(documentValue: unknown) {
  const document = asObject(documentValue);
  return {
    id: cleanText(document.id),
    ...asObject(document.data),
    revision: Number(document.revision || 0),
    document_updated_at: cleanText(document.updated_at)
  };
}

function assignedWorkEvents(project: JsonObject, actor: CrewActor) {
  return assignedProjectWorkEvents(project, { userId:actor.ctx.userId, groupIds:actor.groupIds, management:actor.management });
}

// Production-scope roles (supervisors by default) see every project that is
// actually scheduled for work -- any project with a project_work event --
// regardless of crew assignment.
function hasProductionScope(actor: CrewActor) {
  return actor.management || hasCrewPermission(actor, "crew.projects.view_all_production");
}

// Assignment tokens for to-do matching: the user's workforce access role ids
// plus the "office"/"management" tokens for management users. Unassigned
// to-dos never surface in the field apps.
function actorRoleTokens(actor: CrewActor) {
  const tokens = asArray(asObject(actor.accessProfile).access_role_ids).map(cleanText).filter(Boolean);
  if (actor.management) tokens.push("office", "management");
  return [...new Set(tokens)];
}

function checklistAssignment(checklistValue: unknown) {
  const checklist = asObject(checklistValue);
  const policyValue = asObject(checklist.assignment_policy || asObject(checklist.metadata).assignment_policy);
  const assignedUserIds = asArray(checklist.assigned_user_ids || asObject(checklist.metadata).assigned_user_ids).map(cleanText).filter(Boolean);
  const assignedRoleIds = asArray(checklist.assigned_role_ids || asObject(checklist.metadata).assigned_role_ids).map(cleanText).filter(Boolean);
  const assignedResourceGroupIds = asArray(checklist.assigned_resource_group_ids || asObject(checklist.metadata).assigned_resource_group_ids).map(cleanText).filter(Boolean);
  const configured = Object.keys(policyValue).length > 0 || assignedUserIds.length > 0 || assignedRoleIds.length > 0 || assignedResourceGroupIds.length > 0;
  return {
    configured,
    policy: normalizeAssignmentPolicy(policyValue),
    assignedUserIds,
    assignedRoleIds,
    assignedResourceGroupIds
  };
}

function checklistAssignmentMatchesActor(actor: CrewActor, checklistValue: unknown) {
  const assignment = checklistAssignment(checklistValue);
  if (!assignment.configured) return true;
  const explicitlyAssigned = assignment.assignedUserIds.length
    || assignment.assignedRoleIds.length
    || assignment.assignedResourceGroupIds.length;
  if (explicitlyAssigned) {
    const roles = new Set(actorRoleTokens(actor));
    return assignment.assignedUserIds.includes(actor.ctx.userId)
      || assignment.assignedRoleIds.some((roleId) => roles.has(roleId))
      || assignment.assignedResourceGroupIds.some((groupId) => actor.groupIds.has(groupId));
  }
  if (!assignment.policy.allow_unassigned) return false;
  const userSubject = {
    subject_type: "organization_user",
    id: actor.ctx.userId,
    role_ids: actorRoleTokens(actor),
    kind_ids: actorRoleTokens(actor)
  };
  return assignableMatchesPolicy(userSubject, assignment.policy)
    || actor.groupSubjects.some((group) => assignableMatchesPolicy(group, assignment.policy));
}

function checklistNeedsExplicitAssignment(checklistValue: unknown) {
  const assignment = checklistAssignment(checklistValue);
  return assignment.configured
    && !assignment.policy.allow_unassigned
    && !assignment.assignedUserIds.length
    && !assignment.assignedRoleIds.length
    && !assignment.assignedResourceGroupIds.length;
}

async function assertChecklistAssignmentsAllowed(orgId: string, checklistValue: unknown) {
  const checklist = asObject(checklistValue);
  const assignment = checklistAssignment(checklist);
  if (!assignment.configured) return;
  const resolved = await resolveAssignableSubjects(orgId, "default", assignment.policy);
  const allowedUsers = new Set(asArray(resolved.users).map((subject) => cleanText(asObject(subject).id)));
  const allowedGroups = new Set(asArray(resolved.resource_groups).map((subject) => cleanText(asObject(subject).id)));
  const allowedRoles = new Set(assignment.policy.rules.flatMap((rule) => rule.role_ids));
  const invalidUsers = assignment.assignedUserIds.filter((id) => !allowedUsers.has(id));
  const invalidGroups = assignment.assignedResourceGroupIds.filter((id) => !allowedGroups.has(id));
  const invalidRoles = allowedRoles.size
    ? assignment.assignedRoleIds.filter((id) => !allowedRoles.has(id))
    : [];
  if (invalidUsers.length || invalidGroups.length || invalidRoles.length) {
    throw badRequest("checklist_assignment_invalid", "One or more checklist assignees are outside its assignment policy.", {
      invalid_user_ids: invalidUsers,
      invalid_resource_group_ids: invalidGroups,
      invalid_role_ids: invalidRoles
    });
  }
}

function todoVisibleToActor(node: JsonObject, actor: CrewActor) {
  const users = asArray(node.assigned_user_ids).map(cleanText).filter(Boolean);
  const roles = asArray(node.assigned_role_ids).map(cleanText).filter(Boolean);
  const resourceGroups = asArray(node.assigned_resource_group_ids).map(cleanText).filter(Boolean);
  if (!users.length && !roles.length && !resourceGroups.length) return actor.management;
  const tokens = new Set(actorRoleTokens(actor));
  return users.includes(actor.ctx.userId)
    || roles.some((role) => tokens.has(role))
    || resourceGroups.some((groupId) => actor.groupIds.has(groupId));
}

async function enrichTodosWithProjects(orgId: string, todos: JsonObject[]) {
  const projectIds = [...new Set(todos.map((todo) => cleanText(todo.project_id)).filter(Boolean))];
  const labels = new Map<string, { title: string; address: string }>();
  await Promise.all(projectIds.map(async (projectId) => {
    const document = await readDocument(orgId, "projects", projectId).catch(() => null);
    if (!document) return;
    const project = asObject(document.data);
    labels.set(projectId, {
      title: cleanText(project.title || project.project_title || project.customer_name || project.address),
      address: cleanText(project.address || project.project_address)
    });
  }));
  return todos.map((todo) => {
    const label = labels.get(cleanText(todo.project_id));
    return label ? { ...todo, project_title: label.title, project_address: label.address } : todo;
  });
}

async function assignedProject(orgId: string, projectId: string, actor: CrewActor) {
  const document = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!document) throw notFound("project_not_found", "Project was not found.");
  const project = projectData(document);
  const events = assignedWorkEvents(project, actor);
  if (events.length) return { document, project, events };
  if (hasProductionScope(actor)) {
    const production = projectWorkEvents(project);
    if (production.length) return { document, project, events: production };
  }
  // Sales personas are assigned through their sales appointments; that grants
  // the same project access so shared project tabs (payments, checklists, …)
  // work for them. Per-action permissions still gate what they can do inside.
  const salesEvents = assignedSalesAppointmentEvents(project, { userId: actor.ctx.userId });
  if (salesEvents.length) return { document, project, events: salesEvents };
  throw forbidden("crew_project_forbidden", "This project is not assigned to this user or their active work group.");
}

async function todosOnAccessibleProjects(orgId: string, todos: JsonObject[], actor: CrewActor) {
  const access = new Map<string, boolean>();
  await Promise.all([...new Set(todos.map((todo) => cleanText(todo.project_id)).filter(Boolean))].map(async (projectId) => {
    const document = await readDocument(orgId, "projects", projectId).catch(() => null);
    if (!document) {
      access.set(projectId, false);
      return;
    }
    const project = projectData(document);
    access.set(projectId, assignedWorkEvents(project, actor).length > 0
      || (hasProductionScope(actor) && projectWorkEvents(project).length > 0));
  }));
  return todos.filter((todo) => {
    const projectId = cleanText(todo.project_id);
    return !projectId || access.get(projectId) === true;
  });
}

// Management users may open any project (for the office checklist workspace);
// field users still need an assigned work event.
async function accessibleProject(orgId: string, projectId: string, actor: CrewActor) {
  if (!actor.management) return assignedProject(orgId, projectId, actor);
  const document = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!document) throw notFound("project_not_found", "Project was not found.");
  const project = projectData(document);
  return { document, project, events: assignedWorkEvents(project, actor) };
}

async function checklistAccessibleProject(orgId: string, projectId: string, actor: CrewActor) {
  if (actor.management) return accessibleProject(orgId, projectId, actor);
  const document = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!document) throw notFound("project_not_found", "Project was not found.");
  const project = projectData(document);
  (await ensureProjectChecklists(orgId, projectId, { actorUserId: actor.ctx.userId }));
  const assignedChecklist = (await listProjectChecklists(orgId, projectId))
    .some((checklist) => checklistVisibleToActor(actor, checklist));
  if (assignedChecklist) return { document, project, events: assignedWorkEvents(project, actor) };
  return assignedProject(orgId, projectId, actor);
}

function checklistAudiencesForActor(actor: CrewActor): string[] | null {
  if (actor.management) return null;
  const audiences: string[] = [];
  if (hasCrewPermission(actor, "crew.checklists.view")) audiences.push("crew");
  if (hasCrewPermission(actor, "crew.checklists.supervise")) audiences.push("supervisor");
  return audiences;
}

function checklistCompletionAllowed(actor: CrewActor, checklist: { audience: string }) {
  if (checklistNeedsExplicitAssignment(checklist)) return false;
  if (actor.management) return true;
  if (checklistAssignment(checklist).configured) return checklistAssignmentMatchesActor(actor, checklist);
  if (cleanText(checklist.audience) === "supervisor") return hasCrewPermission(actor, "crew.checklists.supervise");
  return hasCrewPermission(actor, "crew.checklists.complete|crew.checklists.manage");
}

function checklistVisibleToActor(actor: CrewActor, checklist: { audience: string }) {
  if (actor.management) return true;
  if (hasCrewPermission(actor, "crew.checklists.supervise")) return true;
  if (checklistAssignment(checklist).configured) return checklistAssignmentMatchesActor(actor, checklist);
  if (cleanText(checklist.audience) === "supervisor") return hasCrewPermission(actor, "crew.checklists.supervise");
  return hasCrewPermission(actor, "crew.checklists.view|crew.checklists.complete|crew.checklists.manage");
}

function checklistEditAllowed(actor: CrewActor, checklist: { audience: string; crew_editable: boolean }) {
  if (actor.management) return true;
  if (!hasCrewPermission(actor, "crew.checklists.manage")) return false;
  if (cleanText(checklist.audience) === "supervisor") return hasCrewPermission(actor, "crew.checklists.supervise");
  return checklist.crew_editable === true;
}

async function checklistUserNames(orgId: string, userIds: string[]) {
  const names: Record<string, string> = {};
  for (const userId of [...new Set(userIds.map(cleanText).filter(Boolean))]) {
    const document = await readDocument(orgId, "users", userId).catch(() => null);
    const user = asObject(document?.data);
    const name = cleanText(user.name || user.display_name || user.full_name || user.email);
    if (name) names[userId] = name;
  }
  return names;
}

async function checklistCollectionPayload(orgId: string, projectId: string, actor: CrewActor) {
  (await ensureProjectChecklists(orgId, projectId, { actorUserId: actor.ctx.userId }));
  const checklists = (await listProjectChecklists(orgId, projectId))
    .filter((checklist) => checklistVisibleToActor(actor, checklist));
  const canManage = actor.management || hasCrewPermission(actor, "crew.checklists.manage");
  const deletedChecklists = canManage
    ? (await listDeletedProjectChecklists(orgId, projectId)).filter((checklist) => checklistVisibleToActor(actor, checklist))
    : [];
  const allChecklists = [...checklists, ...deletedChecklists];
  const names = await checklistUserNames(orgId, allChecklists.flatMap((checklist) =>
    [...checklist.items.map((item) => item.completed_by_user_id), ...checklist.assigned_user_ids]));
  const groups = await listResourceGroups(orgId, {});
  const groupNames = Object.fromEntries(groups.map((group) => [cleanText(group.id), cleanText(group.name || group.id)]));
  const enrich = (checklist: (typeof allChecklists)[number]) => ({
    ...checklist,
    assigned_user_names: Object.fromEntries(checklist.assigned_user_ids.map((id: string) => [id, names[id] || id])),
    assigned_resource_group_names: Object.fromEntries(checklist.assigned_resource_group_ids.map((id: string) => [id, groupNames[id] || id])),
    assignment_required: checklistNeedsExplicitAssignment(checklist),
    can_complete: checklistCompletionAllowed(actor, checklist),
    can_edit: checklistEditAllowed(actor, checklist),
    items: checklist.items.map((item) => ({
      ...item,
      completed_by_name: names[item.completed_by_user_id] || ""
    }))
  });
  return {
    ok: true,
    project_id: projectId,
    management: actor.management,
    permissions: {
      view: true,
      complete: actor.management || hasCrewPermission(actor, "crew.checklists.complete|crew.checklists.manage"),
      supervise: actor.management || hasCrewPermission(actor, "crew.checklists.supervise"),
      manage: actor.management || hasCrewPermission(actor, "crew.checklists.manage")
    },
    checklists: checklists.map(enrich),
    deleted_checklists: deletedChecklists.map(enrich)
  };
}

function dateValue(value: unknown) {
  const text = cleanText(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function checklistAudioRequirements(value: unknown) {
  const kinds = [...new Set(asArray(value).map(cleanText).filter((kind) => ["media", "photo", "video", "document", "audio"].includes(kind)))];
  return kinds.map((kind, index) => {
    if (["media", "photo", "video"].includes(kind)) return {
      id: `voice_media_${index + 1}`,
      kind: "media",
      allowed_kinds: kind === "media" ? ["photo", "video"] : [kind],
      min_count: 1
    };
    return { id:`voice_${kind}_${index + 1}`, kind, min_count:1 };
  });
}

function validDate(value: unknown, fallback = "") {
  const text = dateValue(value);
  if (!text) return fallback;
  const parsed = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? text : fallback;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function dateOrdinal(value: string) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 86_400_000) : 0;
}

function eventDateRange(event: JsonObject) {
  const start = validDate(event.start_date || event.start_at || event.start);
  let end = validDate(event.end_date);
  if (!end) {
    const rawEnd = validDate(event.end_at || event.end, start);
    const allDay = event.all_day === true || cleanText(event.schedule_granularity) !== "time";
    if (allDay && rawEnd && start && rawEnd > start) {
      const endDate = new Date(`${rawEnd}T00:00:00.000Z`);
      endDate.setUTCDate(endDate.getUTCDate() - 1);
      end = endDate.toISOString().slice(0, 10);
    } else end = rawEnd;
  }
  return { start, end: end || start };
}

function eventIsSpecificTime(event: JsonObject) {
  return event.all_day === false || cleanText(event.schedule_granularity).toLowerCase() === "time";
}

function projectCompleted(project: JsonObject) {
  if (asObject(project.work_projection).completed === true) return true;
  const lifecycle = cleanText(asObject(project.lifecycle).status).toLowerCase();
  if (lifecycle) return lifecycle !== "open";
  const state = cleanText(project.status || project.project_status).toLowerCase();
  return ["completed", "complete", "finished", "done", "closed"].includes(state)
    || !!cleanText(project.completed_at || project.completed_date || project.finished_at);
}

function projectPrimaryContact(project: JsonObject) {
  const contacts = asArray(project.contacts).map(asObject);
  const primary = contacts.find((entry) => entry.primary === true || cleanText(entry.role).toLowerCase() === "primary") || contacts[0] || {};
  const customer = asObject(project.customer);
  return {
    id: cleanText(primary.id || customer.id || project.customer_id),
    name: cleanText(primary.name || customer.name || project.customer_name || project.customerName || project.primary_contact_name),
    phone: cleanText(primary.phone || asArray(primary.phones)[0] || customer.phone || project.customer_phone || project.primary_contact_phone),
    email: cleanText(primary.email || customer.email || project.customer_email || project.primary_contact_email)
  };
}

function projectTitle(project: JsonObject) {
  return cleanText(project.title || project.project_title || project.name || project.address || "Project") || "Project";
}

function projectAddress(project: JsonObject) {
  return cleanText(project.address || project.project_address || project.property_address);
}

function projectNotes(project: JsonObject) {
  return cleanText(project.notes || project.project_notes || project.description || project.summary);
}

function scopeTemplateId(project: JsonObject, event: JsonObject) {
  const direct = cleanText(event.scope_template_id || event.scope_id);
  if (direct) return direct;
  const plans = asArray(asObject(project.work_projection).plans).map(asObject);
  return cleanText(plans.find((plan) => !["sales", "project_sales"].includes(cleanText(plan.template_id || plan.source_type)))?.template_id);
}

async function scopeView(orgId: string, project: JsonObject, event: JsonObject) {
  const id = scopeTemplateId(project, event);
  if (!id) return { id: "", name: "", icon: "fa-helmet-safety", color: "#16a34a" };
  try {
    const template = asObject((await readScopeTemplate(orgId, cleanText(project.branch_id || "default") || "default", id)));
    const definition = asObject(template.definition);
    return {
      id,
      version: Number(template.version || 0),
      name: cleanText(definition.name || template.name || id.replace(/[_-]+/g, " ")),
      icon: cleanText(definition.icon || template.icon || "fa-helmet-safety"),
      color: cleanText(definition.color || template.color || "#16a34a")
    };
  } catch {
    return { id, name: id.replace(/[_-]+/g, " "), icon: "fa-helmet-safety", color: "#16a34a" };
  }
}

function scheduleView(event: JsonObject, targetDate: string) {
  const range = eventDateRange(event);
  const startOrdinal = dateOrdinal(range.start);
  const endOrdinal = dateOrdinal(range.end);
  const targetOrdinal = dateOrdinal(targetDate);
  const totalDays = startOrdinal && endOrdinal ? Math.max(1, endOrdinal - startOrdinal + 1) : 1;
  const currentDay = startOrdinal && targetOrdinal ? Math.max(1, targetOrdinal - startOrdinal + 1) : 1;
  return {
    event_id: cleanText(event.id),
    start_at: cleanText(event.start_at || event.start),
    end_at: cleanText(event.end_at || event.end),
    start_date: range.start,
    end_date: range.end,
    specific_time: eventIsSpecificTime(event),
    all_day: !eventIsSpecificTime(event),
    schedule_granularity: cleanText(event.schedule_granularity || (eventIsSpecificTime(event) ? "time" : "date")),
    day_number: currentDay,
    total_days: totalDays,
    day_indicator: `${currentDay}/${totalDays}`,
    overdue_day: currentDay > totalDays,
    status: cleanText(event.status || "scheduled")
  };
}

async function projectTile(orgId: string, project: JsonObject, event: JsonObject, targetDate: string) {
  const contact = projectPrimaryContact(project);
  const schedule = scheduleView(event, targetDate);
  const completed = projectCompleted(project);
  const overdue = !completed && !!schedule.end_date && schedule.end_date < targetDate;
  return {
    id: cleanText(project.id),
    project_id: cleanText(project.id),
    title: projectTitle(project),
    address: projectAddress(project),
    customer: contact,
    customer_name: contact.name,
    customer_phone: contact.phone,
    notes: projectNotes(project),
    stage: cleanText(asObject(asObject(project.work_projection).primary_stage).title || project.status),
    completed,
    overdue,
    schedule,
    scope: (await scopeView(orgId, project, event)),
    work_resource_ref: asObject(event.work_resource_ref),
    signature_requirements: asObject(project.signature_requirements),
    event
  };
}

function tileSort(left: JsonObject, right: JsonObject) {
  const leftOverdue = left.overdue === true ? 1 : 0;
  const rightOverdue = right.overdue === true ? 1 : 0;
  if (leftOverdue !== rightOverdue) return leftOverdue - rightOverdue;
  const leftSchedule = asObject(left.schedule);
  const rightSchedule = asObject(right.schedule);
  const leftTimed = leftSchedule.specific_time === true ? 0 : 1;
  const rightTimed = rightSchedule.specific_time === true ? 0 : 1;
  if (leftTimed !== rightTimed) return leftTimed - rightTimed;
  const leftTime = Date.parse(cleanText(leftSchedule.start_at)) || dateOrdinal(cleanText(leftSchedule.start_date));
  const rightTime = Date.parse(cleanText(rightSchedule.start_at)) || dateOrdinal(cleanText(rightSchedule.start_date));
  return leftTime - rightTime || projectTitle(left).localeCompare(projectTitle(right));
}

async function allAssignedProjects(orgId: string, actor: CrewActor) {
  const documents = await listDocuments(orgId, "projects");
  const production = hasProductionScope(actor);
  return documents.map((document) => {
    const project = projectData(document);
    // Production-scope actors see every scheduled work event (worked on by
    // anybody); everyone else sees only their own or their group's work.
    const events = production ? projectWorkEvents(project) : assignedWorkEvents(project, actor);
    return { project, events };
  }).filter((entry) => entry.events.length > 0);
}

function bestEventForDate(events: JsonObject[], targetDate: string, includeAny = false) {
  const containing = events.filter((event) => {
    const range = eventDateRange(event);
    return !!range.start && range.start <= targetDate && range.end >= targetDate;
  }).sort((a, b) => tileSort({ schedule: scheduleView(a, targetDate) }, { schedule: scheduleView(b, targetDate) }));
  if (containing.length) return containing[0];
  const overdue = events.filter((event) => {
    const range = eventDateRange(event);
    return !!range.end && range.end < targetDate;
  }).sort((a, b) => eventDateRange(b).end.localeCompare(eventDateRange(a).end));
  if (overdue.length) return overdue[0];
  if (!includeAny) return null;
  return [...events].sort((a, b) => eventDateRange(a).start.localeCompare(eventDateRange(b).start))[0] || null;
}

async function publicProjectDetail(orgId: string, project: JsonObject, events: JsonObject[], targetDate = todayDate()) {
  const event = bestEventForDate(events, targetDate, true) || {};
  const tile = (await projectTile(orgId, project, event, targetDate));
  return {
    ...tile,
    assigned_events: events,
    contacts: asArray(project.contacts).map(asObject),
    project: {
      id: cleanText(project.id),
      title: projectTitle(project),
      address: projectAddress(project),
      customer_name: tile.customer_name,
      customer_phone: tile.customer_phone,
      notes: projectNotes(project),
      stage: cleanText(asObject(asObject(project.work_projection).primary_stage).title || project.status),
      branch_id: cleanText(project.branch_id || "default"),
      signature_requirements: asObject(project.signature_requirements)
    }
  };
}

function fieldDocumentTotalCents(document: JsonObject) {
  const params = asObject(document.params);
  const walk = (values: unknown[]): number => values.reduce<number>((sum, value) => {
    const item = asObject(value);
    const selected = asObject(item.selection).selected !== false;
    const included = item.included === true || item.price_driving === false;
    const own = selected && !included
      ? Math.max(0, Math.round((Number(item.quantity || 0) || 0) * (Number(item.unit_price || item.base_price || 0) || 0) * 100))
      : 0;
    return sum + own + walk(asArray(item.children));
  }, 0);
  return walk(asArray(params.scope_items)) || cents(params.amount_due_cents || params.deposit_cents || params.final_payment_cents);
}

function receiptActorAllowed(receipt: JsonObject, actor: CrewActor) {
  if (actor.management) return true;
  if (cleanText(asObject(receipt.uploaded_by).user_id) === actor.ctx.userId) return true;
  return asArray(receipt.associations).map(asObject).some((association) => (
    cleanText(association.kind) === "resource_group" && actor.groupIds.has(cleanText(association.id))
  ));
}

function cents(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function dollarsFromCents(value: unknown) {
  return Number((cents(value) / 100).toFixed(4));
}

function moneyValueCents(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = asObject(value);
    if (Number.isFinite(Number(input.amount_cents))) return cents(input.amount_cents);
    if (Number.isFinite(Number(input.cents))) return cents(input.cents);
    return moneyValueCents(input.amount);
  }
  const parsed = typeof value === "string"
    ? Number(value.replace(/[$,\s]/g, ""))
    : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function projectContractTotalCents(project: JsonObject) {
  const financials = asObject(project.financials || project.money || project.contract);
  const pricing = asObject(project.pricing || financials.pricing);
  const centsValues = [
    project.contract_total_cents,
    project.project_total_cents,
    project.total_cents,
    financials.contract_total_cents,
    financials.project_total_cents,
    financials.total_cents,
    pricing.contract_total_cents,
    pricing.total_cents
  ].map(cents);
  const dollarValues = [
    project.contract_total,
    project.project_total,
    financials.contract_total,
    financials.project_total,
    pricing.contract_total,
    pricing.total,
    pricing.totalValue
  ].map(moneyValueCents);
  return Math.max(0, ...centsValues, ...dollarValues);
}

function proposalContractTotalCents(proposal: JsonObject) {
  const editable = asObject(proposal.editable || proposal.content);
  const pricing = asObject(editable.pricing || proposal.pricing);
  const scopeTotal = proposalScopeTotalCents(editable.scope);
  const pages = asArray(editable.pages).map(asObject);
  const signature = pages.find((page) => cleanText(page.kind).toLowerCase() === "signature") || {};
  const centsValues = [
    proposal.total_cents,
    proposal.contract_total_cents,
    pricing.total_cents,
    pricing.contract_total_cents
  ].map(cents);
  const dollarValues = [
    proposal.total,
    proposal.contract_total,
    pricing.total,
    pricing.totalValue,
    pricing.contract_total,
    signature.total,
    signature.totalValue,
    signature.totalAmount,
    signature.contractAmount
  ].map(moneyValueCents);
  return Math.max(0, scopeTotal, ...centsValues, ...dollarValues);
}

function signedProposalContractTotalCents(proposals: JsonObject[]) {
  const signed = proposals.filter((proposal) => {
    const delivery = asObject(proposal.delivery);
    return cleanText(proposal.status).toLowerCase() === "signed"
      || cleanText(delivery.state).toLowerCase() === "signed"
      || !!cleanText(delivery.signed_at || proposal.signed_at || proposal.customer_signed_at);
  });
  const baseTotals = signed.filter((proposal) => !isChangeOrder(proposal)).map(proposalContractTotalCents);
  const changeOrderTotal = signed.filter(isChangeOrder).reduce((sum, proposal) => sum + proposalContractTotalCents(proposal), 0);
  return Math.max(0, ...baseTotals) + changeOrderTotal;
}

async function crewProjectPaymentSummary(orgId: string, projectId: string, project: JsonObject) {
  const [shared, proposals] = await Promise.all([
    projectMoneySummary(orgId, projectId),
    listProjectProposals(orgId, projectId).catch(() => [])
  ]);
  const schedules = asArray(shared.schedules).map(asObject);
  const obligations = asArray(shared.obligations).map(asObject);
  const payments = asArray(shared.payments).map(asObject);
  const obligationTotal = obligations.reduce((sum, item) => sum + cents(item.amount_cents), 0);
  const total = Math.max(
    cents(shared.project_total_cents),
    obligationTotal,
    projectContractTotalCents(project),
    signedProposalContractTotalCents(proposals)
  );
  const paid = cents(shared.total_collected_cents);
  const next = obligations
    .filter((item) => !["paid", "void"].includes(cleanText(item.status).toLowerCase()))
    .sort((left, right) => cleanText(left.due_at).localeCompare(cleanText(right.due_at)))[0] || null;
  return {
    project_id: projectId,
    total_cents: total,
    contract_total_cents: total,
    paid_cents: paid,
    due_cents: Math.max(0, total - paid),
    next_payment: next,
    schedules,
    obligations,
    payments,
    sources: {
      shared_payment_total_cents: cents(shared.project_total_cents),
      project_contract_total_cents: projectContractTotalCents(project),
      signed_proposal_total_cents: signedProposalContractTotalCents(proposals)
    }
  };
}

function crewPaymentMethod(input: JsonObject) {
  const rawMethod = input.method;
  const method = asObject(rawMethod);
  const rawKind = typeof rawMethod === "string" ? rawMethod : method.kind || method.type || input.payment_method;
  const normalizedKind = cleanText(rawKind).toLowerCase();
  const kind = normalizedKind === "cheque" ? "check" : normalizedKind;
  const processorFields = [
    input.processor,
    input.payment_intent_id,
    input.processor_payment_id,
    input.transaction_id,
    method.processor,
    method.payment_intent_id,
    method.card,
    method.ach
  ];
  if (!(["cash", "check"] as string[]).includes(kind) || processorFields.some((value) => (
    value && (typeof value !== "object" || Object.keys(asObject(value)).length > 0)
  ))) {
    throw badRequest(
      "crew_payment_method_unsupported",
      "Crew can record settled cash or check payments only. Card and ACH payments must use the payment intake workflow."
    );
  }
  const requestedDirection = cleanText(input.direction).toLowerCase();
  const requestedStatus = cleanText(input.status).toLowerCase();
  if ((requestedDirection && requestedDirection !== "inbound") || (requestedStatus && requestedStatus !== "settled")) {
    throw badRequest("crew_payment_state_unsupported", "Crew payments must be recorded as settled inbound payments.");
  }
  return {
    kind,
    ...(cleanText(method.reference || input.reference) ? { reference: cleanText(method.reference || input.reference) } : {}),
    ...(kind === "check" && cleanText(method.check_number || input.check_number)
      ? { check_number: cleanText(method.check_number || input.check_number) }
      : {})
  };
}

async function selectedMaterialList(orgId: string, projectId: string, listId: string, actor: CrewActor) {
  if (listId) {
    const list = await readMaterialList(orgId, listId);
    if (cleanText(list.project_id) !== projectId || cleanText(list.resource_type || "material") !== "material") {
      throw badRequest("material_list_project_mismatch", "The selected material list is not available for this project.");
    }
    return list;
  }
  const lists = (await listProjectMaterialLists(orgId, projectId))
    .filter((list) => cleanText(list.resource_type || "material") === "material" && cleanText(list.status) !== "archived");
  if (lists.length) return lists[0] as JsonObject;
  return await createMaterialList(orgId, projectId, {
    title: "Crew Added Materials",
    resource_type: "material",
    status: "planning",
    color: "#f97316",
    metadata: { source: "crew_app" }
  }, actor.ctx);
}

function normalizedManualMaterialItem(inputValue: unknown, actor: CrewActor) {
  const input = asObject(inputValue);
  const name = cleanText(input.name || input.description || input.label);
  if (!name) throw badRequest("material_item_name_required", "A material item name is required.");
  return {
    ...input,
    id: cleanText(input.id) || `crew_item_${randomUUID()}`,
    name,
    quantity: Number.isFinite(Number(input.quantity)) ? Number(input.quantity) : 1,
    unit: cleanText(input.unit || "ea"),
    metadata: {
      ...asObject(input.metadata),
      source: "crew_manual",
      added_by_user_id: actor.ctx.userId,
      added_at: new Date().toISOString()
    }
  };
}

function receiptMaterialItems(receipt: JsonObject, reviewedItemsValue: unknown, actor: CrewActor) {
  const extraction = asObject(receipt.extraction);
  const sourceItems = Array.isArray(reviewedItemsValue) ? reviewedItemsValue : asArray(extraction.line_items);
  const fallback = sourceItems.length ? sourceItems : [{
    id: "receipt_total",
    description: cleanText(receipt.title || extraction.title || "Receipt purchase"),
    quantity: 1,
    unit: "receipt",
    total_cents: cents(receipt.total_cents || extraction.total_cents)
  }];
  return fallback.map((value, index) => {
    const item = asObject(value);
    const sourceLineId = cleanText(item.id || item.source_line_id || `line_${index + 1}`);
    const quantity = Number.isFinite(Number(item.quantity)) && Number(item.quantity) !== 0 ? Number(item.quantity) : 1;
    const totalCents = cents(item.total_cents ?? item.paid_total_cents ?? item.amount_cents);
    const unitCents = cents(item.unit_price_cents ?? item.paid_unit_price_cents) || (quantity ? Math.round(totalCents / quantity) : totalCents);
    const stableId = `receipt_item_${createHash("sha256").update(`${cleanText(receipt.id)}:${sourceLineId}`).digest("hex").slice(0, 24)}`;
    return {
      id: stableId,
      name: cleanText(item.name || item.description || `Receipt item ${index + 1}`),
      description: cleanText(item.description),
      code: cleanText(item.sku || item.code),
      quantity,
      unit: cleanText(item.unit || "ea"),
      paid_unit_price: dollarsFromCents(unitCents),
      paid_total: dollarsFromCents(totalCents),
      currency: cleanText(receipt.currency || extraction.currency || "USD"),
      vendor: { name: cleanText(extraction.vendor_name) },
      metadata: {
        ...asObject(item.metadata),
        source: "crew_receipt",
        receipt_id: cleanText(receipt.id),
        receipt_line_id: sourceLineId,
        receipt_total_cents: cents(receipt.total_cents || extraction.total_cents),
        purchased_date: cleanText(receipt.purchase_date || extraction.purchase_date),
        purchased_time: cleanText(receipt.purchase_time || extraction.purchase_time),
        added_by_user_id: actor.ctx.userId,
        added_at: new Date().toISOString()
      }
    };
  }).filter((item) => item.name);
}

async function projectPayoutView(orgId: string, project: JsonObject, actor: CrewActor) {
  const [expenseSummary, allPayables] = await Promise.all([
    projectExpenseSummary(orgId, cleanText(project.id)),
    listPayables(orgId, { project_id: cleanText(project.id) }).catch(() => [])
  ]);
  const laborTargets = asArray(expenseSummary.targets).map(asObject)
    .filter((target) => cleanText(target.resource_type) === "labor")
    .filter((target) => {
      if (actor.management) return true;
      const details = asObject(target.details);
      const ref = asObject(details.work_resource_ref);
      if (cleanText(ref.kind) === "resource_group" && actor.groupIds.has(cleanText(ref.id))) return true;
      return asArray(details.details).map(asObject).some((detail) => cleanText(detail.user_id) === actor.ctx.userId);
    });
  const payables = allPayables.filter((payable) => {
    if (actor.management) return true;
    const payee = asObject(payable.payee_ref || payable.crew_ref);
    return (cleanText(payee.kind) === "resource_group" && actor.groupIds.has(cleanText(payee.id)))
      || (cleanText(payee.kind) === "organization_user" && cleanText(payee.id) === actor.ctx.userId);
  });
  const projected = laborTargets.reduce((sum, item) => sum + cents(item.projected_cents), 0);
  const payable = payables.reduce((sum, item) => sum + cents(item.amount_cents), 0);
  const paid = payables.reduce((sum, item) => sum + cents(item.paid_cents), 0);
  return {
    project_id: cleanText(project.id),
    project_title: projectTitle(project),
    address: projectAddress(project),
    currency: "USD",
    projected_cents: projected,
    payable_cents: payable,
    paid_cents: paid,
    owed_cents: Math.max(0, payable - paid),
    labor_targets: laborTargets,
    payables
  };
}

function normalizedChangeOrderItem(value: unknown, index: number) {
  const item = asObject(value);
  const quantityValue = Number(item.quantity);
  const quantity = Number.isFinite(quantityValue) && quantityValue > 0 ? quantityValue : 1;
  const hasUnitCents = Object.prototype.hasOwnProperty.call(item, "unit_price_cents")
    || Object.prototype.hasOwnProperty.call(item, "unitPriceCents");
  const hasTotalCents = Object.prototype.hasOwnProperty.call(item, "total_cents")
    || Object.prototype.hasOwnProperty.call(item, "amount_cents")
    || Object.prototype.hasOwnProperty.call(item, "totalPriceCents");
  const unitCents = cents(item.unit_price_cents ?? item.unitPriceCents);
  const totalCents = cents(item.total_cents ?? item.amount_cents ?? item.totalPriceCents);
  const derivedUnitCents = unitCents || (hasTotalCents ? Math.round(totalCents / quantity) : 0);
  const name = cleanText(item.name || item.description || `Change item ${index + 1}`);
  return {
    ...item,
    id: cleanText(item.id) || `change_item_${randomUUID()}`,
    name,
    description: cleanText(item.description || item.name),
    quantity,
    ...(hasUnitCents || derivedUnitCents > 0 ? {
      unit_price: dollarsFromCents(derivedUnitCents),
      base_price: dollarsFromCents(derivedUnitCents)
    } : {}),
    ...(hasTotalCents ? { amount: dollarsFromCents(totalCents) } : {})
  };
}

function changeOrderPricing(inputValue: unknown, scope: JsonObject) {
  const input = asObject(inputValue);
  const scopeTotal = proposalScopeTotalCents(scope);
  const explicitCents = cents(input.total_cents ?? input.contract_total_cents ?? input.subtotal_cents);
  const explicitDollars = moneyValueCents(input.total ?? input.totalValue ?? input.contract_total ?? input.subtotal);
  const total = scopeTotal || explicitCents || explicitDollars;
  return {
    ...input,
    subtotal: dollarsFromCents(total),
    total: dollarsFromCents(total),
    subtotal_cents: total,
    total_cents: total,
    currency: cleanText(input.currency || "USD") || "USD"
  };
}

function deliveryRecipients(value: unknown) {
  const seen = new Set<string>();
  return asArray(value).map(asObject).filter((recipient) => {
    const address = cleanText(recipient.email || recipient.phone || recipient.address).toLowerCase();
    if (!address || seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

function proposalPortalResult(snapshot: JsonObject, delivered: boolean, recipients: JsonObject[]) {
  const publicToken = cleanText(asObject(snapshot.delivery).public_token);
  return {
    delivered,
    delivery_state: delivered ? "sent" : "link_ready",
    recipients,
    public_token: publicToken,
    app_url: publicToken ? `/v1/proposals/public/${encodeURIComponent(publicToken)}/app` : "",
    workflow_url: publicToken ? `/v1/proposals/public/${encodeURIComponent(publicToken)}` : ""
  };
}

function isChangeOrder(proposal: JsonObject) {
  const editable = asObject(proposal.editable);
  const changeOrder = asObject(editable.change_order);
  return cleanText(editable.document_kind || editable.proposal_type || changeOrder.document_kind).toLowerCase() === "change_order";
}

function publicChangeOrder(proposal: JsonObject) {
  const editable = asObject(proposal.editable);
  return {
    ...proposal,
    proposal_type: "change_order",
    document_kind: "change_order",
    change_order: asObject(editable.change_order)
  };
}

function fieldLaunchDescriptor(templateValue: JsonObject) {
  const template = asObject(templateValue);
  const definition = asObject(template.definition);
  const launch = asObject(asObject(definition.metadata).field_launch);
  if (launch.enabled !== true || template.enabled === false || cleanText(template.status) === "archived") return null;
  return {
    id: cleanText(template.id),
    title: cleanText(launch.title || template.name || definition.name) || "Additional work",
    description: cleanText(launch.description || template.description || definition.description),
    category: cleanText(launch.category || "Other work") || "Other work",
    icon: cleanText(launch.icon || template.icon || definition.icon || "fa-list-check"),
    keywords: asArray(launch.keywords).map(cleanText).filter(Boolean),
    frequent: launch.frequent === true,
    color: cleanText(template.color || definition.color || "#1769aa")
  };
}

function workflowTriggerLabel(nodeValue: JsonObject) {
  const node = asObject(nodeValue);
  if (cleanText(node.due_at)) return `Due ${cleanText(node.due_at)}`;
  const trigger = asObject(asArray(node.external_triggers)[0]);
  if (cleanText(trigger.explainer)) return cleanText(trigger.explainer);
  if (cleanText(trigger.event)) return `Starts when ${cleanText(trigger.event).replaceAll("_", " ").replaceAll(".", " ")}`;
  const status = cleanText(node.status);
  if (["pending", "blocked"].includes(status)) return "Available when the preceding project work is complete";
  if (["ready", "active"].includes(status)) return "Ready now";
  return "Project workflow";
}

async function fieldWorkflowTimeline(orgId: string, projectId: string) {
  const capabilityState = await documentCapabilityState(orgId);
  const documents: JsonObject[] = (await listProjectDocuments(orgId, projectId)).map((document): JsonObject => ({
    ...document,
    output_defs: filterOutputDefinitionsByCapabilities(asObject(document.output_defs), capabilityState)
  }));
  const documentNodeIds = new Set(documents.map((document) => cleanText(asObject(asObject(document.metadata).source).work_node_id)).filter(Boolean));
  const plans = (await listPlanRecords(orgId, { project_id: projectId }));
  const planById = new Map(plans.map((plan) => [cleanText(plan.id), plan]));
  const documentItems = documents.map((document) => {
    const requirement = documentSignatureRequirement(document);
    const outputDefs = asObject(document.output_defs);
    const outputs = asObject(document.outputs);
    const paymentKeys = Object.entries(outputDefs)
      .filter(([, value]) => {
        const definition = asObject(value);
        return cleanText(definition.type) === "payment" && (definition.required === true || !!cleanText(definition.required_for));
      })
      .map(([key]) => key);
    const pendingPaymentKeys = paymentKeys.filter((key) => {
      const value = outputs[key];
      return value === undefined || value === null || value === "" || (typeof value === "object" && !Array.isArray(value) && !Object.keys(asObject(value)).length);
    });
    const source = asObject(asObject(document.metadata).source);
    const plan = planById.get(cleanText(source.work_plan_id));
    const requirements = documentRequirementsStatus(document);
    const docStatus = cleanText(document.status);
    const cancellation = asObject(document.cancellation);
    // Signed-but-unpaid stays "ready" (there is still work outstanding) —
    // only a document with zero pending requirements collapses to completed.
    const status = docStatus === "void" ? "canceled"
      : docStatus === "declined" ? "declined"
        : docStatus === "expired" ? "canceled"
          : ["signed", "completed"].includes(docStatus) && Number(requirements.pending_count || 0) > 0 ? "ready"
            : ["signed", "completed"].includes(docStatus) || (requirement.required === true && Number(requirements.pending_count || 0) === 0)
              ? "completed"
              : docStatus === "draft" ? "preparing" : "ready";
    const trigger = status === "canceled"
      ? `Canceled${cleanText(cancellation.reason) ? ` — ${cleanText(cancellation.reason)}` : ""}`
      : status === "declined" ? "Declined by the customer"
        : status === "completed" ? `Completed ${cleanText(document.completed_at || document.updated_at)}`
          : "Ready now";
    return {
      id: `document:${cleanText(document.id)}`,
      kind: "document",
      document_id: cleanText(document.id),
      title: cleanText(document.title || "Customer workflow"),
      description: cleanText(document.document_type).replaceAll("_", " "),
      scope: cleanText(asObject(plan).title),
      scope_template_id: cleanText(asObject(plan).template_id),
      status,
      document_status: docStatus,
      trigger,
      signature_requirement: requirement,
      payment_requirement: {
        required: paymentKeys.length > 0,
        required_count: paymentKeys.length,
        pending_count: pendingPaymentKeys.length,
        required_keys: paymentKeys,
        pending_keys: pendingPaymentKeys
      },
      requirements_status: requirements,
      cancellation: Object.keys(cancellation).length ? cancellation : undefined,
      sent: !!cleanText(asObject(document.delivery).sent_at),
      has_workflow: !!cleanText(asObject(document.workflow_ref).workflow_id),
      created_at: cleanText(document.created_at)
    };
  });
  const futureItems = (await listNodeRecords(orgId, { project_id: projectId }))
    .filter((node) => {
      if (documentNodeIds.has(cleanText(node.id))) return false;
      const action = asObject(asObject(node.metadata).frontend_action);
      const bindings = JSON.stringify(asObject(node.automation_bindings));
      return cleanText(action.tab) === "signatures" || bindings.includes("documents.issue.v1") || bindings.includes("documents.requestCompletionSignoff.v1");
    })
    .map((node) => {
      const plan = planById.get(cleanText(node.plan_id));
      const nodeStatus = cleanText(node.status);
      return {
        id: `node:${cleanText(node.id)}`,
        kind: "obligation",
        node_id: cleanText(node.id),
        title: cleanText(node.title || "Customer workflow"),
        description: cleanText(node.description),
        scope: cleanText(asObject(plan).title),
        scope_template_id: cleanText(asObject(plan).template_id),
        status: ["completed", "skipped", "canceled"].includes(nodeStatus) ? nodeStatus : ["ready", "active"].includes(nodeStatus) ? "ready" : "upcoming",
        trigger: workflowTriggerLabel(node),
        created_at: cleanText(node.created_at)
      };
    });
  const order = { ready: 0, preparing: 1, upcoming: 2, completed: 3, skipped: 4, declined: 5, canceled: 6 } as Record<string, number>;
  return [...documentItems, ...futureItems].sort((a, b) => (order[cleanText(a.status)] ?? 9) - (order[cleanText(b.status)] ?? 9)
    || cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

function visitWorkflowFromTemplate(templateValue: JsonObject, eventValue: JsonObject): JsonObject | null {
  const template = asObject(templateValue);
  const definition = asObject(template.definition);
  const workflow = asObject(asObject(definition.metadata).visit_workflow || asObject(asObject(definition.work_plan).metadata).visit_workflow);
  if (workflow.enabled === false || !asArray(workflow.steps).length) return null;
  const event = asObject(eventValue);
  const eventType = cleanText(event.event_type_default_id || event.type_id || event.kind);
  const eventTypes = asArray(workflow.event_types).map(cleanText).filter(Boolean);
  if (eventTypes.length && !eventTypes.includes(eventType)) return null;
  return {
    ...workflow,
    id: cleanText(workflow.id || `${cleanText(template.id)}_visit`),
    title: cleanText(workflow.title || template.name || definition.name || "Visit"),
    scope_template_id: cleanText(template.id),
    scope_title: cleanText(template.name || definition.name)
  };
}

async function resolveVisitWorkflow(orgId: string, branchId: string, projectId: string, event: JsonObject): Promise<JsonObject | null> {
  const candidateIds = [
    cleanText(event.scope_template_id || event.scope_id),
    ...(await listPlanRecords(orgId, { project_id: projectId })).map((plan) => cleanText(plan.template_id)).reverse()
  ].filter(Boolean);
  for (const templateId of [...new Set(candidateIds)]) {
    try {
      const template = (await readScopeTemplate(orgId, branchId, templateId));
      const workflow = visitWorkflowFromTemplate(template, event);
      if (workflow) return workflow;
    } catch { /* a deleted historical template cannot configure a visit */ }
  }
  const eventType = cleanText(event.event_type_default_id || event.type_id || event.kind).toLowerCase();
  const salesVisit = ["sales", "estimate", "consultation"].some((token) => eventType.includes(token));
  const commonSteps: JsonObject[] = [
    {
      id: "en_route",
      title: "On my way",
      navigation_title: "En route",
      kind: "status",
      description: "Let the customer know you are headed to the appointment.",
      action: {
        label: "I'm on my way",
        transition: "en_route",
        notify: { channel: "sms", message: "Hi {{customer.name}}, {{technician.name}} is on the way to your appointment at {{project.address}}." }
      }
    },
    {
      id: "arrived",
      title: "Arrive",
      navigation_title: "Arrived",
      kind: "status",
      description: "Confirm that you have arrived and are ready to begin.",
      action: { label: "I've arrived", transition: "arrived" }
    }
  ];
  const steps = salesVisit
    ? [
        ...commonSteps,
        {
          id: "proposal",
          title: "Prepare the customer workflow",
          navigation_title: "Proposal",
          kind: "workflow",
          description: "Build or open the proposal, selections, payment, and authorization for this visit.",
          target_tab: "crew_signatures"
        },
        {
          id: "outcome",
          title: "Record the visit outcome",
          navigation_title: "Outcome",
          kind: "outcome",
          description: "Choose what needs to happen after this appointment.",
          actions: [
            { id: "sold", label: "Sold — work authorized", transition: "sold", icon: "fa-circle-check", tone: "success" },
            { id: "follow_up", label: "Follow-up needed", transition: "follow_up", icon: "fa-phone", tone: "warning" },
            { id: "no_sale", label: "No sale", transition: "no_sale", icon: "fa-circle-xmark", tone: "neutral" }
          ]
        },
        {
          id: "follow_up",
          title: "Customer follow-up",
          navigation_title: "Follow-up",
          kind: "follow_up",
          description: "This follow-up stays here until it is completed from your assigned to-do list.",
          when: { step_id: "outcome", action_ids: ["follow_up"] }
        },
        {
          id: "finish",
          title: "Finish the visit",
          navigation_title: "Done",
          kind: "complete",
          description: "Close the appointment after its customer workflow and next steps are recorded.",
          action: { label: "Complete visit", transition: "completed" }
        }
      ]
    : [
        ...commonSteps,
        {
          id: "work",
          title: "Complete the on-site work",
          navigation_title: "Work",
          kind: "status",
          description: "Complete the work planned for this visit.",
          action: { label: "Work complete", transition: "work_completed" }
        },
        { id: "payment", title: "Collect payment", navigation_title: "Payment", kind: "payment", description: "Collect any balance due for this visit.", target_tab: "crew_payments", requires: "payment_due" },
        { id: "signoff", title: "Customer sign-off", navigation_title: "Sign", kind: "workflow", description: "Complete any required customer signature or closeout workflow.", target_tab: "crew_signatures", requires: "workflows" },
        { id: "finish", title: "Finish the visit", navigation_title: "Done", kind: "complete", description: "Close the visit after all required work is finished.", action: { label: "Complete visit", transition: "completed" } }
      ];
  return {
    id: salesVisit ? "default_sales_visit" : "default_field_visit",
    title: salesVisit ? "Sales Visit" : "Project Visit",
    generated_default: true,
    event_types: eventType ? [eventType] : [],
    steps
  };
}

function visitEventState(eventValue: JsonObject) {
  return asObject(asObject(eventValue).visit_state || asObject(asObject(eventValue).metadata).visit_state);
}

function visitRelevantWorkflows(stepValue: JsonObject, integrations: JsonObject) {
  const step = asObject(stepValue);
  const workflows = asArray(integrations.workflows).map(asObject);
  const scopeId = cleanText(step.scope_template_id);
  return scopeId ? workflows.filter((item) => cleanText(item.scope_template_id) === scopeId) : workflows;
}

function visitWorkflowFacts(stepValue: JsonObject, integrations: JsonObject) {
  const workflows = visitRelevantWorkflows(stepValue, integrations);
  const signatures = workflows.map((item) => asObject(item.signature_requirement));
  const payments = workflows.map((item) => asObject(item.payment_requirement));
  const signatureRequired = signatures.some((item) => item.required === true);
  const paymentRequired = payments.some((item) => item.required === true);
  return {
    workflows,
    signed: workflows.length > 0 && (!signatureRequired || signatures.every((item) => item.required !== true || Number(item.pending_count || 0) === 0)),
    paid: workflows.length > 0 && (!paymentRequired || payments.every((item) => item.required !== true || Number(item.pending_count || 0) === 0)),
    signature_required: signatureRequired,
    payment_required: paymentRequired
  };
}

function visitStepCompleted(stepValue: JsonObject, state: JsonObject, integrations: JsonObject) {
  const step = asObject(stepValue);
  const id = cleanText(step.id);
  if (asArray(state.completed_step_ids).map(cleanText).includes(id)) return true;
  const kind = cleanText(step.kind);
  if (kind === "checklist") {
    const items = asArray(integrations.checklist_items).map(asObject);
    return items.length > 0 && items.every((item) => item.completed === true);
  }
  if (kind === "payment") {
    const payment = asObject(integrations.payment_summary);
    return Number(payment.total_cents || 0) > 0 && Number(payment.due_cents || 0) <= 0;
  }
  if (kind === "workflow_prepare") return visitRelevantWorkflows(step, integrations).length > 0;
  if (["document", "workflow", "signature"].includes(kind)) {
    if (id === "proposal") {
      const outcome = cleanText(asObject(asObject(state.step_results).outcome).action_id);
      if (["follow_up", "no_sale"].includes(outcome)) return true;
    }
    const relevant = visitRelevantWorkflows(step, integrations);
    return relevant.length > 0 && relevant.every((item) => ["completed", "skipped", "canceled"].includes(cleanText(item.status)));
  }
  if (kind === "summary") {
    return false;
  }
  if (kind === "follow_up") {
    const outcome = asObject(asObject(state.step_results).outcome);
    const nodeId = cleanText(outcome.follow_up_node_id);
    const followUps = asArray(integrations.follow_ups).map(asObject);
    const node = followUps.find((item) => cleanText(item.id) === nodeId);
    return !!node && ["completed", "canceled", "skipped"].includes(cleanText(node.status));
  }
  return false;
}

function visitStepVisible(stepValue: JsonObject, state: JsonObject, integrations: JsonObject) {
  const step = asObject(stepValue);
  const when = asObject(step.when);
  if (cleanText(when.step_id)) {
    const result = asObject(asObject(state.step_results)[cleanText(when.step_id)]);
    const allowed = asArray(when.action_ids).map(cleanText).filter(Boolean);
    if (allowed.length && !allowed.includes(cleanText(result.action_id))) return false;
  }
  const requirement = cleanText(step.requires);
  if (requirement === "payment_due" && Number(asObject(integrations.payment_summary).due_cents || 0) <= 0) return false;
  if (requirement === "workflows" && !asArray(integrations.workflows).length) return false;
  const facts = visitWorkflowFacts(step, integrations);
  if (requirement === "workflow_signed" && !facts.signed) return false;
  if (requirement === "workflow_unsigned" && facts.signed) return false;
  if (requirement === "workflow_payment_due" && (!facts.signed || facts.paid || !facts.payment_required)) return false;
  if (requirement === "workflow_complete" && (!facts.signed || !facts.paid)) return false;
  return true;
}

async function crewVisitView(orgId: string, projectId: string, assigned: Awaited<ReturnType<typeof assignedProject>>, eventId = "") {
  const project = asObject(assigned.project);
  const event = asObject(assigned.events.find((entry) => cleanText(asObject(entry).id) === eventId)
    || bestEventForDate(assigned.events, todayDate(), true)
    || assigned.events[0]);
  if (!cleanText(event.id)) return { configured: false, project: (await publicProjectDetail(orgId, project, assigned.events)).project };
  const branchId = cleanText(project.branch_id || "default") || "default";
  const workflow = (await resolveVisitWorkflow(orgId, branchId, projectId, event));
  if (!workflow) return { configured: false, event, project: (await publicProjectDetail(orgId, project, assigned.events)).project };
  const [paymentSummary, workflows] = await Promise.all([
    crewProjectPaymentSummary(orgId, projectId, project),
    fieldWorkflowTimeline(orgId, projectId)
  ]);
  const checklistItems = (await listCrewChecklistItems(orgId, projectId));
  const followUps = (await listNodeRecords(orgId, { project_id: projectId }))
    .filter((node) => cleanText(asObject(node.metadata).kind) === "follow_up")
    .map((node) => ({ id:cleanText(node.id), title:cleanText(node.title || "Customer follow-up"), status:cleanText(node.status), due_at:cleanText(node.due_at) }));
  const contact = projectPrimaryContact(project);
  const routing = asObject(event.routing);
  const configuredEta = Number(routing.travel_from_previous_minutes || routing.travel_minutes || event.travel_minutes || 0);
  const integrations = {
    payment_summary: paymentSummary,
    workflows,
    checklist_items: checklistItems,
    follow_ups: followUps,
    visit_context: {
      customer_name: contact.name,
      customer_phone: contact.phone,
      technician_name: cleanText(event.assigned_user_name),
      destination: { lat: Number(project.lat || 0) || null, lng: Number(project.lng || 0) || null },
      estimated_eta_minutes: configuredEta > 0 ? Math.round(configuredEta) : 20
    }
  };
  const state = visitEventState(event);
  const configuredSteps = asArray(workflow.steps).map(asObject);
  const addedWorkSteps = (await listPlanRecords(orgId, { project_id: projectId }))
    .filter((plan) => cleanText(plan.source_type) === "field_added_work")
    .map((plan) => ({
      id: `added_work_${cleanText(plan.id)}`,
      title: cleanText(plan.title || "Additional work"),
      navigation_title: "Added work",
      kind: "workflow",
      description: "Complete the customer-facing workflow added during this visit.",
      scope_template_id: cleanText(plan.template_id),
      target_tab: "crew_signatures",
      added_in_field: true
    }));
  const completionIndex = configuredSteps.findIndex((step) => cleanText(step.kind) === "complete");
  const rawSteps = completionIndex >= 0
    ? [...configuredSteps.slice(0, completionIndex), ...addedWorkSteps, ...configuredSteps.slice(completionIndex)]
    : [...configuredSteps, ...addedWorkSteps];
  const visibleSteps = rawSteps.filter((step) => visitStepVisible(step, state, integrations));
  const steps = visibleSteps.map((step, index) => ({
    ...step,
    id: cleanText(step.id || `step_${index + 1}`),
    title: cleanText(step.title || `Step ${index + 1}`),
    completed: visitStepCompleted(step, state, integrations)
  }));
  const firstIncompleteIndex = Math.max(0, steps.findIndex((step) => step.completed !== true));
  const storedIndex = steps.findIndex((step) => cleanText(step.id) === cleanText(state.current_step_id) && step.completed !== true);
  const currentIndex = storedIndex >= 0 ? storedIndex : firstIncompleteIndex;
  return {
    configured: true,
    project: (await publicProjectDetail(orgId, project, assigned.events)).project,
    event,
    workflow: { ...workflow, steps },
    state: { ...state, current_step_id: cleanText(steps[currentIndex]?.id) },
    integrations
  };
}

function visitMessage(template: unknown, project: JsonObject, actor: CrewActor, values: JsonObject = {}) {
  const contact = projectPrimaryContact(project);
  return cleanText(template || "We are on our way to your appointment.")
    .replaceAll("{{customer.name}}", contact.name || "there")
    .replaceAll("{{customer.phone}}", contact.phone || "")
    .replaceAll("{{project.address}}", projectAddress(project))
    .replaceAll("{{technician.name}}", cleanText(actor.ctx.user?.name || actor.ctx.userId))
    .replaceAll("{{arrival.eta}}", cleanText(values.arrival_eta || "about 20 minutes"));
}

export const registerCrewApi: FastifyPluginAsync = async (app) => {
  app.get("/organizations/:orgId/crew/me/dashboard", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.dashboard.view");
    const targetDate = validDate(requestQuery(request).date, todayDate());
    const entries = await allAssignedProjects(orgId, actor);
    const tiles = (await Promise.all(entries.map(async ({ project, events }) => {
      const event = bestEventForDate(events, targetDate);
      if (!event || projectCompleted(project) && eventDateRange(event).end < targetDate) return null;
      const tile: JsonObject = { ...(await projectTile(orgId, project, event, targetDate)) };
      // Equipment riding along on today's event ("my equipment today").
      const equipmentRefs = asArray(event.resource_refs).map(asObject)
        .filter((ref) => cleanText(ref.kind) === "equipment_unit" && cleanText(ref.id))
        .map((ref) => ({ id: cleanText(ref.id), name: cleanText(ref.name) || cleanText(ref.id) }));
      if (equipmentRefs.length) tile.equipment = equipmentRefs;
      return tile.overdue === true || (cleanText(asObject(tile.schedule).start_date) <= targetDate && cleanText(asObject(tile.schedule).end_date) >= targetDate)
        ? tile
        : null;
    }))).filter((tile) => tile !== null) as JsonObject[];
    tiles.sort(tileSort);
    const clock = (await readCrewTimeClock(orgId, actor.ctx.userId));
    return {
      ok: true,
      date: targetDate,
      projects: tiles,
      today: tiles.filter((tile) => tile.overdue !== true),
      overdue: tiles.filter((tile) => tile.overdue === true),
      count: tiles.length,
      time_clock: clock
    };
  });

  app.get("/organizations/:orgId/crew/me/projects", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.projects.view|crew.schedule.view");
    const query = requestQuery(request);
    const search = cleanText(query.search || query.q).toLowerCase();
    const from = validDate(query.start || query.from || query.date_from);
    const to = validDate(query.end || query.to || query.date_to);
    const targetDate = validDate(query.date, todayDate());
    const entries = await allAssignedProjects(orgId, actor);
    const projects = (await Promise.all(entries.map(async ({ project, events }) => {
      const rangeEvents = events.filter((event) => {
        const range = eventDateRange(event);
        if (from && range.end < from) return false;
        if (to && range.start > to) return false;
        return true;
      });
      if (!rangeEvents.length) return null;
      const haystack = [projectTitle(project), projectAddress(project), projectPrimaryContact(project).name, projectNotes(project)].join(" ").toLowerCase();
      if (search && !haystack.includes(search)) return null;
      return (await publicProjectDetail(orgId, project, rangeEvents, targetDate));
    }))).filter((entry) => entry !== null) as JsonObject[];
    projects.sort((left, right) => cleanText(asObject(left.schedule).start_date).localeCompare(cleanText(asObject(right.schedule).start_date)));
    return { ok: true, projects, count: projects.length, range: { from, to }, search };
  });

  app.get("/organizations/:orgId/crew/me/payouts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.payouts.view");
    const entries = await allAssignedProjects(orgId, actor);
    const payouts = await Promise.all(entries.map(({ project }) => projectPayoutView(orgId, project, actor)));
    return {
      ok: true,
      payouts,
      count: payouts.length,
      totals: {
        projected_cents: payouts.reduce((sum, item) => sum + cents(item.projected_cents), 0),
        payable_cents: payouts.reduce((sum, item) => sum + cents(item.payable_cents), 0),
        paid_cents: payouts.reduce((sum, item) => sum + cents(item.paid_cents), 0),
        owed_cents: payouts.reduce((sum, item) => sum + cents(item.owed_cents), 0)
      }
    };
  });

  app.get("/organizations/:orgId/crew/me/todos", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.dashboard.view|crew.projects.view|crew.schedule.view");
    const todos = (await listWorkTodos(orgId, {
      user_id: actor.ctx.userId,
      role_ids: actorRoleTokens(actor),
      resource_group_ids: [...actor.groupIds],
      include_unassigned: false,
      include_completed: cleanText(asObject(request.query).include_completed) === "1"
    }));
    const accessible = await todosOnAccessibleProjects(orgId, todos as JsonObject[], actor);
    const enriched = await enrichTodosWithProjects(orgId, accessible);
    return { ok: true, todos: enriched, count: enriched.length };
  });

  app.post("/organizations/:orgId/crew/me/todos/:nodeId/complete", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.dashboard.view|crew.projects.view|crew.schedule.view", true);
    const node = (await readNodeRecord(orgId, getParam(request.params, "nodeId")));
    if (!node || node.show_in_todo_list !== true || !todoVisibleToActor(node, actor)) {
      throw notFound("todo_not_found", "This to-do was not found or is not assigned to this user.");
    }
    const projectId = cleanText(node.project_id);
    if (projectId) await assignedProject(orgId, projectId, actor);
    const body = requestBody(request);
    const reopen = body.completed === false;
    const updated = await transitionWorkNode(orgId, cleanText(node.id), reopen ? "ready" : "completed", {
      reason: "crew_app",
      allow_reopen: reopen,
      actor_user_id: actor.ctx.userId
    });
    return { ok: true, todo: updated };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/todos", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.projects.view");
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const todos = (await listWorkTodos(orgId, {
      project_id: projectId,
      user_id: actor.ctx.userId,
      role_ids: actorRoleTokens(actor),
      resource_group_ids: [...actor.groupIds],
      include_unassigned: actor.management,
      include_completed: true
    })).filter((todo) => ["ready", "active", "completed"].includes(cleanText((todo as JsonObject).status)));
    return { ok: true, todos, count: todos.length };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/todos/:nodeId/complete", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.projects.view", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const node = (await readNodeRecord(orgId, getParam(request.params, "nodeId")));
    if (!node || cleanText(node.project_id) !== projectId || node.show_in_todo_list !== true) {
      throw notFound("todo_not_found", "To-do item was not found on this project.");
    }
    if (!todoVisibleToActor(node, actor)) {
      throw forbidden("todo_forbidden", "This to-do is not assigned to this user or their role.");
    }
    const body = requestBody(request);
    const reopen = body.completed === false;
    const updated = await transitionWorkNode(orgId, cleanText(node.id), reopen ? "ready" : "completed", {
      reason: "crew_app",
      allow_reopen: reopen,
      actor_user_id: actor.ctx.userId
    });
    return { ok: true, todo: updated };
  });

  app.get("/organizations/:orgId/crew/me/time-clock", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.time_clock.use");
    return {
      ok: true,
      applicable: (await hasHourlyCompensation(orgId, actor.ctx.userId)),
      time_clock: (await readCrewTimeClock(orgId, actor.ctx.userId))
    };
  });

  app.post("/organizations/:orgId/crew/me/time-clock/actions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.time_clock.use", true);
    // The clock is compensation-derived: salaried or pure piece-rate workers
    // have no hourly component and therefore nothing to clock against.
    if (!(await hasHourlyCompensation(orgId, actor.ctx.userId))) {
      throw forbidden("time_clock_not_applicable", "The time clock is only available for workers with hourly compensation.");
    }
    const body = requestBody(request);
    const result = (await performCrewTimeClockAction(orgId, actor.ctx.userId, body.action, clockActionMetadata(request, body.metadata)));
    await emitTimeClockWorkEvent(orgId, actor.ctx.userId, cleanText(result.action), result);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.projects.view");
    const result = await assignedProject(orgId, getParam(request.params, "projectId"), actor);
    return { ok: true, ...(await publicProjectDetail(orgId, result.project, result.events)) };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/visit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.projects.view");
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    return { ok: true, ...await crewVisitView(orgId, projectId, assigned, cleanText(requestQuery(request).event_id)) };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/visit/steps/:stepId/actions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.projects.view", true);
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    const body = requestBody(request);
    const eventId = cleanText(body.event_id);
    const currentView = await crewVisitView(orgId, projectId, assigned, eventId);
    if (currentView.configured !== true) throw notFound("visit_workflow_not_found", "This appointment does not have a visit workflow.");
    const workflow = asObject(currentView.workflow);
    const steps = asArray(workflow.steps).map(asObject);
    const stepId = getParam(request.params, "stepId");
    const stepIndex = steps.findIndex((step) => cleanText(step.id) === stepId);
    if (stepIndex < 0) throw notFound("visit_step_not_found", "Visit step was not found.");
    const step = steps[stepIndex]!;
    const actionId = cleanText(body.action_id || body.actionId);
    const availableActions = asArray(step.actions).map(asObject);
    const selectedAction = availableActions.find((entry) => cleanText(entry.id) === actionId);
    if (availableActions.length && !selectedAction) throw badRequest("visit_action_required", "Choose one of the available visit outcomes.");
    const action = availableActions.length ? asObject(selectedAction) : asObject(step.action);
    const event = asObject(currentView.event);
    const rawDocument = assigned.document;
    const projectDataValue = asObject(rawDocument.data);
    const events = asArray(projectDataValue.events).map(asObject);
    const eventIndex = events.findIndex((entry) => cleanText(entry.id) === cleanText(event.id));
    if (eventIndex < 0) throw notFound("visit_event_not_found", "The scheduled visit was not found on this project.");
    const now = new Date().toISOString();
    const previousState = visitEventState(events[eventIndex]!);
    const previousResult = asObject(asObject(previousState.step_results)[stepId]);
    const completedIds = new Set(asArray(previousState.completed_step_ids).map(cleanText).filter(Boolean));
    const transition = cleanText(action.transition || body.transition || step.transition);
    const requestedActionId = cleanText(action.id || actionId);
    const visitNotes = cleanText(body.notes);
    if (cleanText(step.kind) === "notes_followup" && !visitNotes) {
      throw badRequest("visit_notes_required", "Add appointment notes before continuing.");
    }
    if (completedIds.has(stepId) && (!requestedActionId || cleanText(previousResult.action_id) === requestedActionId)) {
      return {
        ok: true,
        idempotent: true,
        notification: { ...asObject(previousResult.notification), already_processed: true },
        ...currentView
      };
    }

    let notification: JsonObject = { requested: false };
    const notify = asObject(action.notify);
    const skipNotification = body.skip_notification === true || body.skipNotification === true;
    const etaMinutes = Math.max(5, Math.min(240, Math.round(Number(body.eta_minutes || body.etaMinutes || asObject(asObject(currentView.integrations).visit_context).estimated_eta_minutes || 20))));
    if (cleanText(notify.channel) === "sms" && !skipNotification) {
      const text = visitMessage(notify.message, asObject(assigned.project), actor, { arrival_eta:`about ${etaMinutes} minutes` });
      try {
        const sent = await sendProjectSms(orgId, cleanText(projectDataValue.branch_id || "default") || "default", projectId, {
          text,
          source: { type: "user", id: actor.ctx.userId },
          idempotency_key: `visit:${cleanText(event.id)}:${stepId}:sms`
        }, actor.ctx);
        notification = {
          requested: true,
          sent: true,
          sent_at: now,
          eta_minutes: etaMinutes,
          recipient: projectPrimaryContact(asObject(assigned.project)).phone,
          text,
          message_id: cleanText(asObject(sent).id || asObject(asObject(sent).message).id)
        };
      } catch (error) {
        throw badRequest("visit_notification_failed", cleanText((error as Error)?.message || "The customer notification could not be sent."));
      }
    } else if (cleanText(notify.channel) === "sms" && skipNotification) {
      notification = { requested: false, skipped: true, skipped_at: now, eta_minutes: etaMinutes };
    }

    completedIds.add(stepId);
    const nextStep = steps.slice(stepIndex + 1).find((candidate) => !completedIds.has(cleanText(candidate.id)));
    let followUpNodeId = cleanText(previousResult.follow_up_node_id || asObject(asObject(previousState.step_results).outcome).follow_up_node_id);
    const shouldCreateFollowUp = transition === "follow_up" || requestedActionId === "follow_up" || body.create_follow_up === true || body.createFollowUp === true;
    if (shouldCreateFollowUp) {
      const contact = projectPrimaryContact(asObject(assigned.project));
      const created = await createFollowUpTodo(orgId, {
        branch_id: cleanText(projectDataValue.branch_id || "default") || "default",
        project_id: projectId,
        source_key: `visit_follow_up:${cleanText(event.id)}:${stepId}`,
        title: contact.name ? `Follow up with ${contact.name}` : "Customer follow-up",
        body: cleanText(body.follow_up_notes || body.notes) || `Follow up after ${cleanText(asObject(currentView.workflow).title || "the customer visit")}.`,
        due_at: cleanText(body.follow_up_due_at || body.followUpDueAt),
        assigned_user_ids: [actor.ctx.userId],
        origin: "visit_outcome",
        metadata: { visit_event_id:cleanText(event.id), visit_step_id:stepId }
      });
      followUpNodeId = cleanText(asObject(created.node).id);
    }
    let deliveredDocumentId = "";
    const effect = asObject(action.effect);
    if (cleanText(effect.kind) === "send_workflow_to_portal") {
      const scopeId = cleanText(effect.scope_template_id || step.scope_template_id);
      const workflowItem = asArray(asObject(currentView.integrations).workflows).map(asObject)
        .find((item) => cleanText(item.document_id) && (!scopeId || cleanText(item.scope_template_id) === scopeId));
      if (!workflowItem) throw badRequest("visit_workflow_not_ready", "Prepare the customer workflow before sending it to the portal.");
      deliveredDocumentId = cleanText(workflowItem.document_id);
      await sendDocument(orgId, deliveredDocumentId, { include_pdf: false, include_portal: true }, actor.ctx);
    }
    const priorNotes = cleanText(projectDataValue.notes);
    const updatedProjectData = visitNotes && !priorNotes.includes(visitNotes)
      ? { ...projectDataValue, notes: [priorNotes, visitNotes].filter(Boolean).join("\n") }
      : projectDataValue;
    const stepResults = {
      ...asObject(previousState.step_results),
      [stepId]: {
        ...previousResult,
        action_id: requestedActionId,
        transition,
        completed_at: now,
        ...(visitNotes ? { notes:visitNotes } : {}),
        ...(cleanText(body.follow_up_due_at || body.followUpDueAt) ? { follow_up_due_at:cleanText(body.follow_up_due_at || body.followUpDueAt) } : {}),
        ...(Object.keys(notification).length ? { notification } : {}),
        ...(deliveredDocumentId ? { delivered_document_id:deliveredDocumentId } : {}),
        ...(followUpNodeId ? { follow_up_node_id:followUpNodeId } : {})
      }
    };
    const nextState = {
      ...previousState,
      status: transition || cleanText(previousState.status || "in_progress"),
      completed_step_ids: [...completedIds],
      current_step_id: transition === "follow_up" ? "" : cleanText(nextStep?.id || step.id),
      step_results: stepResults,
      started_at: cleanText(previousState.started_at) || now,
      ...(transition === "en_route" ? { en_route_at: now } : {}),
      ...(transition === "arrived" ? { arrived_at: now } : {}),
      ...(transition === "completed" ? { completed_at: now } : {}),
      updated_at: now,
      updated_by_user_id: actor.ctx.userId
    };
    events[eventIndex] = { ...events[eventIndex], visit_state: nextState, status: transition === "completed" ? "completed" : events[eventIndex]!.status };
    await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { ...updatedProjectData, events, updated_at: now },
      metadata: rawDocument.metadata
    }, { replace: true });
    if (["arrived", "completed"].includes(transition)) {
      const type = transition === "completed" ? "project.event.completed" : "project.event.started";
      await emitWorkEvent({
        organization_id: orgId,
        branch_id: cleanText(projectDataValue.branch_id || "default") || "default",
        project_id: projectId,
        type,
        idempotency_key: `${type}:${cleanText(event.id)}:${stepId}`,
        payload: { event_id: cleanText(event.id), event_type_default_id: cleanText(event.event_type_default_id), visit_step_id: stepId },
        context: { actor_user_id: actor.ctx.userId }
      });
    }
    const refreshed = await assignedProject(orgId, projectId, actor);
    return { ok: true, notification, ...await crewVisitView(orgId, projectId, refreshed, cleanText(event.id)) };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/workflows", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present");
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    const branchId = cleanText(asObject(assigned.project).branch_id || "default") || "default";
    const library = hasCrewPermission(actor, "crew.workflows.add")
      ? (await listScopeTemplates(orgId, branchId)).map(fieldLaunchDescriptor).filter((entry) => entry !== null)
      : [];
    const items = await fieldWorkflowTimeline(orgId, projectId);
    return { ok: true, items, count: items.length, library, can_add_work: hasCrewPermission(actor, "crew.workflows.add") };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/workflows/scopes/:templateId", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.workflows.add", true);
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    const branchId = cleanText(asObject(assigned.project).branch_id || "default") || "default";
    const templateId = getParam(request.params, "templateId");
    const template = (await readScopeTemplate(orgId, branchId, templateId));
    if (!fieldLaunchDescriptor(template)) {
      throw forbidden("scope_not_field_launchable", "This scope is not available for field-created work.");
    }
    const body = requestBody(request);
    const instanceId = cleanText(body.instance_id) || randomUUID();
    const result = await instantiateScopeTemplateWorkPlan(orgId, {
      project_id: projectId,
      branch_id: branchId,
      template,
      source_type: "field_added_work",
      source_id: actor.ctx.userId,
      source_key: `field_added_work:${projectId}:${templateId}:${instanceId}`,
      title: cleanText(body.title),
      context: {
        field_launch: {
          instance_id: instanceId,
          added_by_user_id: actor.ctx.userId,
          added_at: new Date().toISOString()
        }
      }
    });
    reply.code(201);
    return { ok: true, ...result, items: await fieldWorkflowTimeline(orgId, projectId) };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/signatures", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present");
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const documents = (await listProjectDocuments(orgId, projectId))
      .filter((document) => Number(documentSignatureRequirement(document).pending_count || 0) > 0)
      .map((document) => ({ ...document, signature_requirement: documentSignatureRequirement(document) }));
    return { ok: true, documents, count: documents.length };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/signatures/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present");
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const document = await readDocumentInstance(orgId, getParam(request.params, "documentId"));
    if (cleanText(document.project_id) !== projectId) throw notFound("document_not_found", "Document was not found on this project.");
    const resolved = await resolveDocumentInstance(orgId, document, { target: "interactive" });
    const workflow = cleanText(asObject(document.workflow_ref).workflow_id)
      ? await documentWorkflowDetail(orgId, cleanText(document.id)).then((detail) => {
        const fieldDefinition = filterWorkflowForAudience(asObject(detail.definition), "field");
        const customerDefinition = filterWorkflowForAudience(asObject(detail.definition), "customer");
        if (asArray(fieldDefinition.steps).length) return { ...detail, audience:"field", definition:fieldDefinition, customer_definition:customerDefinition };
        return { ...detail, audience:"customer", definition:customerDefinition, customer_definition:customerDefinition };
      }).catch(() => null)
      : null;
    return { ok: true, document, workflow, signature_requirement: documentSignatureRequirement(document), ...resolved };
  });

  app.patch("/organizations/:orgId/crew/projects/:projectId/signatures/:documentId/params", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const documentId = getParam(request.params, "documentId");
    const current = await readDocumentInstance(orgId, documentId);
    if (cleanText(current.project_id) !== projectId) throw notFound("document_not_found", "Document was not found on this project.");
    const body = requestBody(request);
    const params = asObject(body.params);
    const definitions = asObject(current.param_defs);
    for (const key of Object.keys(params)) {
      if (!Object.prototype.hasOwnProperty.call(definitions, key)) {
        throw badRequest("document_param_unknown", `The document does not declare a '${key}' parameter.`);
      }
    }
    const document = await patchDocumentInstance(orgId, documentId, { params }, actor.ctx);
    const resolved = await resolveDocumentInstance(orgId, document, { target: "interactive" });
    return { ok: true, document, ...resolved };
  });

  app.patch("/organizations/:orgId/crew/projects/:projectId/signatures/:documentId/workflow", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const documentId = getParam(request.params, "documentId");
    const current = await readDocumentInstance(orgId, documentId);
    if (cleanText(current.project_id) !== projectId) throw notFound("document_not_found", "Document was not found on this project.");
    const result = await updateDocumentWorkflowState(orgId, documentId, requestBody(request), actor.ctx);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/signatures/:documentId/outputs/:key", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const documentId = getParam(request.params, "documentId");
    const key = getParam(request.params, "key");
    const document = await readDocumentInstance(orgId, documentId);
    if (cleanText(document.project_id) !== projectId) throw notFound("document_not_found", "Document was not found on this project.");
    const output = asObject(asObject(document.output_defs)[key]);
    if (cleanText(output.type) !== "signature") throw forbidden("crew_signature_output_only", "The field signature surface may only record signature outputs.");
    const body = requestBody(request);
    const result = await recordDocumentOutput(orgId, documentId, key, {
      ...body,
      evidence: {
        ...asObject(body.evidence),
        capture_mode: "in_person",
        witnessed_by_user_id: actor.ctx.userId
      }
    }, {}, actor.ctx, { surface: "field" });
    return { ok: true, document: result.document, snapshot: result.snapshot, status: result.status };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/signatures/:documentId/payments/:key", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.payments.take", true);
    if (!hasCrewPermission(actor, "crew.signatures.present")) {
      throw forbidden("crew_permission_denied", "Document checkout requires field signature access.");
    }
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    const documentId = getParam(request.params, "documentId");
    const key = getParam(request.params, "key");
    const document = await readDocumentInstance(orgId, documentId);
    if (cleanText(document.project_id) !== projectId) throw notFound("document_not_found", "Document was not found on this project.");
    const output = asObject(asObject(document.output_defs)[key]);
    if (cleanText(output.type) !== "payment") throw badRequest("document_payment_output_required", "The selected document field is not a payment output.");
    const body = requestBody(request);
    const expectedAmount = fieldDocumentTotalCents(document);
    const submittedAmount = cents(body.amount_cents);
    if (expectedAmount <= 0) throw badRequest("document_payment_amount_missing", "The document does not have a payable amount.");
    if (submittedAmount !== expectedAmount) {
      throw badRequest("document_payment_amount_mismatch", "The payment amount changed. Review the quote and try again.", { expected_amount_cents: expectedAmount });
    }
    // Provider tokenization branch: when the field intake modal tokenized the
    // card/bank (payment_method_id) or picked a saved method, the charge runs
    // through the SAME intake charge helpers the staff and portal flows use —
    // a decline throws the structured payment_declined error and records
    // nothing. metadata.document_output_id lets recordDocumentOutput's
    // payment-transaction resolver find this charge instead of double-writing.
    // Without a token the legacy record path below is untouched.
    const providerToken = cleanText(body.payment_method_id);
    const savedMethodId = cleanText(body.saved_method_id || body.saved_payment_method_id);
    let paymentResult;
    if (providerToken || savedMethodId) {
      const { resolveIntakeProvider, recordProviderChargedPayment } = await import("../payments/intake.js");
      const { provider } = await resolveIntakeProvider(orgId);
      if (!provider) {
        throw badRequest("merchant_not_configured", "Online card processing is not available for this organization.");
      }
      paymentResult = await recordProviderChargedPayment(orgId, provider, {
        amount_cents: expectedAmount,
        payment_method_id: providerToken,
        saved_method_id: providerToken ? "" : savedMethodId,
        method: cleanText(asObject(body.method).kind || asObject(body.method).type),
        project_id: projectId,
        branch_id: cleanText(document.branch_id || "default") || "default",
        save_payment_method: body.save_payment_method === true,
        // The document's own pricing carries any processing-fee rows and the
        // amount was validated against the quote total above — never stack
        // the org surcharge on top.
        apply_surcharge: false,
        contact_ref: asObject(body.contact_ref),
        method_descriptor: asObject(body.method),
        payment: {
          kind: cleanText(output.obligation || "field_payment"),
          currency: cleanText(body.currency || "USD") || "USD",
          allocate: true,
          allocation_mode: "auto_next_due",
          metadata: {
            source: "crew_document_checkout",
            document_id: documentId,
            output_key: key,
            document_output_id: `${documentId}:${key}`,
            received_by_user_id: actor.ctx.userId
          }
        }
      }, actor.ctx);
    } else {
      paymentResult = await createPayment(orgId, {
        project_id: projectId,
        direction: "inbound",
        kind: cleanText(output.obligation || "field_payment"),
        status: "settled",
        amount_cents: expectedAmount,
        currency: cleanText(body.currency || "USD") || "USD",
        method: asObject(body.method),
        allocate: true,
        allocation_mode: "auto_next_due",
        contact_ref: asObject(body.contact_ref),
        metadata: {
          source: "crew_document_checkout",
          document_id: documentId,
          output_key: key,
          received_by_user_id: actor.ctx.userId
        }
      }, actor.ctx);
    }
    const recorded = await recordDocumentOutput(orgId, documentId, key, {
      value: {
        payment_id: cleanText(asObject(paymentResult.payment).id),
        amount_cents: expectedAmount,
        payment_method: cleanText(asObject(body.method).kind || asObject(body.method).type),
        paid_at: new Date().toISOString()
      },
      evidence: {
        ...asObject(body.evidence),
        capture_mode: "in_person",
        witnessed_by_user_id: actor.ctx.userId
      }
    }, {}, actor.ctx, { surface: "field" });
    reply.code(201);
    return {
      ok: true,
      payment: paymentResult.payment,
      document: recorded.document,
      status: recorded.status,
      payment_summary: await crewProjectPaymentSummary(orgId, projectId, assigned.project)
    };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/signatures/:documentId/portal", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const documentId = getParam(request.params, "documentId");
    const document = await readDocumentInstance(orgId, documentId);
    if (cleanText(document.project_id) !== projectId) throw notFound("document_not_found", "Document was not found on this project.");
    const result = await sendDocument(orgId, documentId, { include_pdf: false, include_portal: true }, actor.ctx);
    return { ok: true, ...result };
  });

  /** Cancel/revoke a sent document or workflow from the field. Revokes public
   *  tokens and keeps the item visible as canceled unless hidden. */
  app.post("/organizations/:orgId/crew/projects/:projectId/signatures/:documentId/void", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.signatures.present", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const documentId = getParam(request.params, "documentId");
    const current = await readDocumentInstance(orgId, documentId);
    if (cleanText(current.project_id) !== projectId) throw notFound("document_not_found", "Document was not found on this project.");
    const body = requestBody(request);
    const document = await voidDocumentInstance(orgId, documentId, actor.ctx, {
      reason: cleanText(body.reason),
      customer_visibility: cleanText(body.customer_visibility)
    });
    return { ok: true, document, items: await fieldWorkflowTimeline(orgId, projectId) };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/materials", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.materials.view");
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const lists = (await listProjectMaterialLists(orgId, projectId)).filter((list) => cleanText(list.resource_type || "material") === "material");
    const materialLists = await Promise.all(lists.map(async (list) => {
      const orders = await listMaterialOrders(orgId, cleanText(list.id));
      const orderViews = await Promise.all(orders.map(async (order) => ({
        ...order,
        deliveries: await listMaterialDeliveries(orgId, cleanText(order.id))
      })));
      return { ...list, orders: orderViews };
    }));
    return { ok: true, material_lists: materialLists, count: materialLists.length };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/materials/items", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.materials.append", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const body = requestBody(request);
    const list = await selectedMaterialList(orgId, projectId, cleanText(body.list_id), actor);
    const item = normalizedManualMaterialItem(body.item || body, actor);
    const result = await createMaterialVersion(orgId, cleanText(list.id), {
      expected_revision: Number(list.revision || 0) || undefined,
      reason: "manual",
      add_items: [item],
      notes: cleanText(body.notes || "Added from Crew app"),
      metadata: { source: "crew_app", added_by_user_id: actor.ctx.userId }
    }, actor.ctx);
    reply.code(201);
    return { ok: true, item, material_list: result.list, version: result.version };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/materials/from-receipt", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.materials.append", true);
    if (!hasCrewPermission(actor, "crew.receipts.upload")) {
      throw forbidden("crew_permission_denied", "Uploading receipt-derived materials requires receipt upload access.", {
        permission: "crew.receipts.upload"
      });
    }
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const body = requestBody(request);
    const receiptId = cleanText(body.receipt_id);
    if (!receiptId) throw badRequest("receipt_id_required", "A receipt id is required.");
    const receipt = await readReceipt(orgId, receiptId);
    if (!receiptActorAllowed(receipt, actor)) throw forbidden("receipt_forbidden", "This receipt is not available to this user.");
    if (cleanText(receipt.project_id) && cleanText(receipt.project_id) !== projectId) {
      throw forbidden("receipt_project_forbidden", "This receipt belongs to another project.");
    }
    const list = await selectedMaterialList(orgId, projectId, cleanText(body.list_id), actor);
    const candidates = receiptMaterialItems(receipt, body.reviewed_items || body.items, actor);
    const existingReceiptLineIds = new Set(asArray(list.current_items).map(asObject)
      .filter((item) => cleanText(asObject(item.metadata).receipt_id) === receiptId)
      .map((item) => cleanText(asObject(item.metadata).receipt_line_id)));
    const addItems = candidates.filter((item) => !existingReceiptLineIds.has(cleanText(asObject(item.metadata).receipt_line_id)));
    if (!addItems.length) {
      return {
        ok: true,
        idempotent: true,
        imported_count: 0,
        receipt: receiptView(receipt),
        material_list: list,
        version: null
      };
    }
    const result = await createMaterialVersion(orgId, cleanText(list.id), {
      expected_revision: Number(list.revision || 0) || undefined,
      reason: "supplement",
      add_items: addItems,
      notes: `Imported from receipt ${receiptId}`,
      metadata: { source: "crew_receipt", receipt_id: receiptId, added_by_user_id: actor.ctx.userId }
    }, actor.ctx);
    const associated = await associateReceiptWithProject(orgId, receiptId, projectId, actor.ctx, {
      material_list_id: cleanText(list.id),
      material_version_id: cleanText(result.version.id),
      source: "crew_material_import"
    });
    reply.code(201);
    return {
      ok: true,
      idempotent: false,
      imported_count: addItems.length,
      items: addItems,
      receipt: associated,
      material_list: result.list,
      version: result.version
    };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/payouts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.payouts.view");
    const result = await assignedProject(orgId, getParam(request.params, "projectId"), actor);
    return { ok: true, payout: await projectPayoutView(orgId, result.project, actor) };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/payments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.payments.view");
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    return { ok: true, payment_summary: await crewProjectPaymentSummary(orgId, projectId, assigned.project) };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/payments", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.payments.take", true);
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    const body = requestBody(request);
    // Provider tokenization branch: a payment_method_id / saved_method_id from
    // the intake modal charges card/ACH through the SAME intake charge helpers
    // as the staff flow (crewPaymentMethod's cash/check rule exists precisely
    // because untokenized card data has no processing path). Declines throw
    // the structured payment_declined error and record nothing. Cash/check
    // recording below stays byte-identical.
    const providerToken = cleanText(body.payment_method_id);
    const savedMethodId = cleanText(body.saved_method_id || body.saved_payment_method_id);
    if (providerToken || savedMethodId) {
      const requestedDirection = cleanText(body.direction).toLowerCase();
      const requestedStatus = cleanText(body.status).toLowerCase();
      if ((requestedDirection && requestedDirection !== "inbound") || (requestedStatus && requestedStatus !== "settled")) {
        throw badRequest("crew_payment_state_unsupported", "Crew payments must be recorded as settled inbound payments.");
      }
      const { resolveIntakeProvider, recordProviderChargedPayment } = await import("../payments/intake.js");
      const { provider } = await resolveIntakeProvider(orgId);
      if (!provider) {
        throw badRequest("merchant_not_configured", "Online card processing is not available for this organization.");
      }
      const methodKind = cleanText(asObject(body.method).kind || asObject(body.method).type || body.payment_method);
      const charged = await recordProviderChargedPayment(orgId, provider, {
        amount_cents: cents(body.amount_cents),
        payment_method_id: providerToken,
        saved_method_id: providerToken ? "" : savedMethodId,
        method: methodKind,
        project_id: projectId,
        save_payment_method: body.save_payment_method === true,
        apply_surcharge: body.apply_surcharge !== false,
        contact_ref: asObject(body.contact_ref),
        method_label: cleanText(body.method_label || asObject(body.method).label),
        method_descriptor: asObject(body.method),
        payment: {
          kind: "field_payment",
          currency: cleanText(body.currency || "USD") || "USD",
          allocate: body.allocate !== false,
          allocation_mode: cleanText(body.allocation_mode || "auto_next_due"),
          customer_id: cleanText(body.customer_id),
          notes: cleanText(body.notes),
          metadata: {
            source: "crew_app",
            received_by_user_id: actor.ctx.userId,
            recording_method: methodKind || "card"
          }
        }
      }, actor.ctx);
      reply.code(201);
      return {
        ok: true,
        ...charged,
        payment_summary: await crewProjectPaymentSummary(orgId, projectId, assigned.project)
      };
    }
    const method = crewPaymentMethod(body);
    const result = await createPayment(orgId, {
      project_id: projectId,
      direction: "inbound",
      kind: "field_payment",
      status: "settled",
      amount_cents: body.amount_cents,
      amount: body.amount,
      currency: cleanText(body.currency || "USD") || "USD",
      method,
      allocate: body.allocate !== false,
      allocation_mode: cleanText(body.allocation_mode || "auto_next_due"),
      contact_ref: asObject(body.contact_ref),
      customer_id: cleanText(body.customer_id),
      received_at: cleanText(body.received_at),
      notes: cleanText(body.notes),
      metadata: {
        source: "crew_app",
        received_by_user_id: actor.ctx.userId,
        recording_method: cleanText(method.kind)
      }
    }, actor.ctx);
    reply.code(201);
    return {
      ok: true,
      ...result,
      payment_summary: await crewProjectPaymentSummary(orgId, projectId, assigned.project)
    };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/change-orders", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.change_orders.view");
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const changeOrders = (await listProjectProposals(orgId, projectId)).filter(isChangeOrder).map(publicChangeOrder);
    return { ok: true, change_orders: changeOrders, count: changeOrders.length };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/change-orders", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.change_orders.manage", true);
    const projectId = getParam(request.params, "projectId");
    const assigned = await assignedProject(orgId, projectId, actor);
    const body = requestBody(request);
    const items = asArray(body.items || asObject(body.scope).root_items).map(normalizedChangeOrderItem);
    if (!items.length) throw badRequest("change_order_items_required", "At least one change-order item is required.");
    const scope = {
      ...asObject(body.scope),
      root_items: items
    };
    const pricing = changeOrderPricing(body.pricing, scope);
    const title = cleanText(body.title || `Change Order - ${projectTitle(assigned.project)}`);
    const proposal = await createProposal(orgId, projectId, {
      title,
      contacts: asArray(body.contacts).length ? body.contacts : asObject(assigned.project).contacts,
      editable: {
        ...asObject(body.editable),
        title,
        document_kind: "change_order",
        proposal_type: "change_order",
        change_order: {
          ...asObject(body.change_order),
          document_kind: "change_order",
          base_proposal_id: cleanText(body.base_proposal_id),
          details: cleanText(body.details || body.description),
          created_in_crew_app: true
        },
        scope,
        pricing,
        payment: asObject(body.payment)
      },
      metadata: {
        ...asObject(body.metadata),
        proposal_type: "change_order",
        document_kind: "change_order",
        source: "crew_app"
      }
    }, actor.ctx);
    reply.code(201);
    return {
      ok: true,
      change_order: {
        ...publicChangeOrder(proposal),
        total_cents: proposalScopeTotalCents(scope)
      }
    };
  });

  app.post("/organizations/:orgId/crew/change-orders/:changeOrderId/send", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.change_orders.manage", true);
    const proposal = await readProposal(orgId, getParam(request.params, "changeOrderId"));
    if (!isChangeOrder(proposal)) throw badRequest("change_order_required", "The requested record is not a change order.");
    const assigned = await assignedProject(orgId, cleanText(proposal.project_id), actor);
    const body = requestBody(request);
    const requestedRecipients = Array.isArray(body.recipients)
      ? deliveryRecipients(body.recipients)
      : deliveryRecipients([
          ...asArray(asObject(proposal.delivery).recipients),
          ...asArray(proposal.contacts).filter((contact) => !!cleanText(asObject(contact).email)),
          ...asArray(asObject(assigned.project).contacts).filter((contact) => !!cleanText(asObject(contact).email))
        ]);
    if (requestedRecipients.length) {
      const result = await sendProposal(orgId, cleanText(proposal.id), {
        ...body,
        recipients: requestedRecipients,
        include_portal: true
      }, actor.ctx);
      const portal = proposalPortalResult(result.snapshot, true, requestedRecipients);
      return { ok: true, ...result, delivery_result: portal, portal };
    }

    const snapshot = await createProposalSnapshot(orgId, cleanText(proposal.id), {
      ...body,
      reason: "manual",
      create_portal_link: true,
      include_portal: true,
      generate_pdf: body.include_pdf === true,
      recipients: [],
      delivery: {
        ...asObject(body.delivery),
        state: "not_sent",
        recipients: [],
        include_portal: true,
        include_pdf: body.include_pdf === true
      }
    }, actor.ctx);
    const token = cleanText(asObject(snapshot.delivery).public_token);
    const updated = await patchProposal(orgId, cleanText(proposal.id), {
      delivery: {
        ...asObject(proposal.delivery),
        state: "not_sent",
        current_snapshot_id: cleanText(snapshot.id),
        current_public_token: token,
        recipients: [],
        include_portal: true,
        include_pdf: body.include_pdf === true,
        link_prepared_at: new Date().toISOString()
      }
    }, actor.ctx);
    const portal = proposalPortalResult(snapshot, false, []);
    return { ok: true, proposal: updated, snapshot, delivery_result: portal, portal };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/checklists", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId);
    const projectId = getParam(request.params, "projectId");
    await checklistAccessibleProject(orgId, projectId, actor);
    return checklistCollectionPayload(orgId, projectId, actor);
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/checklists", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await accessibleProject(orgId, projectId, actor);
    const body = requestBody(request);
    if (!actor.management && cleanText(body.audience) === "supervisor" && !hasCrewPermission(actor, "crew.checklists.supervise")) {
      throw forbidden("checklist_audience_forbidden", "This user cannot create supervisor checklists.");
    }
    await assertChecklistAssignmentsAllowed(orgId, body);
    const checklist = (await createProjectChecklist(orgId, projectId, body, actor.ctx.userId));
    reply.code(201);
    return { ok: true, checklist };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/checklists/voice", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await accessibleProject(orgId, projectId, actor);
    const typed = request as unknown as {
      parts?: () => AsyncIterable<{
        type: "file" | "field";
        fieldname: string;
        value?: unknown;
        filename?: string;
        mimetype?: string;
        toBuffer?: () => Promise<Buffer>;
      }>;
    };
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_required", "Checklist voice updates must be multipart/form-data.");
    let audio: Buffer | null = null;
    let fileName = "checklist.wav";
    let contentType = "audio/wav";
    const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === "file" && !audio) {
        audio = await part.toBuffer?.() ?? null;
        fileName = cleanText(part.filename || fileName);
        contentType = cleanText(part.mimetype || contentType);
      } else if (part.type === "field") {
        fields[part.fieldname] = cleanText(part.value);
      }
    }
    if (!audio) throw badRequest("missing_audio", "Record a checklist update first.");
    const mode = fields.mode === "update" ? "update" : "create";
    const existing = mode === "update"
      ? (await listProjectChecklists(orgId, projectId)).find((entry) => entry.id === fields.checklist_id)
      : null;
    if (mode === "update" && !existing) throw notFound("checklist_not_found", "Checklist was not found.");
    const result = await processStructuredAudio(checklistAudioProcessor, {
      audio,
      fileName,
      contentType,
      context: mode === "create"
        ? { mode, requestedTitle: fields.title }
        : {
            mode,
            checklist: {
              id: existing!.id,
              title: existing!.title,
              audience: cleanText(existing!.audience),
              customer_access: asObject(existing!.customer_access),
              items: asArray(existing!.items).map((itemValue) => {
                const item = asObject(itemValue);
                return {
                  id: cleanText(item.id),
                  title: cleanText(item.title),
                  completed: item.completed === true,
                  item_type: cleanText(item.item_type) || "todo",
                  note: cleanText(item.note),
                  required_attachments: asArray(asObject(item.metadata).required_attachments)
                };
              })
            }
          }
    });
    if (mode === "create") {
      const reconciled = reconcileChecklistAudioOperations(
        result.operations.filter((entry) => entry.confidence >= 0.5),
        []
      );
      const assignToCreator = !result.completion_audience_explicit || result.completion_audience === "assigned";
      const checklist = (await createProjectChecklist(orgId, projectId, {
        title: fields.title || result.title,
        audience: result.completion_audience_explicit && result.completion_audience === "supervisor" ? "supervisor" : (fields.audience || "crew"),
        kind: "todo",
        crew_editable: fields.crew_editable === "true",
        assignment_policy: {
          schema_version: 1,
          mode: "any",
          allow_unassigned: !assignToCreator,
          rules: []
        },
        assigned_user_ids: assignToCreator ? [actor.ctx.userId] : [],
        customer_access: result.customer_access_explicit ? {
          schema_version: 1,
          visible: result.customer_access !== "private",
          can_complete: result.customer_access === "complete" || result.customer_access === "edit",
          can_edit_items: result.customer_access === "edit"
        } : { schema_version: 1, visible: false, can_complete: false, can_edit_items: false, voice_mode: "off" },
        metadata: { created_from_audio: true, audio_processor: checklistAudioProcessor.id },
        items: reconciled.operations
          .filter((operation) => operation.action === "add")
          .map((operation, index) => ({
            title: operation.title,
            item_type:operation.item_type === "rating" ? "rating" : "todo",
            note:cleanText(operation.note),
            metadata:{ required_attachments:checklistAudioRequirements(operation.requirements) },
            sort_order:index
          }))
      }, actor.ctx.userId));
      return {
        ok: true,
        mode,
        checklist,
        result: { ...result, operations: reconciled.operations },
        suppressed_operations: reconciled.suppressed
      };
    }
    const existingItems = new Map(asArray(existing!.items).map((itemValue) => {
      const item = asObject(itemValue);
      return [cleanText(item.id), item];
    }));
    const reconciled = reconcileChecklistAudioOperations(
      result.operations.filter((entry) => entry.confidence >= 0.55),
      [...existingItems.values()].map((item) => ({
        id: cleanText(item.id),
        title: cleanText(item.title),
        completed: item.completed === true,
        item_type: cleanText(item.item_type)
      }))
    );
    const applied: Array<Record<string, unknown>> = [];
    const draftChecklist = cleanText(existing!.title).toLowerCase() === "untitled checklist";
    const checklistPatch: Record<string, unknown> = {};
    if (draftChecklist && cleanText(result.title)) checklistPatch.title = result.title;
    if (result.completion_audience_explicit) {
      checklistPatch.audience = result.completion_audience === "supervisor" ? "supervisor" : "crew";
      checklistPatch.assignment_policy = {
        schema_version: 1,
        mode: "any",
        ...asObject(existing!.assignment_policy),
        allow_unassigned: result.completion_audience !== "assigned"
      };
      checklistPatch.assigned_user_ids = result.completion_audience === "assigned" ? [actor.ctx.userId] : [];
      checklistPatch.assigned_role_ids = [];
      checklistPatch.assigned_resource_group_ids = [];
    }
    if (result.customer_access_explicit) checklistPatch.customer_access = {
      schema_version: 1,
      visible: result.customer_access !== "private",
      can_complete: result.customer_access === "complete" || result.customer_access === "edit",
      can_edit_items: result.customer_access === "edit"
    };
    if (Object.keys(checklistPatch).length) (await patchProjectChecklist(orgId, projectId, existing!.id, checklistPatch));
    for (const operation of reconciled.operations) {
      if (operation.action === "complete") {
        const item = existingItems.get(operation.item_id);
        if (!item || item.completed === true) continue;
        const updated = (await patchProjectChecklistItem(
          orgId,
          projectId,
          operation.item_id,
          cleanText(item.item_type) === "rating" ? { rating: "good" } : { completed: true },
          actor.ctx.userId,
          true
        ));
        await emitChecklistWorkEvents(orgId, projectId, actor.ctx.userId, item, updated);
        applied.push({ action: "complete", item: updated });
      } else if (operation.action === "add_note") {
        const item = existingItems.get(operation.item_id);
        if (!item) continue;
        const updated = (await patchProjectChecklistItem(orgId, projectId, operation.item_id, { note:cleanText(operation.note) }, actor.ctx.userId, true));
        existingItems.set(operation.item_id, updated);
        applied.push({ action:"add_note", item:updated });
      } else if (operation.action === "set_requirements") {
        const item = existingItems.get(operation.item_id);
        if (!item) continue;
        const updated = (await patchProjectChecklistItem(orgId, projectId, operation.item_id, {
          metadata:{ required_attachments:checklistAudioRequirements(operation.requirements) }
        }, actor.ctx.userId, true));
        existingItems.set(operation.item_id, updated);
        applied.push({ action:"set_requirements", item:updated });
      } else {
        const duplicate = [...existingItems.values()].some((item) =>
          cleanText(item.title).toLowerCase() === operation.title.toLowerCase()
        );
        if (duplicate) continue;
        const item = (await createProjectChecklistItem(orgId, projectId, existing!.id, {
          title:operation.title,
          item_type:operation.item_type === "rating" ? "rating" : "todo",
          note:cleanText(operation.note),
          metadata:{ required_attachments:checklistAudioRequirements(operation.requirements) }
        }, actor.ctx.userId));
        existingItems.set(item.id, item);
        applied.push({ action: "add", item });
      }
    }
    return {
      ok: true,
      mode,
      result: { ...result, operations: reconciled.operations },
      suppressed_operations: reconciled.suppressed,
      applied,
      checklist: (await readProjectChecklist(orgId, projectId, existing!.id))
    };
  });

  app.patch("/organizations/:orgId/crew/projects/:projectId/checklists/:checklistId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await accessibleProject(orgId, projectId, actor);
    const checklistId = getParam(request.params, "checklistId");
    const current = (await readProjectChecklist(orgId, projectId, checklistId));
    if (!checklistEditAllowed(actor, current)) {
      throw forbidden("checklist_edit_forbidden", "This checklist is not editable by this user.");
    }
    const body = requestBody(request);
    if (!actor.management && cleanText(body.audience) === "supervisor" && !hasCrewPermission(actor, "crew.checklists.supervise")) {
      throw forbidden("checklist_audience_forbidden", "This user cannot assign checklists to supervisors.");
    }
    await assertChecklistAssignmentsAllowed(orgId, { ...current, ...body });
    return { ok: true, checklist: (await patchProjectChecklist(orgId, projectId, checklistId, body)) };
  });

  app.delete("/organizations/:orgId/crew/projects/:projectId/checklists/:checklistId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await accessibleProject(orgId, projectId, actor);
    const checklistId = getParam(request.params, "checklistId");
    const current = (await readProjectChecklist(orgId, projectId, checklistId));
    if (!checklistEditAllowed(actor, current)) {
      throw forbidden("checklist_edit_forbidden", "This checklist is not editable by this user.");
    }
    return { ok: true, ...(await deleteProjectChecklist(orgId, projectId, checklistId, actor.ctx.userId)) };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/checklists/:checklistId/items", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await accessibleProject(orgId, projectId, actor);
    const checklistId = getParam(request.params, "checklistId");
    const checklist = (await readProjectChecklist(orgId, projectId, checklistId));
    if (!checklistEditAllowed(actor, checklist)) {
      throw forbidden("checklist_edit_forbidden", "This checklist is not editable by this user.");
    }
    const item = (await createProjectChecklistItem(orgId, projectId, checklistId, requestBody(request), actor.ctx.userId));
    reply.code(201);
    return { ok: true, item };
  });

  app.patch("/organizations/:orgId/crew/projects/:projectId/checklists/:checklistId/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(
      request,
      orgId,
      "",
      true
    );
    const projectId = getParam(request.params, "projectId");
    await checklistAccessibleProject(orgId, projectId, actor);
    const checklistId = getParam(request.params, "checklistId");
    const checklist = (await readProjectChecklist(orgId, projectId, checklistId));
    const item = (await readProjectChecklistItem(orgId, projectId, getParam(request.params, "itemId")));
    if (item.checklist_id !== checklist.id) throw notFound("checklist_item_not_found", "Checklist item was not found.");
    if (!checklistCompletionAllowed(actor, checklist)) {
      if (checklistNeedsExplicitAssignment(checklist)) {
        throw badRequest("checklist_assignment_required", "Assign this checklist to a person, role, or group before completing it.");
      }
      throw forbidden("checklist_complete_forbidden", "This user cannot update items on this checklist.");
    }
    const canEdit = checklistEditAllowed(actor, checklist);
    const updated = (await patchProjectChecklistItem(orgId, projectId, item.id, requestBody(request), actor.ctx.userId, canEdit));
    await emitChecklistWorkEvents(orgId, projectId, actor.ctx.userId, item, updated);
    return { ok: true, item: updated, can_edit: canEdit };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/checklists/:checklistId/items/:itemId/attachments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(
      request,
      orgId,
      "",
      true
    );
    const projectId = getParam(request.params, "projectId");
    await checklistAccessibleProject(orgId, projectId, actor);
    const checklist = (await readProjectChecklist(orgId, projectId, getParam(request.params, "checklistId")));
    if (!checklistCompletionAllowed(actor, checklist)) {
      throw forbidden("checklist_complete_forbidden", "This user cannot attach evidence to this checklist.");
    }
    const item = (await readProjectChecklistItem(orgId, projectId, getParam(request.params, "itemId")));
    if (item.checklist_id !== checklist.id) throw notFound("checklist_item_not_found", "Checklist item was not found.");
    const typed = request as unknown as {
      parts?: () => AsyncIterable<{
        type: "file" | "field";
        fieldname: string;
        value?: unknown;
        filename?: string;
        mimetype?: string;
        toBuffer?: () => Promise<Buffer>;
      }>;
    };
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_required", "Checklist evidence must be multipart/form-data.");
    let bytes: Buffer | null = null;
    let fileName = "checklist-evidence";
    let contentType = "application/octet-stream";
    let requirementId = "";
    for await (const part of parts) {
      if (part.type === "file" && !bytes) {
        bytes = await part.toBuffer?.() ?? null;
        fileName = cleanText(part.filename || fileName);
        contentType = cleanText(part.mimetype || contentType).toLowerCase();
      } else if (part.type === "field" && part.fieldname === "requirement_id") {
        requirementId = cleanText(part.value);
      }
    }
    if (!bytes) throw badRequest("checklist_attachment_missing", "Choose a file to attach.");
    if (bytes.length > 128 * 1024 * 1024) throw badRequest("checklist_attachment_too_large", "Checklist evidence cannot exceed 128 MB.");
    const kind = contentType.startsWith("image/") ? "photo"
      : contentType.startsWith("video/") ? "video"
        : contentType.startsWith("audio/") ? "audio"
          : "document";
    const media = await storeMediaUpload(orgId, {
      bytes,
      fileName,
      contentType,
      ownerType: "project",
      ownerId: projectId,
      slot: kind === "photo" || kind === "video" ? "photos" : "checklist_evidence",
      scope: "projects",
      metadata: {
        source: "checklist_evidence",
        field: kind === "photo" || kind === "video" ? "photos" : "checklist_evidence",
        document_collection: "projects",
        document_id: projectId,
        project_id: projectId,
        checklist_id: checklist.id,
        checklist_item_id: item.id,
        requirement_id: requirementId,
        media_type: kind
      }
    });
    const attachment = {
      media_id: media.id,
      file_name: media.file_name,
      content_type: media.content_type,
      size_bytes: media.size_bytes,
      kind,
      requirement_id: requirementId
    };
    const updated = (await addProjectChecklistItemAttachment(orgId, projectId, item.id, attachment, actor.ctx.userId));
    return { ok: true, attachment, item: updated };
  });

  app.delete("/organizations/:orgId/crew/projects/:projectId/checklists/:checklistId/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await accessibleProject(orgId, projectId, actor);
    const checklistId = getParam(request.params, "checklistId");
    const checklist = (await readProjectChecklist(orgId, projectId, checklistId));
    if (!checklistEditAllowed(actor, checklist)) {
      throw forbidden("checklist_edit_forbidden", "This checklist is not editable by this user.");
    }
    const item = (await readProjectChecklistItem(orgId, projectId, getParam(request.params, "itemId")));
    if (item.checklist_id !== checklist.id) throw notFound("checklist_item_not_found", "Checklist item was not found.");
    return { ok: true, ...(await deleteCrewChecklistItem(orgId, projectId, item.id, actor.ctx.userId)) };
  });

  app.get("/organizations/:orgId/crew/projects/:projectId/checklist", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.view");
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const manage = hasCrewPermission(actor, "crew.checklists.manage");
    return {
      ok: true,
      project_id: projectId,
      mode: manage ? "manage" : "complete",
      permissions: { view: true, complete: hasCrewPermission(actor, "crew.checklists.complete") || manage, manage },
      items: (await listCrewChecklistItems(orgId, projectId))
    };
  });

  app.post("/organizations/:orgId/crew/projects/:projectId/checklist/items", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const item = (await createCrewChecklistItem(orgId, projectId, requestBody(request), actor.ctx.userId));
    reply.code(201);
    return { ok: true, item };
  });

  app.patch("/organizations/:orgId/crew/projects/:projectId/checklist/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.complete|crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    const manage = hasCrewPermission(actor, "crew.checklists.manage");
    const itemId = getParam(request.params, "itemId");
    const before = (await readProjectChecklistItem(orgId, projectId, itemId));
    const item = (await patchCrewChecklistItem(orgId, projectId, itemId, requestBody(request), actor.ctx.userId, manage));
    await emitChecklistWorkEvents(orgId, projectId, actor.ctx.userId, before, item);
    return { ok: true, item, mode: manage ? "manage" : "complete" };
  });

  app.delete("/organizations/:orgId/crew/projects/:projectId/checklist/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireCrewActor(request, orgId, "crew.checklists.manage", true);
    const projectId = getParam(request.params, "projectId");
    await assignedProject(orgId, projectId, actor);
    return { ok: true, ...(await deleteCrewChecklistItem(orgId, projectId, getParam(request.params, "itemId"), actor.ctx.userId)) };
  });
};
