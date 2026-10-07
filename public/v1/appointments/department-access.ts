import type {PlatformAuthContext} from '../platform/auth.js';
import {assertResourcePermission,hasResourcePermission,resourceDepartmentIds} from '../workforce/department-access.js';
import {readDocument,type JsonObject} from '../platform/storage.js';
import {notFound,badRequest} from '../platform/errors.js';
export const SCHEDULE_VIEW='manage_schedule|manage_projects|view_projects';
export const SCHEDULE_MANAGE='manage_schedule|manage_projects';
/** A shared appointment requires authority over every classified department. */
export function assertAppointmentDepartmentPermission(ctx:PlatformAuthContext,event:JsonObject,permission=SCHEDULE_MANAGE){
  const ids=resourceDepartmentIds(event);
  if(ids.length)for(const department_id of ids)assertResourcePermission(ctx,permission,{organization_id:ctx.orgId,department_id,branch_id:event.branch_id||ctx.branchId});
  else assertResourcePermission(ctx,permission,{...event,organization_id:ctx.orgId,branch_id:event.branch_id||ctx.branchId});
}
export function canViewAppointmentDepartment(ctx:PlatformAuthContext,event:JsonObject){const ids=resourceDepartmentIds(event);return ids.length?ids.some(department_id=>hasResourcePermission(ctx,SCHEDULE_VIEW,{department_id,branch_id:event.branch_id||ctx.branchId})):hasResourcePermission(ctx,SCHEDULE_VIEW,event);}
export async function readAuthorizedAppointment(ctx:PlatformAuthContext,projectId:string,eventId:string,permission=SCHEDULE_MANAGE){
  let event:JsonObject|undefined;
  if(projectId){const project=await readDocument(ctx.orgId,'projects',projectId);event=(Array.isArray(project.data.events)?project.data.events:[]).find((e:JsonObject)=>String(e.id)===eventId) as JsonObject|undefined;}
  else event=(await readDocument(ctx.orgId,'calendar_events',eventId)).data;
  if(!event)throw notFound('appointment_not_found','This appointment is unavailable.');
  assertAppointmentDepartmentPermission(ctx,event,permission);return event;
}
export function validateAppointmentDepartments(ctx:PlatformAuthContext,event:JsonObject){
  for(const id of resourceDepartmentIds(event))if(ctx.organizationStructure&&!ctx.organizationStructure.catalog.departments.some(d=>d.id===id&&d.status!=='archived'))throw badRequest('unknown_department','Choose an active department from this organization.');
}
