import {listResourceTypes,saveResourceType,archiveResourceType} from './resource-types.js';
import {listSuppliers,saveSupplier,archiveSupplier,saveSupplierLocation,archiveSupplierLocation} from './suppliers.js';
import {listPaySheets,savePaySheet,archivePaySheet,paySheetRequirements} from '../labor/pay-sheets.js';
import {evaluateProjectPaySheets,requireLaborEnabled} from '../labor/pay-sheet-publication.js';
import {assigneeSchema} from '../labor/assignees.js';
import {commitLaborList,listCommitments,listDeliverySettings,saveDeliverySetting,releaseCommitment,redeliverCommitment,confirmDelivery,releaseCommitmentsForList,listUnits,saveUnit,archiveUnit,assigneeAvailability} from '../labor/commitments.js';
import type { FastifyPluginAsync } from "fastify";
import { registerCalculusApi } from "./calculus-api.js";
import { ZodError } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import {
  archiveMaterialList,
  createMaterialList,
  createMaterialOrder,
  createMaterialVersion,
  ensureMaterialListScheduleEvent,
  initializeProjectMaterialListsFromScope,
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
  ensureMaterialScheduleEventSchema,
  initializeMaterialListsFromScopeSchema,
  patchMaterialDeliverySchema,
  patchMaterialListSchema,
  patchMaterialOrderSchema,
  recordMaterialDeliverySchema
} from "./schemas.js";

export const registerMaterialsApi: FastifyPluginAsync = async (app) => {
  registerCalculusApi(app);
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
      initializeFromScope: "/organizations/:orgId/projects/:projectId/material-lists/initialize-from-scope",
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

  app.get('/organizations/:orgId/resource-types',async request=>{const orgId=getParam(request.params,'orgId');await requirePlatformAuth(request,{orgId,permission:'view_projects'});return {ok:true,resource_types:await listResourceTypes(orgId)};});
  app.post('/organizations/:orgId/resource-types',async(request,reply)=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_projects'});const resource_type=await saveResourceType(orgId,request.body,ctx,true);reply.code(201);return {ok:true,resource_type};});
  app.patch('/organizations/:orgId/resource-types/:typeId',async request=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_projects'});return {ok:true,resource_type:await saveResourceType(orgId,{...(request.body as Record<string,unknown>),id:getParam(request.params,'typeId')},ctx)};});
  app.delete('/organizations/:orgId/resource-types/:typeId',async request=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_projects'});return {ok:true,resource_type:await archiveResourceType(orgId,{...((request.body??{}) as Record<string,unknown>),id:getParam(request.params,'typeId')},ctx)};});
  // Pay sheets are compensation records: reading them needs the same access as editing company settings.
  const laborAuth=async(request:Parameters<typeof requirePlatformAuth>[0]&{params:unknown},permission:string,write=false)=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,permission,...(write?{csrf:true}:{})});await requireLaborEnabled(orgId);return {orgId,ctx};};
  app.get('/organizations/:orgId/pay-sheets',async request=>{const {orgId}=await laborAuth(request,'manage_company_settings');const sheets=await listPaySheets(orgId);return {ok:true,pay_sheets:sheets,requirements:sheets.map(paySheetRequirements)};});
  app.post('/organizations/:orgId/pay-sheets',async(request,reply)=>{const {orgId,ctx}=await laborAuth(request,'manage_company_settings',true);const {id:_id,...body}=(request.body||{}) as Record<string,unknown>;reply.code(201);return {ok:true,pay_sheet:await savePaySheet(orgId,body,ctx)};});
  app.patch('/organizations/:orgId/pay-sheets/:sheetId',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_company_settings',true);return {ok:true,pay_sheet:await savePaySheet(orgId,{...(request.body as object),id:getParam(request.params,'sheetId')},ctx)};});
  app.delete('/organizations/:orgId/pay-sheets/:sheetId',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_company_settings',true);return {ok:true,...await archivePaySheet(orgId,{id:getParam(request.params,'sheetId')},ctx)};});
  // Prices every pay sheet (or one) against a project, so assignees can be compared on the same job. Reads only.
  app.post('/organizations/:orgId/projects/:projectId/pay-sheets/evaluate',async request=>{const {orgId}=await laborAuth(request,'manage_projects');const body=(request.body||{}) as {sheet_id?:string;fields?:Record<string,number>;manual?:Record<string,number>};return {ok:true,evaluations:await evaluateProjectPaySheets(orgId,getParam(request.params,'projectId'),{sheet_id:body.sheet_id,fields:body.fields,manual:body.manual})};});
  // Freezes a labor list and hands it to its assignee. The same key sent twice returns the first commitment.
  app.post('/organizations/:orgId/lists/:listId/commit',async(request,reply)=>{const {orgId,ctx}=await laborAuth(request,'manage_projects',true);const body=(request.body||{}) as {note?:string;unit_id?:string;idempotency_key?:string};const key=String(body.idempotency_key||request.headers['idempotency-key']||'');reply.code(201);return {ok:true,commitment:await commitLaborList(orgId,{list_id:getParam(request.params,'listId'),...(body.note?{note:body.note}:{}),...(body.unit_id?{unit_id:body.unit_id}:{}),...(key?{idempotency_key:key}:{})},ctx)};});
  app.get('/organizations/:orgId/projects/:projectId/labor-commitments',async request=>{const {orgId}=await laborAuth(request,'manage_projects');return {ok:true,commitments:await listCommitments(orgId,{project_id:getParam(request.params,'projectId')})};});
  app.post('/organizations/:orgId/labor-commitments/:commitmentId/release',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_projects',true);const reason=((request.body||{}) as {reason?:string}).reason;return {ok:true,commitment:await releaseCommitment(orgId,{id:getParam(request.params,'commitmentId'),...(reason?{reason}:{})},ctx)};});
  app.post('/organizations/:orgId/labor-commitments/:commitmentId/deliver',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_projects',true);return {ok:true,commitment:await redeliverCommitment(orgId,{id:getParam(request.params,'commitmentId')},ctx)};});
  app.post('/organizations/:orgId/labor-commitments/:commitmentId/confirm-delivery',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_projects',true);const detail=((request.body||{}) as {detail?:string}).detail;return {ok:true,commitment:await confirmDelivery(orgId,{id:getParam(request.params,'commitmentId'),...(detail?{detail}:{})},ctx)};});
  app.get('/organizations/:orgId/labor-delivery-settings',async request=>{const {orgId}=await laborAuth(request,'manage_company_settings');return {ok:true,settings:await listDeliverySettings(orgId)};});
  app.put('/organizations/:orgId/labor-delivery-settings',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_company_settings',true);return {ok:true,setting:await saveDeliverySetting(orgId,request.body,ctx)};});
  // Units inside an assignee, and how much the assignee can take on given what it is committed to.
  app.get('/organizations/:orgId/assignees/:type/:assigneeId',async request=>{const {orgId}=await laborAuth(request,'manage_projects|manage_company_settings');const assignee=assigneeSchema.parse({type:getParam(request.params,'type'),id:getParam(request.params,'assigneeId')});return {ok:true,units:await listUnits(orgId,assignee),availability:await assigneeAvailability(orgId,assignee)};});
  app.post('/organizations/:orgId/assignee-units',async(request,reply)=>{const {orgId,ctx}=await laborAuth(request,'manage_company_settings',true);const {id:_id,...body}=(request.body||{}) as Record<string,unknown>;reply.code(201);return {ok:true,unit:await saveUnit(orgId,body,ctx)};});
  app.patch('/organizations/:orgId/assignee-units/:unitId',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_company_settings',true);return {ok:true,unit:await saveUnit(orgId,{...(request.body as object),id:getParam(request.params,'unitId')},ctx)};});
  app.delete('/organizations/:orgId/assignee-units/:unitId',async request=>{const {orgId,ctx}=await laborAuth(request,'manage_company_settings',true);return {ok:true,...await archiveUnit(orgId,{id:getParam(request.params,'unitId')},ctx)};});
  app.get('/organizations/:orgId/suppliers',async request=>{const orgId=getParam(request.params,'orgId');await requirePlatformAuth(request,{orgId,permission:'view_projects|manage_company_settings'});return {ok:true,suppliers:await listSuppliers(orgId)};});
  app.post('/organizations/:orgId/suppliers',async(request,reply)=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_company_settings'});const {id:_id,...body}=(request.body??{}) as Record<string,unknown>;const supplier=await saveSupplier(orgId,body,ctx);reply.code(201);return {ok:true,supplier};});
  app.patch('/organizations/:orgId/suppliers/:supplierId',async request=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_company_settings'});return {ok:true,supplier:await saveSupplier(orgId,{...((request.body??{}) as Record<string,unknown>),id:getParam(request.params,'supplierId')},ctx)};});
  app.delete('/organizations/:orgId/suppliers/:supplierId',async request=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_company_settings'});return {ok:true,supplier:await archiveSupplier(orgId,{...((request.body??{}) as Record<string,unknown>),id:getParam(request.params,'supplierId')},ctx)};});
  app.post('/organizations/:orgId/suppliers/:supplierId/locations',async(request,reply)=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_company_settings'});const {id:_id,...body}=(request.body??{}) as Record<string,unknown>;const location=await saveSupplierLocation(orgId,{...body,supplier_id:getParam(request.params,'supplierId')},ctx);reply.code(201);return {ok:true,location};});
  app.patch('/organizations/:orgId/suppliers/:supplierId/locations/:locationId',async request=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_company_settings'});return {ok:true,location:await saveSupplierLocation(orgId,{...((request.body??{}) as Record<string,unknown>),supplier_id:getParam(request.params,'supplierId'),id:getParam(request.params,'locationId')},ctx)};});
  app.delete('/organizations/:orgId/suppliers/:supplierId/locations/:locationId',async request=>{const orgId=getParam(request.params,'orgId'),ctx=await requirePlatformAuth(request,{orgId,csrf:true,permission:'manage_company_settings'});return {ok:true,location:await archiveSupplierLocation(orgId,{...((request.body??{}) as Record<string,unknown>),id:getParam(request.params,'locationId')},ctx)};});
  app.get("/organizations/:orgId/projects/:projectId/material-lists", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const lists = await listProjectMaterialLists(orgId, getParam(request.params, "projectId"));
    return { ok: true, material_lists: lists, resource_types:await listResourceTypes(orgId), count: lists.length };
  });

  app.post("/organizations/:orgId/projects/:projectId/material-lists", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = createMaterialListSchema.parse(request.body ?? {});
    const materialList = await createMaterialList(orgId, getParam(request.params, "projectId"), body, ctx);
    reply.code(201);
    return { ok: true, material_list: materialList };
  });

  app.post("/organizations/:orgId/projects/:projectId/material-lists/initialize-from-scope", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = initializeMaterialListsFromScopeSchema.parse(request.body ?? {});
    const result = await initializeProjectMaterialListsFromScope(orgId, getParam(request.params, "projectId"), body, ctx);
    return { ok: true, ...result };
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

  app.post("/organizations/:orgId/material-lists/:listId/schedule-event", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = ensureMaterialScheduleEventSchema.parse(request.body ?? {});
    const listId = getParam(request.params, "listId");
    const event = await ensureMaterialListScheduleEvent(orgId, listId, body);
    const materialList = await readMaterialList(orgId, listId);
    return { ok: true, event, material_list: materialList };
  });

  app.delete("/organizations/:orgId/material-lists/:listId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = archiveMaterialListSchema.parse(request.body ?? {});
    const materialList = await archiveMaterialList(orgId, getParam(request.params, "listId"), body, ctx);
    await releaseCommitmentsForList(orgId, getParam(request.params, "listId"), ctx);
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
