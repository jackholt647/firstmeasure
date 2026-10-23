import type { FastifyInstance } from "fastify";
import { requirePlatformAuth } from "../platform/auth.js";
import { checkPublicShoppingListItem, createShoppingList, preparePurchaseOrder, publicShoppingList, readShoppingList, renderPurchaseOrderPdf, renderShoppingListPdf, sendSupplierOrderEmail, shareShoppingList } from "./ordering.js";
import { shoppingListAppHtml } from "./shopping-list-page.js";

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

const SEND_PERMISSION = "send_comms|send_communications|manage_projects|manage_company_settings";
const safeName = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "-") || "document.pdf";

/** The order window's purchase orders, supplier emails and shopping lists (materials/ordering.ts), under /v1/materials. */
export function registerMaterialOrderingApi(app: FastifyInstance) {
  const project = "/organizations/:orgId/projects/:projectId";

  app.post(`${project}/purchase-orders/preview`, async (request) => {
    const ctx = await requirePlatformAuth(request, { orgId: getParam(request.params, "orgId"), csrf: true, permission: "manage_projects" });
    return { ok: true, ...await preparePurchaseOrder(ctx.orgId, getParam(request.params, "projectId"), request.body, ctx) };
  });

  app.post(`${project}/purchase-orders/pdf`, async (request, reply) => {
    const ctx = await requirePlatformAuth(request, { orgId: getParam(request.params, "orgId"), csrf: true, permission: "manage_projects" });
    const file = await renderPurchaseOrderPdf(ctx.orgId, getParam(request.params, "projectId"), request.body, ctx);
    reply.type(file.contentType);
    reply.header("Content-Disposition", `attachment; filename="${safeName(file.fileName)}"`);
    reply.header("X-Purchase-Order-Number", file.poNumber);
    reply.header("X-Document-Id", file.documentId);
    return reply.send(file.bytes);
  });

  app.post(`${project}/supplier-emails`, async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SEND_PERMISSION, capability: "comms.email" });
    return { ok: true, ...await sendSupplierOrderEmail(orgId, getParam(request.params, "projectId"), request.body, ctx) };
  });

  app.post(`${project}/shopping-lists`, async (request, reply) => {
    const ctx = await requirePlatformAuth(request, { orgId: getParam(request.params, "orgId"), csrf: true, permission: "manage_projects" });
    const shoppingList = await createShoppingList(ctx.orgId, getParam(request.params, "projectId"), request.body, ctx);
    reply.code(201);
    return { ok: true, shopping_list: shoppingList };
  });

  app.get(`${project}/shopping-lists/:checklistId`, async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_projects" });
    return { ok: true, shopping_list: await readShoppingList(orgId, getParam(request.params, "projectId"), getParam(request.params, "checklistId")) };
  });

  app.post(`${project}/shopping-lists/:checklistId/share`, async (request) => {
    const ctx = await requirePlatformAuth(request, { orgId: getParam(request.params, "orgId"), csrf: true, permission: "manage_projects" });
    return { ok: true, ...await shareShoppingList(ctx.orgId, getParam(request.params, "projectId"), getParam(request.params, "checklistId"), request.body, ctx) };
  });

  app.get(`${project}/shopping-lists/:checklistId/pdf`, async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_projects" });
    const file = await renderShoppingListPdf(orgId, getParam(request.params, "projectId"), getParam(request.params, "checklistId"), ctx);
    reply.type(file.contentType);
    reply.header("Content-Disposition", `attachment; filename="${safeName(file.fileName)}"`);
    return reply.send(file.bytes);
  });

  // ── Public: the shopping list behind a link ────────────────────────────────
  app.get("/public/shopping-lists/:token/app", async (request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    return reply.send(shoppingListAppHtml(getParam(request.params, "token")));
  });

  app.get("/public/shopping-lists/:token", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { ok: true, shopping_list: await publicShoppingList(getParam(request.params, "token")) };
  });

  app.post("/public/shopping-lists/:token/items/:itemId", async (request) => {
    return { ok: true, item: await checkPublicShoppingListItem(getParam(request.params, "token"), getParam(request.params, "itemId"), request.body ?? {}) };
  });
}
