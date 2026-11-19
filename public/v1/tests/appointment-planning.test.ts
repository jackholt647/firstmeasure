import assert from 'node:assert/strict';
import test from 'node:test';
import {appointmentConfigurationSchema,selectAppointmentResources,appointmentCatalogSchema,appointmentStaffing} from '../appointments/planning.js';

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
test('a branch catalog keeps only its own departments: stored presets drop other branches and a save names them',async()=>{
  const {departmentInBranch,presetsForBranch,otherBranchDepartmentIds}=await import('../appointments/planning.js');
  const org=[{id:'east-sales',branch_id:'east'},{id:'west-sales',branch_id:'west'},{id:'legacy'}];
  assert.equal(departmentInBranch({branch_id:'east'},'east'),true);
  assert.equal(departmentInBranch({branch_id:'west'},'east'),false);
  assert.equal(departmentInBranch({},'east'),true,'a department without a branch belongs to every branch');
  const stored=appointmentCatalogSchema.parse({departments:[],presets:[{id:'p',label:'P',configuration:{department_ids:['east-sales','west-sales','legacy'],requirements:[{department_id:'west-sales'},{department_id:'east-sales'},{}]}}]});
  const [kept]=presetsForBranch(stored.presets,org,'east');
  assert.deepEqual(kept!.configuration.department_ids,['east-sales','legacy']);
  assert.deepEqual(kept!.configuration.requirements.map(r=>r.department_id),['east-sales',undefined]);
  assert.deepEqual(otherBranchDepartmentIds(stored,org,'east'),['west-sales']);
  assert.deepEqual(otherBranchDepartmentIds({...stored,presets:presetsForBranch(stored.presets,org,'east')},org,'east'),[]);
});
test('a type that never said whether it needs a project: sales and production work does, an office meeting does not (FM-557)',async()=>{
  const {requiresProject}=await import('../appointments/planning.js');
  const parse=(value:unknown)=>appointmentConfigurationSchema.parse(value);
  assert.equal(requiresProject(parse({department_ids:['sales']})),true);
  assert.equal(requiresProject(parse({department_ids:['production']})),true);
  assert.equal(requiresProject(parse({event_type_id:'project_work'})),true);
  assert.equal(requiresProject(parse({department_ids:['sales'],location:{mode:'company_office'}})),false);
  assert.equal(requiresProject(parse({department_ids:['consulting']})),false);
  assert.equal(requiresProject(parse({department_ids:['sales'],requires_project:false})),false,'a type that says is taken at its word');
  assert.equal(requiresProject(parse({requires_project:true})),true);
});

test("a person booking an appointment nobody can staff yet gets an unassigned time; a customer does not (GP-85)", () => {
  const departments=appointmentCatalogSchema.parse({departments:[{id:'production',label:'Production',group_kind_ids:['crew']}],presets:[]}).departments;
  const people=[{id:'1',subject_type:'organization_user',name:'One',department_ids:['production']}];
  const crewWork=appointmentConfigurationSchema.parse({department_ids:['production'],requirements:[{department_id:'production',subject_type:'resource_group',crew_member_percent:100}]});
  assert.equal(selectAppointmentResources(crewWork,departments,people,new Set(['organization_user:1'])),null,'a customer, or the old behaviour');
  assert.deepEqual(selectAppointmentResources(crewWork,departments,people,new Set(['organization_user:1']),{unstaffed:'allow'}),[],'booked unassigned: there are no crews at all');
  const crews=[...people,{id:'c1',subject_type:'resource_group',name:'Crew',department_ids:['production'],member_user_ids:['1']}];
  assert.equal(selectAppointmentResources(crewWork,departments,crews,new Set(),{unstaffed:'allow'}),null,'a crew that is only busy still blocks');
  assert.deepEqual(appointmentStaffing(crewWork,departments,people).map(r=>[r.subject_type,r.pool,r.unstaffed]),[['resource_group',0,true]]);
  assert.deepEqual(appointmentStaffing(crewWork,departments,crews,new Set(['resource_group:c1','organization_user:1'])).map(r=>[r.pool,r.free]),[[1,1]]);
});
