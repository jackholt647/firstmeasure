import assert from 'node:assert/strict';
import test from 'node:test';
import {appointmentConfigurationSchema,selectAppointmentResources,appointmentCatalogSchema} from '../appointments/planning.js';

const people=[1,2,3,4].map(id=>({id:String(id),subject_type:'organization_user',name:`Person ${id}`,role_ids:['sales']}));
const crew={id:'crew',subject_type:'resource_group',name:'Crew',member_user_ids:['1','2'],group_kind_id:'crew'};
const departments=appointmentCatalogSchema.parse({departments:[{id:'sales',label:'Sales',role_ids:['sales']},{id:'production',label:'Production',subject_keys:['resource_group:crew']}],presets:[]}).departments;
const configuration=(requirement:unknown)=>appointmentConfigurationSchema.parse({department_ids:['sales','production'],requirements:[requirement]});
test('staffing counts, percentages, specific resources and whole department requirements use eligible membership',()=>{
  const free=new Set(['organization_user:1','organization_user:2']);
  assert.equal(selectAppointmentResources(configuration({department_id:'sales',mode:'count',count:2}),departments,people,free)?.length,2);
  assert.equal(selectAppointmentResources(configuration({department_id:'sales',mode:'count',count:3}),departments,people,free),null);
  assert.equal(selectAppointmentResources(configuration({department_id:'sales',mode:'percent',percent:50}),departments,people,free)?.length,2);
  assert.equal(selectAppointmentResources(configuration({department_id:'sales',mode:'percent',percent:51}),departments,people,free),null);
  assert.equal(selectAppointmentResources(configuration({department_id:'sales',mode:'all'}),departments,people,free),null);
  assert.equal(selectAppointmentResources(configuration({department_id:'sales',mode:'specific',subject_keys:['organization_user:3']}),departments,people,free),null);
  assert.equal(selectAppointmentResources(configuration({department_id:'sales',mode:'specific',subject_keys:[]}),departments,people,free),null);
});
test('crew roster percentages require available members and reserve them as well as the crew',()=>{
  const resources=[...people,crew],free=new Set(['resource_group:crew','organization_user:1']);
  assert.equal(selectAppointmentResources(configuration({department_id:'production',crew_member_percent:100}),departments,resources,free),null);
  const partial=selectAppointmentResources(configuration({department_id:'production',crew_member_percent:50}),departments,resources,free);
  assert.deepEqual(partial?.map(r=>r.id),['crew','1']);
});
test('departments, delivery and recurrence are independent; invalid windows and unbounded recurrence are rejected',()=>{
  const empty=appointmentConfigurationSchema.parse({});assert.deepEqual(empty.department_ids,[]);assert.equal(empty.delivery,false);assert.equal(empty.recurrence,null);
  const both=appointmentConfigurationSchema.parse({department_ids:['sales','production'],delivery:true,recurrence:{frequency:'weekly',occurrence_count:4}});
  assert.equal(both.department_ids.length,2);assert.equal(both.delivery,true);
  assert.equal(appointmentConfigurationSchema.safeParse({duration_minutes:120,window_minutes:60}).success,false);
  assert.equal(appointmentConfigurationSchema.safeParse({recurrence:{frequency:'daily',occurrence_count:1000}}).success,false);
});
