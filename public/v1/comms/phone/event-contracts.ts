import {z} from 'zod';
// Pure contract module: shared by the durable outbox and the automation catalog.
const names={
 'phone.tracking.source_updated':'A lead-source binding changed.',
 'phone.tracking.pool_updated':'A website tracking pool changed.',
 'phone.broadcast.updated':'An SMS campaign draft, audience or lifecycle changed.',
 'phone.reputation.onboarding_updated':'Business reputation enrollment or authorization status changed.',
 'phone.reputation.remediation_updated':'A spam-label review status or result changed.',
 'phone.line.updated':'A phone line assignment, routing, messaging or tracking configuration changed.',
 'phone.group.updated':'A ring or department group changed.',
 'phone.personal.updated':'A user changed their phone preferences, hours, notifications or dialing settings.',
 'phone.messaging.updated':'Organization SMS sending windows or automatic reply policy changed.',
 'phone.lead.updated':'A tracking inquiry was attributed, qualified or linked to a project.',
 'phone.port.updated':'A local or carrier number port status changed.',
 'phone.order.updated':'A number purchase order status changed.',
 'phone.number.updated':'An owned phone number status or assignment changed.',
 'phone.reputation.updated':'Cached reputation approval or monitoring policy changed.',
 'phone.reputation.number_updated':'A monitored number score or enrollment changed.',
 'phone.voicemail.handled':'A retained voicemail handled state changed.',
 'phone.sms.updated':'A phone number SMS campaign assignment or status changed.',
 'phone.call.created':'A customer call was created.',
 'phone.call.connected':'A customer call connected.',
 'phone.call.ended':'A customer call ended, including its final voicemail drop state.',
 'phone.voicemail.received':'A voicemail recording became ready.',
 'phone.voicemail_drop.started':'Outgoing voicemail playback started after machine detection.',
 'phone.voicemail_drop.finished':'Outgoing voicemail handling finished: completed, interrupted, skipped, failed or uncertain.'
} as const;
export const phoneEventNames=Object.keys(names) as [keyof typeof names,...(keyof typeof names)[]];
export const phoneEventPayload=z.object({
 schema_version:z.literal(1),occurred_at:z.string(),resource_id:z.string(),revision:z.number().int().nonnegative(),
 branch_id:z.string(),project_id:z.string(),department_ids:z.array(z.string()),
 spam_risk:z.string(),previous_spam_risk:z.string(),monitored:z.boolean(),handled:z.boolean(),changed_fields:z.array(z.string()),status:z.string(),previous_status:z.string(),
 call_id:z.string(),user_id:z.string(),phone_number:z.string(),direction:z.string(),
 lead_source_id:z.string().default(''),marketing_campaign_id:z.string().default(''),pool_id:z.string().default(''),visit_id:z.string().default(''),
 voicemail_drop_state:z.string(),source:z.string(),medium:z.string(),campaign:z.string(),ad_id:z.string()
}).strict();
export const phoneEventEnvelope=z.object({type:z.enum(phoneEventNames),payload:phoneEventPayload}).strict();
export const phoneEventDefinitions=phoneEventNames.map(name=>({name,description:names[name],visibility:'system' as const,
 notification:{group:'messages' as const,source:'messaging' as const,tab:'messaging' as const},
 payload:Object.fromEntries(Object.keys(phoneEventPayload.shape).map(key=>[key,({schema_version:'Contract version (1).',resource_id:'Local domain record ID; read the permission-checked phone-settings export for details.',revision:'Domain revision at capture time.',changed_fields:'Names of changed public business fields; no private values.',status:'Current local status; may be empty for settings.',previous_status:'Previous status; empty on creation.'} as Record<string,string>)[key]||key.replaceAll('_',' ')]))
}));
type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const text=(v:unknown)=>String(v??'');
const strings=(v:unknown)=>Array.isArray(v)?v.map(text):[];
const fields:Record<string,{event:keyof typeof names;keys:string[]}>={
 phone_tracking_source:{event:'phone.tracking.source_updated',keys:['label','enabled','external_ref']},
 phone_tracking_pool:{event:'phone.tracking.pool_updated',keys:['enabled','numbers','fallback_number','origins','rules','lead_source_id','marketing_campaign_id']},
 phone_broadcast:{event:'phone.broadcast.updated',keys:['status','label','template','audience_revision','last_error']},
 phone_reputation_account:{event:'phone.reputation.onboarding_updated',keys:['status','signed_at','disabled_at']},
 phone_reputation_remediation:{event:'phone.reputation.remediation_updated',keys:['status','results']},
 phone_line:{event:'phone.line.updated',keys:['label','user_ids','group_id','department_ids','routing','messaging','tracking']},
 phone_group:{event:'phone.group.updated',keys:['label','user_ids','department_ids','routing','branch_id']},
 phone_personal:{event:'phone.personal.updated',keys:['schedule','available','notifications','voicemail_greeting','voicemail_media_id','voicemail_drop','power_dial']},
 phone_messaging:{event:'phone.messaging.updated',keys:['enabled','schedule','timezone_mode','unknown_timezone','apply_manual','expiry_hours','cancel_on_reply','auto_reply_open','auto_reply_closed','missed_call_reply','cooldown_minutes']},
 phone_lead:{event:'phone.lead.updated',keys:['first_call_id','last_call_id','first_touch','last_touch','status','project_id','contact_id','department_ids']},
 phone_port:{event:'phone.port.updated',keys:['status','provider_status','action_pending']},
 phone_order:{event:'phone.order.updated',keys:['status']},
 number:{event:'phone.number.updated',keys:['status','assigned_user_id','branch_id','label']},
 phone_reputation:{event:'phone.reputation.updated',keys:['status','loa_status','check_frequency','last_error']},
 phone_reputation_number:{event:'phone.reputation.number_updated',keys:['monitored','reputation_data']},
 phone_mailbox:{event:'phone.voicemail.handled',keys:['handled','handled_by']},
 phone_sms:{event:'phone.sms.updated',keys:['assignment_status','compliance_profile_id','campaign_id']}
};
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
function base(id:string,row:Json){return {schema_version:1 as const,occurred_at:text(row.updated_at),resource_id:id,revision:Number(row.revision)||0,branch_id:text(row.branch_id),project_id:text(row.project_id),department_ids:strings(row.department_ids),spam_risk:text(obj(row.reputation_data).spam_risk),previous_spam_risk:'',monitored:row.monitored===true,handled:row.handled===true,changed_fields:[] as string[],status:text(row.status||row.assignment_status),previous_status:'',call_id:'',user_id:'',phone_number:text(row.phone_number),direction:'',voicemail_drop_state:'',source:'',medium:'',campaign:'',ad_id:''};}
export function resourcePhoneEvent(kind:string,id:string,previous:Json|null,row:Json){
 const rule=fields[kind];if(!rule)return null;
 const changed=rule.keys.filter(k=>JSON.stringify(canonical(previous?.[k]))!==JSON.stringify(canonical(row[k])));if(!changed.length)return null;
 const touch=obj(row.last_touch);
 const payload={...base(id,row),changed_fields:changed,previous_spam_risk:text(obj(previous?.reputation_data).spam_risk),previous_status:text(previous?.status||previous?.assignment_status),call_id:kind==='phone_mailbox'?id:text(row.last_call_id),user_id:kind==='phone_personal'?id:'',phone_number:text(row.phone_number)||(kind==='phone_line'||kind==='number'||kind==='phone_sms'||kind==='phone_reputation_number'?id:''),...Object.fromEntries(['lead_source_id','marketing_campaign_id','pool_id','visit_id','source','medium','campaign','ad_id'].map(k=>[k,text(touch[k])]))};
 return phoneEventEnvelope.parse({type:rule.event,payload});
}
const callEvents:Record<string,keyof typeof names>={'communication.call.created':'phone.call.created','communication.call.connected':'phone.call.connected','communication.call.ended':'phone.call.ended','communication.call.recording_ready':'phone.voicemail.received','phone.voicemail_drop.started':'phone.voicemail_drop.started','phone.voicemail_drop.finished':'phone.voicemail_drop.finished'};
export function isPublishedPhoneCallEvent(type:string){return !!callEvents[type];}
export function callPhoneEvent(type:string,call:Json,data:Json){
 if(!callEvents[type]||call.mode==='diagnostic')return null;
 const metadata=obj(call.metadata),attribution=obj(metadata.attribution);
 if(type==='communication.call.recording_ready'&&!obj(metadata.voicemail).started)return null;
 return phoneEventEnvelope.parse({type:callEvents[type],payload:{...base(text(call.id),call),call_id:text(call.id),user_id:text(call.owner_user_id),phone_number:text(call.business_number),direction:text(call.direction),department_ids:strings(metadata.department_ids),status:text(call.state),voicemail_drop_state:text(obj(metadata.voicemail_drop).state),...Object.fromEntries(['lead_source_id','marketing_campaign_id','pool_id','visit_id','source','medium','campaign','ad_id'].map(k=>[k,text(attribution[k])]))}});
}
