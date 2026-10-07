import {authorizeEquipmentUnit,authorizeEquipmentWorkOrder,authorizeEquipmentOwner,filterEquipmentUnits,filterEquipmentRows,visibleEquipmentUnitIds} from './access.js';
import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { requirePlatformAuth as platformAuth, hasPermission, relevantDepartmentContext } from "../platform/auth.js";
import { PlatformError,forbidden } from "../platform/errors.js";
import {
  completeWorkOrderSchema,
  createWorkOrderSchema,
  meterEntrySchema,
  moduleSettingsSchema,
  patchUnitSchema,
  patchWorkOrderSchema,
  saveCategorySchema,
  saveProgramSchema,
  saveTypeSchema,
  saveYardSchema,
  saveUnitSchema,
  scheduleWorkOrderSchema
} from "./schemas.js";
import {
  availabilityForEquipment,
  cancelWorkOrder,
  checkInUnit,
  checkOutUnit,
  completeWorkOrder,
  dashboard,
  ensureEquipmentSeed,
  fleetUnits,
  logMeterEntry,
  openWorkOrder,
  readModuleSettings,
  scheduleWorkOrder,
  unitHistory,
  upcomingService,
  utilization,
  workOrdersWithSchedule,
  writeModuleSettings
} from "./service.js";
import {
  archiveCategory,
  archiveType,
  archiveUnit,
  archiveYard,
  listCategories,
  listPrograms,
  listTypes,
  listYards,
  listWorkOrders,
  patchUnit,
  readProgram,
  readType,
  readUnit,
  readWorkOrder,
  recordMeterEntry,
  saveCategory,
  saveProgram,
  saveType,
  saveYard,
  saveUnit,
  saveWorkOrder
} from "./storage.js";

const VIEW_PERMISSION = "equipment.view|equipment.manage|equipment.service|manage_company_settings";
const MANAGE_PERMISSION = "equipment.manage|manage_company_settings";
const SERVICE_PERMISSION = "equipment.manage|equipment.service|manage_company_settings";
const CAPABILITY = "apps.equipment";
const MAINTENANCE_CAPABILITY = "equipment.maintenance";

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

function getQuery(query: unknown, key: string) {
  return getParam(query, key);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

async function requirePlatformAuth(request:Parameters<typeof platformAuth>[0],options:NonNullable<Parameters<typeof platformAuth>[1]>){
  const url=request.url.split('?')[0]||'';
  const resourceRoute=/\/(units|work-orders|service-programs|due-service|dashboard|availability|utilization)(\/|$)/.test(url);
  const ctx=await platformAuth(request,{...options,allowScopedPermission:request.method==='GET'||resourceRoute});
  const permission=options.permission||VIEW_PERMISSION;
  const unitId=getParam(request.params,'unitId'),orderId=getParam(request.params,'workOrderId');
  if(unitId)await authorizeEquipmentUnit(ctx,unitId,permission);
  if(orderId)await authorizeEquipmentWorkOrder(ctx,orderId,permission);
  const body=asRecord(request.body);
  if(body.unit_id)await authorizeEquipmentUnit(ctx,String(body.unit_id),permission);
  if(request.method!=='GET'&&/\/service-programs(?:\/|$)/.test(url)&&!hasPermission(ctx,permission))throw forbidden('equipment_program_denied','Organization-wide permission is required to manage shared maintenance programs.');
  return ctx;
}

async function requireViewer(request: Parameters<typeof requirePlatformAuth>[0], orgId: string) {
  return requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: VIEW_PERMISSION, capability: CAPABILITY });
}

/* Read-only equipment data the scheduler needs to book units (types, conflict
 * mode, availability) is also open to schedule editors without equipment
 * permissions, so they see reserved/down units before saving instead of
 * after a 409. */
async function requireScheduleReader(request: Parameters<typeof requirePlatformAuth>[0], orgId: string) {
  return requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: `${VIEW_PERMISSION}|manage_schedule`, capability: CAPABILITY });
}

async function requireManager(request: Parameters<typeof requirePlatformAuth>[0], orgId: string) {
  return requirePlatformAuth(request, { orgId, permission: MANAGE_PERMISSION, capability: CAPABILITY, csrf: true });
}

export const registerEquipmentApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({ ok: true, api: "equipment" }));

  /* Categories. */

  app.get("/organizations/:orgId/categories", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    (await ensureEquipmentSeed(orgId));
    const categories = (await listCategories(orgId, { includeArchived: getQuery(request.query, "include_archived") === "1" }));
    return { ok: true, categories, count: categories.length };
  });

  app.post("/organizations/:orgId/categories", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = saveCategorySchema.parse(request.body ?? {});
    return { ok: true, category: (await saveCategory(orgId, { ...body, id: "" })) };
  });

  app.patch("/organizations/:orgId/categories/:categoryId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = saveCategorySchema.parse({ ...(request.body as object ?? {}), id: getParam(request.params, "categoryId") });
    return { ok: true, category: (await saveCategory(orgId, body)) };
  });

  app.delete("/organizations/:orgId/categories/:categoryId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    return { ok: true, category: (await archiveCategory(orgId, getParam(request.params, "categoryId"))) };
  });

  /* Types. */

  app.get("/organizations/:orgId/types", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireScheduleReader(request, orgId);
    (await ensureEquipmentSeed(orgId));
    const types = (await listTypes(orgId, {
      includeArchived: getQuery(request.query, "include_archived") === "1",
      categoryId: getQuery(request.query, "category_id")
    }));
    return { ok: true, types, count: types.length };
  });

  app.get("/organizations/:orgId/types/:typeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    return { ok: true, type: (await readType(orgId, getParam(request.params, "typeId"))) };
  });

  app.post("/organizations/:orgId/types", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = saveTypeSchema.parse(request.body ?? {});
    return { ok: true, type: (await saveType(orgId, { ...body, id: "" })) };
  });

  app.patch("/organizations/:orgId/types/:typeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const typeId = getParam(request.params, "typeId");
    const current = (await readType(orgId, typeId));
    const body = saveTypeSchema.parse({ ...current, ...(request.body as object ?? {}), id: typeId });
    return { ok: true, type: (await saveType(orgId, body)) };
  });

  app.delete("/organizations/:orgId/types/:typeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    return { ok: true, type: (await archiveType(orgId, getParam(request.params, "typeId"))) };
  });

  /* Yards. */

  app.get("/organizations/:orgId/yards", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    const yards = (await listYards(orgId, { includeArchived: getQuery(request.query, "include_archived") === "1" }));
    return { ok: true, yards, count: yards.length };
  });

  app.post("/organizations/:orgId/yards", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = saveYardSchema.parse(request.body ?? {});
    return { ok: true, yard: (await saveYard(orgId, { ...body, id: "" })) };
  });

  app.patch("/organizations/:orgId/yards/:yardId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = saveYardSchema.parse({ ...(request.body as object ?? {}), id: getParam(request.params, "yardId") });
    return { ok: true, yard: (await saveYard(orgId, body)) };
  });

  app.delete("/organizations/:orgId/yards/:yardId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    return { ok: true, yard: (await archiveYard(orgId, getParam(request.params, "yardId"))) };
  });

  /* Units. */

  app.get("/organizations/:orgId/units", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    (await ensureEquipmentSeed(orgId));
    const units = filterEquipmentUnits(ctx,(await fleetUnits(orgId, {
      includeArchived: getQuery(request.query, "include_archived") === "1",
      typeId: getQuery(request.query, "type_id"),
      branchId: getQuery(request.query, "branch_id"),
      status: getQuery(request.query, "status"),
      /* The fleet surfaces default to internal units; customer-installed units
       * (ownership=customer) are reachable by explicit filter. */
      ownership: getQuery(request.query, "ownership") || "internal",
      contactId: getQuery(request.query, "contact_id"),
      query: getQuery(request.query, "q")
    })),getQuery(request.query,"department_id"));
    return { ok: true, units, count: units.length,department_context:relevantDepartmentContext(ctx) };
  });

  app.get("/organizations/:orgId/units/:unitId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    const unitId = getParam(request.params, "unitId");
    const stored = await readUnit(orgId, unitId);
    return { ok: true, unit: (await fleetUnits(orgId, { includeArchived: true })).find((unit) => unit.id === unitId) || stored };
  });

  app.post("/organizations/:orgId/units", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = saveUnitSchema.parse(request.body ?? {});
    await authorizeEquipmentOwner(ctx,body);
    return { ok: true, unit: (await saveUnit(orgId, { ...body, id: "" })) };
  });

  app.patch("/organizations/:orgId/units/:unitId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = patchUnitSchema.parse(request.body ?? {});
    await authorizeEquipmentOwner(ctx,body,await readUnit(orgId,getParam(request.params,"unitId")));
    return { ok: true, unit: (await patchUnit(orgId, getParam(request.params, "unitId"), body)) };
  });

  app.delete("/organizations/:orgId/units/:unitId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    return { ok: true, unit: (await archiveUnit(orgId, getParam(request.params, "unitId"))) };
  });

  app.post("/organizations/:orgId/units/:unitId/meter-entries", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, {
      orgId,
      application: ["management", "field"],
      permission: "equipment.manage|equipment.service|manage_company_settings",
      capability: CAPABILITY,
      csrf: true
    });
    const unitId = getParam(request.params, "unitId");
    (await readUnit(orgId, unitId));
    const body = meterEntrySchema.parse(request.body ?? {});
    const entry = (await logMeterEntry(orgId, { ...body, unit_id: unitId, user_id: ctx.userId }));
    return { ok: true, entry };
  });

  app.get("/organizations/:orgId/units/:unitId/history", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    return { ok: true, ...(await unitHistory(orgId, getParam(request.params, "unitId"))) };
  });

  /* Custody (equipment.custody). */

  app.post("/organizations/:orgId/units/:unitId/check-out", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: VIEW_PERMISSION, capability: "equipment.custody", csrf: true });
    const body = asRecord(request.body);
    return { ok: true, unit: (await checkOutUnit(orgId, getParam(request.params, "unitId"), body, ctx.userId)) };
  });

  app.post("/organizations/:orgId/units/:unitId/check-in", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: VIEW_PERMISSION, capability: "equipment.custody", csrf: true });
    return { ok: true, unit: (await checkInUnit(orgId, getParam(request.params, "unitId"))) };
  });

  /* Utilization (equipment.costing). */

  app.get("/organizations/:orgId/utilization", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "equipment.costing" });
    const result=await utilization(orgId,{start:getQuery(request.query,"start"),end:getQuery(request.query,"end")});
    return {ok:true,...result,units:await filterEquipmentRows(ctx,result.units,getQuery(request.query,"department_id"))};
  });

  /* Maintenance: service programs + work orders (equipment.maintenance). */

  app.get("/organizations/:orgId/service-programs", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: VIEW_PERMISSION, capability: MAINTENANCE_CAPABILITY });
    const allowed=await visibleEquipmentUnitIds(ctx);
    const programs = (await listPrograms(orgId, {
      includeArchived: getQuery(request.query, "include_archived") === "1",
      unitId: getQuery(request.query, "unit_id"),
      typeId: getQuery(request.query, "type_id")
    })).filter(p=>!p.unit_id||allowed.has(String(p.unit_id)));
    return { ok: true, programs, count: programs.length };
  });

  app.post("/organizations/:orgId/service-programs", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: MANAGE_PERMISSION, capability: MAINTENANCE_CAPABILITY, csrf: true });
    const body = saveProgramSchema.parse(request.body ?? {});
    return { ok: true, program: (await saveProgram(orgId, { ...body, id: "" })) };
  });

  app.patch("/organizations/:orgId/service-programs/:programId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: MANAGE_PERMISSION, capability: MAINTENANCE_CAPABILITY, csrf: true });
    (await readProgram(orgId, getParam(request.params, "programId")));
    const body = saveProgramSchema.parse({ ...(request.body as object ?? {}), id: getParam(request.params, "programId") });
    return { ok: true, program: (await saveProgram(orgId, body)) };
  });

  app.get("/organizations/:orgId/work-orders", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: VIEW_PERMISSION, capability: MAINTENANCE_CAPABILITY });
    const workOrders = await filterEquipmentRows(ctx,await workOrdersWithSchedule(orgId, await listWorkOrders(orgId, {
      unitId: getQuery(request.query, "unit_id"),
      status: getQuery(request.query, "status"),
      programId: getQuery(request.query, "program_id")
    })),getQuery(request.query,"department_id"));
    return { ok: true, work_orders: workOrders, count: workOrders.length };
  });

  app.get("/organizations/:orgId/work-orders/:workOrderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: VIEW_PERMISSION, capability: MAINTENANCE_CAPABILITY });
    return { ok: true, work_order: (await workOrdersWithSchedule(orgId, [await readWorkOrder(orgId, getParam(request.params, "workOrderId"))]))[0] };
  });

  app.post("/organizations/:orgId/work-orders", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: SERVICE_PERMISSION, capability: MAINTENANCE_CAPABILITY, csrf: true });
    const body = createWorkOrderSchema.parse(request.body ?? {});
    return { ok: true, work_order: (await openWorkOrder(orgId, body)) };
  });

  app.patch("/organizations/:orgId/work-orders/:workOrderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: SERVICE_PERMISSION, capability: MAINTENANCE_CAPABILITY, csrf: true });
    const workOrderId = getParam(request.params, "workOrderId");
    const current = (await readWorkOrder(orgId, workOrderId));
    const body = patchWorkOrderSchema.parse(request.body ?? {});
    return { ok: true, work_order: (await saveWorkOrder(orgId, { ...current, ...body, id: workOrderId, expected_revision: body.expected_revision ?? Number(current.revision || 0) })) };
  });

  app.post("/organizations/:orgId/work-orders/:workOrderId/schedule", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: SERVICE_PERMISSION, capability: MAINTENANCE_CAPABILITY, csrf: true });
    const body = scheduleWorkOrderSchema.parse(request.body ?? {});
    return { ok: true, work_order: await scheduleWorkOrder(orgId, getParam(request.params, "workOrderId"), body) };
  });

  app.post("/organizations/:orgId/work-orders/:workOrderId/complete", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: SERVICE_PERMISSION, capability: MAINTENANCE_CAPABILITY, csrf: true });
    const body = completeWorkOrderSchema.parse(request.body ?? {});
    return { ok: true, ...(await completeWorkOrder(orgId, getParam(request.params, "workOrderId"), body, ctx.userId)) };
  });

  app.post("/organizations/:orgId/work-orders/:workOrderId/cancel", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: SERVICE_PERMISSION, capability: MAINTENANCE_CAPABILITY, csrf: true });
    return { ok: true, work_order: await cancelWorkOrder(orgId, getParam(request.params, "workOrderId")) };
  });

  app.get("/organizations/:orgId/due-service", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"], permission: VIEW_PERMISSION, capability: MAINTENANCE_CAPABILITY });
    const due = await filterEquipmentRows(ctx,await upcomingService(orgId, { horizonDays: Number(getQuery(request.query, "horizon_days")) || undefined }),getQuery(request.query,"department_id"));
    return { ok: true, due_service: due, count: due.length };
  });

  /* Availability. */

  app.get("/organizations/:orgId/availability", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireScheduleReader(request, orgId);
    const result = await availabilityForEquipment(orgId, {
      start: getQuery(request.query, "start"),
      end: getQuery(request.query, "end"),
      typeId: getQuery(request.query, "type_id"),
      unitIds: getQuery(request.query, "unit_ids").split(",").map((value) => value.trim()).filter(Boolean),
      excludeEventId: getQuery(request.query, "exclude_event_id")
    });
    const allowed=await visibleEquipmentUnitIds(ctx,getQuery(request.query,"department_id"),`${VIEW_PERMISSION}|manage_schedule`);
    return { ok: true, ...result,units:result.units.filter(u=>allowed.has(String(u.id))) };
  });

  /* Dashboard + settings. */

  app.get("/organizations/:orgId/dashboard", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    (await ensureEquipmentSeed(orgId));
    const result=await dashboard(orgId),selected=getQuery(request.query,'department_id');
    const units=filterEquipmentUnits(ctx,await fleetUnits(orgId,{ownership:'internal'}),selected);
    const orders=await filterEquipmentRows(ctx,result.open_work_orders,selected),due=await filterEquipmentRows(ctx,result.due_service,selected);
    const by_status:Record<string,number>={};for(const unit of units){const status=String(unit.status);by_status[status]=(by_status[status]||0)+1;}
    return {ok:true,...result,counts:{...result.counts,units:units.length,by_status,checked_out:units.filter(u=>asRecord(u.custody).user_id).length,open_work_orders:orders.length},open_work_orders:orders,due_service:due};
  });

  app.get("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireScheduleReader(request, orgId);
    return { ok: true, ...(await readModuleSettings(orgId)) };
  });

  app.put("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId);
    const body = moduleSettingsSchema.parse(request.body ?? {});
    return { ok: true, ...(await writeModuleSettings(orgId, body)) };
  });
};
