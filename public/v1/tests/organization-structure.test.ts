import test from 'node:test';
import assert from 'node:assert/strict';
import {departmentCatalogSchema} from '../workforce/department-contracts.js';
import {buildOrganizationStructure,departmentIdsForUser,divisionAncestors,departmentIdsInDivision} from '../workforce/organization-structure.js';
import {selectAppointmentResources,appointmentConfigurationSchema} from '../appointments/planning.js';

test('effective departments expand flat groups once, retain independent sources and exclude inactive members',()=>{
  const catalog=departmentCatalogSchema.parse({groups:[],divisions:[{id:'region',label:'Pennsylvania',kind:'Region'},{id:'branch',label:'Scranton',kind:'Branch',parent_id:'region'},{id:'office',label:'Office',parent_id:'branch',subject_keys:['resource_group:dispatch']}],departments:[{id:'sales',label:'Inside Sales',division_id:'branch',subject_keys:['organization_user:alice','resource_group:dispatch','organization_connection:partner'],role_ids:['sales']},{id:'production',label:'Production',group_kind_ids:['crew']},{id:'old',label:'Archived',status:'archived',subject_keys:['organization_user:alice']}]});
  const users=[{id:'alice',role_ids:['sales']},{id:'bob'},{id:'disabled',status:'disabled'},{id:'inactive'}];
  const groups=[{id:'dispatch',kind_id:'crew',members:[{user_id:'alice'},{user_id:'bob'},{user_id:'disabled'},{user_id:'inactive',status:'inactive'}]},{id:'retired',status:'archived',kind_id:'crew',members:[{user_id:'inactive'}]}];
  const result=buildOrganizationStructure(catalog,users,groups,[{id:'partner'}]);
  assert.deepEqual(departmentIdsForUser(result,'alice'),['production','sales']);
  assert.deepEqual(departmentIdsForUser(result,'bob'),['production','sales']);
  assert.deepEqual(departmentIdsForUser(result,'inactive'),[]);
  assert.equal(result.users.some(u=>u.id==='disabled'),false);
  assert.deepEqual(result.users.find(u=>u.id==='bob')?.division_ids,['branch','office','region']);
  assert.equal(result.users.find(u=>u.id==='alice')?.sources.filter(s=>s.department_id==='sales').length,3);
  assert.deepEqual(result.connections[0]!.department_ids,['sales']);
  assert.deepEqual(departmentIdsInDivision(catalog,'region'),['sales']);
  assert.deepEqual(divisionAncestors(catalog,'office'),['office','branch','region']);
  const noGroup=buildOrganizationStructure(catalog,users,[],[]);
  assert.deepEqual(departmentIdsForUser(noGroup,'alice'),['sales']);
  assert.deepEqual(departmentIdsForUser(noGroup,'bob'),[]);
});

test('empty departments stay implicit and invalid or archived unit ancestry grants nothing',()=>{
  const catalog=departmentCatalogSchema.parse({departments:[],groups:[]});
  assert.equal(buildOrganizationStructure(catalog,[{id:'sole'}],[]).meaningful_department_count,0);
  const invalid=departmentCatalogSchema.parse({groups:[],divisions:[{id:'a',label:'A',parent_id:'b'},{id:'b',label:'B',parent_id:'a'},{id:'closed',label:'Closed',status:'archived'}],departments:[{id:'sales',label:'Sales',division_id:'closed',subject_keys:['organization_user:u']}]});
  assert.deepEqual(divisionAncestors(invalid,'a'),[]);
  assert.deepEqual(departmentIdsForUser(buildOrganizationStructure(invalid,[{id:'u'}],[]),'u'),[]);
});

test('scheduling uses effective membership and does not count group plus member twice',()=>{
  const catalog=departmentCatalogSchema.parse({groups:[],departments:[{id:'dispatch',label:'Dispatch',subject_keys:['resource_group:team']}]});
  const resources=[{id:'team',subject_type:'resource_group',department_ids:['dispatch'],member_user_ids:['alice']},{id:'alice',subject_type:'organization_user',department_ids:['dispatch']}];
  const available=new Set(['resource_group:team','organization_user:alice']);
  const individual=appointmentConfigurationSchema.parse({requirements:[{department_id:'dispatch',subject_type:'organization_user'}]});
  assert.deepEqual(selectAppointmentResources(individual,catalog.departments,resources,available)?.map(r=>r.id),['alice']);
  const mixed=appointmentConfigurationSchema.parse({requirements:[{department_id:'dispatch',subject_type:'any',count:2}]});
  assert.equal(selectAppointmentResources(mixed,catalog.departments,resources,available),null);
});
