import { TelnyxClient } from '../../messaging/telnyx.js';
import { ensureMessagingOrganization, listSmsComplianceProfiles } from '../../messaging/storage.js';
import { findPhoneNumberOwner, readSmsConsent, listSenderIdentities, upsertSenderIdentity } from '../../messaging/communications_storage.js';
import { smsAutoresponsesReady } from '../../messaging/autoresponses.js';
import { contactSettings, resolveContact } from '../../contacts/service.js';
import { messagingPolicySchema, type MessagingPolicy, type Schedule } from './contracts.js';
import { scheduleOpen, canUseLine } from './service.js';
import { backgroundAuthContext } from '../../platform/auth.js';
import * as s from '../calls/storage.js';

export async function senderConfiguration(org:string,address:string){
  const organization=await ensureMessagingOrganization(org),profiles=await listSmsComplianceProfiles(organization.id),owner=await findPhoneNumberOwner(address);
  const profile=profiles.find(p=>p.id===owner?.compliance_profile_id);if(!profile||s.text(owner?.organization_id)!==org||owner?.status!=='active')return null;
  const refs=s.object(profile.provider_refs),line=await s.resource(org,'phone_sms',address),primary=s.object(profile.campaign).selectedNumber===address;
  const campaign=s.text(refs.telnyx_campaign_id),assignment=primary?s.text(profile.phone_number_campaign_id):s.text(line?.campaign_id),status=primary?s.text(profile.phone_number_campaign_status):s.text(line?.assignment_status);
  if((primary&&!['success','active','purchased'].includes(s.text(profile.phone_number_status).toLowerCase()))||profile.status!=='active'||s.text(profile.campaign_status).toLowerCase()!=='mno_provisioned'||!['verified','vetted_verified','ok','approved'].includes(s.text(profile.brand_status).toLowerCase())||!smsAutoresponsesReady(profile)||!campaign||assignment!==campaign||status.toLowerCase()!=='assigned'||owner?.messaging_profile_id!==refs.telnyx_messaging_profile_id)return null;
  if(!primary){const response=s.object(await new TelnyxClient().getPhoneNumberCampaign(address)),binding=s.object(response.data||response),bindingStatus=s.text(binding.status||binding.assignmentStatus).toLowerCase();if(!['assigned','success'].includes(bindingStatus)||![binding.telnyxCampaignId,binding.campaignId].includes(campaign))return null;}
  return {phoneNumber:address,messagingProfileId:s.text(refs.telnyx_messaging_profile_id),profile};
}
export function nextWindow(schedule:Schedule,at:Date):string|null{
  if(!schedule.business_hours.length)return null;
  if(scheduleOpen(schedule,at))return at.toISOString();
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'});
  let instant=Math.ceil(at.getTime()/60000)*60000;
  // Walk UTC instants so skipped/repeated local hours remain correct through DST changes.
  for(let i=0;i<15*1440;i++,instant+=60000){const p=Object.fromEntries(formatter.formatToParts(instant).map(v=>[v.type,v.value]));if(schedule.holidays.includes(`${p.year}-${p.month}-${p.day}`))continue;const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday||''),clock=`${p.hour}:${p.minute}`;if(schedule.business_hours.some(h=>h.day===day&&clock>=h.open&&clock<h.close))return new Date(instant).toISOString();}
  return null;
}
export async function messagePolicy(org:string,number:string):Promise<MessagingPolicy>{const line=await s.resource(org,'phone_line',number);return messagingPolicySchema.parse(line?.messaging||await s.resource(org,'phone_messaging')||{});}
export async function deliveryEligibility(org:string,message:s.Json,recipient:s.Json,at=new Date()){
  const number=s.text(s.object(message.sender).address),policy=await messagePolicy(org,number),source=s.object(message.source),manual=source.type==='user';
  if(source.user_id){const ctx=await backgroundAuthContext(org,s.text(source.user_id)).catch(()=>null);if(!ctx||!await canUseLine(ctx,number))return {action:'cancel',reason:'Sending-line access was revoked.'};}
  if(!policy.enabled||manual&&!policy.apply_manual)return {action:'send'};
  const created=Date.parse(s.text(message.created_at))||at.getTime();
  if(at.getTime()>=created+policy.expiry_hours*3600000)return {action:'cancel',reason:'This message expired before its next permitted sending time.'};
  if(policy.cancel_on_reply&&!manual&&message.conversation_id){const reply=await s.database().prepare("SELECT id FROM communication_messages WHERE organization_id=? AND conversation_id=? AND direction='inbound' AND created_at>? LIMIT 1").get(org,s.text(message.conversation_id),s.text(message.created_at));if(reply)return {action:'cancel',reason:'The customer replied before this message was sent.'};}
  const context=s.object(message.context);
  if(!manual&&context.work_node_id){const {readNodeRecord}=await import('../../work/storage.js');const node=await readNodeRecord(org,s.text(context.work_node_id)).catch(()=>null);if(node&&['completed','canceled','skipped'].includes(s.text(node.status)))return {action:'cancel',reason:'The originating workflow has ended.'};}
  let timezone=policy.schedule.timezone;
  if(policy.timezone_mode==='contact'){
    let contactZone='';if((await contactSettings(org)).track_time_zones===true){const contact=await resolveContact(org,{project_id:recipient.project_id||context.project_id,contact_id:recipient.contact_id||context.contact_id}).catch(()=>null);contactZone=s.text(contact?.contact.time_zone);}
    if(!contactZone&&policy.unknown_timezone==='hold')return {action:'wait',at:new Date(at.getTime()+15*60000).toISOString(),reason:'Waiting for the contact’s time zone.'};
    timezone=contactZone||timezone;
  }
  const requested=Date.parse(s.text(message.scheduled_for)),earliest=new Date(Math.max(at.getTime(),Number.isFinite(requested)?requested:0));
  const next=nextWindow({...policy.schedule,timezone},earliest);
  if(!next)return {action:'wait',at:new Date(at.getTime()+3600000).toISOString(),reason:'No sending window is currently open.'};
  if(Date.parse(next)>at.getTime())return {action:'wait',at:next,reason:`Waiting for permitted hours in ${timezone}.`};
  return {action:'send'};
}
export async function automaticReply(org:string,number:string,customer:string,trigger:'text'|'missed_call',eventId:string,conversationId='',context:s.Json={}){
  const policy=await messagePolicy(org,number),text=trigger==='missed_call'?policy.missed_call_reply:scheduleOpen(policy.schedule)?policy.auto_reply_open:policy.auto_reply_closed;
  if(!text)return false;
  const consent=await readSmsConsent(org,customer);if(consent?.status!=='opted_in')return false;
  const sender=(await listSenderIdentities(org,'','sms')).find(i=>i.address===number&&i.status==='active');if(!sender)return false;
  const key=s.id('reply',`${number}:${customer}`),claimed=await s.transaction(async()=>{const previous=await s.resource(org,'phone_auto_reply',key);if(previous&&Date.parse(s.text(previous.sent_at))>Date.now()-policy.cooldown_minutes*60000)return false;await s.saveResource(org,'phone_auto_reply',key,{sent_at:s.now(),event_id:eventId});return true;});if(!claimed)return true;
  try{const {sendCommunication}=await import('../../messaging/communications_service.js');const {sendCommunicationSchema}=await import('../../messaging/schemas.js');await sendCommunication(org,sendCommunicationSchema.parse({channel:'sms',purpose:'customer_care',branch_id:sender.branch_id,sender:{identity_id:sender.id},recipients:[{address:customer}],content:{text},...(conversationId?{conversation_id:conversationId}:{}),context,source:{type:'automation',id:'phone-auto-reply'},idempotency_key:`phone-auto-reply:${eventId}`}));return true;}
  catch(error){await s.saveResource(org,'phone_auto_reply',key,{sent_at:'',event_id:eventId,error:'Reply could not be queued.'});throw error;}
}
