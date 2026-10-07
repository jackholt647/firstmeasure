import type {PlatformAuthContext} from '../platform/auth.js';
import {assertResourcePermission,hasResourcePermission,matchesDepartmentFilter} from '../workforce/department-access.js';
import {badRequest} from '../platform/errors.js';
import {resolveOrganizationStructure} from '../workforce/organization-structure.js';
import {readUnit,listUnits,readWorkOrder} from './storage.js';
import type {JsonObject} from '../platform/storage.js';
export const EQUIPMENT_VIEW='equipment.view|equipment.manage|equipment.service|manage_company_settings';
export const EQUIPMENT_MANAGE='equipment.manage|manage_company_settings';
export const EQUIPMENT_SERVICE='equipment.manage|equipment.service|manage_company_settings';
export async function authorizeEquipmentUnit(ctx:PlatformAuthContext,id:string,permission=EQUIPMENT_VIEW){const unit=await readUnit(ctx.orgId,id);assertResourcePermission(ctx,permission,unit);return unit;}
export async function authorizeEquipmentWorkOrder(ctx:PlatformAuthContext,id:string,permission=EQUIPMENT_SERVICE){const order=await readWorkOrder(ctx.orgId,id);await authorizeEquipmentUnit(ctx,String(order.unit_id),permission);return order;}
export async function authorizeEquipmentOwner(ctx:PlatformAuthContext,input:JsonObject,current?:JsonObject){
  const next={...current,...input};const departmentId=String(next.department_id||'');
  if(departmentId){const structure=await resolveOrganizationStructure(ctx.orgId);if(!structure.catalog.departments.some(d=>d.id===departmentId&&d.status==='active'))throw badRequest('equipment_department_invalid','Choose an active department from this organization.');}
  assertResourcePermission(ctx,EQUIPMENT_MANAGE,next);
}
export function filterEquipmentUnits<T extends JsonObject>(ctx:PlatformAuthContext,units:T[],selected?:string,permission=EQUIPMENT_VIEW){return units.filter(u=>hasResourcePermission(ctx,permission,u)&&matchesDepartmentFilter(ctx,u,selected));}
export async function visibleEquipmentUnitIds(ctx:PlatformAuthContext,selected?:string,permission=EQUIPMENT_VIEW){return new Set(filterEquipmentUnits(ctx,await listUnits(ctx.orgId,{includeArchived:true}),selected,permission).map(u=>String(u.id)));}
export async function filterEquipmentRows<T extends JsonObject>(ctx:PlatformAuthContext,rows:T[],selected?:string){const allowed=await visibleEquipmentUnitIds(ctx,selected);return rows.filter(row=>allowed.has(String(row.unit_id||row.id)));}
