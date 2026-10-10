import { backgroundAuthContext } from '../../platform/auth.js';
import { hasResourcePermission } from '../../workforce/department-access.js';
import { voiceSettings } from '../calls/settings.js';
import { providerCommand } from '../calls/voice.js';
import { voiceWebhookUrl } from '../../telephony/telnyx.js';
import { resolveRoute, scheduleOpen, userAvailable } from './service.js';
import { routingSchema, targetSchema, type Routing, type Target } from './contracts.js';
import * as s from '../calls/storage.js';
import { greetingUrl } from './greetings.js';

const state=(call:s.CustomerCall,phase:string)=>Buffer.from(JSON.stringify({call_id:call.id,role:'customer',phase})).toString('base64');
export async function applyTarget(call:s.CustomerCall,control:string,target:Target,routing:Routing,closed=false){
  if(target.kind==='ring'||target.kind==='user')return false;
  if(target.kind==='group'){
    const visited=s.strings(call.metadata.route_groups),group=await s.resource(call.organization_id,'phone_group',target.id);
    if(group&&!visited.includes(target.id)&&visited.length<8){await s.patchCall(call.organization_id,call.id,{state:'queued',metadata:{...call.metadata,route_group_id:target.id,route_groups:[...visited,target.id],route_target:null,queue_entered_at:s.now(),attempted_agents:[],department_ids:s.strings(group.department_ids)}});return true;}
    target=targetSchema.parse({kind:'voicemail'});
  }
  if(target.kind==='forward'){
    await providerCommand(call,control,'transfer',{to:target.number,from:call.business_number,timeout_secs:routing.ring_seconds,target_leg_client_state:Buffer.from(JSON.stringify({call_id:call.id,role:'forwarded'})).toString('base64')},`route-forward:${s.digest(target)}`);
    await s.patchCall(call.organization_id,call.id,{state:'forwarding'});return true;
  }
  if(target.kind==='menu'){
    await s.patchCall(call.organization_id,call.id,{state:'phone_menu',metadata:{...call.metadata,phone_menu:routing.menu,menu_fallback:routing.unanswered}});
    await providerCommand(call,control,'gather_using_speak',{payload:target.message||routing.menu.map(m=>`Press ${m.digit} for ${m.label}.`).join(' '),voice:'female',language:'en-US',minimum_digits:1,maximum_digits:1,valid_digits:routing.menu.map(m=>m.digit).join(''),timeout_millis:10000,maximum_tries:2,client_state:state(call,'phone_menu')},`menu:${s.digest(routing.menu)}`);return true;
  }
  const greeting=target.message||(closed&&routing.closed_greeting)||routing.voicemail_greeting;
  if(target.kind==='announcement'){
    await s.patchCall(call.organization_id,call.id,{state:'phone_announcement'});
    await providerCommand(call,control,'speak',{payload:greeting,voice:'female',language:'en-US',client_state:state(call,'phone_announcement')},'phone-announcement');return true;
  }
  await s.patchCall(call.organization_id,call.id,{state:'voicemail',metadata:{...call.metadata,voicemail:{pending:true}}});
  const media=(closed&&routing.closed_media_id)||routing.voicemail_media_id;
  if(media&&await s.resource(call.organization_id,'phone_greeting',media))await providerCommand(call,control,'playback_start',{audio_url:greetingUrl(call.organization_id,media),client_state:state(call,'voicemail_greeting')},'voicemail-greeting');
  else await providerCommand(call,control,'speak',{payload:greeting,voice:'female',language:'en-US',client_state:state(call,'voicemail_greeting')},'voicemail-greeting');return true;
}
export async function routeConfiguredCall(call:s.CustomerCall):Promise<boolean>{
  let resolved=await resolveRoute(call.organization_id,call.business_number);const groupId=s.text(call.metadata.route_group_id);
  if(groupId){const group=await s.resource(call.organization_id,'phone_group',groupId);if(group){const base=await voiceSettings(call.organization_id),routing=routingSchema.parse(group.routing);resolved={routing,schedule:routing.schedule||base,members:s.strings(group.user_ids),department_ids:s.strings(group.department_ids),group_id:groupId};}}
  if(!resolved)return false;
  const {routing,members,schedule}=resolved,org=call.organization_id,settings=await voiceSettings(org);
  const customer=(await s.legs(org,call.id)).find(l=>l.role==='customer'&&l.state!=='ended');if(!customer)return true;
  const closed=!scheduleOpen(schedule),expired=Date.now()-Date.parse(s.text(call.metadata.queue_entered_at)||call.created_at)>=routing.max_wait_seconds*1000;
  const queue=s.object(await s.database().prepare("SELECT count(*) AS n FROM customer_calls WHERE organization_id=? AND business_number=? AND state='queued'").get(org,call.business_number));
  let target=call.metadata.route_target?targetSchema.parse(call.metadata.route_target):closed?routing.closed:routing.open;
  if(!settings.enabled||call.metadata.force_voicemail)target=targetSchema.parse({kind:'voicemail'});
  else if(expired||Number(queue.n)>routing.max_queue)target=routing.unanswered;
  if(await applyTarget(call,s.text(customer.control_id),target,routing,closed))return true;
  const candidates=[];
  for(const endpoint of await s.resources(org,'endpoint')){
    const user=s.text(endpoint.user_id);
    if(target.kind==='user'?user!==target.id:members.length&&!members.includes(user))continue;
    if(s.strings(call.metadata.attempted_agents).includes(user)||endpoint.registered!==true||endpoint.availability!=='available'||s.text(endpoint.heartbeat_at)<new Date(Date.now()-45000).toISOString()||s.text(endpoint.wrap_until)>s.now()||s.text(endpoint.branch_id||'default')!==call.branch_id||!await userAvailable(org,user))continue;
    if(settings.require_disposition&&await s.database().prepare("SELECT id FROM customer_calls WHERE organization_id=? AND owner_user_id=? AND mode<>'diagnostic' AND (mode='external' OR state IN ('ended','canceled','failed','no_answer','busy','rejected')) AND wrap_up_state NOT IN ('saved','processing_effects') LIMIT 1").get(org,user))continue;
    if(s.text((await s.resource(org,'endpoint_lock',user))?.expires_at)>s.now()||(await s.listCalls(org,{owner_user_id:user,active:true})).total)continue;
    const auth=await backgroundAuthContext(org,user).catch(()=>null);if(!auth||!hasResourcePermission(auth,'make_calls|manage_communications|manage_company_settings',{department_ids:resolved.department_ids}))continue;
    candidates.push(endpoint);
  }
  if(!candidates.length){if(target.kind==='user'&&!await userAvailable(org,target.id)){const personal=await s.resource(org,'phone_personal',target.id);await applyTarget(call,s.text(customer.control_id),targetSchema.parse({kind:'voicemail'}),{...routing,voicemail_greeting:s.text(personal?.voicemail_greeting)||routing.voicemail_greeting,voicemail_media_id:s.text(personal?.voicemail_media_id)||routing.voicemail_media_id},true);}return true;}
  const counter=await s.resource(org,'phone_rotation',resolved.group_id||call.business_number),last=s.text(counter?.last_user_id);
  const order=members.length?members:candidates.map(e=>s.text(e.user_id)).sort();
  const rank=(user:string)=>(order.indexOf(user)-order.indexOf(last)-1+order.length)%Math.max(1,order.length);
  candidates.sort((a,b)=>routing.strategy==='sequential'?members.indexOf(s.text(a.user_id))-members.indexOf(s.text(b.user_id)):routing.strategy==='round_robin'?rank(s.text(a.user_id))-rank(s.text(b.user_id)):s.text(a.last_call_at).localeCompare(s.text(b.last_call_at)));
  const selected=routing.strategy==='simultaneous'?candidates.slice(0,25):candidates.slice(0,1),app=await s.resource(org,'application');if(!app?.provider_id)return true;
  const offered=selected.map(e=>s.text(e.user_id));
  call=await s.patchCall(org,call.id,{state:'agent_connecting',owner_user_id:offered.length===1?offered[0]:'',metadata:{...call.metadata,phone_routing:true,offered_user_ids:offered,winning_control_id:'',attempted_agents:[...s.strings(call.metadata.attempted_agents),...offered],department_ids:resolved.department_ids}});
  for(const endpoint of selected){const user=s.text(endpoint.user_id);await s.saveResource(org,'endpoint',user,{...endpoint,availability:'busy',offered_call_id:call.id,last_call_at:s.now()});
    await s.enqueue(org,call.id,'provider',{path:'dial',role:'agent',payload:{connection_id:app.provider_id,to:`sip:${endpoint.sip_username}@sip.telnyx.com`,from:call.business_number,webhook_url:voiceWebhookUrl(),client_state:Buffer.from(JSON.stringify({call_id:call.id,role:'agent',ring_user_id:user})).toString('base64'),timeout_secs:routing.ring_seconds,time_limit_secs:settings.max_call_minutes*60,custom_headers:[{name:'X-FirstMate-Call',value:call.id}]}},`${call.id}:ring:${user}`);
  }
  await s.saveResource(org,'phone_rotation',resolved.group_id||call.business_number,{last_user_id:offered[0]});return true;
}
/** Claim exactly one answer under the database transaction; late answers are disconnected. */
export async function ringEvent(call:s.CustomerCall,type:string,control:string,user:string){
  if(!call.metadata.phone_routing||!user)return false;
  return s.transaction(async()=>{
    call=await s.readCall(call.organization_id,call.id);const winner=s.text(call.metadata.winning_control_id);
    if(type==='call.answered'){
      if(winner&&winner!==control){await providerCommand(call,control,'hangup',{},`ring-loser:${control}`);return true;}
      if(!winner){call=await s.patchCall(call.organization_id,call.id,{owner_user_id:user,metadata:{...call.metadata,winning_control_id:control}});
        for(const leg of await s.legs(call.organization_id,call.id))if(leg.role==='agent'&&leg.control_id!==control&&leg.state!=='ended')await providerCommand(call,s.text(leg.control_id),'hangup',{},`ring-loser:${leg.control_id}`);
      }
      return false;
    }
    if(type==='call.hangup'&&control!==winner){
      const endpoint=await s.resource(call.organization_id,'endpoint',user);if(endpoint?.offered_call_id===call.id)await s.saveResource(call.organization_id,'endpoint',user,{...endpoint,offered_call_id:'',availability:'unavailable'});
      const live=(await s.legs(call.organization_id,call.id)).some(l=>l.role==='agent'&&l.state!=='ended');
      const pending=!!await s.database().prepare("SELECT id FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND kind='provider' AND state IN ('pending','running','uncertain') AND json_extract(payload_json,'$.role')='agent'", "SELECT id FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND kind='provider' AND state IN ('pending','running','uncertain') AND payload_json::jsonb->>'role'='agent'").get(call.organization_id,call.id);
      if(!winner&&!live&&!pending)await s.patchCall(call.organization_id,call.id,{state:'queued',owner_user_id:''});return true;
    }
    return false;
  });
}
