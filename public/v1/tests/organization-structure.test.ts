import test from 'node:test';
import assert from 'node:assert/strict';
import {departmentCatalogSchema,departmentSaveSchema,isLegacyCatalog,migrateLegacyCatalog} from '../workforce/department-contracts.js';
import {buildOrganizationStructure,departmentIdsForUser,departmentIdsInBranch,departmentIdsInRegion,branchIdsInRegion,regionIdsForBranch,structureBranch} from '../workforce/organization-structure.js';
import {resolveScopedAccessGrants} from '../workforce/department-access.js';
import {selectAppointmentResources,appointmentConfigurationSchema,appointmentCatalogSchema} from '../appointments/planning.js';
import type {AccessRole} from '../workforce/access.js';

const branches=[{id:'default',name:'',status:'active' as const,is_default:true},{id:'scranton',name:'Scranton',status:'active' as const,is_default:false},{id:'erie',name:'Erie',status:'active' as const,is_default:false}];

test('effective departments expand flat groups once, retain independent sources and exclude inactive members',()=>{
  const catalog=departmentCatalogSchema.parse({regions:[{id:'pa',label:'Pennsylvania',branch_ids:['scranton','erie']}],departments:[{id:'sales',label:'Inside Sales',branch_id:'scranton',subject_keys:['organization_user:alice','resource_group:dispatch','organization_connection:partner'],role_ids:['sales']},{id:'production',label:'Production',branch_id:'scranton',group_kind_ids:['crew']},{id:'old',label:'Archived',status:'archived',subject_keys:['organization_user:alice']}]});
  const users=[{id:'alice',role_ids:['sales'],branch_id:'scranton'},{id:'bob',branch_id:'scranton'},{id:'disabled',status:'disabled'},{id:'inactive'}];
  const groups=[{id:'dispatch',kind_id:'crew',branch_id:'scranton',members:[{user_id:'alice'},{user_id:'bob'},{user_id:'disabled'},{user_id:'inactive',status:'inactive'}]},{id:'retired',status:'archived',kind_id:'crew',members:[{user_id:'inactive'}]}];
  const result=buildOrganizationStructure(catalog,users,groups,[{id:'partner'}],branches);
  assert.deepEqual(departmentIdsForUser(result,'alice'),['production','sales']);
  assert.deepEqual(departmentIdsForUser(result,'bob'),['production','sales']);
  assert.deepEqual(departmentIdsForUser(result,'inactive'),[]);
  assert.deepEqual(result.users.find(u=>u.id==='alice')?.resource_group_ids,['dispatch']);
  assert.deepEqual(result.users.find(u=>u.id==='inactive')?.resource_group_ids,[]);
  assert.equal(result.groups[0]!.kind_id,'crew');
  assert.equal(result.users.some(u=>u.id==='disabled'),false);
  assert.deepEqual(result.users.find(u=>u.id==='bob')?.branch_ids,['scranton']);
  assert.deepEqual(result.users.find(u=>u.id==='bob')?.region_ids,['pa']);
  assert.deepEqual(result.users.find(u=>u.id==='inactive')?.branch_ids,['default'],'a person with no branch saved is in the default branch');
  assert.equal(result.users.find(u=>u.id==='alice')?.sources.filter(s=>s.department_id==='sales').length,3);
  assert.deepEqual(result.connections[0]!.department_ids,['sales']);
  assert.deepEqual(result.connections[0]!.branch_ids,[],'a company with no branch works in every branch');
  assert.deepEqual(departmentIdsInRegion(catalog,'pa'),['sales','production']);
  assert.deepEqual(departmentIdsInBranch(catalog,'scranton'),['sales','production']);
  assert.deepEqual(branchIdsInRegion(catalog,'pa'),['erie','scranton']);
  assert.deepEqual(regionIdsForBranch(catalog,'erie'),['pa']);
  assert.deepEqual(regionIdsForBranch(catalog,'default'),[]);
  const noGroup=buildOrganizationStructure(catalog,users,[],[],branches);
  assert.deepEqual(departmentIdsForUser(noGroup,'alice'),['sales']);
  assert.deepEqual(departmentIdsForUser(noGroup,'bob'),[]);
});

test('each branch has its own departments: a role or group type puts someone only in departments of their branches',()=>{
  const catalog=departmentCatalogSchema.parse({departments:[{id:'scranton-sales',label:'Sales',branch_id:'scranton',role_ids:['sales'],group_kind_ids:['crew']},{id:'erie-sales',label:'Sales',branch_id:'erie',role_ids:['sales'],group_kind_ids:['crew']}]});
  const result=buildOrganizationStructure(catalog,[{id:'ann',role_ids:['sales'],branch_id:'scranton'},{id:'both',role_ids:['sales'],branch_id:'scranton',branch_ids:['erie']}],[{id:'crew-s',kind_id:'crew',branch_id:'scranton'},{id:'crew-e',kind_id:'crew',branch_id:'erie'}],[],branches);
  assert.deepEqual(departmentIdsForUser(result,'ann'),['scranton-sales']);
  assert.deepEqual(departmentIdsForUser(result,'both'),['erie-sales','scranton-sales']);
  assert.deepEqual(result.groups.find(g=>g.id==='crew-e')?.department_ids,['erie-sales']);
  // A department-scoped role is scoped to that one branch's department.
  const roles=[{id:'lead',status:'active',permissions:{view_comms:true}}] as unknown as AccessRole[];
  const [grant]=resolveScopedAccessGrants([{role_id:'lead',scope:{kind:'department',id:'erie-sales'}}],roles,result);
  assert.deepEqual(grant?.scope,{kind:'department',id:'erie-sales'});
});

test('empty departments stay implicit; archived branches and regions confer nothing',()=>{
  const catalog=departmentCatalogSchema.parse({departments:[]});
  assert.equal(buildOrganizationStructure(catalog,[{id:'sole'}],[]).meaningful_department_count,0);
  const closed=departmentCatalogSchema.parse({regions:[{id:'gone',label:'Gone',status:'archived',branch_ids:['erie']}],departments:[{id:'sales',label:'Sales',branch_id:'erie',subject_keys:['organization_user:u']}]});
  const archived=buildOrganizationStructure(closed,[{id:'u',branch_id:'erie'}],[],[],[branches[0]!,{...branches[2]!,status:'archived'}]);
  assert.deepEqual(departmentIdsForUser(archived,'u'),[]);
  assert.deepEqual(archived.users[0]!.region_ids,[]);
  assert.deepEqual(branchIdsInRegion(closed,'gone'),[]);
});

test('categories are gone: the catalog and a department save refuse them',()=>{
  assert.throws(()=>departmentCatalogSchema.parse({departments:[],groups:[]}));
  assert.throws(()=>departmentCatalogSchema.parse({departments:[{id:'sales',label:'Sales',group_id:'office'}]}));
  assert.throws(()=>departmentSaveSchema.parse({departments:[],groups:[],revision:0}));
  assert.throws(()=>departmentSaveSchema.parse({departments:[{id:'sales',label:'Sales',division_id:'x'}],revision:0}));
  assert.equal('groups' in departmentCatalogSchema.parse({departments:[]}),false);
  // A scheduling copy saved with categories reads without them.
  const copy=appointmentCatalogSchema.parse({departments:[{id:'sales',label:'Sales',group_id:'office',division_id:'x'}],groups:[{id:'office',label:'Office'}],presets:[]});
  assert.deepEqual(copy.groups,[]);
  assert.equal('group_id' in copy.departments[0]!,false);
});

test('a catalog with units migrates on read: branch units become branches, groupings become flat regions, the rest are dropped',()=>{
  const legacy={
    groups:[{id:'office',label:'Office'}],
    divisions:[
      {id:'east',label:'East',kind:'Region'},
      {id:'scranton-unit',label:'Scranton',kind:'Branch',parent_id:'east',branch_id:'scranton'},
      {id:'erie-unit',label:'Erie',kind:'Branch',parent_id:'east',branch_id:'erie'},
      {id:'office-unit',label:'Back office',parent_id:'scranton-unit',subject_keys:['organization_user:ann']},
      {id:'loose',label:'Loose'},
      {id:'retired',label:'Retired',status:'archived',branch_id:'erie'},
      {id:'ghost',label:'Ghost',branch_id:'nowhere'}
    ],
    departments:[{id:'sales',label:'Sales',group_id:'office',division_id:'office-unit'},{id:'service',label:'Service',division_id:'loose'},{id:'plain',label:'Plain',group_id:'office',division_id:''}]
  };
  assert.equal(isLegacyCatalog(legacy),true);
  const migrated=migrateLegacyCatalog(legacy,['default','scranton','erie']);
  assert.deepEqual(migrated.regions,[{id:'east',label:'East',status:'active',branch_ids:['erie','scranton']}]);
  assert.deepEqual(migrated.departments.map(d=>[d.id,d.branch_id]),[['sales','scranton'],['service','default'],['plain','default']]);
  assert.equal(migrated.departments.some(d=>'group_id' in d||'division_id' in d),false);
  assert.deepEqual(migrated.unit_migration?.scopes,{
    east:[{kind:'region',id:'east'}],'scranton-unit':[{kind:'branch',id:'scranton'}],'erie-unit':[{kind:'branch',id:'erie'}]
  });
  // A unit that names no branch, itself or below it, is dropped; its departments still go to the nearest branch above.
  assert.deepEqual(migrated.unit_migration?.dropped_unit_ids,['ghost','loose','office-unit','retired']);
  assert.equal(isLegacyCatalog(migrated),false);
  // Saved grants on units resolve to what the unit now covers.
  const structure=buildOrganizationStructure(migrated,[],[],[],branches);
  const roles=[{id:'lead',status:'active',permissions:{view_comms:true}}] as unknown as AccessRole[];
  assert.deepEqual(resolveScopedAccessGrants([{role_id:'lead',scope:{kind:'division',id:'east'}}],roles,structure).map(g=>g.scope),[{kind:'region',id:'east'}]);
  assert.deepEqual(resolveScopedAccessGrants([{role_id:'lead',scope:{kind:'division',id:'scranton-unit'}}],roles,structure).map(g=>g.scope),[{kind:'branch',id:'scranton'}]);
  assert.deepEqual(resolveScopedAccessGrants([{role_id:'lead',scope:{kind:'division',id:'office-unit'}}],roles,structure),[]);
  assert.deepEqual(resolveScopedAccessGrants([{role_id:'lead',scope:{kind:'division',id:'loose'}}],roles,structure),[]);
});

test('nested groupings flatten: each branch goes to its nearest grouping, and an outer grouping covers the regions inside it',()=>{
  const migrated=migrateLegacyCatalog({divisions:[{id:'country',label:'Country'},{id:'north',label:'North',parent_id:'country'},{id:'a',label:'A',parent_id:'north',branch_id:'scranton'},{id:'b',label:'B',parent_id:'country',branch_id:'erie'}],departments:[]},['scranton','erie']);
  assert.deepEqual(migrated.regions.map(r=>[r.id,r.branch_ids]),[['country',['erie']],['north',['scranton']]]);
  assert.deepEqual(migrated.unit_migration?.scopes.country,[{kind:'region',id:'country'},{kind:'region',id:'north'}]);
});

test('the default branch is unnamed until someone names it',()=>{
  assert.deepEqual(structureBranch({id:'default',data:{name:'Default Branch'}}),{id:'default',name:'',status:'active',is_default:true});
  assert.deepEqual(structureBranch({id:'default',data:{name:'Main yard'}}).name,'Main yard');
  assert.equal(structureBranch({id:'b1',data:{name:'Erie',status:'archived'}}).status,'archived');
});

test('scheduling uses effective membership and does not count group plus member twice',()=>{
  const catalog=departmentCatalogSchema.parse({departments:[{id:'dispatch',label:'Dispatch',subject_keys:['resource_group:team']}]});
  const resources=[{id:'team',subject_type:'resource_group',department_ids:['dispatch'],member_user_ids:['alice']},{id:'alice',subject_type:'organization_user',department_ids:['dispatch']}];
  const available=new Set(['resource_group:team','organization_user:alice']);
  const individual=appointmentConfigurationSchema.parse({requirements:[{department_id:'dispatch',subject_type:'organization_user'}]});
  assert.deepEqual(selectAppointmentResources(individual,catalog.departments,resources,available)?.map(r=>r.id),['alice']);
  const mixed=appointmentConfigurationSchema.parse({requirements:[{department_id:'dispatch',subject_type:'any',count:2}]});
  assert.equal(selectAppointmentResources(mixed,catalog.departments,resources,available),null);
});

test('active resource groups retain IDs independently of department affiliation',()=>{
 const catalog=departmentCatalogSchema.parse({departments:[]});const structure=buildOrganizationStructure(catalog,[{id:'user'}],[{id:'standalone',name:'Standalone',kind_id:'crew',members:[{user_id:'user'}]}]);assert.deepEqual(structure.users[0]!.resource_group_ids,['standalone']);assert.deepEqual(structure.users[0]!.department_ids,[]);assert.equal(structure.groups[0]!.label,'Standalone');
});
