import { hasResourcePermission, matchesDepartmentFilter, relevantDepartmentContext } from "../workforce/department-access.js";
import { forbidden } from "../platform/errors.js";
import { createTodo } from "./todos.js";
import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { userPublicationContext } from "../platform/publication/context.js";
import { PlatformError } from "../platform/errors.js";
import { readDocument, upsertDocument } from "../platform/storage.js";
import "./instructions.js";
import { registerBuiltinWorkAutomations } from "./automations/builtins.js";
import { readWorkConfiguration, saveWorkConfiguration } from "./config.js";
import { emitWorkEvent } from "./engine.js";
import { resolveFollowUpOutcome } from "./followups.js";
import { listWorkAutomations } from "./registry.js";
import { createWorkPlanSchema, emitWorkEventSchema, patchWorkNodeSchema, setManualPlanStageSchema, transitionWorkNodeSchema } from "./schemas.js";
import { startWorkScheduler } from "./scheduler.js";
import {
  createWorkPlan,
  listWorkPlans,
  listWorkBoards,
  listWorkTodos,
  patchWorkNode,
  projectWorkProjection,
  setManualPlanStage,
  transitionWorkNode,
  workPlanTree
} from "./service.js";
import { ensurePipelinePlanForProject } from "../scopes/router.js";
import { listEventRecords, listExecutionRecords, listNodeRecords, readNodeRecord, readPlanRecord } from "./storage.js";

const objectSchema = z.object({}).passthrough();

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

function boolValue(value: unknown) {
  return [true, 1, "1", "true", "yes"].includes(value as never);
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}


export const registerWorkApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.addHook("preHandler", async request => {
    const orgId = getParam(request.params, "orgId");
    if (!orgId) return;
    const nodeId = getParam(request.params, "nodeId"), planId = getParam(request.params, "planId");
    if (!nodeId && !planId) return;
    const ctx = await requirePlatformAuth(request, { orgId });
    const resource = nodeId ? await readNodeRecord(orgId, nodeId) : await readPlanRecord(orgId, planId);
    const permission = request.method === "GET" ? "view_projects" : "manage_projects";
    if (resource && !hasResourcePermission(ctx, permission, resource)) throw forbidden("work_department_denied", "This work is outside your department access.");
    if (resource && request.method === "PATCH" && !hasResourcePermission(ctx, permission, { ...resource, ...asObject(request.body) })) throw forbidden("work_department_denied", "The destination department is outside your access.");
  });
  registerBuiltinWorkAutomations();
  startWorkScheduler();

  app.get("/", async () => ({ ok: true, api: "work", automations: listWorkAutomations() }));

  app.get("/organizations/:orgId/projects/:projectId/plans", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects", allowScopedPermission: true });
    const projectId = getParam(request.params, "projectId");
    const projectDocument = await readDocument(orgId, "projects", projectId).catch(() => null);
    if (projectDocument) await ensurePipelinePlanForProject(orgId, { id: projectId, ...objectSchema.parse(projectDocument.data) });
    const query = objectSchema.parse(request.query ?? {});
    const departmentCtx = await requirePlatformAuth(request, { orgId });
    const plans: Record<string, unknown>[] = (await listWorkPlans(orgId, { ...query, project_id: projectId })).filter(plan => hasResourcePermission(departmentCtx, "view_projects", asObject(plan)) && matchesDepartmentFilter(departmentCtx, asObject(plan), cleanText(query.department_id)));
    return {
      ok: true,
      plans: boolValue(query.include_tree) ? (await Promise.all(plans.map(async (plan) => (await workPlanTree(orgId, String(plan.id), departmentCtx))))) : plans,
      count: plans.length
    };
  });

  app.post("/organizations/:orgId/projects/:projectId/plans", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects", allowScopedPermission: true });
    const body = createWorkPlanSchema.parse({
      ...objectSchema.parse(request.body ?? {}),
      project_id: getParam(request.params, "projectId"),
      branch_id: String(objectSchema.parse(request.body ?? {}).branch_id || ctx.branchId || "default")
    });
    if (!hasResourcePermission(ctx, "manage_projects", body)) throw forbidden("work_department_denied", "This work is outside your department access.");
    const result = await createWorkPlan({ ...body, organization_id: orgId });
    reply.code(result.created ? 201 : 200);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/plans/:planId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects", allowScopedPermission: true });
    return { ok: true, plan: (await workPlanTree(orgId, getParam(request.params, "planId"), await requirePlatformAuth(request, { orgId }))) };
  });

  app.put("/organizations/:orgId/plans/:planId/manual-stage", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, {
      orgId,
      csrf: true,
      permission: "manage_projects", allowScopedPermission: true,
      capability: "platform.manual_project_stage_movement"
    });
    const body = setManualPlanStageSchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await setManualPlanStage(orgId, getParam(request.params, "planId"), body.stage_id, {
        actor_user_id: ctx.userId,
        actor_email: String(ctx.identity.email || "")
      }))
    };
  });

  app.get("/organizations/:orgId/nodes", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects", allowScopedPermission: true });
    const query = objectSchema.parse(request.query ?? {});
    const nodes = (await listNodeRecords(orgId, {
      ...query,
      actionable: boolValue(query.actionable),
      open_only: boolValue(query.open_only)
    }));
    const departmentCtx = await requirePlatformAuth(request, { orgId });
    const visible = nodes.filter(node => hasResourcePermission(departmentCtx, "view_projects", node) && matchesDepartmentFilter(departmentCtx, node, cleanText(query.department_id)));
    return { ok: true, nodes: visible, count: visible.length };
  });

  app.get("/organizations/:orgId/nodes/:nodeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects", allowScopedPermission: true });
    return { ok: true, node: (await readNodeRecord(orgId, getParam(request.params, "nodeId"))) };
  });

  app.patch("/organizations/:orgId/nodes/:nodeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects", allowScopedPermission: true });
    const patch = patchWorkNodeSchema.parse(request.body ?? {});
    return { ok: true, node: await patchWorkNode(orgId, getParam(request.params, "nodeId"), patch) };
  });

  app.post("/organizations/:orgId/nodes/:nodeId/transition", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects", allowScopedPermission: true });
    const body = transitionWorkNodeSchema.parse(request.body ?? {});
    return {
      ok: true,
      node: await transitionWorkNode(orgId, getParam(request.params, "nodeId"), body.status, {
        ...body,
        actor_user_id: ctx.userId,
        actor_email: String(ctx.identity.email || "")
      })
    };
  });

  app.get("/organizations/:orgId/todos", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_projects", allowScopedPermission: true });
    const query = objectSchema.parse(request.query ?? {});
    // This is a management route (view_projects): a project-scoped query is
    // the office's project to-do list and always shows every assignment.
    // Contact-scoped queries (contact_id / project_ids) behave the same way.
    const contactScoped = !!(getParam(query, "contact_id") || getParam(query, "contact_email")
      || getParam(query, "contact_phone") || getParam(query, "project_ids"));
    const allUsers = boolValue(query.all_users) || !!getParam(query, "project_id") || contactScoped;
    // Role tokens for assignment matching: legacy management roles, the
    // user's workforce access role ids (crew_member, supervisor, custom
    // roles...), and the "office" token for any management-application user.
    const managementEnabled = asObject(asObject(ctx.applicationAccess).management).enabled === true;
    const roles = allUsers ? [] : [
      ...asArray(ctx.user.roles),
      ...asArray(asObject(ctx.user).access_role_ids),
      ctx.role,
      ...(managementEnabled ? ["office", "management"] : [])
    ].map(String).filter(Boolean);
    const todos = (await listWorkTodos(orgId, {
      ...query,
      user_id: allUsers ? "" : ctx.userId,
      role_ids: roles,
      include_unassigned: boolValue(query.include_unassigned) || !!getParam(query, "project_id") || contactScoped,
      include_completed: boolValue(query.include_completed),
      include_future: boolValue(query.include_future)
    })).filter(node => hasResourcePermission(ctx, "view_projects", node) && matchesDepartmentFilter(ctx, node, cleanText(query.department_id)));
    const projectIds = [...new Set(todos.map((todo) => cleanText(todo.project_id)).filter(Boolean))];
    const projectLabels = new Map<string, { title: string; address: string }>();
    await Promise.all(projectIds.map(async (projectId) => {
      const document = await readDocument(orgId, "projects", projectId).catch(() => null);
      const project = asObject(document?.data);
      if (!document) return;
      projectLabels.set(projectId, {
        title: cleanText(project.title || project.project_title || project.project_name || project.customer_name || project.address),
        address: cleanText(project.address || project.project_address)
      });
    }));
    const enrichedTodos = todos.map((todo) => {
      const label = projectLabels.get(cleanText(todo.project_id));
      return label ? { ...todo, project_title: label.title, project_address: label.address } : todo;
    });
    return { ok: true, todos: enrichedTodos, count: enrichedTodos.length, department_context: relevantDepartmentContext(ctx) };
  });

  app.post("/organizations/:orgId/todos", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects", allowScopedPermission: true });
    const body = objectSchema.parse(request.body ?? {});
    const result = await createTodo(orgId, body, ctx);
    reply.code(result.created ? 201 : 200);
    return { ok: true, todo: result.todo, plan: result.plan };
  });

  app.post("/organizations/:orgId/follow-ups/:nodeId/outcome", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects", allowScopedPermission: true });
    const body = objectSchema.parse(request.body ?? {});
    return {
      ok: true,
      result: await resolveFollowUpOutcome(orgId, getParam(request.params, "nodeId"), {
        ...body,
        actor_user_id: ctx.userId,
        actor_email: String(ctx.identity.email || "")
      })
    };
  });

  app.get("/organizations/:orgId/projects/:projectId/projection", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    return { ok: true, projection: (await projectWorkProjection(orgId, getParam(request.params, "projectId"))) };
  });

  app.get("/organizations/:orgId/boards", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const auth = await requirePlatformAuth(request, { orgId, permission: "view_projects", allowScopedPermission: true });
    const boards = await listWorkBoards(orgId, objectSchema.parse(request.query ?? {}), userPublicationContext(auth));
    return { ok: true, boards, count: boards.length, department_context: relevantDepartmentContext(auth) };
  });

  app.get("/organizations/:orgId/branches/:branchId/config", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    return { ok: true, configuration: await readWorkConfiguration(orgId, getParam(request.params, "branchId") || "default") };
  });

  app.put("/organizations/:orgId/branches/:branchId/config", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return {
      ok: true,
      configuration: await saveWorkConfiguration(orgId, getParam(request.params, "branchId") || "default", objectSchema.parse(request.body ?? {}))
    };
  });

  app.get("/organizations/:orgId/events", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = objectSchema.parse(request.query ?? {});
    return { ok: true, events: (await listEventRecords(orgId, query)) };
  });

  app.get("/organizations/:orgId/executions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, executions: (await listExecutionRecords(orgId, objectSchema.parse(request.query ?? {}))) };
  });

  app.post("/organizations/:orgId/events/emit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = emitWorkEventSchema.parse(request.body ?? {});
    const event = await emitWorkEvent({
      ...body,
      organization_id: orgId,
      branch_id: ctx.branchId || "default",
      type: body.event,
      context: { ...body.context, actor_user_id: ctx.userId, actor_email: String(ctx.identity.email || "") }
    });
    return { ok: true, event };
  });

  app.get("/organizations/:orgId/automations", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, automations: listWorkAutomations() };
  });

  // Organization automation rules — the always-on layer above scope sets.
  app.get("/organizations/:orgId/branches/:branchId/automation-rules", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const { readAutomationRules } = await import("./rules.js");
    return { ok: true, ...(await readAutomationRules(orgId, getParam(request.params, "branchId") || "default")) };
  });

  app.put("/organizations/:orgId/branches/:branchId/automation-rules", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const { saveAutomationRules } = await import("./rules.js");
    return { ok: true, ...(await saveAutomationRules(orgId, getParam(request.params, "branchId") || "default", objectSchema.parse(request.body ?? {}))) };
  });

  // Browsable catalog of every registered platform event — the trigger picker
  // for scope-template and automation-rule editors.
  app.get("/organizations/:orgId/event-catalog", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const { listWorkEventDefinitions } = await import("./events.js");
    return { ok: true, events: listWorkEventDefinitions() };
  });

  // Human-relevant activity feeds built on the same event store the engine
  // runs on. `visibility=all` exposes system events for debugging.
  app.get("/organizations/:orgId/activity", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = objectSchema.parse(request.query ?? {});
    const visibility = cleanText(query.visibility) === "all" ? "" : cleanText(query.visibility) || "activity";
    const events = (await listEventRecords(orgId, { ...query, visibility }));
    return { ok: true, events, count: events.length, next_before: events.length ? cleanText((events[events.length - 1] as Record<string, unknown>).created_at) : "" };
  });

  app.get("/organizations/:orgId/projects/:projectId/activity", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = objectSchema.parse(request.query ?? {});
    const visibility = cleanText(query.visibility) === "all" ? "" : cleanText(query.visibility) || "activity";
    const events = (await listEventRecords(orgId, { ...query, project_id: getParam(request.params, "projectId"), visibility }));
    return { ok: true, events, count: events.length, next_before: events.length ? cleanText((events[events.length - 1] as Record<string, unknown>).created_at) : "" };
  });

  // Marks a project lost: cancels its live pipeline scope instances (which
  // drives lifecycle.status to "lost") and records the lead status.
  app.post("/organizations/:orgId/projects/:projectId/lost", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = objectSchema.parse(request.body ?? {});
    const { cancelPipelinePlansForProject } = await import("./service.js");
    const canceled = await cancelPipelinePlansForProject(orgId, projectId, "lost");
    const document = await readDocument(orgId, "projects", projectId).catch(() => null);
    if (document) {
      const data = { ...(document.data as Record<string, unknown>), lead_status: "lost", updated_at: new Date().toISOString() };
      await upsertDocument(orgId, "projects", { id: projectId, data, metadata: document.metadata }, { replace: true });
    }
    return { ok: true, canceled_plan_ids: canceled, reason: String(body.reason || "lost") };
  });
};
