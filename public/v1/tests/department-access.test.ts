import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPermission, type PlatformAuthContext } from '../platform/auth.js';
import { resourcePermissionRules, scopedPermissionBranchIds, hasResourcePermission, resolveScopedAccessGrants, canUseScopedPermission, relevantDepartmentContext, matchesDepartmentFilter, canAccessDepartmentResource, validateScopedAccessAssignments, type OrganizationStructureAccess } from '../workforce/department-access.js';
import { authorizePublication, authorizePublicationDiscovery, userPublicationContext } from '../platform/publication/context.js';
import type { AccessRole } from '../workforce/access.js';
const structure: OrganizationStructureAccess = {
  catalog: { divisions: [{ id:'east' }, { id:'scranton',parent_id:'east',branch_id:'scranton' },{id:'west'},{id:'retired',status:'archived'}],
    departments: [{ id:'sales', label:'Sales', division_id:'scranton' }, { id:'production',label:'Production',division_id:'scranton' },{id:'west-sales',label:'West Sales',division_id:'west'},{id:'old',label:'Old',status:'archived'}] },
  users: [{id:'person',department_ids:['sales'],division_ids:['scranton','east']}]
};
const roles = [{id:'supervisor',status:'active',permissions:{view_comms:true,manage_communications:true}},{id:'admin',status:'active',permissions:{'*':true}}] as unknown as AccessRole[];
const context = (patch: Partial<PlatformAuthContext> = {}) => ({orgId:'org',userId:'person',role:'viewer',user:{},permissions:{},organizationStructure:structure,applicationAccess:{management:{enabled:true,role_id:'',permissions:{}}},scopedAccessGrants:resolveScopedAccessGrants([{role_id:'supervisor',scope:{kind:'department',id:'sales'}}],roles,structure),...patch} as PlatformAuthContext);
test('a scoped role grants only the actual matching resource and never global permission',()=>{
  const ctx=context();
  assert.equal(hasPermission(ctx,'manage_communications'),false);
  assert.equal(canUseScopedPermission(ctx,'manage_communications'),true);
  assert.equal(hasResourcePermission(ctx,'manage_communications',{department_id:'sales'}),true);
  assert.equal(hasResourcePermission(ctx,'manage_communications',{department_id:'production'}),false);
  assert.equal(hasResourcePermission(ctx,'manage_communications',{}),false);
  assert.equal(hasResourcePermission(ctx,'manage_communications',{organization_id:'other',department_id:'sales'}),false);
});
test('division grants cover descendants and mapped branches only',()=>{
  const ctx=context({scopedAccessGrants:resolveScopedAccessGrants([{role_id:'supervisor',scope:{kind:'division',id:'east'}}],roles,structure)});
  assert.equal(hasResourcePermission(ctx,'manage_communications',{department_id:'production'}),true);
  assert.equal(hasResourcePermission(ctx,'manage_communications',{branch_id:'scranton'}),true);
  assert.deepEqual(scopedPermissionBranchIds(ctx,'manage_communications'),['scranton']);
  assert.deepEqual(scopedPermissionBranchIds(context(),'manage_communications'),[]);
  assert.equal(hasResourcePermission(ctx,'manage_communications',{department_id:'west-sales'}),false);
});
test('explicit denials override wildcard and scoped grants',()=>{
  assert.equal(hasResourcePermission(context({permissions:{'*':true,manage_communications:false}}),'manage_communications',{department_id:'sales'}),false);
  const ctx=context({permissions:{'*':true},scopedAccessGrants:resolveScopedAccessGrants([{permissions:{manage_communications:false},scope:{kind:'department',id:'sales'}}],roles,structure)});
  assert.equal(hasResourcePermission(ctx,'manage_communications',{department_id:'sales'}),false);
  assert.equal(hasResourcePermission(ctx,'manage_communications',{department_id:'production'}),true);
});
test('permission rules preserve each OR capability and denials on mixed department resources',()=>{
  const ctx=context({scopedAccessGrants:resolveScopedAccessGrants([{permissions:{view_comms:true},scope:{kind:'division',id:'east'}},{permissions:{view_comms:false},scope:{kind:'department',id:'sales'}},{permissions:{view_call_recordings:true},scope:{kind:'department',id:'production'}}],roles,structure)});
  assert.equal(hasResourcePermission(ctx,'view_comms',{department_ids:['sales','production'],branch_id:'scranton'}),false);
  const [calls,recordings]=resourcePermissionRules(ctx,'view_comms|view_call_recordings');
  assert.ok(calls && recordings);
  assert.deepEqual(calls.branch_ids,['scranton']);
  assert.deepEqual(calls.denied_department_ids,['sales']);
  assert.deepEqual(recordings.department_ids,['production']);
  assert.deepEqual(recordings.denied_department_ids,[]);
  assert.equal(hasResourcePermission(ctx,'view_comms|view_call_recordings',{department_ids:['sales','production'],branch_id:'scranton'}),true);
  assert.deepEqual(resourcePermissionRules({...ctx,permissions:{view_comms:false}},'view_comms'),[]);
});
test('missing and archived scope/role never grants authority',()=>{
  for(const id of ['old','missing']) assert.deepEqual(resolveScopedAccessGrants([{role_id:'supervisor',scope:{kind:'department',id}}],roles,structure),[]);
  assert.deepEqual(resolveScopedAccessGrants([{role_id:'missing',scope:{kind:'department',id:'sales'}}],roles,structure),[]);
  assert.throws(()=>validateScopedAccessAssignments([{role_id:'admin',scope:{kind:'department',id:'sales'}}],roles,structure),/organization-wide/);
});
test('membership affects relevance but grants no capabilities, shared records stay visible',()=>{
  const ctx=context({scopedAccessGrants:[]});
  assert.equal(hasResourcePermission(ctx,'manage_communications',{department_id:'sales'}),false);
  assert.equal(relevantDepartmentContext(ctx).show_selector,false);
  assert.equal(matchesDepartmentFilter(ctx,{department_id:'sales'}),true);
  assert.equal(matchesDepartmentFilter(ctx,{department_id:'production'}),false);
  assert.equal(matchesDepartmentFilter(ctx,{}),true);
  assert.equal(matchesDepartmentFilter(ctx,{},'production'),false);
  assert.equal(canAccessDepartmentResource(ctx,{department_id:'production'}),true);
  assert.equal(canAccessDepartmentResource(ctx,{department_id:'production',department_access:'restricted'}),false);
  const nonmember=context({organizationStructure:{...structure,users:[]}});
  assert.equal(canAccessDepartmentResource(nonmember,{department_id:'sales',department_access:'restricted'}),false);
  assert.equal(canAccessDepartmentResource(nonmember,{department_id:'sales',department_access:'restricted'},'view_documents'),false);
  assert.equal(canAccessDepartmentResource(nonmember,{department_id:'sales',department_access:'restricted'},'view_comms'),true);
  const solo=context({organizationStructure:{catalog:{departments:[{id:'sales',label:'Sales'}]},users:[]}});
  assert.equal(relevantDepartmentContext(solo).show_selector,false);
  assert.equal(matchesDepartmentFilter(solo,{department_id:'sales'}),true);
  const renamed=context({organizationStructure:{catalog:{...structure.catalog,terminology:{department:{singular:'Practice',plural:'Practices'}}},users:structure.users}});
  assert.equal(relevantDepartmentContext(renamed).department_label,'Practice');
  assert.equal(relevantDepartmentContext(renamed).departments_label,'Practices');
});
test('publication only opts into scoped entry with a domain authorizer and validates loaded targets',async()=>{
  const ctx=userPublicationContext(context()); const target={scope:'organization' as const,organizationId:'org',id:'call'};
  await assert.rejects(authorizePublication(ctx,target,{scopes:['organization'],permissions:['view_comms']},'test'),/not permitted/);
  await assert.rejects(authorizePublication(ctx,target,{scopes:['organization'],permissions:['view_comms'],scopedPermissions:true},'test'),/authorizer/);
  await authorizePublication(ctx,target,{scopes:['organization'],permissions:['view_comms'],departmentResource:()=>({department_id:'sales'})},'test');
  await assert.rejects(authorizePublication(ctx,target,{scopes:['organization'],permissions:['view_comms'],departmentResource:()=>({department_id:'production'})},'test'),/not permitted/);
  await authorizePublicationDiscovery(ctx,target,{scopes:['organization'],permissions:['view_comms'],scopedPermissions:true,authorize:()=>{throw Error('Missing resource is deliberately not authorized during catalog discovery');}},'test');
});
