import {appointmentCatalogSchema} from './planning-contracts.js';
import {readBranchModule,saveBranchModule} from '../platform/storage.js';

export function defaultAppointmentCatalog(){
  return appointmentCatalogSchema.parse({departments:[{id:'sales',label:'Sales',color:'#16a34a',role_ids:['sales_appointments']},{id:'production',label:'Production',color:'#2563eb',group_kind_ids:['crew'],role_ids:['crew_member','repairman','crew_foreman','supervisor']}],presets:[{id:'sales',label:'Sales appointment',configuration:{title:'Sales appointment',department_ids:['sales'],requirements:[{department_id:'sales',subject_type:'organization_user'}]}},{id:'production',label:'Production appointment',configuration:{title:'Production appointment',department_ids:['production'],requirements:[{department_id:'production',subject_type:'resource_group'}]}}]});
}

export function instantFullAppointmentCatalog(){
  const sales={department_id:'sales',subject_type:'organization_user',mode:'count',count:1};
  const crew={department_id:'production',subject_type:'resource_group',mode:'count',count:1,crew_member_percent:100};
  return appointmentCatalogSchema.parse({...defaultAppointmentCatalog(),presets:[
    {id:'sales',label:'Sales appointments',configuration:{title:'Sales appointment',department_ids:['sales'],duration_minutes:60,window_minutes:60,requirements:[sales]}},
    {id:'installation',label:'Installation work',configuration:{title:'Installation work',department_ids:['production'],timing_mode:'days',duration_days:2,requirements:[crew]}},
    {id:'maintenance',label:'Maintenance appointments',configuration:{title:'Maintenance appointment',department_ids:['production'],duration_minutes:60,window_minutes:240,requirements:[crew],recurrence:{frequency:'quarterly',interval:1,occurrence_count:4}}},
    {id:'repair',label:'Repair appointments',configuration:{title:'Repair appointment',department_ids:['production'],duration_minutes:60,window_minutes:240,requirements:[crew]}},
    {id:'delivery',label:'Material deliveries',configuration:{title:'Material delivery',department_ids:['production'],delivery:true,duration_minutes:60,window_minutes:240,requirements:[crew]}},
    {id:'company-meeting',label:'Company meeting',configuration:{title:'Company meeting',duration_minutes:60,window_minutes:60,location:{mode:'company_office'},requirements:[{subject_type:'organization_user',mode:'all'}]}},
    {id:'sales-meeting',label:'Company sales meeting',configuration:{title:'Company sales meeting',department_ids:['sales'],duration_minutes:60,window_minutes:60,location:{mode:'company_office'},requirements:[{department_id:'sales',subject_type:'organization_user',mode:'all'}]}}
  ]});
}

/** Creation-only seed; existing catalogs are never replaced. */
export async function seedInstantFullAppointmentCatalog(orgId:string){
  const existing=await readBranchModule(orgId,'default','scheduling').catch((error)=>{if(error.statusCode===404)return null;throw error;});
  if(existing?.data?.appointment_catalog)return;
  await saveBranchModule(orgId,'default','scheduling',{data:{...existing?.data,appointment_catalog:instantFullAppointmentCatalog()},expected_revision:existing?.revision||0},{replace:true});
}
