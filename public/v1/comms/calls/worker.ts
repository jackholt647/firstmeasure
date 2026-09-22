import { platformBackgroundAllowed } from "../../platform/runtime.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { env } from "../../src/config/env.js";
import { TelnyxError } from "../../messaging/telnyx.js";
import { conflict, PlatformError } from '../../platform/errors.js';
import { listDocuments } from "../../platform/storage.js";
import { createFollowUpTodo } from "../../work/followups.js";
import { voiceClient, voiceMode, voiceWebhookUrl } from "../../telephony/telnyx.js";
import { applyWrapUpEffects } from "./service.js";
import { voiceSettings, businessOpen } from "./settings.js";
import { providerCommand } from "./voice.js";
import { expireArtifacts } from "./media.js";
import { maintainVoiceSessions } from "./recovery.js";
import { recordVoiceCost } from './operations.js';
import * as s from "./storage.js";
import { text, object, strings, type Json, type CustomerCall } from "./storage.js";

function decodeState(payload:Json){try{return object(JSON.parse(Buffer.from(text(payload.client_state),"base64").toString()));}catch{return {};}}
async function queueDial(call:CustomerCall,role:string,to:string,key:string){
  const settings=(await voiceSettings(call.organization_id));const app=(await s.resource(call.organization_id,"application"));if(!app?.provider_id)throw new Error("Voice application is unavailable");
  return (await s.enqueue(call.organization_id,call.id,"provider",{path:"dial",role,payload:{connection_id:app.provider_id,to,from:call.business_number,webhook_url:voiceWebhookUrl(),
    client_state:Buffer.from(JSON.stringify({call_id:call.id,role})).toString("base64"),timeout_secs:settings.ring_seconds,time_limit_secs:settings.max_call_minutes*60,
    custom_headers:[{name:"X-FirstMate-Call",value:call.id}]}},`${call.id}:${key}`));
}
async function endCall(call:CustomerCall,cause:string,at=s.now()){
  if(s.terminal.has(call.state))return;
  (await s.patchCall(call.organization_id,call.id,{state:call.connected_at?"ended":cause==="USER_BUSY"?"busy":cause==="ORIGINATOR_CANCEL"?"canceled":"no_answer",
    ended_at:at,wrap_up_state:"needs_wrap_up",metadata:{...call.metadata,hangup_cause:cause}}));
  for(const leg of (await s.legs(call.organization_id,call.id)).filter(l=>l.state!=="ended"))(await providerCommand(call,text(leg.control_id),"hangup",{},`end:${leg.id}`));
  (await s.releaseClaims(call.organization_id,call.id));
  const endpoint=(await s.resource(call.organization_id,"endpoint",call.owner_user_id));
  if(endpoint)(await s.saveResource(call.organization_id,"endpoint",call.owner_user_id,{...endpoint,availability:"unavailable",wrap_until:new Date(Date.now()+(await voiceSettings(call.organization_id)).wrap_up_seconds*1000).toISOString()}));
  (await s.appendEvent(call.organization_id,call.id,"communication.call.ended",{cause},`${call.id}:ended`));
  if(call.direction==="inbound"&&!call.connected_at)(await s.enqueue(call.organization_id,call.id,"missed_callback",{},`${call.id}:missed-callback`));
}
async function matchInbound(orgId:string,number:string){
  const matches:Json[]=[];
  for(const doc of await listDocuments(orgId,"projects")){
    const project=object(doc.data);const contacts=Array.isArray(project.contacts)?project.contacts.map(object):[];
    for(const contact of contacts){const digits=text(contact.phone||contact.mobile||contact.phone_number).replace(/\D/g,"");if(digits&&(number.replace(/\D/g,"")===digits||number.replace(/\D/g,"")===`1${digits}`))matches.push({project_id:doc.id,contact_id:text(contact.id||contact.contact_id),name:text(contact.name),branch_id:text(project.branch_id||"default")});}
  }
  return matches;
}
async function setCapture(call:CustomerCall,state:string,extra:Json={}){return (await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,capture:{...object(call.metadata.capture),state,...extra}}}));}
async function ensureConference(call:CustomerCall){
  const legs=(await s.legs(call.organization_id,call.id));const agent=legs.find(l=>l.role==="agent"&&l.state==="answered");const customer=legs.find(l=>l.role==="customer"&&l.state==="answered");
  if(!agent||!customer)return;
  if(!text(call.metadata.conference_id))(await s.enqueue(call.organization_id,call.id,"provider",{path:"conference_create",payload:{call_control_id:agent.control_id,name:call.id,beep_enabled:"never",start_conference_on_create:true,max_participants:6,
    duration_minutes:(await voiceSettings(call.organization_id)).max_call_minutes,client_state:Buffer.from(JSON.stringify({call_id:call.id})).toString("base64")}},`${call.id}:conference`));
  else (await providerCommand(call,text(customer.control_id),"conference_join",{},"join-customer"));
}
/** Signed events are still correlated against tenant-owned application/number resources. */
export async function processVoiceEvent(body:Json){
  const event=object(body.data),payload=object(event.payload),type=text(event.event_type),at=text(event.occurred_at)||s.now();
  const state=decodeState(payload),controlId=text(payload.call_control_id);
  const known=controlId?(await s.legByControl(controlId)):text(payload.call_leg_id)?object((await s.database().prepare('SELECT * FROM customer_call_legs WHERE provider_leg_id=?').get(text(payload.call_leg_id)))):null;
  let call:CustomerCall|null=null;
  if(known?.call_id)call=(await s.readCall(text(known.organization_id),text(known.call_id)));
  else if(text(state.call_id)){
    const app=(await s.resourceByProvider("application",text(payload.connection_id)));
    // Conference events use conference IDs instead of a connection ID.
    const row=object((await s.database().prepare("SELECT organization_id FROM customer_calls WHERE id=?").get(text(state.call_id))));
    if(app&&row.organization_id===app.organization_id)call=(await s.readCall(app.organization_id,text(state.call_id)));
    else if(type.startsWith("conference.")&&row.organization_id){
      const candidate=(await s.readCall(text(row.organization_id),text(state.call_id)));
      const expected=object((await s.database().prepare("SELECT id FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND kind='provider' AND json_extract(payload_json,'$.path')='conference_create'", "SELECT id FROM customer_call_jobs WHERE organization_id=? AND call_id=? AND kind='provider' AND payload_json::jsonb #>> '{path}'='conference_create'").get(candidate.organization_id,candidate.id)));
      if(text(candidate.metadata.conference_id)===text(payload.id||payload.conference_id)||(type==="conference.created"&&!candidate.metadata.conference_id&&expected.id))call=candidate;
    }
  }
  if(!call&&type==="call.initiated"){
    const connection=(await s.resourceByProvider("connection",text(payload.connection_id)));
    if(connection){
      // No browser credential may originate an uncontrolled PSTN call.
      (await s.enqueue(connection.organization_id,"","provider_reject",{control_id:controlId},`reject-unauthorized:${controlId}`));return;
    }
    const app=(await s.resourceByProvider("application",text(payload.connection_id)));
    if(!app||payload.direction!=="incoming")return;
    const number=(await s.resource(app.organization_id,"number",text(payload.to)));if(!number||number.status!=="active")return;
    const matches=(await matchInbound(app.organization_id,text(payload.from))).filter(match=>text(match.branch_id||'default')===text(number.branch_id||'default'));const unique=matches.length===1?matches[0]:null;
    call=(await s.transaction(async ()=>{
      const duplicate=(await s.legByControl(controlId));if(duplicate)return (await s.readCall(text(duplicate.organization_id),text(duplicate.call_id)));
      const settings=(await voiceSettings(app.organization_id));const created=(await s.insertCall({id:s.id("call",`inbound:${controlId}`),organization_id:app.organization_id,branch_id:text(number.branch_id)||"default",mode:"browser",direction:"inbound",state:"ringing",
        project_id:text(unique?.project_id),contact_id:text(unique?.contact_id),customer_name:text(unique?.name)||text(payload.from),customer_number:text(payload.from),business_number:text(payload.to),
        metadata:{matches,queue_entered_at:at,attempted_agents:[],consent:{state:"not_requested"},policy:{recording_enabled:settings.recording_enabled,transcription_enabled:settings.transcription_enabled,disclosure:settings.disclosure,retention_days:settings.recording_retention_days}}}));
      (await s.saveLeg(created.organization_id,created.id,"customer",{...payload,state:"initiated"},at));
      (await providerCommand(created,controlId,"answer",{},"inbound-answer"));(await s.appendEvent(created.organization_id,created.id,"communication.call.created",{},`${created.id}:created`));return created;
    }));
  }
  if(!call)return;
  const current=call;const role=text(known?.role||state.role||(call.direction==="inbound"?"customer":""));
  if(controlId&&role){
    const legState=type==="call.hangup"?"ended":type==="call.answered"?"answered":text(known?.state)||"initiated";
    (await s.saveLeg(call.organization_id,call.id,role,{...payload,...(state.operation_id?{operation_id:state.operation_id}:{}),state:legState},at));
  }
  if(type==="call.recording.saved"){
    const recordingId=text(payload.recording_id);if(!recordingId)return;
    const voicemail=object(call.metadata.voicemail).started===true;
    const artifact=(await s.saveArtifact(call.organization_id,call.id,voicemail?"voicemail":"recording",recordingId,{provider_recording_id:recordingId,channels:payload.channels,recording_started_at:payload.recording_started_at,recording_ended_at:payload.recording_ended_at},"processing",Number(object(call.metadata.policy).retention_days)||30));
    (await s.enqueue(call.organization_id,call.id,"recording_ingest",{artifact_id:artifact,recording_id:recordingId,urls:payload.recording_urls},`recording:${recordingId}`));
    if(voicemail)(await providerCommand(call,controlId,"hangup",{},"voicemail-end"));return;
  }
  if(type==="call.recording.transcription.saved"||type==="call.transcription"){
    const content=text(payload.transcription_text||payload.transcription||object(payload.transcription_data).transcript||payload.transcript);
    if(content){(await s.saveArtifact(call.organization_id,call.id,"transcript",text(payload.recording_id)||text(event.id),{text:content,final:payload.is_final!==false,source:"telnyx",recording_id:payload.recording_id,started_at:payload.transcription_started_at},"ready",Number(object(call.metadata.policy).retention_days)||30));(await s.appendEvent(call.organization_id,call.id,"communication.call.transcript_ready",{},text(event.id)));}return;
  }
  if(type==="call.cost"){
    (await recordVoiceCost(call.organization_id,call.id,text(event.id),payload));
    (await s.appendEvent(call.organization_id,call.id,"communication.call.cost",{leg_id:payload.call_leg_id,total_cost:payload.total_cost,status:payload.status,cost_parts:payload.cost_parts},text(event.id)));return;
  }
  if(s.terminal.has(call.state)){
    if(controlId&&["call.initiated","call.answered"].includes(type))(await providerCommand(call,controlId,"hangup",{},`late-leg:${controlId}`));
    return;
  }
  // Delayed events for a previous ringing leg cannot reroute or end its replacement.
  if(known?.state==='ended'&&['call.answered','call.hangup','call.initiated'].includes(type))return;
  if(type==="call.answered"){
    if(call.mode==='diagnostic'){
      (await s.patchCall(call.organization_id,call.id,{state:'connected',connected_at:at}));
      (await providerCommand(call,controlId,'speak',{payload:'This is your FirstMate audio check. Speak normally while we measure your connection. This check does not record your voice.',voice:'female',language:'en-US'},'diagnostic-prompt'));
      (await s.enqueue(call.organization_id,call.id,'provider',{path:'hangup',control_id:controlId,payload:{}},`${call.id}:diagnostic-end`,12000));return;
    }
    if(role==="agent"&&call.direction==="outbound"&&['created','agent_connecting','dialing'].includes(call.state)){
      if(call.metadata.canceled_at){(await providerCommand(call,controlId,"hangup",{},`canceled:${controlId}`));return;}
      if(!(await s.legs(call.organization_id,call.id)).some(l=>l.role==="customer"))(await queueDial(call,"customer",call.customer_number,"dial-customer"));
      (await s.patchCall(call.organization_id,call.id,{state:"dialing"}));
    }else if(role==="customer"&&call.direction==="inbound"&&call.state==='ringing'){
      (await s.patchCall(call.organization_id,call.id,{state:"queued"}));const settings=(await voiceSettings(call.organization_id));
      (await providerCommand(call,controlId,"speak",{payload:settings.greeting,voice:"female",language:"en-US"},"greeting"));
    }else if(role==="consult"){
      const transfer=object(call.metadata.transfer),leg=(await s.legByControl(controlId));
      if(!['dialing','consulting'].includes(text(transfer.state))||(transfer.job_id&&object(leg?.data).operation_id!==transfer.job_id)){(await providerCommand(call,controlId,'hangup',{},`canceled-consult:${controlId}`));return;}
      (await providerCommand(call,controlId,"conference_join",{},`join-consult:${controlId}`));
      (await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,transfer:{...object(call.metadata.transfer),state:"consulting"}}}));
    }
    if(!call.connected_at)(await ensureConference((await s.readCall(call.organization_id,call.id))));
  }
  if(type==="conference.created"){
    const conferenceId=text(payload.id||payload.conference_id);
    if(conferenceId){(await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,conference_id:conferenceId}}));(await ensureConference((await s.readCall(call.organization_id,call.id))));}
  }
  if(type==="conference.participant.joined"&&role==="customer"&&!call.connected_at){
    (await s.patchCall(call.organization_id,call.id,{state:"connected",connected_at:call.connected_at||at}));(await s.appendEvent(call.organization_id,call.id,"communication.call.connected",{},`${call.id}:connected`));
  }
  if(type==="call.speak.ended"&&state.phase==='voicemail_greeting'&&object(call.metadata.voicemail).pending===true){
    (await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,voicemail:{started:true},consent:{state:"voicemail_prompt",at}}}));
    (await providerCommand(call,controlId,"record_start",{format:"mp3",channels:"single",play_beep:true,timeout_secs:5,max_length:180,transcription:(await voiceSettings(call.organization_id)).transcription_enabled},"voicemail-record"));
  }
  if(type==="call.hangup"){
    if(role==='forwarded'&&!call.connected_at){
      (await s.patchCall(call.organization_id,call.id,{state:'queued',metadata:{...call.metadata,force_voicemail:true}}));return;
    }
    if(role==="agent"&&call.direction==="inbound"&&!call.connected_at&&!call.metadata.canceled_at){
      const endpoint=(await s.resource(call.organization_id,'endpoint',call.owner_user_id));if(endpoint)(await s.saveResource(call.organization_id,'endpoint',call.owner_user_id,{...endpoint,availability:'unavailable'}));
      (await s.patchCall(call.organization_id,call.id,{state:"queued",owner_user_id:""}));return;
    }
    if(role==="consult"&&object(call.metadata.transfer).state!=="completed"){
      const endpoint=(await s.resource(call.organization_id,'endpoint',text(object(call.metadata.transfer).target_user_id)));if(endpoint)(await s.saveResource(call.organization_id,'endpoint',text(endpoint.user_id),{...endpoint,availability:'unavailable'}));
      const customer=(await s.legs(call.organization_id,call.id)).find(l=>l.role==="customer"&&l.state!=="ended");
      if(customer)(await providerCommand(call,text(customer.control_id),"conference_unhold",{},`transfer-failed:${controlId}`));
      (await s.patchCall(call.organization_id,call.id,{metadata:{...call.metadata,transfer:{...object(call.metadata.transfer),state:object(call.metadata.transfer).state==='canceled'?'canceled':"failed"}}}));return;
    }
    if(role!=="transferred_agent")(await endCall((await s.readCall(call.organization_id,call.id)),text(payload.hangup_cause),at));
  }
  if(type==='call.bridged'&&call.state==='forwarding'){
    (await s.patchCall(call.organization_id,call.id,{state:'connected',connected_at:call.connected_at||at,metadata:{...call.metadata,forwarded:true}}));
  }
  if(type.startsWith("call.recording."))(await s.appendEvent(current.organization_id,current.id,type,{recording_id:payload.recording_id},text(event.id)));
}

async function ingestRecording(orgId:string,callId:string,input:Json){
  const call=(await s.readCall(orgId,callId));const recording=await voiceClient().recording(text(input.recording_id));
  const urls=object(recording.download_urls||recording.recording_urls||input.urls);const url=text(urls.mp3||urls.wav);
  const parsed=new URL(url);
  if(parsed.protocol!=="https:"||!/(^|\.)(telnyx\.com|amazonaws\.com)$/.test(parsed.hostname))throw new Error("Recording URL is not on an approved provider host");
  const response=await fetch(url,{redirect:"error",signal:AbortSignal.timeout(60_000)});
  if(!response.ok||!response.body)throw new Error("Recording download is not ready");
  if(Number(response.headers.get("content-length"))>128*1024*1024)throw new Error("Recording exceeds the supported size");
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>128*1024*1024)throw new Error("Recording exceeds the supported size");chunks.push(Buffer.from(chunk));}
  const folder=path.resolve(env.messagingStorageRoot,"call-recordings",s.id("org",orgId));await mkdir(folder,{recursive:true});
  const extension=urls.mp3?"mp3":"wav";const filename=path.join(folder,`${text(input.artifact_id)}.${extension}`);const temporary=`${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary,Buffer.concat(chunks),{mode:0o600});await rename(temporary,filename);
  const old=(await s.artifacts(orgId,callId)).find(a=>a.id===input.artifact_id);
  if(!old){await unlink(filename);return;}
  const update=(await s.database().prepare("UPDATE customer_call_artifacts SET state='ready',data_json=? WHERE organization_id=? AND id=? AND state<>'deleted'")
    .run(JSON.stringify({...object(old.data),file_path:filename,content_type:extension==="mp3"?"audio/mpeg":"audio/wav",bytes}),orgId,text(input.artifact_id)));
  if(!update.changes){await unlink(filename).catch(()=>{});return;}
  (await s.appendEvent(orgId,callId,"communication.call.recording_ready",{artifact_id:input.artifact_id},`recording-ready:${input.artifact_id}`));
  if(object(call.metadata.voicemail).started)(await s.enqueue(orgId,callId,"missed_callback",{},`${callId}:missed-callback`));
}
async function executeProvider(job:Json,payload:Json){
  if(voiceMode()!=="live")throw conflict('voice_disabled',"Voice is disabled on this server");
  const orgId=text(job.organization_id),callId=text(job.call_id),action=text(payload.path);let call=(await s.readCall(orgId,callId));
  const commandId=text(job.id);const input={...object(payload.payload),command_id:commandId};
  if(['record_start','record_resume'].includes(action)&&!object(call.metadata.voicemail).started){
    const settings=(await voiceSettings(orgId));if(object(call.metadata.consent).state!=='granted'||!settings.recording_enabled||!settings.recording_policy_confirmed)return {canceled:true,reason:'Recording consent or policy changed'};
  }
  if((s.terminal.has(call.state)||call.metadata.canceled_at)&&action!=="hangup")return {canceled:true};
  let result:Json;
  if(action==="dial"){
    if(payload.role==='consult'&&object(call.metadata.transfer).state!=='dialing')return {canceled:true};
    const settings=(await voiceSettings(orgId));if(!settings.enabled)throw conflict('voice_disabled',"Voice was disabled before dialing");
    if(payload.role==="customer"&&(await s.resource(orgId,"suppression",call.customer_number)))throw conflict('number_suppressed',"Customer requested no further calls");
    const correlation={...decodeState(input),call_id:callId,role:payload.role,operation_id:commandId};
    result=await voiceClient().dial({...input,client_state:Buffer.from(JSON.stringify(correlation)).toString('base64')});if(!text(result.call_control_id))throw new Error("Provider dial response did not include a call ID");
    // Provider event timestamps beat a synchronous create response, including when the webhook arrives first.
    (await s.saveLeg(orgId,callId,text(payload.role),{...result,operation_id:commandId,state:"initiated"},"0000-01-01T00:00:00.000Z"));
    call=(await s.readCall(orgId,callId));if(s.terminal.has(call.state)||call.metadata.canceled_at)(await providerCommand(call,text(result.call_control_id),"hangup",{},`canceled-response:${result.call_control_id}`));
    else if(payload.role==='consult'&&(object(call.metadata.transfer).state!=='dialing'||object(call.metadata.transfer).job_id!==commandId))(await providerCommand(call,text(result.call_control_id),'hangup',{},`canceled-consult-response:${commandId}`));
  }else if(action==="conference_create"){
    result=await voiceClient().createConference(input);if(!text(result.id))throw new Error("Provider conference response did not include an ID");
    call=(await s.readCall(orgId,callId));
    (await s.patchCall(orgId,callId,{metadata:{...call.metadata,conference_id:result.id}}));(await ensureConference((await s.readCall(orgId,callId))));
  }else if(action.startsWith("conference_")){
    const conferenceId=text(call.metadata.conference_id);if(!conferenceId)throw new Error("The call conference is not ready");
    const command=action.slice(11);const control=text(payload.control_id);
    result=await voiceClient().conference(conferenceId,command,command==="join"?{call_control_id:control,beep_enabled:"never",end_conference_on_exit:false,command_id:commandId}:{call_control_ids:[control]});
    call=(await s.readCall(orgId,callId));
    const leg=(await s.legByControl(control));
    if(command==="join"&&leg?.role==="customer"){
      (await s.patchCall(orgId,callId,{state:"connected",connected_at:call.connected_at||s.now()}));(await s.appendEvent(orgId,callId,"communication.call.connected",{},`${callId}:connected`));
    }
    if(command==="hold"||command==="unhold")(await s.patchCall(orgId,callId,{state:command==="hold"?"held":"connected"}));
    if(command==="join"&&leg?.role==="consult"&&object(call.metadata.transfer).mode==="cold"&&['dialing','consulting'].includes(text(object(call.metadata.transfer).state))){
      const agent=(await s.legs(orgId,callId)).find(l=>l.role==="agent"&&l.state!=="ended");const customer=(await s.legs(orgId,callId)).find(l=>l.role==="customer"&&l.state!=="ended");
      (await s.transaction(async db=>{
        (await db.prepare("UPDATE customer_call_legs SET role='transferred_agent' WHERE organization_id=? AND call_id=? AND role='agent'").run(orgId,callId));
        (await db.prepare("UPDATE customer_call_legs SET role='agent' WHERE organization_id=? AND call_id=? AND control_id=?").run(orgId,callId,control));
        (await s.patchCall(orgId,callId,{owner_user_id:text(object(call.metadata.transfer).target_user_id),metadata:{...call.metadata,transfer:{...object(call.metadata.transfer),state:"completed"}}}));
        if(customer)(await providerCommand(call,text(customer.control_id),"conference_unhold",{},"cold-transfer-resume"));if(agent)(await providerCommand(call,text(agent.control_id),"hangup",{},"cold-transfer-leave"));
      }));
    }
  }else{
    result=await voiceClient().command(text(payload.control_id),action,input);
    if(action.startsWith("record_"))(await setCapture((await s.readCall(orgId,callId)),action==="record_start"||action==="record_resume"?"recording":action==="record_pause"?"paused":"stopped"));
  }
  return result;
}
export async function processOneJob(workerId:string,lane:'all'|'voice'|'background'='all',onlyCallId=''){
  const job=(await s.claimJob(workerId,lane,onlyCallId));if(!job)return false;const orgId=text(job.organization_id),callId=text(job.call_id),payload=object(job.payload);
  try{
    let result:Json={};
    if(job.kind==="provider")result=await executeProvider(job,payload);
    else if(job.kind==="provider_reject"){if(voiceMode()==="live")await voiceClient().command(text(payload.control_id),"hangup",{command_id:job.id});}
    else if(job.kind==="wrap_up")await applyWrapUpEffects(orgId,callId,payload);
    else if(job.kind==="recording_ingest")await ingestRecording(orgId,callId,payload);
    else if(job.kind==="missed_callback"){
      const call=(await s.readCall(orgId,callId));if(!call.connected_at)await createFollowUpTodo(orgId,{id:s.id("callback",callId),source_key:`missed-call:${callId}`,project_id:call.project_id,branch_id:call.branch_id,title:`Return ${call.customer_name}'s call`,due_at:s.now(),assigned_user_ids:call.owner_user_id?[call.owner_user_id]:[],metadata:{follow_up:{channel:"call",call_id:callId,phone:call.customer_number,contact_id:call.contact_id,completion_policy:"explicit"}}});
    }else throw new Error("Unknown customer-call job");
    (await s.finishJob(text(job.id),workerId,"completed",result));
  }catch(error){
    const ambiguous=job.kind==="provider"&&!(error instanceof PlatformError)&&(error instanceof TelnyxError?object(error.details).submission_unknown===true:true);
    const retry=!ambiguous&&!(error instanceof PlatformError)&&job.kind!=="provider"&&job.attempts<8;
    (await s.finishJob(text(job.id),workerId,ambiguous?"uncertain":retry?"pending":"failed",{},job.kind==='provider'?(ambiguous?'Provider response is uncertain; reconcile before retrying.':error instanceof PlatformError?error.message:'Provider rejected this operation.'):error instanceof Error?error.message:"Call processing failed",Math.min(300_000,1000*2**job.attempts)));
    if(job.kind==="provider"&&callId){let call=(await s.readCall(orgId,callId));
      if(!ambiguous&&payload.path==='dial'){
        if(payload.role==='consult'){
          const customer=(await s.legs(orgId,callId)).find(l=>l.role==='customer'&&l.state!=='ended');if(customer)(await providerCommand(call,text(customer.control_id),'conference_unhold',{},`failed-consult:${job.id}`));
          call=(await s.patchCall(orgId,callId,{metadata:{...call.metadata,transfer:{...object(call.metadata.transfer),state:'failed'}}}));
        }else{(await endCall(call,'PROVIDER_REJECTED'));call=(await s.readCall(orgId,callId));if(!call.connected_at)call=(await s.patchCall(orgId,callId,{state:'failed'}));}
      }
      (await s.patchCall(orgId,callId,{metadata:{...call.metadata,provider_error:{operation_id:job.id,state:ambiguous?"uncertain":"failed",message:"The provider operation needs attention. Check call status before retrying."}}}));
    }
  }
  return true;
}
export async function processOneWebhook(workerId:string){
  const row=(await s.transaction(async db=>{const event=object((await db.prepare("SELECT * FROM customer_voice_webhooks WHERE state='pending' OR (state='running' AND lease_until<?) ORDER BY received_at LIMIT 1").get(s.now())));if(!event.event_id)return null;
    (await db.prepare("UPDATE customer_voice_webhooks SET state='running',attempts=attempts+1,lease_owner=?,lease_until=? WHERE event_id=?").run(workerId,new Date(Date.now()+90_000).toISOString(),text(event.event_id)));return event;}));
  if(!row)return false;
  try{await processVoiceEvent(object(JSON.parse(text(row.body_json))));(await s.database().prepare("UPDATE customer_voice_webhooks SET state='completed',body_json='{}',lease_owner='',lease_until='',error='' WHERE event_id=? AND lease_owner=?").run(text(row.event_id),workerId));}
  catch(error){(await s.database().prepare("UPDATE customer_voice_webhooks SET state=?,lease_until='',lease_owner='',error=? WHERE event_id=? AND lease_owner=?")
    .run(Number(row.attempts)>=7?"failed":"pending",error instanceof Error?error.message:"Event processing failed",text(row.event_id),workerId));}
  return true;
}
export async function routeWaitingCalls(){
  const waiting=(await s.database().prepare("SELECT organization_id,id FROM customer_calls WHERE direction='inbound' AND state='queued' ORDER BY created_at LIMIT 50").all());
  for(const row of waiting){const orgId=text(object(row).organization_id),callId=text(object(row).id);
    (await s.transaction(async ()=>{
      let call=(await s.readCall(orgId,callId));if(call.state!=="queued")return;const settings=(await voiceSettings(orgId));const customer=(await s.legs(orgId,callId)).find(l=>l.role==="customer"&&l.state!=="ended");if(!customer)return;
      const expired=Date.now()-Date.parse(text(call.metadata.queue_entered_at)||call.created_at)>=settings.max_wait_seconds*1000;
      if(!settings.enabled||!businessOpen(settings)||expired||call.metadata.force_voicemail){
        if(!call.metadata.force_voicemail&&settings.enabled&&settings.fallback==="forward"&&settings.overflow_number){(await providerCommand(call,text(customer.control_id),"transfer",{to:settings.overflow_number,from:call.business_number,timeout_secs:settings.ring_seconds,time_limit_secs:settings.max_call_minutes*60,target_leg_client_state:Buffer.from(JSON.stringify({call_id:call.id,role:'forwarded'})).toString('base64')},"overflow-forward"));(await s.patchCall(orgId,callId,{state:"forwarding"}));}
        else{(await s.patchCall(orgId,callId,{state:"voicemail",metadata:{...call.metadata,voicemail:{pending:true}}}));(await providerCommand(call,text(customer.control_id),"speak",{payload:settings.voicemail_greeting,voice:"female",language:"en-US",client_state:Buffer.from(JSON.stringify({call_id:call.id,role:'customer',phase:'voicemail_greeting'})).toString('base64')},"voicemail-greeting"));}
        return;
      }
      const used=strings(call.metadata.attempted_agents);const endpoints: Json[] = [];
      for (const e of await s.resources(orgId, "endpoint")) {
        if (text((await s.resource(orgId,'endpoint_lock',text(e.user_id)))?.expires_at)<=s.now()&&e.registered===true&&e.availability==="available"&&text(e.branch_id||'default')===call.branch_id&&text(e.wrap_until)<=s.now()&&text(e.heartbeat_at)>new Date(Date.now()-45_000).toISOString()&&!used.includes(text(e.user_id))&&(!settings.agent_user_ids.length||settings.agent_user_ids.includes(text(e.user_id)))) endpoints.push(e);
      }
      endpoints.sort((a,b)=>settings.routing==="sequential"?settings.agent_user_ids.indexOf(text(a.user_id))-settings.agent_user_ids.indexOf(text(b.user_id)):text(a.last_call_at).localeCompare(text(b.last_call_at)));
      let agent: Json | undefined;
      for (const candidate of endpoints) {
        if ((await s.listCalls(orgId, { owner_user_id: text(candidate.user_id), active: true })).total === 0) { agent = candidate; break; }
      }
      if (!agent) return;
      call=(await s.patchCall(orgId,callId,{state:"agent_connecting",owner_user_id:text(agent.user_id),metadata:{...call.metadata,attempted_agents:[...used,text(agent.user_id)]}}));
      (await s.saveResource(orgId,"endpoint",text(agent.user_id),{...agent,availability:"busy",last_call_at:s.now()}));(await queueDial(call,"agent",`sip:${text(agent.sip_username)}@sip.telnyx.com`,`ring:${agent.user_id}`));
    }));
  }
}
export function startCallWorker(app:FastifyInstance){
  if (!platformBackgroundAllowed()) return;
  if(process.env.CUSTOMER_CALL_WORKER_DISABLED==="1"||process.env.NODE_ENV==="test")return;
  const workerId=`voice:${process.pid}:${randomUUID()}`;let running=false,stopped=false,lastRetention=0;
  let maintenance:Promise<void>|null=null,activeTick:Promise<void>|null=null,background:Promise<void>|null=null;
  const tick=async()=>{
    if(running||stopped)return;running=true;
    try{
      for(let n=0;n<20&&!stopped;n++)if(!await processOneWebhook(workerId))break;
      (await routeWaitingCalls());
      for(let n=0;n<10&&!stopped;n++)if(!await processOneJob(workerId,'voice'))break;
      if(!background)background=(async()=>{for(let n=0;n<5&&!stopped;n++)if(!await processOneJob(`${workerId}:background`,'background'))break;})()
        .catch(()=>app.log.error('Customer call background processing failed')).finally(()=>{background=null;});
      if(!maintenance&&Date.now()-lastRetention>60000){
        lastRetention=Date.now();maintenance=(async()=>{await maintainVoiceSessions();await expireArtifacts();})()
          .catch(error=>app.log.error({message:error instanceof Error?error.message:'Voice maintenance failed'},'Customer call maintenance'))
          .finally(()=>{maintenance=null;});
      }
    }catch(error){app.log.error({message:error instanceof Error?error.message:"Call worker failed"},"Customer call worker");}
    finally{running=false;}
  };
  const timer=setInterval(()=>{if(!running)activeTick=tick();},1000);timer.unref();
  app.addHook("preClose",async()=>{stopped=true;clearInterval(timer);await Promise.allSettled([activeTick,maintenance,background]);});
}
