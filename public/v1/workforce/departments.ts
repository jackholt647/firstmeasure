import {z} from 'zod';
import {createHash} from 'node:crypto';
import {hasPermission, type PlatformAuthContext} from '../platform/auth.js';
import {badRequest, conflict, forbidden} from '../platform/errors.js';
import {listDocuments, readDocument, readBranchModule, upsertDocument} from '../platform/storage.js';
import {DEFAULT_BRANCH_ID,departmentSchema,departmentCatalogSchema,departmentSaveSchema,departmentAssignmentSchema,isLegacyCatalog,migrateLegacyCatalog} from './department-contracts.js';
export {departmentCatalogSchema,departmentSaveSchema,departmentAssignmentSchema} from './department-contracts.js';
import {listOrganizationConnections} from '../connections/storage.js';
import {listWorkforceUsers} from './service.js';
import {listAccessRoles} from './access.js';
import {groupBranchIds, listResourceGroups, readWorkforceConfiguration} from './storage.js';
import {assertManageBranches,branchScope,canManageBranches,canSeeBranches,userBranchIds,type BranchScope} from './branch-scope.js';

/**
 * The department catalog: one document per organization (`organization_departments/catalog`) holding every branch's
 * departments, the flat regions that group branches, and department terminology. A department belongs to one branch.
 * See docs/architecture/branches.md.
 */
const missing=async<T>(promise:Promise<T>)=>promise.catch((error)=>{if(error.statusCode===404)return null;throw error;});
type Catalog=z.infer<typeof departmentCatalogSchema>;
type Department=Catalog['departments'][number];
export function assertDepartmentRead(ctx:PlatformAuthContext){
  if(!['manage_company_settings','manage_company_users','manage_company_user_permissions','manage_schedule','view_projects'].some(p=>hasPermission(ctx,p)))throw forbidden('departments_denied','Department access is required.');
}
function canAssign(ctx:PlatformAuthContext,kind:string){
  return hasPermission(ctx,'manage_company_settings')||(kind==='user'&&hasPermission(ctx,'manage_company_users'))||(kind==='role'&&hasPermission(ctx,'manage_company_user_permissions'));
}

/**
 * Reads only. A catalog saved before branches owned departments is migrated on read (`migrateLegacyCatalog`): its
 * categories are dropped, its departments move to a branch and its units become regions or are dropped. The first
 * save writes the migrated shape with `unit_migration`. Older per-branch scheduling catalogs are projected without
 * writes, each department in the branch it was first found in; the first explicit save adopts their union.
 */
export async function readOrganizationDepartments(orgId:string,knownBranchIds?:string[]){
  const stored=await missing(readDocument(orgId,'organization_departments','catalog'));
  if(stored){
    if(isLegacyCatalog(stored.data))return {...migrateLegacyCatalog(stored.data,knownBranchIds||(await listDocuments(orgId,'branch')).map(b=>b.id)),revision:stored.revision,legacy_token:''};
    return {...departmentCatalogSchema.parse(stored.data),revision:stored.revision,legacy_token:''};
  }
  const branches=await listDocuments(orgId,'branch');
  const ids=[DEFAULT_BRANCH_ID,...branches.map(b=>b.id).filter(id=>id!==DEFAULT_BRANCH_ID).sort()];
  const departments=new Map<string,Department>();
  const evidence:unknown[]=[];

  for(const id of ids){
    const branch=await missing(readBranchModule(orgId,id,'scheduling'));
    const catalog=branch?.data?.appointment_catalog as {departments?:unknown[]}|undefined;
    evidence.push([id,branch?.revision||0]);
    if(!catalog)continue;

    for(const row of catalog.departments||[]){
      const {group_id:_group,division_id:_division,...rest}=(row&&typeof row==='object'?row:{}) as Record<string,unknown>;
      const parsed=departmentSchema.parse({...rest,branch_id:id}),old=departments.get(parsed.id);
      departments.set(parsed.id,old?{...old,subject_keys:[...new Set([...old.subject_keys,...parsed.subject_keys])],role_ids:[...new Set([...old.role_ids,...parsed.role_ids])],group_kind_ids:[...new Set([...old.group_kind_ids,...parsed.group_kind_ids])]}:parsed);
    }
  }

  return {...departmentCatalogSchema.parse({departments:[...departments.values()]}),revision:0,legacy_token:createHash('sha256').update(JSON.stringify(evidence)).digest('hex')};
}

async function directory(orgId:string){
  const [users,roles,groups,configuration,connections,branches]=await Promise.all([listWorkforceUsers(orgId),listAccessRoles(orgId),listResourceGroups(orgId),readWorkforceConfiguration(orgId),listOrganizationConnections(orgId),(await import('./organization-structure.js')).readStructureBranches(orgId)]);
  const roleDirectory=roles.map(r=>({id:r.id,name:r.name}));
  for(const user of users)for(const id of user.role_ids)if(!roleDirectory.some(r=>r.id===id))roleDirectory.push({id,name:id.replace(/_/g,' ')});
  return {
    users:users.map(u=>({id:u.id,name:u.name,role_ids:u.role_ids,branch_id:u.branch_id,branch_ids:userBranchIds(u)})),
    roles:roleDirectory,
    resource_groups:groups.map(g=>({id:g.id,name:g.name,kind_id:g.kind_id,branch_id:g.branch_id,branch_ids:groupBranchIds(g)})),
    group_kinds:configuration.resource_group_kinds,
    connections:connections.map(c=>({id:String(c.id),name:String(c.name),branch_ids:Array.isArray(c.branch_ids)?c.branch_ids.map(String):[]})),
    branches:branches.map(b=>({id:b.id,name:b.name,status:b.status,is_default:b.is_default}))
  };
}
type Directory=Awaited<ReturnType<typeof directory>>;
/** What a viewer restricted to some branches may see of the directory. */
function visibleDirectory(scope:BranchScope,people:Directory){
  return {...people,
    users:people.users.filter(u=>canSeeBranches(scope,u.branch_ids)),
    resource_groups:people.resource_groups.filter(g=>canSeeBranches(scope,g.branch_ids)),
    connections:people.connections.filter(c=>canSeeBranches(scope,c.branch_ids,true)),
    branches:people.branches.filter(b=>canSeeBranches(scope,[b.id]))};
}
const visibleDepartments=(scope:BranchScope,departments:Department[])=>departments.filter(d=>canSeeBranches(scope,[d.branch_id]));

export async function departmentSettings(ctx:PlatformAuthContext){
  assertDepartmentRead(ctx);
  const catalog=await readOrganizationDepartments(ctx.orgId);
  const scope=branchScope(ctx);
  const administrative=['manage_company_settings','manage_company_users','manage_company_user_permissions'].some(p=>hasPermission(ctx,p));
  const structure=administrative?await (await import('./organization-structure.js')).resolveOrganizationStructure(ctx.orgId):null;
  const people=administrative?visibleDirectory(scope,await directory(ctx.orgId)):null;
  const visibleUsers=new Set(people?.users.map(u=>u.id)||[]);
  const {unit_migration:_migration,...shown}=catalog;
  return {...shown,departments:visibleDepartments(scope,catalog.departments),regions:catalog.regions.map(r=>({...r,branch_ids:r.branch_ids.filter(id=>canSeeBranches(scope,[id]))})).filter(r=>!scope.restricted_view||r.branch_ids.length),
    ...(people||{}),...(structure?{effective_memberships:structure.users.filter(u=>visibleUsers.has(u.id))}:{}),
    branch_scope:{multiple:scope.multiple,my_branch_id:scope.my_branch_id,visible_branch_ids:scope.visible_branch_ids,manageable_branch_ids:scope.manageable_branch_ids},
    can_manage:hasPermission(ctx,'manage_company_settings'),can_assign:Object.fromEntries(['user','role','group','group_kind','connection'].map(k=>[k,canAssign(ctx,k)]))};
}
function identity(kind:string,id:string){
  return {field:kind==='role'?'role_ids':kind==='group_kind'?'group_kind_ids':'subject_keys',value:kind==='user'?`organization_user:${id}`:kind==='group'?`resource_group:${id}`:kind==='connection'?`organization_connection:${id}`:id} as {field:'role_ids'|'group_kind_ids'|'subject_keys',value:string};
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/**
 * Someone limited to some branches may directly put a person, group or company only in a department of a branch that
 * assignee belongs to. `manage_all_branches` lifts this, and `manage_region_branches` lifts it for their region's branches.
 * `subjectBranchIds` undefined means every branch (a company with no branch). See docs/architecture/branches.md.
 */
function assertDirectAssignmentBranch(scope:BranchScope,subjectBranchIds:string[]|undefined,departmentBranchId:string){
  if(!scope.multiple||scope.manage==='all'||!subjectBranchIds||subjectBranchIds.includes(departmentBranchId))return;
  if(scope.manage==='region'&&scope.region_branch_ids.includes(departmentBranchId))return;
  throw badRequest('department_branch_mismatch','That person, group or company is not in the branch of this department.');
}
type SaveInput=z.infer<typeof departmentSaveSchema>;
async function write(ctx:PlatformAuthContext,input:SaveInput){
  const current=await readOrganizationDepartments(ctx.orgId);
  if(current.revision!==input.revision||(!current.revision&&current.legacy_token!==input.legacy_token))throw conflict('stale_departments','Departments changed. Reload before saving.');
  if(new Set(input.departments.map(r=>r.id)).size!==input.departments.length)throw badRequest('duplicate_department_id','Department IDs must be unique.');
  const scope=branchScope(ctx);
  const people=await directory(ctx.orgId);
  const branches=new Map(people.branches.map(b=>[b.id,b]));
  // A department keeps its branch unless the save names another. A new one goes to the saver's own branch.
  const departments:Department[]=input.departments.map(row=>{const old=current.departments.find(d=>d.id===row.id);return departmentSchema.parse({...row,branch_id:row.branch_id||old?.branch_id||(scope.multiple?scope.my_branch_id:DEFAULT_BRANCH_ID)});});
  // Departments of branches the saver cannot see were not sent to them: they are kept exactly as they are.
  for(const hidden of current.departments)if(!canSeeBranches(scope,[hidden.branch_id])&&!departments.some(d=>d.id===hidden.id))departments.push(hidden);
  // Retain stable IDs referenced by appointments and branch presets.
  if(current.departments.some(d=>!departments.some(row=>row.id===d.id)))throw badRequest('department_in_use','Existing departments must be retained for scheduling history.');
  for(const d of departments){
    const old=current.departments.find(row=>row.id===d.id);
    if(!branches.has(d.branch_id))throw badRequest('unknown_department_branch','Choose a branch from this organization.');
    if(d.status==='active'&&branches.get(d.branch_id)?.status==='archived'&&(!old||old.status!=='active'||old.branch_id!==d.branch_id))throw badRequest('archived_department_branch','Choose an active branch.');
    if(old&&same(old,d))continue;
    // Changing a department, adding one or moving one needs the branches involved to be ones the saver manages.
    assertManageBranches(scope,[d.branch_id]);
    if(old&&old.branch_id!==d.branch_id)assertManageBranches(scope,[old.branch_id]);
  }
  const allowed={role_ids:new Set(people.roles.map(r=>String(r.id))),group_kind_ids:new Set((people.group_kinds as {id:string}[]).map(g=>g.id)),subject_keys:new Set([...people.users.map(u=>`organization_user:${u.id}`),...people.resource_groups.map(g=>`resource_group:${g.id}`),...people.connections.map(c=>`organization_connection:${c.id}`)])};
  const shown=visibleDirectory(scope,people);
  // An outside company with no branch works in every branch: undefined below means "every branch".
  const subjectBranches=new Map<string,string[]|undefined>([...people.users.map(u=>[`organization_user:${u.id}`,u.branch_ids] as const),...people.resource_groups.map(g=>[`resource_group:${g.id}`,g.branch_ids] as const),...people.connections.map(c=>[`organization_connection:${c.id}`,c.branch_ids.length?c.branch_ids:undefined] as const)]);
  const visibleKeys=new Set([...shown.users.map(u=>`organization_user:${u.id}`),...shown.resource_groups.map(g=>`resource_group:${g.id}`),...shown.connections.map(c=>`organization_connection:${c.id}`)]);
  for(const d of departments){
    const old=current.departments.find(row=>row.id===d.id);
    for(const field of ['role_ids','group_kind_ids','subject_keys'] as const)if(d[field].some(id=>!allowed[field].has(id)&&!old?.[field].includes(id)))throw badRequest('unknown_department_member','Choose a user, role, group or group type from this organization.');
    if(d.subject_keys.some(key=>!old?.subject_keys.includes(key)&&!visibleKeys.has(key)))throw forbidden('branch_scope_denied','You can only add people, groups and companies from branches you can see.');
    for(const key of d.subject_keys.filter(key=>!old?.subject_keys.includes(key)))assertDirectAssignmentBranch(scope,subjectBranches.get(key),d.branch_id);
  }
  try {
    await upsertDocument(ctx.orgId,'organization_departments',{id:'catalog',data:{departments,regions:current.regions,terminology:input.terminology||current.terminology,...(current.unit_migration?{unit_migration:current.unit_migration}:{})},expected_revision:input.revision},{replace:true,createOnly:input.revision===0});
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
  const current=await readOrganizationDepartments(ctx.orgId),people=await directory(ctx.orgId),scope=branchScope(ctx);
  const choices:Array<{id:string;branch_ids?:string[]}>=change.kind==='user'?people.users:change.kind==='role'?people.roles:change.kind==='group'?people.resource_groups:change.kind==='connection'?people.connections:people.group_kinds as {id:string}[];
  const subject=choices.find(row=>row.id===change.id);
  if(!subject)throw badRequest('unknown_department_subject','Choose a subject from this organization.');
  if(change.department_ids.some(id=>!current.departments.some(d=>d.id===id)))throw badRequest('unknown_department','Choose an existing department.');
  // A person, group or company is assigned only by someone who manages one of its branches.
  if(subject.branch_ids&&!canManageBranches(scope,subject.branch_ids,change.kind==='connection'))throw forbidden('branch_scope_denied','This record belongs to a branch you cannot manage.');
  const {field,value}=identity(change.kind,change.id);
  const departments=current.departments.map(d=>{
    const next=[...new Set([...d[field].filter(id=>id!==value),...(change.department_ids.includes(d.id)?[value]:[])])];
    if(!same(next,d[field])&&!same([...next].sort(),[...d[field]].sort()))assertManageBranches(scope,[d.branch_id]);
    return {...d,[field]:next};
  });
  return write(ctx,{departments,terminology:current.terminology,revision:change.revision,legacy_token:change.legacy_token});
}
