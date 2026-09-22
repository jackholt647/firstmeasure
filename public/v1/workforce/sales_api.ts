import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { PlatformAuthContext } from "../platform/auth.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { listDocuments, readDocument, type JsonObject } from "../platform/storage.js";
import { createFollowUpTodo, isFollowUpWorkNode, resolveFollowUpOutcome } from "../work/followups.js";
import { listWorkTodos, patchWorkNode } from "../work/service.js";
import { readNodeRecord } from "../work/storage.js";
import { resolveAccessProfile } from "./access.js";
import { assignedSalesAppointmentEvents } from "./assignment_scope.js";

// The sales facade mirrors crew_api.ts for the salesperson persona: everything
// is scoped to the session user's assigned sales appointments and their own
// follow-ups. It never exposes the general project-management API.

type SalesActor = {
  ctx: PlatformAuthContext;
  accessProfile: JsonObject;
  management: boolean;
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

function requestQuery(request: FastifyRequest) {
  return asObject(request.query);
}

function requestBody(request: FastifyRequest) {
  return asObject(request.body);
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

function hasSalesPermission(actor: SalesActor, permission: string) {
  if (actor.management) return true;
  const field = fieldPermissions(actor.ctx, actor.accessProfile);
  if (!field.enabled) return false;
  return cleanText(permission).split("|").some((key) => {
    const item = key.trim();
    return field.permissions[item] === true || (field.permissions[item] !== false && field.permissions["*"] === true);
  });
}

async function requireSalesActor(
  request: FastifyRequest,
  orgId: string,
  permission = "",
  csrf = false
): Promise<SalesActor> {
  const ctx = await requirePlatformAuth(request, {
    orgId,
    csrf,
    application: ["management", "field"]
  });
  const contextProfile = asObject((ctx as unknown as { accessProfile?: JsonObject }).accessProfile);
  const accessProfile = Object.keys(contextProfile).length ? contextProfile : (await resolveAccessProfile(orgId, ctx.user));
  const actor: SalesActor = { ctx, accessProfile, management: managementAuthority(ctx) };
  if (permission && !hasSalesPermission(actor, permission)) {
    throw forbidden("sales_permission_denied", "This user does not have access to this Sales action.", { permission });
  }
  return actor;
}

// Assignment tokens for follow-up matching: workforce access role ids plus the
// user's scheduling/user roles (the sales pipeline assigns follow-ups to the
// "sales_appointments" scheduling role). The "office"/"management" broadening
// used by the generic to-dos endpoint is deliberately NOT applied here so a
// salesperson's list stays personal.
function salesRoleTokens(actor: SalesActor) {
  const user = asObject(actor.ctx.user);
  const tokens = [
    ...asArray(asObject(actor.accessProfile).access_role_ids).map(cleanText),
    ...asArray(user.roles).map((value) => cleanText(asObject(value).id || value)),
    ...asArray(user.role_ids).map(cleanText),
    cleanText(actor.ctx.role)
  ];
  return [...new Set(tokens.filter(Boolean))];
}

function dateValue(value: unknown) {
  const text = cleanText(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
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

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function eventDateRange(event: JsonObject) {
  const start = validDate(event.start_date || event.start_at || event.start);
  const end = validDate(event.end_date || event.end_at || event.end, start);
  return { start, end: end || start };
}

function eventIsSpecificTime(event: JsonObject) {
  return event.all_day === false || cleanText(event.schedule_granularity).toLowerCase() === "time";
}

function assignedSalesAppointments(project: JsonObject, actor: SalesActor) {
  return assignedSalesAppointmentEvents(project, { userId: actor.ctx.userId, management: actor.management });
}

function projectData(documentValue: unknown) {
  const document = asObject(documentValue);
  return { id: cleanText(document.id), ...asObject(document.data) };
}

function projectTitle(project: JsonObject) {
  return cleanText(project.title || project.project_title || project.name || project.address || "Project") || "Project";
}

function projectAddress(project: JsonObject) {
  return cleanText(project.address || project.project_address || project.property_address);
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

function appointmentView(project: JsonObject, event: JsonObject) {
  const contact = projectPrimaryContact(project);
  const range = eventDateRange(event);
  return {
    id: cleanText(event.id),
    project_id: cleanText(project.id),
    project_title: projectTitle(project),
    address: projectAddress(project),
    customer: contact,
    customer_name: contact.name,
    customer_phone: contact.phone,
    title: cleanText(event.title || event.name || "Sales appointment") || "Sales appointment",
    notes: cleanText(event.notes || event.description),
    start_at: cleanText(event.start_at || event.start),
    end_at: cleanText(event.end_at || event.end),
    start_date: range.start,
    end_date: range.end,
    duration_minutes: Math.max(0, Number(event.duration_minutes || 0)),
    specific_time: eventIsSpecificTime(event),
    all_day: !eventIsSpecificTime(event),
    status: cleanText(event.status || "scheduled"),
    confirmation: asObject(event.confirmation),
    stage: cleanText(asObject(asObject(project.work_projection).primary_stage).title || project.status),
    lead_status: cleanText(project.lead_status),
    signature_requirements: asObject(project.signature_requirements)
  };
}

function appointmentSort(left: JsonObject, right: JsonObject) {
  const leftTime = Date.parse(cleanText(left.start_at)) || Date.parse(`${cleanText(left.start_date)}T00:00:00.000Z`) || 0;
  const rightTime = Date.parse(cleanText(right.start_at)) || Date.parse(`${cleanText(right.start_date)}T00:00:00.000Z`) || 0;
  return leftTime - rightTime || cleanText(left.project_title).localeCompare(cleanText(right.project_title));
}

async function allAssignedAppointments(orgId: string, actor: SalesActor) {
  const documents = await listDocuments(orgId, "projects");
  const results: JsonObject[] = [];
  for (const document of documents) {
    const project = projectData(document);
    for (const event of assignedSalesAppointments(project, actor)) {
      results.push(appointmentView(project, event));
    }
  }
  results.sort(appointmentSort);
  return results;
}

function todoView(node: JsonObject, mine: boolean) {
  const metadata = asObject(node.metadata);
  const followUp = asObject(metadata.follow_up);
  return {
    id: cleanText(node.id),
    title: cleanText(node.title),
    description: cleanText(node.description),
    status: cleanText(node.status),
    due_at: cleanText(node.due_at),
    priority: Number(node.priority || 0),
    project_id: cleanText(node.project_id),
    channel: cleanText(followUp.channel || "call") || "call",
    origin: cleanText(followUp.origin),
    assigned_user_ids: asArray(node.assigned_user_ids).map(cleanText).filter(Boolean),
    assigned_role_ids: asArray(node.assigned_role_ids).map(cleanText).filter(Boolean),
    mine
  };
}

async function enrichWithProjects(orgId: string, items: JsonObject[]) {
  const projectIds = [...new Set(items.map((item) => cleanText(item.project_id)).filter(Boolean))];
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
  return items.map((item) => {
    const label = labels.get(cleanText(item.project_id));
    return label ? { ...item, project_title: cleanText(item.project_title) || label.title, project_address: label.address } : item;
  });
}

async function salesFollowUps(orgId: string, actor: SalesActor) {
  const roleTokens = salesRoleTokens(actor);
  const todos = (await listWorkTodos(orgId, {
    user_id: actor.ctx.userId,
    role_ids: roleTokens,
    resource_group_ids: [],
    include_unassigned: false,
    include_completed: false
  })) as JsonObject[];
  const followUps = todos.filter((node) => isFollowUpWorkNode(node));
  const mine = followUps.filter((node) => asArray(node.assigned_user_ids).map(cleanText).includes(actor.ctx.userId));
  const mineIds = new Set(mine.map((node) => cleanText(node.id)));
  const unclaimed = followUps.filter((node) => !mineIds.has(cleanText(node.id)));
  return {
    mine: await enrichWithProjects(orgId, mine.map((node) => todoView(node, true))),
    unclaimed: await enrichWithProjects(orgId, unclaimed.map((node) => todoView(node, false)))
  };
}

function followUpVisibleToActor(node: JsonObject, actor: SalesActor) {
  if (actor.management) return true;
  const users = asArray(node.assigned_user_ids).map(cleanText);
  if (users.includes(actor.ctx.userId)) return true;
  const tokens = new Set(salesRoleTokens(actor));
  return asArray(node.assigned_role_ids).map(cleanText).some((roleId) => tokens.has(roleId));
}

export const registerSalesApi: FastifyPluginAsync = async (app) => {
  app.get("/organizations/:orgId/sales/me/dashboard", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireSalesActor(request, orgId, "sales.dashboard.view");
    const targetDate = validDate(requestQuery(request).date, todayDate());
    const weekEnd = addDays(targetDate, 6);
    const appointments = await allAssignedAppointments(orgId, actor);
    const todayAppointments = appointments.filter((entry) =>
      cleanText(entry.start_date) <= targetDate && cleanText(entry.end_date) >= targetDate);
    const upcoming = appointments.filter((entry) => cleanText(entry.start_date) > targetDate).slice(0, 5);
    const weekCount = appointments.filter((entry) =>
      cleanText(entry.start_date) <= weekEnd && cleanText(entry.end_date) >= targetDate).length;
    const followups = await salesFollowUps(orgId, actor);
    const nowMs = Date.now();
    const overdueFollowUps = followups.mine.filter((item) => {
      const dueText = cleanText(item.due_at);
      if (!dueText) return false;
      // Date-only due dates are "due today", not late, until the day passes.
      if (/^\d{4}-\d{2}-\d{2}$/.test(dueText)) return dueText < targetDate;
      const due = Date.parse(dueText);
      return Number.isFinite(due) && due < nowMs;
    }).length;
    return {
      ok: true,
      date: targetDate,
      appointments: todayAppointments,
      upcoming,
      followups,
      pulse: {
        appointments_today: todayAppointments.length,
        appointments_week: weekCount,
        followups_open: followups.mine.length,
        followups_overdue: overdueFollowUps,
        followups_unclaimed: followups.unclaimed.length
      },
      count: todayAppointments.length
    };
  });

  app.get("/organizations/:orgId/sales/me/projects/:projectId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireSalesActor(request, orgId, "sales.dashboard.view|sales.schedule.view");
    const projectId = getParam(request.params, "projectId");
    const document = await readDocument(orgId, "projects", projectId).catch(() => null);
    if (!document) throw notFound("project_not_found", "Project was not found.");
    const project: JsonObject = projectData(document);
    const events = assignedSalesAppointments(project, actor);
    if (!events.length && !actor.management) {
      throw forbidden("sales_project_forbidden", "This project has no sales appointment assigned to this user.");
    }
    const appointments = events.map((event) => appointmentView(project, event)).sort(appointmentSort);
    const roleTokens = salesRoleTokens(actor);
    const todos = (await listWorkTodos(orgId, {
      project_id: projectId,
      user_id: actor.ctx.userId,
      role_ids: roleTokens,
      resource_group_ids: [],
      include_unassigned: false,
      include_completed: false
    })) as JsonObject[];
    const followups = todos.filter((node) => isFollowUpWorkNode(node)).map((node) =>
      todoView(node, asArray(node.assigned_user_ids).map(cleanText).includes(actor.ctx.userId)));
    const contact = projectPrimaryContact(project);
    return {
      ok: true,
      project: {
        id: cleanText(project.id),
        title: projectTitle(project),
        address: projectAddress(project),
        customer: contact,
        customer_name: contact.name,
        customer_phone: contact.phone,
        customer_email: contact.email,
        notes: cleanText(project.notes || project.project_notes || project.description),
        stage: cleanText(asObject(asObject(project.work_projection).primary_stage).title || project.status),
        lead_status: cleanText(project.lead_status),
        signature_requirements: asObject(project.signature_requirements)
      },
      appointments,
      followups
    };
  });

  app.get("/organizations/:orgId/sales/me/appointments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireSalesActor(request, orgId, "sales.schedule.view");
    const query = requestQuery(request);
    const from = validDate(query.start || query.from || query.date_from);
    const to = validDate(query.end || query.to || query.date_to);
    const search = cleanText(query.search || query.q).toLowerCase();
    let appointments = await allAssignedAppointments(orgId, actor);
    appointments = appointments.filter((entry) => {
      if (from && cleanText(entry.end_date) < from) return false;
      if (to && cleanText(entry.start_date) > to) return false;
      if (!search) return true;
      const haystack = [entry.project_title, entry.address, entry.customer_name, entry.notes].map(cleanText).join(" ").toLowerCase();
      return haystack.includes(search);
    });
    return { ok: true, appointments, count: appointments.length, range: { from, to }, search };
  });

  app.post("/organizations/:orgId/sales/me/followups", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireSalesActor(request, orgId, "sales.followups.manage", true);
    const body = requestBody(request);
    const title = cleanText(body.title);
    if (!title) throw badRequest("follow_up_title_required", "A follow-up title is required.");
    const result = await createFollowUpTodo(orgId, {
      project_id: cleanText(body.project_id || body.projectId),
      title,
      body: cleanText(body.body || body.description),
      due_at: cleanText(body.due_at || body.dueAt),
      channel: cleanText(body.channel || "call") || "call",
      origin: "sales_app",
      priority: body.priority,
      // Follow-ups created from the sales app belong to the salesperson who
      // created them.
      assigned_user_ids: [actor.ctx.userId],
      context: { actor_user_id: actor.ctx.userId }
    });
    reply.code(201);
    return { ok: true, follow_up: todoView(asObject(result.node), true) };
  });

  app.post("/organizations/:orgId/sales/me/followups/:nodeId/claim", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireSalesActor(request, orgId, "sales.followups.manage", true);
    const node = (await readNodeRecord(orgId, getParam(request.params, "nodeId")));
    if (!node || !isFollowUpWorkNode(node) || !followUpVisibleToActor(node, actor)) {
      throw notFound("follow_up_not_found", "This follow-up was not found or is not available to this user.");
    }
    const assigned = [...new Set([...asArray(node.assigned_user_ids).map(cleanText).filter(Boolean), actor.ctx.userId])];
    const updated = await patchWorkNode(orgId, cleanText(node.id), { assigned_user_ids: assigned });
    return { ok: true, follow_up: todoView(asObject(updated), true) };
  });

  app.post("/organizations/:orgId/sales/me/followups/:nodeId/outcome", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requireSalesActor(request, orgId, "sales.followups.manage", true);
    const node = (await readNodeRecord(orgId, getParam(request.params, "nodeId")));
    if (!node || !isFollowUpWorkNode(node) || !followUpVisibleToActor(node, actor)) {
      throw notFound("follow_up_not_found", "This follow-up was not found or is not available to this user.");
    }
    const body = requestBody(request);
    const result = await resolveFollowUpOutcome(orgId, cleanText(node.id), {
      ...body,
      actor_user_id: actor.ctx.userId,
      actor_email: cleanText(asObject(actor.ctx.user).email)
    });
    return {
      ok: true,
      outcome: result.outcome,
      completed: result.completed,
      successor: result.successor ? todoView(asObject(result.successor), true) : null
    };
  });
};
