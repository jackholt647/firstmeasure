import type { PlatformAuthContext } from '../../platform/auth.js';
import { conflict } from '../../platform/errors.js';
import * as s from '../calls/storage.js';
import { canUseLine } from './service.js';
import { powerDialSchema, dropSchema } from './contracts.js';
import { greetingUrl } from './greetings.js';
import { providerCommand } from '../calls/voice.js';

/** Called inside the call-creation transaction: competing callers see reserved usage. */
export async function selectPowerDialLine(ctx:PlatformAuthContext,branch:string){
  const personal=await s.resource(ctx.orgId,'phone_personal',ctx.userId),policy=powerDialSchema.parse(personal?.power_dial||{});
  if(!policy.enabled)return null;
  const candidates=[];
  for(const number of [...new Set(policy.numbers)]){
    const line=await s.resource(ctx.orgId,'number',number);
    if(line?.status!=='active'||s.text(line.branch_id||'default')!==branch||!await canUseLine(ctx,number))continue;
    const reputation=await s.resource(ctx.orgId,'phone_reputation_number',number);
    if(policy.skip_high_risk&&s.object(reputation?.reputation_data).spam_risk==='high')continue;
    const usage=s.object(await s.database().prepare("SELECT count(*) AS total,max(created_at) AS last_call FROM customer_calls WHERE organization_id=? AND business_number=? AND direction='outbound' AND mode='browser' AND created_at>=?").get(ctx.orgId,number,new Date(Date.now()-86400000).toISOString()));
    if(Number(usage.total)>=policy.daily_limit||Date.parse(s.text(usage.last_call))>Date.now()-policy.cooldown_seconds*1000)continue;
    candidates.push({line,total:Number(usage.total||0),last:s.text(usage.last_call)});
  }
  candidates.sort((a,b)=>(policy.strategy==='least_used'?a.total-b.total:0)||a.last.localeCompare(b.last)||s.text(a.line.id).localeCompare(s.text(b.line.id)));
  if(!candidates.length)throw conflict('power_dial_pool_unavailable','Your dialing numbers are unavailable, cooling down, at their daily limit, or flagged high risk. Power dialing is paused.');
  return candidates[0]!.line;
}

export async function outgoingDrop(org:string,user:string,powerDial:boolean){
  const personal=await s.resource(org,'phone_personal',user),p=dropSchema.parse(personal?.voicemail_drop||{});
  if(!p.enabled||p.scope==='power_dial'&&!powerDial)return {};
  const media=await s.resource(org,'phone_greeting',p.media_id);
  if(!media||media.owner_user_id!==user)throw conflict('drop_audio_missing','Your outgoing voicemail recording is unavailable. Update My Phone.');
  return {enabled:true,media_id:p.media_id,state:'pending'};
}

export function dropWaiting(call:s.CustomerCall){return ['pending','machine','playing'].includes(s.text(s.object(call.metadata.voicemail_drop).state));}

/** Only the correlated customer leg and a positive beep can trigger a drop. */
export async function voicemailDropEvent(call:s.CustomerCall,type:string,payload:s.Json,state:s.Json,role:string){
  if(role!=='customer'||call.direction!=='outbound'||s.terminal.has(call.state)||call.metadata.canceled_at)return false;
  const recognized=['call.machine.premium.detection.ended','call.machine.premium.greeting.ended','call.playback.ended'];
  if(!recognized.includes(type))return false;
  return s.transaction(async()=>{
    call=await s.readCall(call.organization_id,call.id);const drop=s.object(call.metadata.voicemail_drop);
    if(s.terminal.has(call.state)||call.metadata.canceled_at||!drop.enabled||!dropWaiting(call))return false;
    const control=s.text(payload.call_control_id);
    if(type==='call.playback.ended'){
      if(drop.state!=='playing'||state.phase!=='outgoing_voicemail_drop'||drop.control_id!==control)return false;
      // An interrupted or failed playback is never reported as a delivered message.
      const completed=payload.status==='completed';
      await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,voicemail_drop:{...drop,state:completed?'completed':'interrupted',completed_at:completed?s.now():null}}});
      await s.appendEvent(call.organization_id,call.id,'phone.voicemail_drop.finished',{completed},`${call.id}:drop-finished`);
      await providerCommand(call,control,'hangup',{},'outgoing-drop-end');return true;
    }
    if(drop.state==='playing')return true;
    if(type==='call.machine.premium.detection.ended'){
      const result=s.text(payload.result);
      await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,voicemail_drop:{...drop,state:result==='machine'?'machine':'skipped',detection:result}}});return true;
    }
    if(payload.result!=='beep_detected')return true;
    // Premium AMD may emit the beep before its classification event.
    const next={...drop,state:'playing',control_id:control,started_at:s.now()};
    await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,voicemail_drop:next}});
    await providerCommand(call,control,'playback_start',{audio_url:greetingUrl(call.organization_id,s.text(drop.media_id)),loop:1,client_state:Buffer.from(JSON.stringify({call_id:call.id,role:'customer',phase:'outgoing_voicemail_drop'})).toString('base64')},'outgoing-voicemail-drop');
    await s.appendEvent(call.organization_id,call.id,'phone.voicemail_drop.started',{},`${call.id}:drop-started`);return true;
  });
}

export async function expireVoicemailDetection(call:s.CustomerCall){
  return s.transaction(async()=>{call=await s.readCall(call.organization_id,call.id);const drop=s.object(call.metadata.voicemail_drop);
    if(s.terminal.has(call.state)||!['pending','machine'].includes(s.text(drop.state)))return;
    await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,voicemail_drop:{...drop,state:'skipped',reason:'no_confirmed_beep'}}});
  });
}
