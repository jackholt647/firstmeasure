import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import {
  archiveMaterialList,
  createMaterialList,
  createMaterialOrder,
  createMaterialVersion,
  listMaterialDeliveries,
  listMaterialEvents,
  listMaterialOrders,
  listMaterialVersions,
  listProjectMaterialLists,
  patchMaterialDelivery,
  patchMaterialList,
  patchMaterialOrder,
  readMaterialList,
  readMaterialOrder,
  recordMaterialDelivery
} from "./storage.js";
import {
  archiveMaterialListSchema,
  createMaterialListSchema,
  createMaterialOrderSchema,
  createMaterialVersionSchema,
  patchMaterialDeliverySchema,
  patchMaterialListSchema,
  patchMaterialOrderSchema,
  recordMaterialDeliverySchema
} from "./schemas.js";

export const registerMaterialsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
    }
    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      reply.code(Number((error as { statusCode: number }).statusCode));
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "materials",
    message: "materials API is mounted",
    endpoints: {
      projectMaterialLists: "/organizations/:orgId/projects/:projectId/material-lists",
      materialList: "/organizations/:orgId/material-lists/:listId",
      versions: "/organizations/:orgId/material-lists/:listId/versions",
      orders: "/organizations/:orgId/material-lists/:listId/orders",
      order: "/organizations/:orgId/material-orders/:orderId",
      deliveries: "/organizations/:orgId/material-orders/:orderId/deliveries",
      events: "/organizations/:orgId/material-lists/:listId/events"
    }
  }));

  app.get("/ping", async (request) => ({
    ok: true,
    api: "materials",
    route: "/ping",
    method: request.method,
    receivedAt: new Date().toISOString()
  }));

  app.get("/organizations/:orgId/projects/:projectId/material-lists", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const lists = await listProjectMaterialLists(orgId, getParam(request.params, "projectId"));
    return { ok: true, material_lists: lists, count: lists.length };
  });

  app.post("/organizations/:orgId/projects/:projectId/material-lists", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createMaterialListSchema.parse(request.body ?? {});
    const materialList = await createMaterialList(orgId, getParam(request.params, "projectId"), body, ctx);
    reply.code(201);
    return { ok: true, material_list: materialList };
  });

  app.get("/organizations/:orgId/material-lists/:listId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const materialList = await readMaterialList(orgId, getParam(request.params, "listId"));
    return { ok: true, material_list: materialList };
  });

  app.patch("/organizations/:orgId/material-lists/:listId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = patchMaterialListSchema.parse(request.body ?? {});
    const materialList = await patchMaterialList(orgId, getParam(request.params, "listId"), body, ctx);
    return { ok: true, material_list: materialList };
  });

  app.delete("/organizations/:orgId/material-lists/:listId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = archiveMaterialListSchema.parse(request.body ?? {});
    const materialList = await archiveMaterialList(orgId, getParam(request.params, "listId"), body, ctx);
    return { ok: true, material_list: materialList };
  });

  app.get("/organizations/:orgId/material-lists/:listId/versions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const versions = await listMaterialVersions(orgId, getParam(request.params, "listId"));
    return { ok: true, versions, count: versions.length };
  });

  app.post("/organizations/:orgId/material-lists/:listId/versions", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createMaterialVersionSchema.parse(request.body ?? {});
    const result = await createMaterialVersion(orgId, getParam(request.params, "listId"), body, ctx);
    reply.code(201);
    return { ok: true, material_list: result.list, version: result.version };
  });

  app.get("/organizations/:orgId/material-lists/:listId/orders", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const orders = await listMaterialOrders(orgId, getParam(request.params, "listId"));
    return { ok: true, orders, count: orders.length };
  });

  app.post("/organizations/:orgId/material-lists/:listId/orders", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createMaterialOrderSchema.parse(request.body ?? {});
    const result = await createMaterialOrder(orgId, getParam(request.params, "listId"), body, ctx);
    reply.code(201);
    return { ok: true, material_list: result.list, version: result.version, order: result.order };
  });

  app.get("/organizations/:orgId/material-orders/:orderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const order = await readMaterialOrder(orgId, getParam(request.params, "orderId"));
    return { ok: true, order };
  });

  app.patch("/organizations/:orgId/material-orders/:orderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = patchMaterialOrderSchema.parse(request.body ?? {});
    const order = await patchMaterialOrder(orgId, getParam(request.params, "orderId"), body, ctx);
    return { ok: true, order };
  });

  app.get("/organizations/:orgId/material-orders/:orderId/deliveries", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const deliveries = await listMaterialDeliveries(orgId, getParam(request.params, "orderId"));
    return { ok: true, deliveries, count: deliveries.length };
  });

  app.post("/organizations/:orgId/material-orders/:orderId/deliveries", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = recordMaterialDeliverySchema.parse(request.body ?? {});
    const delivery = await recordMaterialDelivery(orgId, getParam(request.params, "orderId"), body, ctx);
    reply.code(201);
    return { ok: true, delivery };
  });

  app.patch("/organizations/:orgId/material-deliveries/:deliveryId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = patchMaterialDeliverySchema.parse(request.body ?? {});
    const delivery = await patchMaterialDelivery(orgId, getParam(request.params, "deliveryId"), body, ctx);
    return { ok: true, delivery };
  });

  app.get("/organizations/:orgId/material-lists/:listId/events", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const events = await listMaterialEvents(orgId, getParam(request.params, "listId"));
    return { ok: true, events, count: events.length };
  });
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}
