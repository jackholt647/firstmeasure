import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasPermission, type PlatformAuthContext } from "../../platform/auth.js";
import { badRequest, conflict, forbidden } from "../../platform/errors.js";
import { findPhoneNumberOwner } from "../../messaging/communications_storage.js";
import { TelnyxError } from '../../messaging/telnyx.js';
import { voiceClient, voiceMode, voiceEnvironmentStatus, requireVoiceEnvironment } from "../../telephony/telnyx.js";
import { voiceSettings, diagnosticVerdict, validateVoiceSettings, updateVoiceSettings } from "./settings.js";
import { requireCallAccess, manageCalls } from "./service.js";
import * as s from "./storage.js";
import { text, object, type Json, type CustomerCall } from "./storage.js";

export async function voiceStatus(ctx:PlatformAuthContext){
  const settings=(await voiceSettings(ctx.orgId));const endpoint=(await s.resource(ctx.orgId,"endpoint",ctx.userId));
  const environment=voiceEnvironmentStatus();
  return {settings,environment:manageCalls(ctx)?environment:{mode:environment.mode,ready:environment.api_key_configured&&environment.webhook_key_configured&&environment.public_https},
    permissions:{manage:manageCalls(ctx),record:hasPermission(ctx,'record_calls|manage_communications|manage_company_settings'),recordings:hasPermission(ctx,'view_call_recordings|manage_communications|manage_company_settings')},
    available_numbers:manageCalls(ctx)?(await s.database().prepare("SELECT phone_number FROM messaging_phone_number_ownership WHERE organization_id=? AND provider_phone_number_id<>''").all(ctx.orgId)).map(row=>text(object(row).phone_number)):[],
    resources:manageCalls(ctx)?[...(await s.resources(ctx.orgId,"application")),...(await s.resources(ctx.orgId,"connection")),...(await s.resources(ctx.orgId,"outbound_profile"))].map(r=>({id:r.id,kind:r.kind,status:r.status,provider_id:r.provider_id})):[],
    numbers:(await s.resources(ctx.orgId,"number")).map(n=>({id:n.id,phone_number:n.phone_number,label:n.label,status:n.status,branch_id:n.branch_id})),
    endpoint:endpoint?{registered:endpoint.registered===true&&text(endpoint.heartbeat_at)>new Date(Date.now()-45_000).toISOString(),availability:endpoint.availability,device_id:endpoint.device_id}:null};
}
/** A lost create response must be reconciled by a deterministic provider name before retry. */
async function ensureProviderResource(orgId:string,kind:string,name:string,path:string,nameField:string,create:()=>Promise<Json>){
  let current=(await s.resource(orgId,kind));
  if(current?.provider_id)return current;
  if(current?.status==="creating"||current?.status==="uncertain"){
    const matches=await voiceClient().findNamed(path,nameField,name);
    if(matches.length===1){const found=matches[0]!;return (await s.saveResource(orgId,kind,"default",{status:"ready",kind,name},text(found.id)));}
    throw conflict("voice_provision_reconciliation","A previous provider request has an uncertain result. Verify the named resource in Telnyx before retrying setup.",{kind,name});
  }
  (await s.transaction(async ()=>{current=(await s.resource(orgId,kind));if(current&&current.status!=='failed')throw conflict("voice_setup_in_progress","Voice setup is already in progress.");(await s.saveResource(orgId,kind,"default",{status:"creating",kind,name}));}));
  try{const created=await create();if(!text(created.id))throw new Error("Provider did not return a resource ID");return (await s.saveResource(orgId,kind,"default",{status:"ready",kind,name},text(created.id)));}
  catch(error){(await s.saveResource(orgId,kind,"default",{status:error instanceof TelnyxError&&object(error.details).submission_unknown!==true?'failed':'uncertain',kind,name}));throw error;}
}
export async function provisionVoice(ctx:PlatformAuthContext){
  requireVoiceEnvironment();const settings=(await voiceSettings(ctx.orgId));const name=`FirstMate ${s.id("org",ctx.orgId)}`;
  const profile=await ensureProviderResource(ctx.orgId,"outbound_profile",`${name} voice`,"/outbound_voice_profiles","name",()=>voiceClient().createOutboundProfile(ctx.orgId,settings.max_concurrent_calls,settings.daily_spend_limit,settings.allowed_destination_countries));
  await ensureProviderResource(ctx.orgId,"application",`${name} customer calls`,"/call_control_applications","application_name",()=>voiceClient().createApplication(ctx.orgId,profile.provider_id));
  await ensureProviderResource(ctx.orgId,"connection",`${name} staff`,"/credential_connections","connection_name",()=>voiceClient().createConnection(ctx.orgId));
  (await s.appendEvent(ctx.orgId,"","voice.provisioned",{actor_user_id:ctx.userId}));return (await voiceStatus(ctx));
}
export async function configureVoice(ctx:PlatformAuthContext,input:unknown){
  const settings=(await validateVoiceSettings(ctx.orgId,input)),lease=randomUUID();
  if(settings.enabled)requireVoiceEnvironment();
  (await s.transaction(async ()=>{
    const lock=(await s.resource(ctx.orgId,'settings_lock'));if(lock&&text(lock.expires_at)>s.now())throw conflict('settings_busy','Another phone settings update is in progress.');
    if(settings.revision!==undefined&&Number((await s.resource(ctx.orgId,'settings'))?.revision||0)!==settings.revision)throw conflict('settings_revision_conflict','Phone settings changed. Refresh before saving.');
    (await s.saveResource(ctx.orgId,'settings_lock','default',{lease,expires_at:new Date(Date.now()+90000).toISOString()}));
  }));
  try{
    const profile=(await s.resource(ctx.orgId,'outbound_profile'));
    if(profile?.provider_id&&voiceMode()==='live'){
      requireVoiceEnvironment();(await s.saveResource(ctx.orgId,'outbound_profile','default',{...profile,status:'sync_pending'}));
      try{await voiceClient().data(`/outbound_voice_profiles/${encodeURIComponent(profile.provider_id)}`,'PATCH',{
        enabled:settings.enabled,concurrent_call_limit:settings.max_concurrent_calls*3,daily_spend_limit:settings.daily_spend_limit,daily_spend_limit_enabled:true,whitelisted_destinations:settings.allowed_destination_countries});}
      catch(error){(await s.saveResource(ctx.orgId,'outbound_profile','default',{...profile,status:'sync_uncertain'}));throw error;}
      (await s.saveResource(ctx.orgId,'outbound_profile','default',{...profile,status:'ready'}));
    }else if(profile?.provider_id)(await s.saveResource(ctx.orgId,'outbound_profile','default',{...profile,status:'sync_required'}));
    const saved=(await updateVoiceSettings(ctx.orgId,settings));(await s.appendEvent(ctx.orgId,'','voice.settings_changed',{actor_user_id:ctx.userId,revision:saved.revision}));return saved;
  }finally{const lock=(await s.resource(ctx.orgId,'settings_lock'));if(lock?.lease===lease)(await s.database().prepare("DELETE FROM customer_voice_resources WHERE organization_id=? AND kind='settings_lock'").run(ctx.orgId));}
}
export const bindNumberSchema=z.object({phone_number:z.string().regex(/^\+[1-9]\d{7,14}$/),label:z.string().max(120).default("Business line"),branch_id:z.string().max(180).default("default"),confirm_routing_change:z.boolean().default(false)});
export async function bindNumber(ctx:PlatformAuthContext,input:unknown){
  requireVoiceEnvironment();const body=bindNumberSchema.parse(input);const owner=(await findPhoneNumberOwner(body.phone_number));
  if(!owner||owner.organization_id!==ctx.orgId||!text(owner.provider_phone_number_id))throw forbidden("number_not_owned","Choose a Telnyx number owned by this organization in SMS setup.");
  const application=(await s.resource(ctx.orgId,"application"));if(!application?.provider_id)throw conflict("voice_provision_required","Prepare your voice resources before connecting a number.");
  const provider=await voiceClient().readNumber(text(owner.provider_phone_number_id));
  if(text(provider.phone_number)!==body.phone_number)throw conflict("number_verification_failed","The provider number does not match the selected business line.");
  const prior=text(provider.connection_id);const already=prior===application.provider_id;
  const saved=(await s.resource(ctx.orgId,'number',body.phone_number));
  // A retry or label edit must retain the route that existed before FirstMate.
  const previous=already&&saved?text(saved.previous_connection_id):already?'':prior;
  if(prior&&!already&&!body.confirm_routing_change)throw conflict("number_route_confirmation","This number already has a voice route. Confirm the routing change to connect it to FirstMate.",{previous_connection_id:prior});
  (await s.saveResource(ctx.orgId,"number",body.phone_number,{...body,status:"binding",previous_connection_id:previous},text(owner.provider_phone_number_id)));
  if(!already)await voiceClient().bindNumber(text(owner.provider_phone_number_id),application.provider_id);
  const verified=await voiceClient().readNumber(text(owner.provider_phone_number_id));
  if(text(verified.connection_id)!==application.provider_id)throw conflict("number_route_pending","The provider has not confirmed the number's voice route yet.");
  (await s.saveResource(ctx.orgId,"number",body.phone_number,{...body,status:"active",previous_connection_id:previous,application_id:application.provider_id},text(owner.provider_phone_number_id)));
  (await s.appendEvent(ctx.orgId,"","voice.number_connected",{phone_number:body.phone_number,actor_user_id:ctx.userId}));return (await voiceStatus(ctx));
}
export async function disconnectNumber(ctx:PlatformAuthContext,phone:string){
  requireVoiceEnvironment();
  const number=(await s.resource(ctx.orgId,"number",phone));if(!number)throw badRequest("number_not_found","That voice line is unavailable.");
  if((await s.listCalls(ctx.orgId,{active:true})).calls.some(c=>c.business_number===phone))throw conflict("number_in_use","Finish active calls before disconnecting this line.");
  const current=await voiceClient().readNumber(text(number.provider_id));
  if(text(current.connection_id)!==text(number.application_id)&&text(current.connection_id)!==text(number.previous_connection_id))throw conflict('number_route_changed','This line was rerouted outside FirstMate. Review its current Telnyx route before disconnecting.');
  await voiceClient().bindNumber(text(number.provider_id),text(number.previous_connection_id));
  const verified=await voiceClient().readNumber(text(number.provider_id));
  if(text(verified.connection_id)!==text(number.previous_connection_id))throw conflict("number_route_pending","The provider has not confirmed that this line is disconnected.");
  return (await s.saveResource(ctx.orgId,"number",phone,{...number,status:"disconnected"}));
}
export async function withEndpointLease<T>(orgId:string,userId:string,action:()=>Promise<T>){
  const lease=randomUUID();(await s.transaction(async ()=>{
    const lock=(await s.resource(orgId,"endpoint_lock",userId));
    if(lock&&text(lock.expires_at)>s.now())throw conflict("endpoint_busy","Your phone is already connecting. Wait a moment and retry.");
    (await s.saveResource(orgId,"endpoint_lock",userId,{lease,expires_at:new Date(Date.now()+90_000).toISOString()}));
  }));
  try{return await action();}finally{
    const lock=(await s.resource(orgId,"endpoint_lock",userId));if(lock?.lease===lease)(await s.database().prepare("DELETE FROM customer_voice_resources WHERE organization_id=? AND kind='endpoint_lock' AND id=?").run(orgId,userId));
  }
}
export async function endpointToken(ctx:PlatformAuthContext,deviceId:string){return withEndpointLease(ctx.orgId,ctx.userId,()=>createEndpointToken(ctx,deviceId));}
async function createEndpointToken(ctx:PlatformAuthContext,deviceId:string){
  requireVoiceEnvironment();const settings=(await voiceSettings(ctx.orgId));if(!settings.enabled)throw conflict("voice_not_enabled","FirstMate phone is not enabled for this organization.");
  const connection=(await s.resource(ctx.orgId,"connection"));if(!connection?.provider_id)throw conflict("voice_setup_required","Complete phone setup first.");
  const current=(await s.resource(ctx.orgId,"endpoint",ctx.userId));
  if(current&&text(current.device_id)!==deviceId&&text(current.heartbeat_at)>new Date(Date.now()-45_000).toISOString())throw conflict("phone_in_another_tab","Your phone is connected in another tab or device. Disconnect it there first.");
  let endpoint=current;
  if(!endpoint?.provider_id||endpoint.session_id!==ctx.sessionId||Date.parse(text(endpoint.credential_expires_at))<Date.now()+settings.max_call_minutes*60000+300_000){
    if(current?.provider_id){
      if((await s.listCalls(ctx.orgId,{owner_user_id:ctx.userId,active:true,include_diagnostics:true})).total)throw conflict('call_in_progress','Finish this call before renewing the phone credential.');
      await voiceClient().revokeCredential(text(current.provider_id));
    }
    const credentialName=`FirstMate ${s.id('user',`${ctx.orgId}:${ctx.userId}:${ctx.sessionId}`)}`;
    const intent=(await s.resource(ctx.orgId,'credential_intent',ctx.userId));let credential:Json;
    if(intent?.status==='uncertain'||intent?.status==='creating'){
      const matches=await voiceClient().findNamed('/telephony_credentials','name',text(intent.name));
      if(matches.length!==1)throw conflict('credential_reconciliation_required','An earlier endpoint request needs provider reconciliation. A manager can inspect Phone setup health.');
      credential=await voiceClient().data(`/telephony_credentials/${encodeURIComponent(text(matches[0]!.id))}`);
    }else{
      (await s.saveResource(ctx.orgId,'credential_intent',ctx.userId,{name:credentialName,status:'creating'}));
      try{credential=await voiceClient().createCredential(connection.provider_id,credentialName);}
      catch(error){(await s.saveResource(ctx.orgId,'credential_intent',ctx.userId,{name:credentialName,status:error instanceof TelnyxError&&object(error.details).submission_unknown!==true?'failed':'uncertain'}));throw error;}
    }
    if(!text(credential.id)||!text(credential.sip_username))throw conflict("endpoint_unavailable","The provider could not create your phone endpoint.");
    // Do not persist the provider's SIP password or return it to the browser.
    endpoint=(await s.saveResource(ctx.orgId,"endpoint",ctx.userId,{user_id:ctx.userId,branch_id:ctx.branchId||"default",name:text(ctx.user.name||ctx.identity.name),device_id:deviceId,session_id:ctx.sessionId,
      sip_username:text(credential.sip_username),credential_expires_at:text(credential.expires_at)||new Date(Date.now()+24*3600_000).toISOString(),registered:false,availability:"unavailable",heartbeat_at:s.now()},text(credential.id)));
    (await s.saveResource(ctx.orgId,'credential_intent',ctx.userId,{name:credentialName,status:'ready',credential_id:credential.id}));
  }
  if(endpoint.device_id!==deviceId)endpoint=(await s.saveResource(ctx.orgId,'endpoint',ctx.userId,{...endpoint,device_id:deviceId,registered:false,availability:'unavailable',heartbeat_at:s.now()}));
  const token=await voiceClient().token(text(endpoint.provider_id));return {...token,user_id:ctx.userId,device_id:deviceId};
}
export async function presence(ctx:PlatformAuthContext,input:Json){
  const endpoint=(await s.resource(ctx.orgId,"endpoint",ctx.userId));
  if(!endpoint||endpoint.device_id!==input.device_id||endpoint.session_id!==ctx.sessionId)throw conflict("phone_owner_changed","This browser no longer owns your phone session.");
  if(text((await s.resource(ctx.orgId,'endpoint_lock',ctx.userId))?.expires_at)>s.now())return {...endpoint,registered:false,availability:'unavailable'};
  let offered=false;if(text(endpoint.offered_call_id)){try{const call=(await s.readCall(ctx.orgId,text(endpoint.offered_call_id)));offered=!s.terminal.has(call.state)&&text(object(call.metadata.transfer).target_user_id)===ctx.userId&&['dialing','consulting'].includes(text(object(call.metadata.transfer).state));}catch{}}
  const active=offered||(await s.listCalls(ctx.orgId,{owner_user_id:ctx.userId,active:true,include_diagnostics:true})).total>0;
  const availability=input.registered===true&&!active&&input.availability==="available"?"available":active?"busy":"unavailable";
  return (await s.saveResource(ctx.orgId,"endpoint",ctx.userId,{...endpoint,offered_call_id:offered?endpoint.offered_call_id:'',registered:input.registered===true,availability,heartbeat_at:s.now()}));
}
export async function disconnectEndpoint(ctx:PlatformAuthContext,deviceId:string){
  return withEndpointLease(ctx.orgId,ctx.userId,async()=>{
  const endpoint=(await s.resource(ctx.orgId,"endpoint",ctx.userId));if(!endpoint||endpoint.device_id!==deviceId||endpoint.session_id!==ctx.sessionId)return;
  if((await s.listCalls(ctx.orgId,{owner_user_id:ctx.userId,active:true,include_diagnostics:true})).total)throw conflict("call_in_progress","End or transfer the active call before disconnecting your phone.");
  (await s.saveResource(ctx.orgId,'endpoint',ctx.userId,{...endpoint,registered:false,availability:'unavailable'}));
  if(endpoint.provider_id)await voiceClient().revokeCredential(text(endpoint.provider_id));
  (await s.database().prepare("DELETE FROM customer_voice_resources WHERE organization_id=? AND kind='endpoint' AND id=?").run(ctx.orgId,ctx.userId));
  });
}
export async function saveDiagnostic(ctx:PlatformAuthContext,input:Json){
  const endpoint=(await s.resource(ctx.orgId,'endpoint',ctx.userId));
  if(!endpoint||endpoint.device_id!==input.device_id||endpoint.session_id!==ctx.sessionId)throw conflict('phone_owner_changed','Connect this browser before saving a device check.');
  const verdict=diagnosticVerdict(input);return (await s.saveResource(ctx.orgId,"diagnostic",`${ctx.userId}:${text(input.device_id)}`,{
    ...verdict,microphone:text(input.microphone),connectivity:text(input.connectivity),provider_verdict:text(input.provider_verdict),metrics:object(input.metrics),device_id:text(input.device_id)}));
}
export async function startDiagnostic(ctx:PlatformAuthContext,deviceId:string){
  requireVoiceEnvironment();const endpoint=(await s.resource(ctx.orgId,"endpoint",ctx.userId)),app=(await s.resource(ctx.orgId,"application"));
  if(!endpoint?.provider_id||!app?.provider_id||endpoint.session_id!==ctx.sessionId||endpoint.device_id!==deviceId||endpoint.registered!==true||text(endpoint.heartbeat_at)<new Date(Date.now()-45000).toISOString())throw conflict("phone_not_ready","Connect your browser phone first.");
  return (await s.transaction(async ()=>{
    const active=(await s.listCalls(ctx.orgId,{active:true,include_diagnostics:true}));
    if(active.calls.some(c=>c.owner_user_id===ctx.userId))throw conflict("call_in_progress","Run the device check between calls.");
    const recent=Number(object((await s.database().prepare("SELECT count(*) AS n FROM customer_calls WHERE organization_id=? AND mode='diagnostic' AND created_at>?").get(ctx.orgId,new Date(Date.now()-86400000).toISOString()))).n);
    if(recent>=50)throw conflict("diagnostic_daily_limit","The organization has reached today's device-check limit.");
    const number=(await s.resources(ctx.orgId,"number")).find(n=>n.status==='active');if(!number)throw conflict("voice_number_required","Connect a business number first.");
    const call=(await s.insertCall({id:s.id("check"),organization_id:ctx.orgId,branch_id:ctx.branchId||"default",owner_user_id:ctx.userId,mode:"diagnostic",direction:"outbound",state:"agent_connecting",business_number:text(number.phone_number),customer_name:"Device readiness check",metadata:{device_id:deviceId,diagnostic:true}}));
    (await s.enqueue(ctx.orgId,call.id,"provider",{path:"dial",role:"agent",payload:{connection_id:app.provider_id,to:`sip:${text(endpoint.sip_username)}@sip.telnyx.com`,from:number.phone_number,timeout_secs:15,time_limit_secs:25,
      client_state:Buffer.from(JSON.stringify({call_id:call.id,role:"agent"})).toString("base64"),custom_headers:[{name:"X-FirstMate-Call",value:call.id}]}},`${call.id}:diagnostic`));
    return {call_id:call.id};
  }));
}
export async function providerCommand(call:CustomerCall,controlId:string,action:string,payload:Json={},key:string=randomUUID()){
  return (await s.enqueue(call.organization_id,call.id,"provider",{path:action,control_id:controlId,payload},`${call.id}:${key}`));
}
export const callActionSchema=z.object({operation_id:z.string().min(8).max(180),action:z.enum(["hangup","hold","resume","dtmf","consent","record_start","record_stop","record_pause","record_resume","transfer","transfer_cancel","transfer_complete","accept","decline"]),
  digits:z.string().regex(/^[0-9*#wW]{1,32}$/).optional(),consent:z.enum(["granted","refused","withdrawn"]).optional(),target_user_id:z.string().max(180).optional(),transfer_mode:z.enum(["warm","cold"]).default("warm")});
export async function callAction(ctx:PlatformAuthContext,callId:string,input:unknown){
  const body=callActionSchema.parse(input);const call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,callId)));
  const consultation=text(object(call.metadata.transfer).target_user_id)===ctx.userId&&call.owner_user_id!==ctx.userId&&['dialing','consulting'].includes(text(object(call.metadata.transfer).state));
  if(consultation&&['accept','decline','hangup'].includes(body.action)){
    const leg=(await s.legs(ctx.orgId,callId)).find(l=>l.role==='consult'&&l.state!=='ended');if(!leg)throw conflict('consult_not_ready','The consultation is still connecting.');
    (await s.transaction(async ()=>{const op=(await s.operation(ctx.orgId,'action',body.operation_id,call.id,{...body,actor:ctx.userId}));if(!op.existing){(await providerCommand(call,text(leg.control_id),body.action==='accept'?'answer':'hangup',{},op.id));(await s.finishOperation(ctx.orgId,op.id,{call_id:call.id}));}}));return {call};
  }
  requireCallAccess(ctx,call,true);
  if(call.mode==='diagnostic'&&body.action!=='hangup')throw conflict("diagnostic_controls","Only ending the check is supported.");
  if(!['browser','diagnostic'].includes(call.mode))throw conflict("external_call_controls","External-phone calls do not have browser call controls.");
  if(s.terminal.has(call.state))return {call};
  const callLegs=(await s.legs(ctx.orgId,call.id));const customer=callLegs.find(l=>l.role==="customer"&&l.state!=="ended");
  const agent=callLegs.find(l=>l.role==="agent"&&l.state!=="ended");
  return (await s.transaction(async ()=>{
    const op=(await s.operation(ctx.orgId,"action",body.operation_id,call.id,{...body,actor:ctx.userId}));if(op.existing)return {call:(await s.readCall(ctx.orgId,call.id))};
    const send=async (leg:Json|undefined,action:string,payload:Json={},suffix=action)=>{if(!leg?.control_id)throw conflict("call_leg_not_ready","The call is still connecting. Try again in a moment.");return (await providerCommand(call,text(leg.control_id),action,payload,`${op.id}:${suffix}`));};
    let updated=call;
    if(body.action==="hangup"||body.action==="decline"){
      if(body.action==="decline"&&call.direction==="inbound"&&!call.connected_at){
        (await send(agent,"hangup",{},`decline:${agent?.id}`));
        updated=(await s.patchCall(ctx.orgId,call.id,{metadata:{...call.metadata,declined_by:ctx.userId}}));
        (await s.finishOperation(ctx.orgId,op.id,{call_id:call.id}));return {call:updated};
      }
      updated=(await s.patchCall(ctx.orgId,call.id,{state:"ending",metadata:{...call.metadata,canceled_at:s.now()}}));
      for(const leg of callLegs.filter(l=>l.state!=="ended"))(await send(leg,"hangup",{},`hangup:${leg.id}`));
      if(!callLegs.length)updated=(await s.patchCall(ctx.orgId,call.id,{state:"canceled",ended_at:s.now(),wrap_up_state:"needs_wrap_up"}));
    }else if(body.action==="accept")(await send(agent,"answer"));
    else if(body.action==="hold"||body.action==="resume")(await send(customer,body.action==="hold"?"conference_hold":"conference_unhold",{},body.action));
    else if(body.action==="dtmf"){if(!body.digits)throw badRequest("digits_required","Enter keypad digits.");(await send(customer,"send_dtmf",{digits:body.digits}));}
    else if(body.action==="consent"){
      if(!body.consent)throw badRequest("consent_required","Record whether the caller agreed to recording.");
      updated=(await s.patchCall(ctx.orgId,call.id,{metadata:{...call.metadata,consent:{state:body.consent,at:s.now(),actor_user_id:ctx.userId,disclosure:text(object(call.metadata.policy).disclosure)}}}));
      if(body.consent!=="granted"&&['recording','paused','pending'].includes(text(object(call.metadata.capture).state)))(await send(customer,"record_stop"));
    }else if(body.action.startsWith("record_")){
      const settings=(await voiceSettings(ctx.orgId));
      if(['record_start','record_resume'].includes(body.action)&&(!settings.recording_enabled||!settings.recording_policy_confirmed))throw forbidden("recording_not_enabled","Recording is not enabled for this organization.");
      if(["record_start","record_resume"].includes(body.action)&&object(call.metadata.consent).state!=="granted")throw conflict("recording_consent_required","Confirm the caller's permission before recording.");
      if(!["connected","held"].includes(call.state))throw conflict("call_not_connected","Recording is available once the call is connected.");
      (await send(customer,body.action,body.action==="record_start"?{format:"mp3",channels:"dual",play_beep:true,transcription:settings.transcription_enabled,max_length:settings.max_call_minutes*60}:{}));
      updated=(await s.patchCall(ctx.orgId,call.id,{metadata:{...call.metadata,capture:{state:"pending",action:body.action,requested_at:s.now()}}}));
    }else if(body.action==="transfer"){
      if(!customer||!agent)throw conflict("call_not_connected","Connect the call before transferring it.");
      if(['dialing','consulting'].includes(text(object(call.metadata.transfer).state)))throw conflict("transfer_in_progress","Finish or cancel the current transfer first.");
      const target=(await s.resource(ctx.orgId,"endpoint",text(body.target_user_id)));
      if(!target||target.registered!==true||target.availability!=="available"||text(target.branch_id||'default')!==call.branch_id||text(target.heartbeat_at)<new Date(Date.now()-45_000).toISOString())throw conflict("transfer_target_unavailable","Choose an available teammate in this branch.");
      if(body.target_user_id===ctx.userId)throw badRequest("transfer_self","Choose another teammate.");
      (await s.saveResource(ctx.orgId,'endpoint',text(body.target_user_id),{...target,offered_call_id:call.id,availability:'busy',last_call_at:s.now()}));
      (await send(customer,"conference_hold"));
      updated=(await s.patchCall(ctx.orgId,call.id,{metadata:{...call.metadata,transfer:{state:"dialing",mode:body.transfer_mode,target_user_id:body.target_user_id,started_at:s.now()}}}));
      const app=(await s.resource(ctx.orgId,"application"))!;
      const consultJob=(await s.enqueue(ctx.orgId,call.id,"provider",{path:"dial",role:"consult",payload:{connection_id:app.provider_id,to:`sip:${text(target.sip_username)}@sip.telnyx.com`,from:call.business_number,
        client_state:Buffer.from(JSON.stringify({call_id:call.id,role:"consult"})).toString("base64"),custom_headers:[{name:'X-FirstMate-Call',value:call.id}],time_limit_secs:(await voiceSettings(ctx.orgId)).max_call_minutes*60,timeout_secs:(await voiceSettings(ctx.orgId)).ring_seconds}},`${op.id}:consult`));
      updated=(await s.patchCall(ctx.orgId,call.id,{metadata:{...updated.metadata,transfer:{...object(updated.metadata.transfer),job_id:consultJob}}}));
    }else if(body.action==="transfer_cancel"){
      const consult=callLegs.find(l=>l.role==="consult"&&l.state!=="ended");if(consult)(await send(consult,"hangup"));(await send(customer,"conference_unhold"));
      updated=(await s.patchCall(ctx.orgId,call.id,{metadata:{...call.metadata,transfer:{...object(call.metadata.transfer),state:"canceled"}}}));
      const targetId=text(object(call.metadata.transfer).target_user_id),endpoint=(await s.resource(ctx.orgId,'endpoint',targetId));if(endpoint)(await s.saveResource(ctx.orgId,'endpoint',targetId,{...endpoint,offered_call_id:'',availability:'unavailable'}));
    }else if(body.action==="transfer_complete"){
      const consult=callLegs.find(l=>l.role==="consult"&&l.state==="answered");if(!consult)throw conflict("transfer_not_ready","Wait for your teammate to answer before completing the transfer.");
      (await send(customer,"conference_unhold"));(await send(agent,"hangup"));
      (await s.database().prepare("UPDATE customer_call_legs SET role='transferred_agent' WHERE organization_id=? AND call_id=? AND role='agent'").run(ctx.orgId,call.id));
      (await s.database().prepare("UPDATE customer_call_legs SET role='agent' WHERE organization_id=? AND call_id=? AND control_id=?").run(ctx.orgId,call.id,text(consult.control_id)));
      updated=(await s.patchCall(ctx.orgId,call.id,{owner_user_id:text(object(call.metadata.transfer).target_user_id),metadata:{...call.metadata,transfer:{...object(call.metadata.transfer),state:"completed"}}}));
    }
    (await s.appendEvent(ctx.orgId,call.id,`communication.call.action.${body.action}`,{actor_user_id:ctx.userId},op.id));
    (await s.finishOperation(ctx.orgId,op.id,{call_id:call.id}));return {call:updated};
  }));
}
