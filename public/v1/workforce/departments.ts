import {z} from 'zod';
import {createHash} from 'node:crypto';
import {hasPermission, type PlatformAuthContext} from '../platform/auth.js';
import {badRequest, conflict, forbidden} from '../platform/errors.js';
import {listDocuments, readDocument, readBranchModule, upsertDocument} from '../platform/storage.js';
import {departmentSchema,departmentCatalogSchema,departmentSaveSchema,departmentAssignmentSchema,groupSchema} from './department-contracts.js';
export {departmentCatalogSchema,departmentSaveSchema,departmentAssignmentSchema} from './department-contracts.js';
import {listOrganizationConnections} from '../connections/storage.js';
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

  for(const id of ids){
    const branch=await missing(readBranchModule(orgId,id,'scheduling'));
    const catalog=branch?.data?.appointment_catalog as Catalog|undefined;
    evidence.push([id,branch?.revision||0]);
    if(!catalog)continue;

    for(const row of catalog.departments||[]){
      const parsed=departmentSchema.parse(row),old=departments.get(parsed.id);
      departments.set(parsed.id,old?{...old,subject_keys:[...new Set([...old.subject_keys,...parsed.subject_keys])],role_ids:[...new Set([...old.role_ids,...parsed.role_ids])],group_kind_ids:[...new Set([...old.group_kind_ids,...parsed.group_kind_ids])]}:parsed);
    }
    for(const row of catalog.groups||[])if(!groups.has(row.id))groups.set(row.id,groupSchema.parse(row));
  }

  return {...departmentCatalogSchema.parse({departments:[...departments.values()],groups:[...groups.values()]}),revision:0,legacy_token:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
}

async function directory(orgId:string){
  const [users,roles,groups,configuration,connections,branches]=await Promise.all([listWorkforceUsers(orgId),listAccessRoles(orgId),listResourceGroups(orgId),readWorkforceConfiguration(orgId),listOrganizationConnections(orgId),listDocuments(orgId,'branch')]);
  const roleDirectory=roles.map(r=>({id:r.id,name:r.name}));
  for(const user of users)for(const id of user.role_ids)if(!roleDirectory.some(r=>r.id===id))roleDirectory.push({id,name:id.replace(/_/g,' ')});
  return {users:users.map(u=>({id:u.id,name:u.name,role_ids:u.role_ids,branch_id:u.branch_id})),roles:roleDirectory,resource_groups:groups.map(g=>({id:g.id,name:g.name,kind_id:g.kind_id,branch_id:g.branch_id})),group_kinds:configuration.resource_group_kinds,connections:connections.map(c=>({id:String(c.id),name:String(c.name)})),branches:branches.map(b=>({id:b.id,name:String(b.data.name||b.id)}))};
}
export async function departmentSettings(ctx:PlatformAuthContext){
  assertDepartmentRead(ctx);
  const catalog=await readOrganizationDepartments(ctx.orgId);
  const administrative=['manage_company_settings','manage_company_users','manage_company_user_permissions'].some(p=>hasPermission(ctx,p));
  const structure=administrative?await (await import('./organization-structure.js')).resolveOrganizationStructure(ctx.orgId):null;
  return {...catalog,...(administrative?await directory(ctx.orgId):{}),...(structure?{effective_memberships:structure.users}:{}),can_manage:hasPermission(ctx,'manage_company_settings'),can_assign:Object.fromEntries(['user','role','group','group_kind','connection'].map(k=>[k,canAssign(ctx,k)]))};
}
function identity(kind:string,id:string){
  return {field:kind==='role'?'role_ids':kind==='group_kind'?'group_kind_ids':'subject_keys',value:kind==='user'?`organization_user:${id}`:kind==='group'?`resource_group:${id}`:kind==='connection'?`organization_connection:${id}`:id} as {field:'role_ids'|'group_kind_ids'|'subject_keys',value:string};
}
async function write(ctx:PlatformAuthContext,input:z.infer<typeof departmentSaveSchema>){
  const current=await readOrganizationDepartments(ctx.orgId);
  if(current.revision!==input.revision||(!current.revision&&current.legacy_token!==input.legacy_token))throw conflict('stale_departments','Departments changed. Reload before saving.');
  for(const rows of [input.departments,input.groups,input.divisions])if(new Set(rows.map(r=>r.id)).size!==rows.length)throw badRequest('duplicate_department_id','Department and category IDs must be unique.');
  const groupIds=new Set(input.groups.map(g=>g.id));
  if(input.departments.some(d=>d.group_id&&!groupIds.has(d.group_id)))throw badRequest('unknown_department_category','Choose an existing department category.');
  // Retain stable IDs referenced by appointments and branch presets.
  if(current.departments.some(d=>!input.departments.some(row=>row.id===d.id)))throw badRequest('department_in_use','Existing departments must be retained for scheduling history.');
  const divisions=new Map(input.divisions.map(d=>[d.id,d]));
  for(const division of input.divisions){
    const seen=new Set<string>();let row:typeof division|undefined=division;
    while(row){if(seen.has(row.id))throw badRequest('division_cycle','Organizational units cannot contain themselves.');seen.add(row.id);if(row.parent_id&&!divisions.has(row.parent_id))throw badRequest('unknown_parent_division','Choose an existing parent unit.');row=row.parent_id?divisions.get(row.parent_id):undefined;}
    if(division.status==='active'&&division.parent_id&&divisions.get(division.parent_id)?.status==='archived')throw badRequest('archived_parent_division','Archive child units before archiving their parent.');
  }
  for(const d of input.departments)if(d.division_id&&(!divisions.has(d.division_id)||(d.status==='active'&&divisions.get(d.division_id)?.status==='archived')))throw badRequest('unknown_department_division','Choose an active organizational unit.');
  if(current.divisions.some(d=>!divisions.has(d.id)))throw badRequest('division_in_use','Archive existing units to retain their history.');
  const people=await directory(ctx.orgId);
  const branchIds=new Set(['default',...people.branches.map(b=>b.id)]);
  if(input.divisions.some(d=>d.branch_id&&!branchIds.has(d.branch_id)))throw badRequest('unknown_division_branch','Choose a branch from this organization.');
  const allowed={role_ids:new Set(people.roles.map(r=>String(r.id))),group_kind_ids:new Set((people.group_kinds as {id:string}[]).map(g=>g.id)),subject_keys:new Set([...people.users.map(u=>`organization_user:${u.id}`),...people.resource_groups.map(g=>`resource_group:${g.id}`),...people.connections.map(c=>`organization_connection:${c.id}`)])};
  for(const d of input.departments){
    const old=current.departments.find(row=>row.id===d.id);
    for(const field of ['role_ids','group_kind_ids','subject_keys'] as const)if(d[field].some(id=>!allowed[field].has(id)&&!old?.[field].includes(id)))throw badRequest('unknown_department_member','Choose a user, role, group or group type from this organization.');
  }
  for(const division of input.divisions)if(division.subject_keys.some(key=>!allowed.subject_keys.has(key)&&!current.divisions.find(d=>d.id===division.id)?.subject_keys.includes(key)))throw badRequest('unknown_division_member','Choose a subject from this organization.');
  try {
  await upsertDocument(ctx.orgId,'organization_departments',{id:'catalog',data:{departments:input.departments,groups:input.groups,divisions:input.divisions,terminology:input.terminology},expected_revision:input.revision},{replace:true,createOnly:input.revision===0});
  } catch(error) {
    if((error as {statusCode?:number}).statusCode===409)throw conflict('stale_departments','Departments changed. Reload before saving.');
    throw error;
  }
  await (await import('../channels/department-channels.js')).syncDepartmentChannels(ctx);
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
  const choices=change.kind==='user'?people.users:change.kind==='role'?people.roles:change.kind==='group'?people.resource_groups:change.kind==='connection'?people.connections:people.group_kinds as {id:string}[];
  if(!choices.some(row=>row.id===change.id))throw badRequest('unknown_department_subject','Choose a subject from this organization.');
  if(change.department_ids.some(id=>!current.departments.some(d=>d.id===id)))throw badRequest('unknown_department','Choose an existing department.');
  const {field,value}=identity(change.kind,change.id);
  const departments=current.departments.map(d=>({...d,[field]:[...new Set([...d[field].filter(id=>id!==value),...(change.department_ids.includes(d.id)?[value]:[])])]}));
  return write(ctx,{departments,groups:current.groups,divisions:current.divisions,terminology:current.terminology,revision:change.revision,legacy_token:change.legacy_token});
}
