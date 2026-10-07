import type {DepartmentCatalog} from './department-contracts.js';
import {readOrganizationDepartments} from './departments.js';
import {listDocuments} from '../platform/storage.js';
import {listAssignmentGroups} from './storage.js';
import {listOrganizationConnections} from '../connections/storage.js';

export type StructureSubject={id:string;status?:string;role_ids?:string[];branch_id?:string;kind_id?:string;members?:Array<{user_id:string;status?:string}>};
export type MembershipSource={department_id:string;kind:'direct'|'role'|'group'|'group_kind';id:string};
export type EffectiveMembership={id:string;department_ids:string[];division_ids:string[];sources:MembershipSource[]};
const unique=(values:string[])=>[...new Set(values)].sort();
/** Includes the selected unit. Archived or invalid ancestry confers no membership. */
export function divisionAncestors(catalog:DepartmentCatalog,divisionId:string):string[]{
  const result:string[]=[];let current=divisionId;
  while(current){const row=catalog.divisions.find(d=>d.id===current);if(!row||row.status==='archived'||result.includes(current))return [];result.push(current);current=row.parent_id;}
  return result;
}
export function departmentIdsInDivision(catalog:DepartmentCatalog,divisionId:string){return catalog.departments.filter(d=>d.status!=='archived'&&divisionAncestors(catalog,d.division_id).includes(divisionId)).map(d=>d.id);}
/** Pure resolver shared by auth, scheduling, reporting, and tests. Resource groups remain flat. */
export function buildOrganizationStructure(catalog:DepartmentCatalog,users:StructureSubject[],groups:StructureSubject[],connections:StructureSubject[]=[]){
  const active=(s:StructureSubject)=>!['archived','inactive','disabled','deleted','missing'].includes(s.status||'active');
  const departments=catalog.departments.filter(d=>d.status==='active'&&(!d.division_id||divisionAncestors(catalog,d.division_id).length));
  const units=catalog.divisions.filter(d=>divisionAncestors(catalog,d.id).length);
  const affiliation=(subject:StructureSubject,key:string,departmentIds:string[])=>unique([
    ...units.filter(d=>d.subject_keys.includes(key)||(d.branch_id&&d.branch_id===subject.branch_id)).flatMap(d=>divisionAncestors(catalog,d.id)),
    ...departments.filter(d=>departmentIds.includes(d.id)).flatMap(d=>divisionAncestors(catalog,d.division_id))
  ]);
  const groupMemberships=groups.filter(active).map(g=>{const sources:MembershipSource[]=departments.flatMap(d=>[...(d.subject_keys.includes(`resource_group:${g.id}`)?[{department_id:d.id,kind:'direct' as const,id:g.id}]:[]),...(d.group_kind_ids.includes(g.kind_id||'')?[{department_id:d.id,kind:'group_kind' as const,id:g.kind_id!}]:[])]);const department_ids=unique(sources.map(s=>s.department_id));return {id:g.id,department_ids,division_ids:affiliation(g,`resource_group:${g.id}`,department_ids),sources};});
  const userMemberships=users.filter(active).map(u=>{
    const memberGroups=groups.filter(g=>active(g)&&g.members?.some(m=>m.user_id===u.id&&(!m.status||m.status==='active')));
    const sources:MembershipSource[]=departments.flatMap(d=>[...(d.subject_keys.includes(`organization_user:${u.id}`)?[{department_id:d.id,kind:'direct' as const,id:u.id}]:[]),...d.role_ids.filter(r=>u.role_ids?.includes(r)).map(id=>({department_id:d.id,kind:'role' as const,id}))]);
    for(const group of memberGroups)for(const department_id of groupMemberships.find(g=>g.id===group.id)?.department_ids||[])sources.push({department_id,kind:'group',id:group.id});
    const department_ids=unique(sources.map(s=>s.department_id));
    return {id:u.id,department_ids,division_ids:unique([...affiliation(u,`organization_user:${u.id}`,department_ids),...memberGroups.flatMap(g=>groupMemberships.find(m=>m.id===g.id)?.division_ids||[])]),sources};
  });
  const connectionMemberships=connections.filter(active).map(c=>{const department_ids=departments.filter(d=>d.subject_keys.includes(`organization_connection:${c.id}`)).map(d=>d.id);return {id:c.id,department_ids,division_ids:affiliation(c,`organization_connection:${c.id}`,department_ids),sources:department_ids.map(department_id=>({department_id,kind:'direct' as const,id:c.id}))};});
  return {catalog,users:userMemberships,groups:groupMemberships,connections:connectionMemberships,meaningful_department_count:departments.length};
}
export type OrganizationStructure=ReturnType<typeof buildOrganizationStructure>;
export function departmentIdsForUser(structure:OrganizationStructure,userId:string){return structure.users.find(u=>u.id===userId)?.department_ids||[];}
export function departmentIdsForSubject(structure:OrganizationStructure,subjectType:string,id:string){return (subjectType==='organization_user'?structure.users:subjectType==='resource_group'?structure.groups:subjectType==='organization_connection'?structure.connections:[]).find(s=>s.id===id)?.department_ids||[];}
export async function resolveOrganizationStructure(orgId:string):Promise<OrganizationStructure>{
  const [catalog,documents,groups,connections]=await Promise.all([readOrganizationDepartments(orgId),listDocuments(orgId,'users'),listAssignmentGroups(orgId,true),listOrganizationConnections(orgId)]);
  const users=documents.map(d=>({id:d.id,status:String(d.data.status||'active'),branch_id:String(d.data.branch_id||'default'),role_ids:unique([...(Array.isArray(d.data.roles)?d.data.roles.map(String):[]),...(Array.isArray(d.data.access_role_ids)?d.data.access_role_ids.map(String):[])])}));
  return buildOrganizationStructure(catalog,users,groups,connections.map(c=>({id:String(c.id),status:String(c.status)})));
}
