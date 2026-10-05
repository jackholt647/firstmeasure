import {z} from 'zod';
import {createHash} from 'node:crypto';
import {hasPermission, type PlatformAuthContext} from '../platform/auth.js';
import {badRequest, conflict, forbidden} from '../platform/errors.js';
import {listDocuments, readDocument, readBranchModule, upsertDocument} from '../platform/storage.js';
import {departmentSchema,departmentCatalogSchema,departmentSaveSchema,departmentAssignmentSchema,groupSchema} from './department-contracts.js';
export {departmentCatalogSchema,departmentSaveSchema,departmentAssignmentSchema} from './department-contracts.js';
import {defaultAppointmentCatalog} from '../appointments/defaults.js';
import {listWorkforceUsers} from './service.js';
import {listAccessRoles} from './access.js';
import {listResourceGroups, readWorkforceConfiguration} from './storage.js';

const missing=async<T>(promise:Promise<T>)=>promise.catch((error)=>{if(error.statusCode===404)return null;throw error;});
type Catalog=z.infer<typeof departmentCatalogSchema>;
type Department=Catalog['departments'][number];
export function assertDepartmentRead(ctx:PlatformAuthContext){
  if(!['manage_company_settings','manage_company_users','manage_company_user_permissions','manage_schedule','view_projects'].some(p=>hasPermission(ctx,p)))throw forbidden('departments_denied','Department access is required.');
}
function canAssign(ctx:PlatformAuthContext,kind:string){
  return hasPermission(ctx,'manage_company_settings')||(kind==='user'&&hasPermission(ctx,'manage_company_users'))||(kind==='role'&&hasPermission(ctx,'manage_company_user_permissions'));
}

// Legacy catalogs are projected without writes. The first explicit save adopts
// their union; the branch records stay intact as migration evidence.
export async function readOrganizationDepartments(orgId:string){
  const stored=await missing(readDocument(orgId,'organization_departments','catalog'));
  if(stored)return {...departmentCatalogSchema.parse(stored.data),revision:stored.revision,legacy_token:''};
  const branches=await listDocuments(orgId,'branch');
  const ids=['default',...branches.map(b=>b.id).filter(id=>id!=='default').sort()];
  const departments=new Map<string,Department>(),groups=new Map<string,Catalog['groups'][number]>();
  const evidence:unknown[]=[];
  let hasLegacyCatalog=false;
  for(const id of ids){
    const branch=await missing(readBranchModule(orgId,id,'scheduling'));
    const catalog=branch?.data?.appointment_catalog as Catalog|undefined;
    evidence.push([id,branch?.revision||0]);
    if(!catalog)continue;
    hasLegacyCatalog=true;
    for(const row of catalog.departments||[]){
      const parsed=departmentSchema.parse(row),old=departments.get(parsed.id);
      departments.set(parsed.id,old?{...old,subject_keys:[...new Set([...old.subject_keys,...parsed.subject_keys])],role_ids:[...new Set([...old.role_ids,...parsed.role_ids])],group_kind_ids:[...new Set([...old.group_kind_ids,...parsed.group_kind_ids])]}:parsed);
    }
    for(const row of catalog.groups||[])if(!groups.has(row.id))groups.set(row.id,groupSchema.parse(row));
  }
  if(!hasLegacyCatalog)for(const row of defaultAppointmentCatalog().departments)departments.set(row.id,row);
  return {departments:[...departments.values()],groups:[...groups.values()],revision:0,legacy_token:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
}

async function directory(orgId:string){
  const [users,roles,groups,configuration]=await Promise.all([listWorkforceUsers(orgId),listAccessRoles(orgId),listResourceGroups(orgId),readWorkforceConfiguration(orgId)]);
  const roleDirectory=roles.map(r=>({id:r.id,name:r.name}));
  for(const user of users)for(const id of user.role_ids)if(!roleDirectory.some(r=>r.id===id))roleDirectory.push({id,name:id.replace(/_/g,' ')});
  return {users:users.map(u=>({id:u.id,name:u.name,role_ids:u.role_ids,branch_id:u.branch_id})),roles:roleDirectory,resource_groups:groups.map(g=>({id:g.id,name:g.name,kind_id:g.kind_id,branch_id:g.branch_id})),group_kinds:configuration.resource_group_kinds};
}
export async function departmentSettings(ctx:PlatformAuthContext){
  assertDepartmentRead(ctx);
  const catalog=await readOrganizationDepartments(ctx.orgId);
  const administrative=['manage_company_settings','manage_company_users','manage_company_user_permissions'].some(p=>hasPermission(ctx,p));
  return {...catalog,...(administrative?await directory(ctx.orgId):{}),can_manage:hasPermission(ctx,'manage_company_settings'),can_assign:Object.fromEntries(['user','role','group','group_kind'].map(k=>[k,canAssign(ctx,k)]))};
}
function identity(kind:string,id:string){
  return {field:kind==='role'?'role_ids':kind==='group_kind'?'group_kind_ids':'subject_keys',value:kind==='user'?`organization_user:${id}`:kind==='group'?`resource_group:${id}`:id} as {field:'role_ids'|'group_kind_ids'|'subject_keys',value:string};
}
async function write(ctx:PlatformAuthContext,input:z.infer<typeof departmentSaveSchema>){
  const current=await readOrganizationDepartments(ctx.orgId);
  if(current.revision!==input.revision||(!current.revision&&current.legacy_token!==input.legacy_token))throw conflict('stale_departments','Departments changed. Reload before saving.');
  for(const rows of [input.departments,input.groups])if(new Set(rows.map(r=>r.id)).size!==rows.length)throw badRequest('duplicate_department_id','Department and category IDs must be unique.');
  const groupIds=new Set(input.groups.map(g=>g.id));
  if(input.departments.some(d=>d.group_id&&!groupIds.has(d.group_id)))throw badRequest('unknown_department_category','Choose an existing department category.');
  // Retain stable IDs referenced by appointments and branch presets.
  if(current.departments.some(d=>!input.departments.some(row=>row.id===d.id)))throw badRequest('department_in_use','Existing departments must be retained for scheduling history.');
  const people=await directory(ctx.orgId);
  const allowed={role_ids:new Set(people.roles.map(r=>String(r.id))),group_kind_ids:new Set((people.group_kinds as {id:string}[]).map(g=>g.id)),subject_keys:new Set([...people.users.map(u=>`organization_user:${u.id}`),...people.resource_groups.map(g=>`resource_group:${g.id}`)])};
  for(const d of input.departments){
    const old=current.departments.find(row=>row.id===d.id);
    for(const field of ['role_ids','group_kind_ids','subject_keys'] as const)if(d[field].some(id=>!allowed[field].has(id)&&!old?.[field].includes(id)))throw badRequest('unknown_department_member','Choose a user, role, group or group type from this organization.');
  }
  try {
  await upsertDocument(ctx.orgId,'organization_departments',{id:'catalog',data:{departments:input.departments,groups:input.groups},expected_revision:input.revision},{replace:true,createOnly:input.revision===0});
  } catch(error) {
    if((error as {statusCode?:number}).statusCode===409)throw conflict('stale_departments','Departments changed. Reload before saving.');
    throw error;
  }
  return departmentSettings(ctx);
}
export async function saveDepartmentSettings(ctx:PlatformAuthContext,input:unknown){
  if(!hasPermission(ctx,'manage_company_settings'))throw forbidden('departments_denied','Company settings permission is required.');
  return write(ctx,departmentSaveSchema.parse(input));
}
export async function saveDepartmentAssignment(ctx:PlatformAuthContext,input:unknown){
  const change=departmentAssignmentSchema.parse(input);
  if(!canAssign(ctx,change.kind))throw forbidden('department_assignment_denied','Permission to manage this assignment is required.');
  const current=await readOrganizationDepartments(ctx.orgId),people=await directory(ctx.orgId);
  const choices=change.kind==='user'?people.users:change.kind==='role'?people.roles:change.kind==='group'?people.resource_groups:people.group_kinds as {id:string}[];
  if(!choices.some(row=>row.id===change.id))throw badRequest('unknown_department_subject','Choose a subject from this organization.');
  if(change.department_ids.some(id=>!current.departments.some(d=>d.id===id)))throw badRequest('unknown_department','Choose an existing department.');
  const {field,value}=identity(change.kind,change.id);
  const departments=current.departments.map(d=>({...d,[field]:[...new Set([...d[field].filter(id=>id!==value),...(change.department_ids.includes(d.id)?[value]:[])])]}));
  return write(ctx,{departments,groups:current.groups,revision:change.revision,legacy_token:change.legacy_token});
}
