import {broadcastSchema,audienceSchema,broadcastCommandSchema} from './marketing-contracts.js';
export {broadcastSchema,audienceSchema,broadcastCommandSchema} from './marketing-contracts.js';
import {isCapabilityEnabled} from '../../platform/capabilities.js';
import {z} from 'zod';
import {PlatformError,badRequest,conflict,forbidden,notFound} from '../../platform/errors.js';
import {backgroundAuthContext,hasPermission,type PlatformAuthContext} from '../../platform/auth.js';
import {env} from '../../src/config/env.js';
import {readDocument} from '../../platform/storage.js';
import {resolveContact,contactSettings} from '../../contacts/service.js';
import {projectContext} from '../calls/service.js';
import {assertManage,canUseLine} from './service.js';
import {validateSource} from './tracking.js';
import {messagePolicy,nextWindow,senderConfiguration} from './messaging.js';
import {scheduleSchema} from './contracts.js';
import {sendCommunicationSchema} from '../../messaging/schemas.js';
import {sendCommunication} from '../../messaging/communications_service.js';
import {smsConsentPurposesAllow,outboundSmsComplianceIssue} from '../../messaging/compliance_rules.js';
import {listSenderIdentities,readSmsConsent,readMessageRecord,listDeliveryRecords,findSmsConversationRecord,createConversationRecord} from '../../messaging/communications_storage.js';
import * as s from '../calls/storage.js';

const key=z.string().regex(/^[a-zA-Z0-9_-]{1,180}$/),revision=z.number().int().nonnegative();
const fields=['name','first_name','last_name','company_name'] as const;
function parse(v:unknown){try{return s.object(JSON.parse(s.text(v)));}catch{return {};}}
export function renderBroadcast(template:string,recipient:s.Json){return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_all,k)=>s.text(recipient[k]));}
export function assertBroadcast(ctx:PlatformAuthContext){assertManage(ctx);if(!hasPermission(ctx,'send_comms|send_communications|manage_communications|manage_company_settings'))throw forbidden('broadcast_send_denied');}
export async function campaign(ctx:PlatformAuthContext,id:string){assertBroadcast(ctx);const c=await s.resource(ctx.orgId,'phone_broadcast',id);if(!c)throw notFound('broadcast_missing');assertManage(ctx,c);return c;}
async function sender(ctx:PlatformAuthContext,id:string){const row=(await listSenderIdentities(ctx.orgId,'','sms')).find(i=>i.id===id&&i.status==='active');if(!row||!await canUseLine(ctx,s.text(row.address)))throw forbidden('broadcast_sender_denied','Select a registered line you can use.');assertManage(ctx,{...await s.resource(ctx.orgId,'number',s.text(row.address)),...await s.resource(ctx.orgId,'phone_line',s.text(row.address))});return row;}
export async function saveBroadcast(ctx:PlatformAuthContext,id:string,input:unknown){
 assertBroadcast(ctx);key.parse(id);const v=broadcastSchema.parse(input),old=await s.resource(ctx.orgId,'phone_broadcast',id);if(old?.started_at||old&&old.status!=='draft')throw conflict('broadcast_locked','Create a new draft to change a launched campaign.');
 const unknown=[...v.template.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)].map(m=>m[1]!.trim()).filter(k=>!fields.includes(k as any));if(unknown.length)throw badRequest('broadcast_variable_invalid','Use name, first_name, last_name or company_name placeholders.');
 const line=await sender(ctx,v.sender_identity_id);await validateSource(ctx.orgId,v.lead_source_id);
 const cap=Math.max(0.01,Number(process.env.TELNYX_SMS_APPROVED_MPS)||1);if(v.messages_per_second>cap)throw badRequest('broadcast_rate_unapproved','The campaign pace exceeds the platform carrier-account allowance.');
 if(v.scheduled_for&&Date.parse(v.scheduled_for)<Date.now())throw badRequest('broadcast_schedule_past');
 return s.saveResource(ctx.orgId,'phone_broadcast',id,{...old,...v,status:'draft',owner_user_id:ctx.userId,branch_id:s.text(line.branch_id)||'default',sender_number:line.address},'',v.revision);
}
async function savedRecipient(ctx:PlatformAuthContext,ref:{project_id:string;contact_id:string}){
 await projectContext(ctx,ref.project_id);const {contact}=await resolveContact(ctx.orgId,ref);let address=s.text(contact.phone||contact.mobile||contact.phone_number).replace(/[^+\d]/g,'');if(/^\d{10}$/.test(address))address='+1'+address;else if(/^1\d{10}$/.test(address))address='+'+address;
 if(!/^\+[1-9]\d{7,14}$/.test(address))throw badRequest('broadcast_recipient_phone','This contact has no valid phone number.');
 const name=s.text(contact.name),parts=name.split(/\s+/);return {...ref,address,name,first_name:s.text(contact.first_name)||parts[0]||'',last_name:s.text(contact.last_name)||parts.slice(1).join(' '),company_name:s.text(contact.company_name||contact.company)};
}
export async function addAudience(ctx:PlatformAuthContext,id:string,input:unknown){
 const v=audienceSchema.parse(input),c=await campaign(ctx,id);if(c.status!=='draft')throw conflict('broadcast_locked');
 const candidates:s.Json[]=[];let invalid=0;for(const ref of v.contacts)try{candidates.push(await savedRecipient(ctx,ref));}catch(e){if(!(e instanceof PlatformError)||![400,403,404].includes(e.statusCode))throw e;invalid++;}
 return s.transaction(async()=>{const current=await campaign(ctx,id);if(current.status!=='draft'||current.revision!==v.revision)throw conflict('settings_revision_conflict');
  let added=0,duplicates=0;const count=s.object(await s.database().prepare('SELECT COUNT(*) AS total FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=?').get(ctx.orgId,id));if(Number(count.total)+candidates.length>50000)throw badRequest('broadcast_audience_limit','Use at most 50,000 recipients per campaign.');
  for(const recipient of candidates){const r=await s.database().prepare(`INSERT INTO phone_broadcast_recipients(organization_id,campaign_id,id,address,recipient_json,state,message_id,reason,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,'pending','','','',?,?) ON CONFLICT(organization_id,campaign_id,address) DO NOTHING`).run(ctx.orgId,id,s.id('recipient',s.text(recipient.address)),s.text(recipient.address),JSON.stringify(recipient),s.now(),s.now());if(r.changes)added++;else duplicates++;}
  const saved=await s.saveResource(ctx.orgId,'phone_broadcast',id,{...current,audience_revision:Number(current.audience_revision||0)+1},'',v.revision);return {id,revision:saved.revision,added,duplicates,invalid};
 });
}
export async function removeAudience(ctx:PlatformAuthContext,id:string,recipientId:string,rev:number){const c=await campaign(ctx,id);return s.transaction(async()=>{const current=await campaign(ctx,id);if(c.status!=='draft'||current.revision!==rev)throw conflict('broadcast_locked');await s.database().prepare('DELETE FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=? AND id=?').run(ctx.orgId,id,recipientId);return s.saveResource(ctx.orgId,'phone_broadcast',id,{...current,audience_revision:Number(current.audience_revision||0)+1},'',rev);});}
async function recipientEligibility(ctx:PlatformAuthContext,c:s.Json,r:s.Json){
 try{const current=await savedRecipient(ctx,{project_id:s.text(r.project_id),contact_id:s.text(r.contact_id)});if(current.address!==r.address)return 'The contact phone number changed after audience selection.';}catch{return 'Contact access or the saved contact is no longer available.';}
 if(c.stop_on_reply&&c.started_at){const status=s.object(await s.database().prepare('SELECT replied_at FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=? AND address=?').get(ctx.orgId,s.text(c.id),s.text(r.address)));if(status.replied_at)return 'The contact replied before this message was sent.';}
 const consent=await readSmsConsent(ctx.orgId,s.text(r.address));if(consent?.status!=='opted_in'||!smsConsentPurposesAllow(s.object(consent.evidence).purposes,'marketing'))return 'Marketing consent is missing or withdrawn.';
 const rendered=renderBroadcast(s.text(c.template),r);if(!rendered.trim()||rendered.length>1600)return 'Personalized text must contain 1–1600 characters.';
 if(env.communicationsDeliveryMode==='live'){
  const config=await senderConfiguration(ctx.orgId,s.text(c.sender_number));if(!config)return 'Sending line registration is not ready.';
  const issue=outboundSmsComplianceIssue(config.profile,'marketing',rendered);if(issue)return issue.message;
 }
 return '';
}
export async function previewBroadcast(ctx:PlatformAuthContext,id:string,limit=500,cursor=''){
 const c=await campaign(ctx,id);await sender(ctx,s.text(c.sender_identity_id));const signature=s.digest({org:ctx.orgId,user:ctx.userId,id,revision:c.revision});let after='';if(cursor){let v:s.Json={};try{v=parse(Buffer.from(cursor,'base64url').toString());}catch{}if(v.signature!==signature)throw badRequest('broadcast_preview_cursor_invalid');after=s.text(v.after);}
 const bounded=Math.min(500,Math.max(1,limit)),all=await s.database().prepare('SELECT id,recipient_json FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=? AND id>? ORDER BY id LIMIT ?').all(ctx.orgId,id,after,bounded+1),rows=all.slice(0,bounded),total=Number(s.object(await s.database().prepare('SELECT COUNT(*) AS n FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=?').get(ctx.orgId,id)).n);
 let eligible=0;const reasons:Record<string,number>={},samples:s.Json[]=[],authorized=new Set<string>();
 for(const raw of rows){const r=parse(s.object(raw).recipient_json),project=s.text(r.project_id);if(!authorized.has(project)){await projectContext(ctx,project);authorized.add(project);}const reason=await recipientEligibility(ctx,c,r);if(reason)reasons[reason]=(reasons[reason]||0)+1;else eligible++;if(samples.length<5)samples.push({name:r.name,text:renderBroadcast(s.text(c.template),r),eligible:!reason,reason});}
 return {id,revision:c.revision,total,examined:rows.length,eligible,skipped:rows.length-eligible,reasons,samples,nextCursor:all.length>bounded?Buffer.from(JSON.stringify({signature,after:s.object(rows[rows.length-1]).id})).toString('base64url'):''};
}
export async function commandBroadcast(ctx:PlatformAuthContext,id:string,input:unknown){const v=broadcastCommandSchema.parse(input);assertBroadcast(ctx);return s.transaction(async()=>{
 const c=await campaign(ctx,id);if(c.revision!==v.revision)throw conflict('settings_revision_conflict');const transitions:Record<string,string[]>={start:['draft'],pause:['running'],resume:['paused'],cancel:['draft','running','paused']};if(!transitions[v.action]!.includes(s.text(c.status)))throw conflict('broadcast_state_invalid');
 if(v.action==='start'||v.action==='resume'){if(!await isCapabilityEnabled(ctx.orgId,'apps.comms')||!await isCapabilityEnabled(ctx.orgId,'comms.sms'))throw forbidden('broadcast_feature_disabled');await sender(ctx,s.text(c.sender_identity_id));const count=s.object(await s.database().prepare('SELECT COUNT(*) AS total FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=?').get(ctx.orgId,id));if(!Number(count.total))throw badRequest('broadcast_empty');}
 const status=v.action==='start'||v.action==='resume'?'running':v.action==='pause'?'paused':'canceled';
 const saved=await s.saveResource(ctx.orgId,'phone_broadcast',id,{...c,status,...(v.action==='start'?{started_at:s.now(),owner_user_id:ctx.userId}:{}),...(v.action==='cancel'?{canceled_at:s.now()}:{}),last_error:''},'',v.revision);
 if(status==='canceled')await s.database().prepare("UPDATE phone_broadcast_recipients SET state='canceled',reason='Campaign canceled.',updated_at=? WHERE organization_id=? AND campaign_id=? AND state IN ('pending','preparing')").run(s.now(),ctx.orgId,id);
 return saved;
 });}
/** Checked again in the shared SMS dispatcher; queued messages obey controls too. */
export async function broadcastGate(org:string,message:s.Json){
 const id=s.text(s.object(message.context).broadcast_id);if(!id)return null;
 const c=await s.resource(org,'phone_broadcast',id);if(!c||c.status==='canceled')return {action:'cancel',reason:'Broadcast canceled.'};
 if(c.status==='paused')return {action:'wait',at:new Date(Date.now()+15000).toISOString(),reason:'Broadcast paused.'};
 if(c.status!=='running')return {action:'cancel',reason:'Broadcast is no longer active.'};
 const owner=await backgroundAuthContext(org,s.text(c.owner_user_id)).catch(()=>null);if(!owner)return {action:'cancel',reason:'Campaign owner membership was revoked.'};
 try{if(!await isCapabilityEnabled(org,'apps.comms')||!await isCapabilityEnabled(org,'comms.sms'))throw forbidden('broadcast_feature_disabled');assertBroadcast(owner);await sender(owner,s.text(c.sender_identity_id));const r=Array.isArray(message.recipients)?s.object(message.recipients[0]):{};const reason=await recipientEligibility(owner,c,r);if(reason)return {action:'cancel',reason};}catch{return {action:'cancel',reason:'Campaign permissions or sending line access were revoked.'};}
 if(Date.now()>Math.max(Date.parse(s.text(c.started_at)),Date.parse(s.text(c.scheduled_for))||0)+Number(c.expiry_hours)*3600000)return {action:'cancel',reason:'Broadcast expired.'};
 return {policy:{enabled:true,schedule:c.schedule,timezone_mode:c.timezone_mode,unknown_timezone:c.unknown_timezone,apply_manual:true,expiry_hours:c.expiry_hours,cancel_on_reply:c.stop_on_reply,cooldown_minutes:180}};
}
/** Shared carrier-account and campaign budget; numbers do not multiply approved throughput. */
export function estimatedSmsSegments(text:string){
 const gsm=new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"),extended=new Set('^{}\\[~]|€\f');let septets=0;
 for(const char of text){if(extended.has(char))septets+=2;else if(gsm.has(char))septets++;else return Math.max(1,Math.ceil(text.length/(text.length>70?67:70)));}
 return Math.max(1,Math.ceil(septets/(septets>160?153:160)));
}
export async function reserveSmsPace(org:string,profile:string,message:s.Json,at=new Date()){
 const broadcast=s.text(s.object(message.context).broadcast_id),c=broadcast?await s.resource(org,'phone_broadcast',broadcast):null;
 const rate=Math.max(0.01,Number(process.env.TELNYX_SMS_APPROVED_MPS)||1),campaignRate=Math.min(rate,Number(c?.messages_per_second)||rate);
 const segments=estimatedSmsSegments(s.text(message.text_body));
 const keys:[string,number][]=[['telnyx-account',rate],[s.id('profile',profile),rate],...(broadcast?[[s.id('broadcast-rate',`${org}:${broadcast}`),campaignRate] as [string,number]]:[])];
 return s.transaction(async()=>{let next=at.toISOString();for(const [key] of keys){const row=s.object(await s.database().prepare('SELECT next_at FROM phone_sms_throttle WHERE id=?').get(key));if(s.text(row.next_at)>next)next=s.text(row.next_at);}if(next>at.toISOString())return next;
  for(const [key,mps]of keys)await s.database().prepare('INSERT INTO phone_sms_throttle(id,next_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at').run(key,new Date(at.getTime()+Math.ceil(segments*1000/mps)).toISOString());return '';
 });
}
async function stopCampaign(org:string,id:string,status:string,reason:string){await s.transaction(async()=>{const current=await s.resource(org,'phone_broadcast',id);if(current?.status!=='running')return;await s.saveResource(org,'phone_broadcast',id,{...current,status,last_error:reason});if(status==='canceled')await s.database().prepare("UPDATE phone_broadcast_recipients SET state='canceled',reason=?,lease_until='',updated_at=? WHERE organization_id=? AND campaign_id=? AND state IN ('pending','preparing')").run(reason,s.now(),org,id);});}
let processing=false;
export async function maintainBroadcasts(limit=20){if(processing)return;processing=true;try{
 const campaigns=await s.database().prepare("SELECT organization_id,id FROM customer_voice_resources WHERE kind='phone_broadcast'").all();let processed=0;
 for(const raw of campaigns){if(processed>=limit)break;const org=s.text(s.object(raw).organization_id),id=s.text(s.object(raw).id),c=await s.resource(org,'phone_broadcast',id);if(c?.status!=='running')continue;
  const ctx=await backgroundAuthContext(org,s.text(c.owner_user_id)).catch(()=>null);try{if(!ctx||!await isCapabilityEnabled(org,'apps.comms')||!await isCapabilityEnabled(org,'comms.sms'))throw forbidden('broadcast_owner_revoked');assertBroadcast(ctx);await sender(ctx,s.text(c.sender_identity_id));}catch{await stopCampaign(org,id,'paused','Campaign owner permissions or sending-line access changed.');continue;}
  if(c.scheduled_for&&s.text(c.scheduled_for)>s.now())continue;
  if(Date.now()>Math.max(Date.parse(s.text(c.started_at)),Date.parse(s.text(c.scheduled_for))||0)+Number(c.expiry_hours)*3600000){await stopCampaign(org,id,'canceled','Campaign expired.');continue;}
  for(let n=0;n<20&&processed<limit;n++){
   const row=await s.transaction(async()=>{const current=await s.resource(org,'phone_broadcast',id);if(current?.status!=='running')return null;const found=s.object(await s.database().prepare("SELECT * FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=? AND (state='pending' OR (state='preparing' AND lease_until<?)) ORDER BY id LIMIT 1").get(org,id,s.now()));if(!found.id)return null;
    await s.database().prepare("UPDATE phone_broadcast_recipients SET state='preparing',lease_until=?,updated_at=? WHERE organization_id=? AND campaign_id=? AND id=?").run(new Date(Date.now()+120000).toISOString(),s.now(),org,id,s.text(found.id));return found;});if(!row)break;processed++;
   const r=parse(row.recipient_json),messageId=s.id('broadcast-message',`${org}:${id}:${row.id}`);let existing:s.Json|null=null;try{existing=await readMessageRecord(org,messageId);}catch(e){if(!(e instanceof PlatformError)||e.statusCode!==404)throw e;}
   let reason='';try{
    if(!existing){reason=await recipientEligibility(ctx!,c,r);if(!reason){
     const policy=await messagePolicy(org,s.text(c.sender_number));let zone=s.text(s.object(c.schedule).timezone);if(c.timezone_mode==='contact'&&(await contactSettings(org)).track_time_zones){const contact=await resolveContact(org,r);zone=s.text(contact.contact.time_zone)||zone;}
     const window=nextWindow({...scheduleSchema.parse(c.schedule),timezone:zone},new Date());const companyWindow=policy.enabled?nextWindow(policy.schedule,new Date()):s.now();
     if(!window||!companyWindow||window>s.now()||companyWindow>s.now()||c.timezone_mode==='contact'&&c.unknown_timezone==='hold'&&(!(await contactSettings(org)).track_time_zones||!s.text((await resolveContact(org,r)).contact.time_zone))){await s.database().prepare("UPDATE phone_broadcast_recipients SET state='preparing',lease_until=?,reason='Waiting for sending hours or contact time zone.',updated_at=? WHERE organization_id=? AND campaign_id=? AND id=?").run(new Date(Date.now()+60000).toISOString(),s.now(),org,id,s.text(row.id));continue;}
     let conversation=await findSmsConversationRecord(org,s.text(r.address));if(!conversation)conversation=await createConversationRecord({id:s.id('broadcast-thread',`${org}:${r.address}`),organization_id:org,branch_id:c.branch_id,participants:[r],context:{project_id:r.project_id,contact_id:r.contact_id},channel_strategy:'sms',subject:`SMS with ${s.text(r.name)||r.address}`});
     const latest=await s.resource(org,'phone_broadcast',id);if(latest?.status!=='running'){await s.database().prepare("UPDATE phone_broadcast_recipients SET state='pending',lease_until='' WHERE organization_id=? AND campaign_id=? AND id=? AND state='preparing'").run(org,id,s.text(row.id));continue;}
     const result=await sendCommunication(org,sendCommunicationSchema.parse({id:messageId,channel:'sms',purpose:'marketing',branch_id:c.branch_id,conversation_id:conversation.id,sender:{identity_id:c.sender_identity_id},recipients:[r],content:{text:renderBroadcast(s.text(c.template),r)},source:{type:'automation',id:'sms-broadcast',user_id:c.owner_user_id},context:{project_id:r.project_id,contact_id:r.contact_id,broadcast_id:id,marketing_campaign_id:c.marketing_campaign_id,lead_source_id:c.lead_source_id},idempotency_key:`broadcast:${id}:${row.id}`}));existing=result.message;
    }}
    await s.database().prepare('UPDATE phone_broadcast_recipients SET state=?,message_id=?,reason=?,lease_until=\'\',updated_at=? WHERE organization_id=? AND campaign_id=? AND id=?').run(reason?'skipped':'queued',existing?s.text(existing.id):'',reason,s.now(),org,id,s.text(row.id));
   }catch(e){let recovered:s.Json|null=null;try{recovered=await readMessageRecord(org,messageId);}catch{}if(recovered){await s.database().prepare("UPDATE phone_broadcast_recipients SET state='queued',message_id=?,reason='',lease_until='',updated_at=? WHERE organization_id=? AND campaign_id=? AND id=?").run(messageId,s.now(),org,id,s.text(row.id));continue;}const retry=!(e instanceof PlatformError)||e.statusCode===429||e.statusCode>=500;await s.database().prepare('UPDATE phone_broadcast_recipients SET state=?,reason=?,lease_until=?,updated_at=? WHERE organization_id=? AND campaign_id=? AND id=?').run(retry?'preparing':'skipped',e instanceof PlatformError?e.message:'Recipient could not be prepared.',retry?new Date(Date.now()+60000).toISOString():'',s.now(),org,id,s.text(row.id));}
  }
  const waiting=s.object(await s.database().prepare("SELECT COUNT(*) AS n FROM phone_broadcast_recipients r LEFT JOIN communication_deliveries d ON d.organization_id=r.organization_id AND d.message_id=r.message_id WHERE r.organization_id=? AND r.campaign_id=? AND (r.state IN ('pending','preparing') OR d.status IN ('queued','scheduled','retry_pending','submitting','submission_unknown') OR (d.status='sent' AND d.transport_mode<>'capture'))").get(org,id));
  if(!Number(waiting.n))await s.transaction(async()=>{const current=await s.resource(org,'phone_broadcast',id);if(current?.status==='running')await s.saveResource(org,'phone_broadcast',id,{...current,status:'completed',completed_at:s.now()});});
 }
 }finally{processing=false;}}
export async function broadcastRecipients(ctx:PlatformAuthContext,id:string,limit=100,after=''){
 await campaign(ctx,id);const bounded=Math.max(1,Math.min(200,limit)),rows=await s.database().prepare('SELECT * FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=? AND id>? ORDER BY id LIMIT ?').all(ctx.orgId,id,after,bounded+1),items:s.Json[]=[];
 for(const raw of rows.slice(0,bounded)){const row=s.object(raw),r=parse(row.recipient_json);try{await projectContext(ctx,s.text(r.project_id));}catch{continue;}const deliveries=row.message_id?await listDeliveryRecords(ctx.orgId,s.text(row.message_id)):[];items.push({id:row.id,...r,state:row.state,reason:row.reason,message_id:row.message_id,deliveries:deliveries.map(d=>({id:d.id,status:d.status,sent_at:d.sent_at||'',delivered_at:d.delivered_at||'',failed_at:d.failed_at||''})),replied_at:row.replied_at||'',opted_out_at:row.opted_out_at||''});}
 return {items,...(rows.length>bounded?{nextCursor:s.text(s.object(rows[bounded-1]).id)}:{})};
}
export async function broadcastReport(ctx:PlatformAuthContext,id:string){const c=await campaign(ctx,id);const rows=await s.database().prepare(`SELECT r.recipient_json,r.state,r.reason,r.replied_at,r.opted_out_at,d.status FROM phone_broadcast_recipients r LEFT JOIN communication_deliveries d ON d.organization_id=r.organization_id AND d.message_id=r.message_id WHERE r.organization_id=? AND r.campaign_id=?`).all(ctx.orgId,id);const counts={total:rows.length,pending:0,queued:0,sent:0,delivered:0,failed:0,skipped:0,canceled:0,replied:0,opted_out:0};const authorized=new Set<string>();for(const raw of rows){const r=s.object(raw),project=s.text(parse(r.recipient_json).project_id);if(!authorized.has(project)){await projectContext(ctx,project);authorized.add(project);}const state=s.text(r.status||r.state);if(['pending','preparing'].includes(state))counts.pending++;else if(state==='delivered')counts.delivered++;else if(state==='sent')counts.sent++;else if(['queued','scheduled','retry_pending','submitting','submission_unknown'].includes(state))counts.queued++;else if(['failed','delivery_unconfirmed'].includes(state))counts.failed++;else if(state==='canceled'||state==='cancelled')counts.canceled++;else if(state==='skipped')counts.skipped++;if(r.replied_at)counts.replied++;if(r.opted_out_at)counts.opted_out++;}return {id,status:c.status,label:c.label,started_at:c.started_at||'',last_error:c.last_error||'',counts};}
export async function recordBroadcastReply(org:string,message:s.Json){
 if(message.direction!=='inbound'||message.channel!=='sms')return;const from=s.text(s.object(message.sender).address),to=Array.isArray(message.recipients)?s.text(s.object(message.recipients[0]).address):'';
 for(const pending of await s.database().prepare("SELECT DISTINCT campaign_id FROM phone_broadcast_recipients WHERE organization_id=? AND address=? AND state IN ('pending','preparing')").all(org,from)){const id=s.text(s.object(pending).campaign_id),c=await s.resource(org,'phone_broadcast',id);if(c&&c.status==='running'&&c.sender_number===to&&s.text(c.started_at)<=s.text(message.created_at)){const consent=await readSmsConsent(org,from);await s.database().prepare("UPDATE phone_broadcast_recipients SET replied_at=CASE WHEN replied_at='' THEN ? ELSE replied_at END,opted_out_at=CASE WHEN ?=1 AND opted_out_at='' THEN ? ELSE opted_out_at END WHERE organization_id=? AND campaign_id=? AND address=? AND state IN ('pending','preparing')").run(s.text(message.created_at),consent?.status==='opted_out'?1:0,s.text(message.created_at),org,id,from);}}
 const rows=await s.database().prepare('SELECT r.campaign_id,r.id,r.message_id FROM phone_broadcast_recipients r JOIN communication_messages m ON m.organization_id=r.organization_id AND m.id=r.message_id WHERE r.organization_id=? AND r.address=? AND m.created_at<=? ORDER BY m.created_at DESC').all(org,from,s.text(message.created_at));
 for(const raw of rows){const row=s.object(raw),out=await readMessageRecord(org,s.text(row.message_id));if(s.text(s.object(out.sender).address)!==to)continue;const consent=await readSmsConsent(org,from);await s.database().prepare("UPDATE phone_broadcast_recipients SET replied_at=CASE WHEN replied_at='' THEN ? ELSE replied_at END,opted_out_at=CASE WHEN ?=1 AND opted_out_at='' THEN ? ELSE opted_out_at END WHERE organization_id=? AND campaign_id=? AND id=?").run(s.text(message.created_at),consent?.status==='opted_out'?1:0,s.text(message.created_at),org,s.text(row.campaign_id),s.text(row.id));break;}
}
