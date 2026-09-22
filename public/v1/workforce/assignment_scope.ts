import { listDocuments, type JsonObject } from "../platform/storage.js";
import { listResourceGroups } from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function uniqueText(value: unknown) {
  return [...new Set(asArray(value).map(cleanText).filter(Boolean))];
}

function isProjectWorkEvent(event: JsonObject) {
  const kind = cleanText(event.kind).toLowerCase();
  const type = cleanText(event.event_type_default_id || event.type_id || event.event_type_id).toLowerCase();
  const itemKind = cleanText(event.schedule_item_kind).toLowerCase();
  return kind === "project_work" || type === "project_work" || type.startsWith("project_work_") || itemKind === "production" || itemKind === "labor";
}

function eventResourceId(event: JsonObject) {
  const ref = asObject(event.work_resource_ref);
  return cleanText(ref.id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id || event.crew_id);
}

function eventResourceKind(event: JsonObject) {
  const ref = asObject(event.work_resource_ref);
  return cleanText(ref.kind || event.assigned_resource_kind || event.resource_kind || (eventResourceId(event) ? "resource_group" : ""));
}

function eventAssignedUserIds(event: JsonObject) {
  return uniqueText([
    ...asArray(event.assigned_user_ids),
    ...asArray(event.user_ids),
    event.assigned_user_id,
    event.user_id,
    ...asArray(event.assigned_users).map((entry) => asObject(entry).id || asObject(entry).user_id)
  ]);
}

function eventHasAssignment(event: JsonObject) {
  return !!eventResourceId(event) || eventAssignedUserIds(event).length > 0;
}

export async function activeResourceGroupsForUser(orgId: string, userId: string) {
  const groups = await listResourceGroups(orgId, {});
  return groups.filter((group) => cleanText(group.status || "active") === "active")
    .filter((group) => asArray(group.members).map(asObject).some((member) => (
      cleanText(member.user_id) === userId && cleanText(member.status || "active") === "active"
    )));
}

export async function activeResourceGroupIdsForUser(orgId: string, userId: string) {
  return new Set((await activeResourceGroupsForUser(orgId, userId))
    .map((group) => cleanText(group.id))
    .filter(Boolean));
}

// Every project_work event on a project, assigned or not. Used for
// production-scope roles (supervisors) that see all scheduled work.
export function projectWorkEvents(project: JsonObject) {
  return asArray(project.events).map(asObject).filter(isProjectWorkEvent);
}

const SALES_APPOINTMENT_ROLE_IDS = new Set(["sales_appointments", "inside_sales"]);

export function isSalesAppointmentEvent(event: JsonObject) {
  const type = cleanText(event.event_type_default_id || event.kind || event.type_id).toLowerCase();
  if (type === "sales_appointment" || type.startsWith("sales_appointment_")) return true;
  const roleIds = [
    ...asArray(event.role_ids),
    ...asArray(event.required_role_ids),
    ...asArray(event.allowed_role_ids)
  ].map((value) => cleanText(value).toLowerCase());
  return roleIds.some((roleId) => SALES_APPOINTMENT_ROLE_IDS.has(roleId));
}

// Sales personas are "assigned" to a project through their sales appointments
// rather than production work events. Both the sales facade and the crew
// project facades accept this as project access.
export function assignedSalesAppointmentEvents(project: JsonObject, actor: { userId: string; management?: boolean }) {
  return asArray(project.events).map(asObject)
    .filter(isSalesAppointmentEvent)
    .filter((event) => cleanText(event.status).toLowerCase() !== "canceled")
    .filter((event) => actor.management === true || eventAssignedUserIds(event).includes(actor.userId));
}

export function assignedProjectWorkEvents(project: JsonObject, actor: { userId: string; groupIds: ReadonlySet<string>; management?: boolean }) {
  return asArray(project.events).map(asObject).filter(isProjectWorkEvent).filter((event) => {
    if (actor.management === true) return eventHasAssignment(event);
    if (eventAssignedUserIds(event).includes(actor.userId)) return true;
    return eventResourceKind(event) === "resource_group" && actor.groupIds.has(eventResourceId(event));
  });
}

export async function assignedProjectIdsForUser(orgId: string, userId: string) {
  const [documents, groupIds] = await Promise.all([
    listDocuments(orgId, "projects"),
    activeResourceGroupIdsForUser(orgId, userId)
  ]);
  return new Set(documents.filter((document) => {
    const project = { id:cleanText(document.id), ...asObject(document.data) };
    return assignedProjectWorkEvents(project, { userId, groupIds }).length > 0;
  }).map((document) => cleanText(document.id)).filter(Boolean));
}
