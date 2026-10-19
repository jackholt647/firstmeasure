import {DEFAULT_BRANCH_ID,type DepartmentCatalog} from './department-contracts.js';
import {readOrganizationDepartments} from './departments.js';
import {listDocuments} from '../platform/storage.js';
import {listAssignmentGroups} from './storage.js';
import {listOrganizationConnections} from '../connections/storage.js';

/**
 * The one resolver of the organization's structure for auth, scheduling and reporting:
 * organization -> (optional) regions -> branches -> departments. See docs/architecture/branches.md.
 *
 * A user and a group always belong to at least one branch (`default` when nothing is saved). An outside company with no
 * branch belongs to every branch. A department belongs to one branch; a role or a group type puts someone in a
 * department only when they belong to that department's branch. Direct assignment is explicit and is kept as made.
 */
export type StructureSubject={id:string;name?:string;status?:string;role_ids?:string[];branch_id?:string;branch_ids?:string[];kind_id?:string;members?:Array<{user_id:string;status?:string}>};
export type StructureBranch={id:string;name:string;status:'active'|'archived';is_default:boolean};
export type MembershipSource={department_id:string;kind:'direct'|'role'|'group'|'group_kind';id:string};
export type EffectiveMembership={id:string;department_ids:string[];branch_ids:string[];region_ids:string[];sources:MembershipSource[]};
const unique=(values:string[])=>[...new Set(values.filter(Boolean))].sort();
const inactive=(status?:string)=>['archived','inactive','disabled','deleted','missing'].includes(status||'active');

/** The branches a subject belongs to. Users and groups: their saved list, else `default`. Outside companies: empty means every branch. */
export function subjectBranchIds(subject:StructureSubject,kind:'organization_user'|'resource_group'|'organization_connection'='organization_user'){
  const ids=unique([...(Array.isArray(subject.branch_ids)?subject.branch_ids.map(String):[]),String(subject.branch_id||'')]);
  return ids.length||kind==='organization_connection'?ids:[DEFAULT_BRANCH_ID];
}
/** The active branches an active region holds. */
export function branchIdsInRegion(catalog:Pick<DepartmentCatalog,'regions'>,regionId:string){
  const region=(catalog.regions||[]).find(row=>row.id===regionId&&row.status!=='archived');
  return region?unique(region.branch_ids):[];
}
/** The active regions a branch is in. A branch is in at most one region; an empty list means it is in none. */
export function regionIdsForBranch(catalog:Pick<DepartmentCatalog,'regions'>,branchId:string){
  return (catalog.regions||[]).filter(row=>row.status!=='archived'&&row.branch_ids.includes(branchId)).map(row=>row.id).sort();
}
export function departmentIdsInBranch(catalog:Pick<DepartmentCatalog,'departments'>,branchId:string){
  return catalog.departments.filter(row=>row.status!=='archived'&&row.branch_id===branchId).map(row=>row.id);
}
export function departmentIdsInRegion(catalog:Pick<DepartmentCatalog,'departments'|'regions'>,regionId:string){
  const branches=new Set(branchIdsInRegion(catalog,regionId));
  return catalog.departments.filter(row=>row.status!=='archived'&&branches.has(row.branch_id)).map(row=>row.id);
}

/** Pure resolver shared by auth, scheduling, reporting and tests. Groups and departments do not nest; regions are flat. */
export function buildOrganizationStructure(catalog:DepartmentCatalog,users:StructureSubject[],groups:StructureSubject[],connections:StructureSubject[]=[],branchList?:StructureBranch[]){
  const branches:StructureBranch[]=branchList?.length?[...branchList]:unique([DEFAULT_BRANCH_ID,...catalog.departments.map(d=>d.branch_id),...(catalog.regions||[]).flatMap(r=>r.branch_ids)]).map(id=>({id,name:'',status:'active' as const,is_default:id===DEFAULT_BRANCH_ID}));
  if(!branches.some(b=>b.id===DEFAULT_BRANCH_ID))branches.unshift({id:DEFAULT_BRANCH_ID,name:'',status:'active',is_default:true});
  const activeBranches=new Set(branches.filter(b=>b.status==='active').map(b=>b.id));
  const regions=(catalog.regions||[]).filter(r=>r.status!=='archived');
  const departments=catalog.departments.filter(d=>d.status==='active'&&activeBranches.has(d.branch_id));
  const regionIds=(branchIds:string[])=>unique(regions.filter(r=>r.branch_ids.some(id=>branchIds.includes(id))).map(r=>r.id));
  // An outside company with no branch belongs to every branch.
  const inBranch=(branchIds:string[],branchId:string,everyWhenEmpty=false)=>(everyWhenEmpty&&!branchIds.length)||branchIds.includes(branchId);
  const groupMemberships=groups.filter(g=>!inactive(g.status)).map(g=>{
    const branch_ids=subjectBranchIds(g,'resource_group');
    const sources:MembershipSource[]=departments.flatMap(d=>[...(d.subject_keys.includes(`resource_group:${g.id}`)?[{department_id:d.id,kind:'direct' as const,id:g.id}]:[]),...(d.group_kind_ids.includes(g.kind_id||'')&&inBranch(branch_ids,d.branch_id)?[{department_id:d.id,kind:'group_kind' as const,id:g.kind_id!}]:[])]);
    return {id:g.id,label:g.name||g.id,kind_id:g.kind_id||'',department_ids:unique(sources.map(s=>s.department_id)),branch_ids,region_ids:regionIds(branch_ids),sources};
  });
  const userMemberships=users.filter(u=>!inactive(u.status)).map(u=>{
    const branch_ids=subjectBranchIds(u,'organization_user');
    const memberGroups=groups.filter(g=>!inactive(g.status)&&g.members?.some(m=>m.user_id===u.id&&(!m.status||m.status==='active')));
    const sources:MembershipSource[]=departments.flatMap(d=>[...(d.subject_keys.includes(`organization_user:${u.id}`)?[{department_id:d.id,kind:'direct' as const,id:u.id}]:[]),...(inBranch(branch_ids,d.branch_id)?d.role_ids.filter(r=>u.role_ids?.includes(r)).map(id=>({department_id:d.id,kind:'role' as const,id})):[])]);
    for(const group of memberGroups)for(const department_id of groupMemberships.find(g=>g.id===group.id)?.department_ids||[])sources.push({department_id,kind:'group',id:group.id});
    return {id:u.id,resource_group_ids:unique(memberGroups.map(g=>g.id)),department_ids:unique(sources.map(s=>s.department_id)),branch_ids,region_ids:regionIds(branch_ids),sources};
  });
  const connectionMemberships=connections.filter(c=>!inactive(c.status)).map(c=>{
    const branch_ids=subjectBranchIds(c,'organization_connection');
    const department_ids=departments.filter(d=>d.subject_keys.includes(`organization_connection:${c.id}`)).map(d=>d.id);
    return {id:c.id,department_ids:unique(department_ids),branch_ids,region_ids:regionIds(branch_ids),sources:department_ids.map(department_id=>({department_id,kind:'direct' as const,id:c.id}))};
  });
  return {catalog,branches,regions,users:userMemberships,groups:groupMemberships,connections:connectionMemberships,meaningful_department_count:departments.length};
}
export type OrganizationStructure=ReturnType<typeof buildOrganizationStructure>;
export function departmentIdsForUser(structure:OrganizationStructure,userId:string){return structure.users.find(u=>u.id===userId)?.department_ids||[];}
export function departmentIdsForSubject(structure:OrganizationStructure,subjectType:string,id:string){return (subjectType==='organization_user'?structure.users:subjectType==='resource_group'?structure.groups:subjectType==='organization_connection'?structure.connections:[]).find(s=>s.id===id)?.department_ids||[];}

/** A branch document as the structure reads it. The placeholder name storage writes for `default` is no name. */
export function structureBranch(document:{id:string;data?:Record<string,unknown>}):StructureBranch{
  const data=document.data||{};
  const name=String(data.name||'').trim();
  return {id:document.id,name:document.id===DEFAULT_BRANCH_ID&&name==='Default Branch'?'':name,status:String(data.status||'')==='archived'||!!data.archived_at?'archived':'active',is_default:document.id===DEFAULT_BRANCH_ID};
}
export async function readStructureBranches(orgId:string):Promise<StructureBranch[]>{
  const documents=await listDocuments(orgId,'branch');
  const branches=documents.map(structureBranch);
  if(!branches.some(b=>b.id===DEFAULT_BRANCH_ID))branches.unshift({id:DEFAULT_BRANCH_ID,name:'',status:'active',is_default:true});
  return branches.sort((a,b)=>Number(b.is_default)-Number(a.is_default)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
}
export async function resolveOrganizationStructure(orgId:string):Promise<OrganizationStructure>{
  const branches=await readStructureBranches(orgId);
  const [catalog,documents,groups,connections]=await Promise.all([readOrganizationDepartments(orgId,branches.map(b=>b.id)),listDocuments(orgId,'users'),listAssignmentGroups(orgId,true),listOrganizationConnections(orgId)]);
  const users=documents.map(d=>({id:d.id,status:String(d.data.status||'active'),branch_id:String(d.data.branch_id||DEFAULT_BRANCH_ID),branch_ids:Array.isArray(d.data.branch_ids)?d.data.branch_ids.map(String):[],role_ids:unique([...(Array.isArray(d.data.roles)?d.data.roles.map(String):[]),...(Array.isArray(d.data.access_role_ids)?d.data.access_role_ids.map(String):[])])}));
  return buildOrganizationStructure(catalog,users,groups,connections.map(c=>({id:String(c.id),status:String(c.status),branch_ids:Array.isArray(c.branch_ids)?c.branch_ids.map(String):[]})),branches);
}
