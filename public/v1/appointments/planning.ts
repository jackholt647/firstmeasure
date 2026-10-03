import {env} from '../src/config/env.js';
import {defaultAppointmentCatalog,instantFullAppointmentCatalog} from './defaults.js';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {readBranchModule,saveBranchModule,readDocument,readGlobal,readOrganization,upsertDocument,type JsonObject} from '../platform/storage.js';
import {hasPermission,type PlatformAuthContext} from '../platform/auth.js';
import {badRequest,conflict,forbidden} from '../platform/errors.js';
import {withProjectDocumentLock} from '../platform/project_document_mutation.js';
import {appointmentAvailability,subjectMemberIds} from './availability.js';
import {resolveAssignableSubjects} from '../workforce/service.js';
import {filterAssignableSubjects} from '../workforce/assignability.js';
import {resolveOrganizationTimezone,zonedParts,zonedInstant} from '../platform/timezone.js';
import {occurrenceDate,createRecurrenceSeries,materializeRecurrenceSeries} from '../platform/recurrence.js';
import {isFirstMeasurePostgresEnabled,withPostgresTransaction,withPlatformPostgresClient} from '../src/database/postgres.js';

import {appointmentCatalogSchema,appointmentConfigurationSchema,previewSchema,plannedBookingSchema,type AppointmentConfiguration} from './planning-contracts.js';
export * from './planning-contracts.js';
const object=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const list=(v:unknown):JsonObject[]=>Array.isArray(v)?v.map(object):[];
const key=(v:JsonObject)=>`${v.subject_type}:${v.id}`;

const defaults=defaultAppointmentCatalog;
const optional=<T>(operation:Promise<T>)=>operation.catch((error)=>{if(error.statusCode===404)return null;throw error;});
function addressText(value:unknown):string {
  if(typeof value==='string')return value.trim();
  const a=object(value);return String(a.formatted_address||a.formatted||[a.address1||a.address_1||a.line1||a.address_line1||a.street,a.address2||a.address_2||a.line2||a.address_line2,a.city||a.locality,a.state||a.region||a.province,a.postal_code||a.postalCode||a.zip||a.zip_code,a.country||a.country_code].filter(Boolean).join(', '));
}
export async function companyOffice(orgId:string,branchId:string){
  const [global,branch]=await Promise.all([optional(readGlobal(orgId)),optional(readDocument(orgId,'branch',branchId))]);
  const globalContact=object(object(global?.data).contact),branchContact=object(object(branch?.data).contact);
  for(const contact of [branchContact,globalContact]){
    const address=addressText(contact.business_address||contact.businessAddress)||addressText(contact.address);
    if(address)return {mode:'company_office',label:'Company office',address,...object(contact.location)};
  }
  return {mode:'company_office',label:'Company office',address:''};
}
async function bookingLocation(ctx:PlatformAuthContext,config:AppointmentConfiguration,projectId?:string){
  if(config.location.mode==='none')return {mode:'none',address:''};
  if(config.location.mode==='company_office')return companyOffice(ctx.orgId,ctx.branchId||'default');
  if(config.location.mode==='custom')return {mode:'custom',address:config.location.address};
  const project=projectId?await readDocument(ctx.orgId,'projects',projectId):null,data=object(project?.data);
  return {...object(data.location),mode:'project',address:addressText(data.address||data.project_address||data.location),lat:data.lat||object(data.location).lat,lng:data.lng||object(data.location).lng};
}
export async function readAppointmentCatalog(ctx:PlatformAuthContext){
  const branch=await readBranchModule(ctx.orgId,ctx.branchId||'default','scheduling').catch((error)=>{if(error.statusCode===404)return null;throw error;});
  const stored=object(branch?.data).appointment_catalog;
  const org=await readOrganization(ctx.orgId);
  const isInstant=env.dataEnvironment==='development'&&object(org.metadata).sandbox_workflow_id==='swf_instant_full_org';
  const fallback=isInstant?instantFullAppointmentCatalog():defaults();
  const catalog=stored?appointmentCatalogSchema.parse(stored):fallback;
  const resources=await resolveAssignableSubjects(ctx.orgId,ctx.branchId||'default',{allow_unassigned:true,rules:[]});
  return {catalog,company_office:await companyOffice(ctx.orgId,ctx.branchId||'default'),revision:Number(branch?.revision||0),can_manage:hasPermission(ctx,'manage_company_settings'),resources:resources.subjects.map((r:JsonObject)=>({id:r.id,key:key(r),name:r.name||r.label||r.id,subject_type:r.subject_type,role_ids:r.role_ids,group_kind_id:r.group_kind_id,member_user_ids:subjectMemberIds(r)}))};
}
export async function saveAppointmentCatalog(ctx:PlatformAuthContext,input:unknown){
  if(!hasPermission(ctx,'manage_company_settings'))throw forbidden('appointment_catalog_denied','Company settings permission is required.');
  const {catalog,revision}=z.object({catalog:appointmentCatalogSchema,revision:z.number().int().nonnegative()}).strict().parse(input);
  for(const rows of [catalog.departments,catalog.groups,catalog.presets])if(new Set(rows.map(r=>r.id)).size!==rows.length)throw badRequest('duplicate_catalog_id','Each entry needs a unique ID.');
  const deps=new Set(catalog.departments.map(d=>d.id)),groups=new Set(catalog.groups.map(d=>d.id));
  if(catalog.departments.some(d=>d.group_id&&!groups.has(d.group_id)))throw badRequest('unknown_department_group','Choose an existing department group.');
  if(catalog.presets.some(p=>p.configuration.department_ids.some(d=>!deps.has(d))||p.configuration.requirements.some(r=>r.department_id&&!deps.has(r.department_id))))throw badRequest('unknown_department','A preset references a missing department.');
  return withProjectDocumentLock(ctx.orgId,'appointment_catalog',async()=>{
    const current=await readBranchModule(ctx.orgId,ctx.branchId||'default','scheduling').catch((error)=>{if(error.statusCode===404)return null;throw error;});
    if(Number(current?.revision||0)!==revision)throw conflict('stale_catalog','Settings changed. Reopen the editor before saving.');
    await saveBranchModule(ctx.orgId,ctx.branchId||'default','scheduling',{data:{...object(current?.data),appointment_catalog:catalog},expected_revision:revision},{replace:true});
    return readAppointmentCatalog(ctx);
  });
}
function departmentPool(resources:JsonObject[],department:ReturnType<typeof defaults>['departments'][number]){
  const rules:JsonObject[]=[];
  if(department.role_ids.length)rules.push({subject_types:['organization_user'],role_ids:department.role_ids});
  if(department.group_kind_ids.length)rules.push({subject_types:['resource_group'],group_kind_ids:department.group_kind_ids});
  const matched=rules.length?filterAssignableSubjects(resources,{rules,allow_unassigned:false}):[];
  return resources.filter(r=>department.subject_keys.includes(key(r))||matched.some(m=>key(m)===key(r)));
}
export function selectAppointmentResources(config:AppointmentConfiguration,departments:ReturnType<typeof defaults>['departments'],resources:JsonObject[],available:Set<string>){
  const chosen=new Map<string,JsonObject>();
  for(const requirement of config.requirements){
    const dep=requirement.department_id?departments.find(d=>d.id===requirement.department_id):null;
    if(requirement.department_id&&!dep)throw badRequest('unknown_department','A selected department no longer exists.');
    let pool=dep?departmentPool(resources,dep):resources;
    pool=pool.filter(r=>['organization_user','resource_group'].includes(String(r.subject_type))&&(requirement.subject_type==='any'||r.subject_type===requirement.subject_type));
    const count=requirement.mode==='all'?pool.length:requirement.mode==='percent'?Math.ceil(pool.length*requirement.percent/100):requirement.mode==='specific'?requirement.subject_keys.length:requirement.count;
    if(!count)return null;
    const candidates=pool.filter(r=>available.has(key(r))&&(requirement.mode!=='specific'||requirement.subject_keys.includes(key(r))));
    const usable=candidates.filter(r=>{
      if(r.subject_type!=='resource_group'||!requirement.crew_member_percent)return true;
      const members=Array.isArray(r.member_user_ids)?r.member_user_ids as string[]:[];
      return members.length>0&&members.filter(id=>available.has(`organization_user:${id}`)).length>=Math.ceil(members.length*requirement.crew_member_percent/100);
    });
    if(usable.length<count)return null;
    for(const resource of usable.slice(0,count)){
      chosen.set(key(resource),resource);
      if(resource.subject_type==='resource_group'&&requirement.crew_member_percent){
        const members=(resource.member_user_ids as string[]).filter(id=>available.has(`organization_user:${id}`)).slice(0,Math.ceil((resource.member_user_ids as string[]).length*requirement.crew_member_percent/100));
        for(const id of members){const member=resources.find(r=>r.subject_type==='organization_user'&&r.id===id);if(member)chosen.set(key(member),member);}
      }
    }
  }
  return [...chosen.values()];
}
function dayKey(date:Date,zone:string){const p=zonedParts(date,zone);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
async function projectAccess(ctx:PlatformAuthContext,projectId?:string){if(!projectId)return;const doc=await readDocument(ctx.orgId,'projects',projectId);if((String(object(doc.data).branch_id||'default'))!==(ctx.branchId||'default'))throw forbidden('appointment_branch_mismatch','Choose a project in your current branch.');}
export async function previewAppointment(ctx:PlatformAuthContext,input:z.infer<typeof previewSchema>){
  await projectAccess(ctx,input.project_id);
  const {catalog,resources}=await readAppointmentCatalog(ctx),config=input.configuration;
  if(config.department_ids.some(id=>!catalog.departments.some(d=>d.id===id)))throw badRequest('unknown_department','A selected department no longer exists.');
  if(config.requirements.some(r=>r.department_id&&!config.department_ids.includes(r.department_id)))throw badRequest('department_requirement','Staffing departments must also be selected for this appointment.');
  const zone=await resolveOrganizationTimezone(ctx.orgId,ctx.branchId||'default');
  const location=await bookingLocation(ctx,config,input.project_id);
  const cache=new Map<string,Awaited<ReturnType<typeof appointmentAvailability>>>();
  const daily=async(date:string)=>{
    if(!cache.has(date))cache.set(date,await appointmentAvailability(ctx.orgId,ctx.branchId||'default',{project_id:input.project_id,event_type_id:'appointment',start_date:date,end_date:date,duration_minutes:config.duration_minutes,address:location,limit:500},{assignmentPolicy:{allow_unassigned:true,rules:[]},slotMinutes:config.slot_minutes,fullDay:config.timing_mode==='days'}));
    return cache.get(date)!;
  };
  const day=await daily(input.date),slots:JsonObject[]=[];
  const rule=config.recurrence?{...config.recurrence,end_at:''}:null;
  if(config.timing_mode==='days'){
    const [y,m,d]=input.date.split('-').map(Number),anchor=zonedInstant(y!,m!,d!,0,0,zone);
    let available:Set<string>|null=null,valid=true;
    const starts=Array.from({length:rule?.occurrence_count||1},(_,i)=>rule?occurrenceDate(anchor,rule,i,zone):anchor);
    let previousEnd:Date|null=null;
    for(const start of starts){
      const local=zonedParts(start,zone);
      if(previousEnd&&start<previousEnd){valid=false;break;}
      previousEnd=zonedInstant(local.year,local.month,local.day+config.duration_days,0,0,zone);
      for(let offset=0;offset<config.duration_days;offset++){
        const date=zonedInstant(local.year,local.month,local.day+offset,0,0,zone);
        if(date.getTime()>Date.now()+730*86400000){valid=false;break;}
        const option=(await daily(dayKey(date,zone))).slots[0];
        if(!option){valid=false;break;}
        const keys=new Set(list(option.candidates).filter(r=>Number(r.available_units)>0).map(r=>String(r.resource_key)));
        available=available===null?keys:new Set(Array.from(available as Set<string>).filter(k=>keys.has(k)));
      }
      if(!valid)break;
    }
    const assigned=valid?selectAppointmentResources(config,catalog.departments,resources,available||new Set()):null;
    const end=zonedInstant(y!,m!,d!+config.duration_days,0,0,zone);
    return {ok:true,timezone:zone,slots:[{start_at:anchor.toISOString(),window_end_at:end.toISOString(),available:!!assigned,label:`${config.duration_days} full day${config.duration_days===1?'':'s'} · ${input.date}`,plan:assigned?{start_at:anchor.toISOString(),end_at:end.toISOString(),resources:assigned}:null}]};
  }
  for(const raw of day.slots){
    const anchor=new Date(String(raw.start_at)),windowEnd=new Date(anchor.getTime()+config.window_minutes*60000);
    const occurrences=Array.from({length:rule?.occurrence_count||1},(_,i)=>rule?occurrenceDate(anchor,rule,i,zone):anchor);
    if(occurrences.some(date=>date.getTime()>Date.now()+730*86400000))continue;
    let plan:JsonObject|null=null;
    for(let offset=0;offset<=config.window_minutes-config.duration_minutes;offset+=config.slot_minutes){
      let available:Set<string>|null=null,valid=true;
      const starts=occurrences.map(date=>new Date(date.getTime()+offset*60000));
      for(const start of starts){
        if(dayKey(start,zone)!==dayKey(new Date(start.getTime()+config.duration_minutes*60000-1),zone)){valid=false;break;}
        const options=await daily(dayKey(start,zone));
        const slot=options.slots.find(s=>s.start_at===start.toISOString());
        if(!slot){valid=false;break;}
        const keys=new Set(list(slot.candidates).filter(r=>Number(r.available_units)>0).map(r=>String(r.resource_key)));
        available=available===null?keys:new Set(Array.from(available as Set<string>).filter((k:string)=>keys.has(k)));
      }
      if(!valid)continue;
      const assigned=selectAppointmentResources(config,catalog.departments,resources,available||new Set());
      if(assigned){plan={start_at:starts[0]!.toISOString(),end_at:new Date(starts[0]!.getTime()+config.duration_minutes*60000).toISOString(),resources:assigned};break;}
    }
    const label=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit'});
    slots.push({start_at:anchor.toISOString(),available:!!plan,label:config.window_minutes>config.duration_minutes?`${label.format(anchor)} – ${label.format(windowEnd)} arrival`:`${label.format(anchor)}`,window_end_at:windowEnd.toISOString(),plan});
  }
  return {ok:true,timezone:zone,slots};
}
export async function bookPlannedAppointment(ctx:PlatformAuthContext,input:z.infer<typeof plannedBookingSchema>){
  if(!hasPermission(ctx,'manage_schedule'))throw forbidden('schedule_permission_required','Schedule management permission is required.');
  const work=()=>withProjectDocumentLock(ctx.orgId,'\u0000appointment_bookings',async()=>{
    await projectAccess(ctx,input.project_id);
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior=await readDocument(ctx.orgId,'appointment_bookings',input.event_id).catch((error)=>{if(error.statusCode===404)return null;throw error;});
    if(prior){if(prior.data.fingerprint!==fingerprint||prior.data.actor!==ctx.userId)throw conflict('appointment_booking_conflict','This booking ID has already been used.');if(prior.data.result)return prior.data.result;throw conflict('appointment_booking_pending','This booking is still being saved. Refresh the calendar before trying again.');}
    const zone=await resolveOrganizationTimezone(ctx.orgId,ctx.branchId||'default');
    const preview=await previewAppointment(ctx,{project_id:input.project_id,date:dayKey(new Date(input.start_at),zone),configuration:input.configuration});
    const slot=preview.slots.find(s=>s.start_at===new Date(input.start_at).toISOString()&&s.available);
    if(!slot)throw conflict('appointment_slot_unavailable','The requirements are no longer available at that time. Choose another slot.');
    const plan=object(slot.plan),resources=list(plan.resources),config=input.configuration;
    const people=resources.filter(r=>r.subject_type==='organization_user').map(r=>r.id),groups=resources.filter(r=>r.subject_type==='resource_group');
    const location=await bookingLocation(ctx,config,input.project_id);
    const event:JsonObject={id:input.event_id,title:config.title,type:'appointment',event_type_default_id:'appointment',department_ids:config.department_ids,delivery:config.delivery,appointment_configuration:config,start_at:plan.start_at,end_at:plan.end_at,duration_minutes:config.timing_mode==='days'?config.duration_days*1440:config.duration_minutes,all_day:config.timing_mode==='days',duration_days:config.timing_mode==='days'?config.duration_days:undefined,location,location_mode:config.location.mode,address:location.address,arrival_window_start_at:slot.start_at,arrival_window_end_at:slot.window_end_at,status:'scheduled',branch_id:ctx.branchId||'default',booking_actor:ctx.userId,assigned_user_ids:people,assigned_user_id:people[0]||'',assigned_crew_ids:groups.map(r=>r.id),assigned_crew_id:groups[0]?.id||'',resource_refs:resources.map(r=>({kind:r.subject_type,id:r.id,name:r.name})),customer_visible:true};
    await upsertDocument(ctx.orgId,'appointment_bookings',{id:input.event_id,data:{fingerprint,actor:ctx.userId,status:'saving'}},{replace:true});
    let result:JsonObject;
    if(config.recurrence){
      const created=await createRecurrenceSeries(ctx.orgId,{id:`series_${input.event_id}`,project_id:input.project_id||'',branch_id:ctx.branchId||'default',title:config.title,start_at:plan.start_at,timezone:zone,recurrence:config.recurrence,event_template:event},ctx.userId);
      await materializeRecurrenceSeries(ctx.orgId,created.series,{horizonDays:730,timezone:zone,occurrences:created.occurrences});
      result={ok:true,event,series:created.series};
    }else{
      const api=await import('../platform/api.js');
      result=input.project_id?await api.saveProjectScheduleEvent(ctx.orgId,input.project_id,ctx,{branch_id:ctx.branchId||'default',event}):{ok:true,event,document:await api.saveCalendarEventDocument(ctx.orgId,input.event_id,{data:event,metadata:{kind:'calendar_event'}},true)};
    }
    await upsertDocument(ctx.orgId,'appointment_bookings',{id:input.event_id,data:{fingerprint,actor:ctx.userId,result,status:'saved'}},{replace:true});
    return result;
  });
  if(!isFirstMeasurePostgresEnabled())return work();
  return withPostgresTransaction(client=>withPlatformPostgresClient(client,async()=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[`appointment:${ctx.orgId}`]);return work();}));
}
