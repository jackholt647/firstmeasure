import { ensureMessagingOrganization, listSmsComplianceProfiles } from '../../messaging/storage.js';
import { type PlatformAuthContext, hasPermission, backgroundAuthContext } from '../../platform/auth.js';
import { hasResourcePermission } from '../../workforce/department-access.js';
import { listDocuments, readDocument, upsertDocument } from '../../platform/storage.js';
import { badRequest, forbidden, notFound } from '../../platform/errors.js';
import { voiceSettings, businessOpen } from '../calls/settings.js';
import { people, projectContext, requireCallAccess, callListDepartmentFilter } from '../calls/service.js';
import * as s from '../calls/storage.js';
import { lineSchema, groupSchema, personalSchema, routingSchema, messagingPolicySchema, type Routing, type Target, type Schedule } from './contracts.js';

const scope=(r:s.Json)=>({department_ids:s.strings(r.department_ids),branch_id:s.text(r.branch_id)});
export const manager=(ctx:PlatformAuthContext)=>hasPermission(ctx,'manage_communications|manage_company_settings');
export function assertManage(ctx:PlatformAuthContext,resource:s.Json={}) {
  if(!hasResourcePermission(ctx,'manage_communications|manage_company_settings',resource))throw forbidden('phone_settings_denied','You cannot manage these phone settings.');
}
export async function lineMembers(org:string,number:string){
  const config=await s.resource(org,'phone_line',number),legacy=await s.resource(org,'number',number);
  const group=config?.group_id?await s.resource(org,'phone_group',s.text(config.group_id)):null;
  return [...new Set([...s.strings(config?.user_ids),...s.strings(group?.user_ids),...(!config&&legacy?.assigned_user_id?[s.text(legacy.assigned_user_id)]:[])])];
}
export async function canUseLine(ctx:Partial<PlatformAuthContext>,number:string){
  if(!ctx.orgId)return false;
  const line=await s.resource(ctx.orgId,'number',number),config=await s.resource(ctx.orgId,'phone_line',number);
  if(line&&s.text(line.branch_id||'default')!==s.text(ctx.branchId||'default'))return false;
  const members=await lineMembers(ctx.orgId,number);
  if(ctx.userId&&members.length&&!members.includes(ctx.userId))return false;
  if(config&&s.strings(config.department_ids).length&&ctx.organizationStructure&&!hasResourcePermission(ctx as PlatformAuthContext,'make_calls|send_comms|send_communications|manage_communications|manage_company_settings',scope(config)))return false;
  return true;
}
export async function workspace(ctx:PlatformAuthContext){
  const all=await s.resources(ctx.orgId,'number'),configs=await s.resources(ctx.orgId,'phone_line'),groups=await s.resources(ctx.orgId,'phone_group');
  const lines=[];
  for(const n of all){const c=configs.find(c=>c.id===n.id);if(manager(ctx)||hasResourcePermission(ctx,'manage_communications|manage_company_settings',scope(c||n))||await canUseLine(ctx,n.id))lines.push({phone_number:n.id,status:n.status,label:c?.label||n.label||n.id,branch_id:n.branch_id,config:c||null,can_manage:hasResourcePermission(ctx,'manage_communications|manage_company_settings',scope(c||n))});}
  const smsProfiles=manager(ctx)?(await listSmsComplianceProfiles((await ensureMessagingOrganization(ctx.orgId)).id)).map(p=>({id:p.id,label:p.display_name||p.id,status:p.status,campaign_status:p.campaign_status})):[];
  return {sms_profiles:smsProfiles,lines,groups:groups.filter(g=>manager(ctx)||s.strings(g.user_ids).includes(ctx.userId)||hasResourcePermission(ctx,'manage_communications|manage_company_settings',scope(g))),personal:await s.resource(ctx.orgId,'phone_personal',ctx.userId)||{revision:0},messaging:manager(ctx)?await s.resource(ctx.orgId,'phone_messaging')||{...messagingPolicySchema.parse({}),revision:0}:null,people:await people(ctx),departments:ctx.organizationStructure?.catalog.departments.filter(d=>d.status==='active')||[],can_manage:manager(ctx),can_bill:hasPermission(ctx,'view_platform_billing|manage_platform_billing|manage_billing'),default_number:s.text((await s.resource(ctx.orgId,'number_preference',ctx.userId))?.phone_number),user_id:ctx.userId};
}
async function validateMembers(ctx:PlatformAuthContext,users:string[],departments:string[],branch:string){
  const roster=await people(ctx);
  if(users.some(id=>!roster.some(u=>u.id===id&&u.branch_id===branch)))throw badRequest('phone_member_invalid','Choose active users in this branch.');
  if(departments.some(id=>!ctx.organizationStructure?.catalog.departments.some(d=>d.id===id&&d.status==='active')))throw badRequest('phone_department_invalid','Choose an existing active department.');
}
async function validateRouting(ctx:PlatformAuthContext,routing:Routing|null,root:string){
  if(!routing)return;
  for(const id of [routing.voicemail_media_id,routing.closed_media_id])if(id&&!await s.resource(ctx.orgId,'phone_greeting',id))throw badRequest('greeting_missing','Choose an uploaded greeting.');
  const all=await s.resources(ctx.orgId,'phone_group');
  const visit=async(target:Target,path:string[])=>{
    if(target.kind==='forward'){
      if(!target.number)throw badRequest('phone_forward_required','Enter a forwarding number.');
      const settings=await voiceSettings(ctx.orgId);
      if(!settings.allowed_country_prefixes.some(p=>target.number.startsWith(p))||await s.resource(ctx.orgId,'number',target.number))throw badRequest('phone_forward_invalid','Choose an allowed external number.');
    }
    if(target.kind==='user'&&!(await people(ctx)).some(p=>p.id===target.id))throw badRequest('phone_user_invalid','Choose an active user.');
    if(target.kind==='group'){
      if(path.includes(target.id)||path.length>=8)throw badRequest('phone_route_loop','This route would loop.');
      const g=all.find(g=>g.id===target.id);if(!g)throw badRequest('phone_group_missing','Choose an existing group.');
      assertManage(ctx,g);
      const r=routingSchema.parse(g.routing);for(const t of [r.open,r.closed,r.unanswered,...r.menu.map(m=>m.target)])await visit(t,[...path,target.id]);
    }
    if(target.kind==='menu'&&!routing.menu.length)throw badRequest('phone_menu_empty','Add at least one menu option.');
  };
  for(const t of [routing.open,routing.closed,routing.unanswered,...routing.menu.map(m=>m.target)])await visit(t,[root]);
}
export async function saveLine(ctx:PlatformAuthContext,number:string,input:unknown){
  const line=await s.resource(ctx.orgId,'number',number);if(!line)throw notFound('phone_line_missing','Connect this number first.');
  const previous=await s.resource(ctx.orgId,'phone_line',number);assertManage(ctx,previous||line);
  const value=lineSchema.parse(input);assertManage(ctx,value);await validateMembers(ctx,value.user_ids,value.department_ids,s.text(line.branch_id||'default'));
  if(value.group_id){const group=await s.resource(ctx.orgId,'phone_group',value.group_id);if(!group)throw badRequest('phone_group_missing','Choose an existing group.');if(s.text(group.branch_id||'default')!==s.text(line.branch_id||'default'))throw badRequest('phone_group_branch','Choose a group in this line’s branch.');assertManage(ctx,group);}
  await validateRouting(ctx,value.routing,number);
  const result=await s.saveResource(ctx.orgId,'phone_line',number,value,'',value.revision);
  await s.appendEvent(ctx.orgId,'','phone.line.updated',{number,actor_user_id:ctx.userId,revision:result.revision});return result;
}
export async function saveGroup(ctx:PlatformAuthContext,id:string,input:unknown){
  const prior=await s.resource(ctx.orgId,'phone_group',id);assertManage(ctx,prior||{});const value=groupSchema.parse(input);assertManage(ctx,value);
  await validateMembers(ctx,value.user_ids,value.department_ids,ctx.branchId||'default');await validateRouting(ctx,value.routing,id);
  return s.saveResource(ctx.orgId,'phone_group',id,{...value,branch_id:ctx.branchId||'default'},'',value.revision);
}
export async function savePersonal(ctx:PlatformAuthContext,input:unknown){const value=personalSchema.parse(input);if(value.voicemail_media_id&&(await s.resource(ctx.orgId,'phone_greeting',value.voicemail_media_id))?.owner_user_id!==ctx.userId)throw forbidden('greeting_denied','Choose your own greeting.');return s.saveResource(ctx.orgId,'phone_personal',ctx.userId,value,'',value.revision);}
export function scheduleOpen(schedule:Schedule,date=new Date()){return businessOpen({...schedule} as Awaited<ReturnType<typeof voiceSettings>>,date);}
export async function userAvailable(org:string,user:string,date=new Date()){
  const p=await s.resource(org,'phone_personal',user);if(p?.available===false)return false;
  return !p?.schedule||scheduleOpen(p.schedule as Schedule,date);
}
export async function resolveRoute(org:string,number:string){
  const c=await s.resource(org,'phone_line',number),g=c?.group_id?await s.resource(org,'phone_group',s.text(c.group_id)):null;
  const settings=await voiceSettings(org),members=await lineMembers(org,number),personal=members.length===1?await s.resource(org,'phone_personal',members[0]!):null;
  const raw=c?.routing||g?.routing||(personal?{schedule:personal.schedule,open:{kind:'user',id:members[0]},voicemail_greeting:personal.voicemail_greeting||undefined,voicemail_media_id:personal.voicemail_media_id||''}:c?{strategy:settings.routing,ring_seconds:settings.ring_seconds,max_wait_seconds:settings.max_wait_seconds,greeting:settings.greeting,voicemail_greeting:settings.voicemail_greeting,closed:{kind:settings.fallback,number:settings.overflow_number},unanswered:{kind:settings.fallback,number:settings.overflow_number}}:null);if(!raw)return null;
  const routing=routingSchema.parse(raw);
  return {routing,schedule:routing.schedule||{timezone:settings.timezone,business_hours:settings.business_hours,holidays:settings.holidays},members:members.length?members:settings.agent_user_ids,department_ids:[...new Set([...s.strings(c?.department_ids),...s.strings(g?.department_ids)])],group_id:s.text(c?.group_id)};
}
export async function trackingSnapshot(org:string,number:string){
  const line=await s.resource(org,'phone_line',number);const tracking=s.object(line?.tracking);
  return tracking.enabled?{...tracking,number,label:line?.label,revision:line?.revision,captured_at:s.now()}:null;
}
/** An inquiry is distinct from a known contact: never guess a project when matches are ambiguous. */
export async function recordAttribution(call:s.CustomerCall){
  const attribution=s.object(call.metadata.attribution);if(!attribution.enabled)return;
  const leadId=s.id('phonelead',`${call.organization_id}:${/^\+[1-9]\d{7,14}$/.test(call.customer_number)?call.customer_number:call.id}`);
  await s.transaction(async()=>{const prior=await s.resource(call.organization_id,'phone_lead',leadId);
    const first=!prior||call.created_at<s.text(prior.first_seen),last=!prior||call.created_at>=s.text(prior.last_seen);
    await s.saveResource(call.organization_id,'phone_lead',leadId,{...prior,customer_number:call.customer_number,first_call_id:first?call.id:prior?.first_call_id,last_call_id:last?call.id:prior?.last_call_id,first_touch:first?attribution:prior?.first_touch,last_touch:last?attribution:prior?.last_touch,first_seen:first?call.created_at:prior?.first_seen,last_seen:last?call.created_at:prior?.last_seen,project_id:prior?.project_id||call.project_id,contact_id:prior?.contact_id||call.contact_id,status:prior?.status||'new',department_ids:[...new Set([...s.strings(prior?.department_ids),...s.strings(call.metadata.department_ids)])]});
  });
  if(call.project_id)for(let attempt=0;attempt<3;attempt++)try{const doc=await readDocument(call.organization_id,'projects',call.project_id);const old=s.object(doc.data.phone_attribution);await upsertDocument(call.organization_id,'projects',{id:doc.id,data:{...doc.data,phone_attribution:{first_touch:!old.first_seen||call.created_at<s.text(old.first_seen)?attribution:old.first_touch,first_seen:!old.first_seen||call.created_at<s.text(old.first_seen)?call.created_at:old.first_seen,last_touch:!old.last_seen||call.created_at>=s.text(old.last_seen)?attribution:old.last_touch,last_seen:!old.last_seen||call.created_at>=s.text(old.last_seen)?call.created_at:old.last_seen,last_call_id:!old.last_seen||call.created_at>=s.text(old.last_seen)?call.id:old.last_call_id}},metadata:doc.metadata,expected_revision:doc.revision},{replace:true});break;}catch(e){if(attempt===2)throw e;}
}
export async function trackingReport(ctx:PlatformAuthContext,from:string,to:string){
  assertManage(ctx);const start=Date.parse(from),end=Date.parse(to);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>366*86400000)throw badRequest('phone_report_range','Choose a range of up to one year.');
  const rows=await s.database().prepare('SELECT id FROM customer_calls WHERE organization_id=? AND direction=? AND created_at>=? AND created_at<? ORDER BY created_at DESC').all(ctx.orgId,'inbound',new Date(start).toISOString(),new Date(end).toISOString());
  const calls=[];const sources=new Map<string,s.Json>();
  for(const row of rows){const c=await s.readCall(ctx.orgId,s.text(s.object(row).id));try{requireCallAccess(ctx,c);}catch{continue;}const a=s.object(c.metadata.attribution);if(!a.enabled)continue;
    const key=JSON.stringify([a.number,a.source,a.medium,a.campaign,a.ad_id]);const entry=sources.get(key)||{number:a.number,source:a.source,medium:a.medium,campaign:a.campaign,ad_id:a.ad_id,calls:0,answered:0,missed:0,voicemails:0,talk_seconds:0,callers:new Set<string>()};
    entry.calls=Number(entry.calls)+1;entry.answered=Number(entry.answered)+(c.connected_at?1:0);entry.missed=Number(entry.missed)+(!c.connected_at&&s.terminal.has(c.state)?1:0);entry.voicemails=Number(entry.voicemails)+(s.object(c.metadata.voicemail).started?1:0);entry.talk_seconds=Number(entry.talk_seconds)+(c.connected_at&&c.ended_at?Math.max(0,(Date.parse(c.ended_at)-Date.parse(c.connected_at))/1000):0);(entry.callers as Set<string>).add(/^\+[1-9]\d{7,14}$/.test(c.customer_number)?c.customer_number:c.id);sources.set(key,entry);
    calls.push({id:c.id,created_at:c.created_at,customer_number:c.customer_number,project_id:c.project_id,state:c.state,attribution:a});
  }
  const leads=(await s.resources(ctx.orgId,'phone_lead')).filter(l=>s.text(l.last_seen)>=new Date(start).toISOString()&&s.text(l.first_seen)<new Date(end).toISOString()&&hasResourcePermission(ctx,'manage_communications|manage_company_settings',scope(l)));
  for(const entry of sources.values()){const same=leads.filter(l=>s.text(l.first_seen)>=new Date(start).toISOString()&&["number","source","medium","campaign","ad_id"].every(k=>s.text(s.object(l.first_touch)[k])===s.text(entry[k])));entry.new_leads=same.length;entry.qualified=same.filter(l=>l.status==='qualified').length;entry.converted=same.filter(l=>l.status==='converted').length;}
  const projects=[];for(const doc of (await listDocuments(ctx.orgId,'projects')).slice(0,200)){try{await projectContext(ctx,doc.id);projects.push({id:doc.id,label:s.text(doc.data.title||doc.data.name)||'Untitled project'});}catch{continue;}}
  return {from,to,projects,sources:[...sources.values()].map(({callers,...r})=>({...r,unique_callers:(callers as Set<string>).size})),calls,leads};
}
export async function notifyPhone(call:s.CustomerCall,kind:'missed_calls'|'voicemail'){
  let members=await lineMembers(call.organization_id,call.business_number);if(!members.length)members=(await listDocuments(call.organization_id,'users')).map(u=>u.id);if(call.owner_user_id&&!members.includes(call.owner_user_id))members.push(call.owner_user_id);
  for(const user of members){const ctx=await backgroundAuthContext(call.organization_id,user).catch(()=>null);if(!ctx)continue;try{requireCallAccess(ctx,call);}catch{continue;}
    const preferences=s.object((await s.resource(call.organization_id,'phone_personal',user))?.notifications);if(preferences[kind]===false)continue;
    const {createPlatformNotification}=await import('../../platform/api.js');await createPlatformNotification(call.organization_id,{id:s.id('phone_notice',`${call.id}:${kind}:${user}`),title:kind==='voicemail'?'New voicemail':'Missed call',body:`${call.customer_name||call.customer_number} called ${call.business_number}`,kind:'comms_message',source:'comms',channel:'passive',push:preferences.push!==false,target_user_ids:[user],branch_id:call.branch_id,context:{call_id:call.id,project_id:call.project_id},frontend_action:call.project_id?{kind:'open_project_comms',project_id:call.project_id,comms_view:'calls'}:{}});
  }
}
