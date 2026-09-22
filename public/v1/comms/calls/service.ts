import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasPermission, type PlatformAuthContext } from "../../platform/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../../platform/errors.js";
import { listDocuments, readDocument } from "../../platform/storage.js";
import { callListQueue, ensureCallListDatabase, recordCallListDisposition } from "../../internal/crm/call_lists.js";
import { withLeadDb } from "../../internal/crm/leads.js";
import { listNodeRecords, readNodeRecord } from "../../work/storage.js";
import { createFollowUpTodo, isFollowUpWorkNode, resolveFollowUpOutcome } from "../../work/followups.js";
import { patchWorkNode, transitionWorkNode } from "../../work/service.js";
import { emitWorkEvent } from "../../work/engine.js";
import { requireVoiceEnvironment, voiceWebhookUrl } from "../../telephony/telnyx.js";
import { normalizePhone, voiceSettings } from "./settings.js";
import { followUpOptions } from './follow-up-policy.js';
import * as store from "./storage.js";
import { text, object, strings, type Json, type CustomerCall } from "./storage.js";

export const manageCalls=(ctx:PlatformAuthContext)=>hasPermission(ctx,"manage_communications|manage_company_settings");
export function requireCallAccess(ctx:PlatformAuthContext,call:CustomerCall,write=false){
  if(call.organization_id!==ctx.orgId)throw notFound("call_not_found","This call is unavailable.");
  if(!manageCalls(ctx)&&call.branch_id!==(ctx.branchId||"default"))throw forbidden("call_branch_forbidden","This call belongs to another branch.");
  if(write&&call.owner_user_id&&call.owner_user_id!==ctx.userId&&!manageCalls(ctx))throw forbidden("call_owner_required","Only the call owner or a communications manager can change this call.");
  return call;
}
export async function projectContext(ctx:PlatformAuthContext,projectId:string):Promise<(Json & {id:string})|null>{
  if(!projectId)return null;
  const doc=await readDocument(ctx.orgId,"projects",projectId);const data=object(doc.data);
  if(!manageCalls(ctx)&&text(data.branch_id||"default")!==(ctx.branchId||"default"))throw forbidden("project_branch_forbidden","This project belongs to another branch.");
  return {id:doc.id,...data};
}
export async function callContext(ctx:PlatformAuthContext,filter:Json={}){
  const query=text(filter.query).toLowerCase();
  const docs=text(filter.project_id)?[await readDocument(ctx.orgId,'projects',text(filter.project_id))]:await listDocuments(ctx.orgId,'projects');
  const projects=docs.map(doc=>({id:doc.id,...object(doc.data)} as Json & {id:string})).filter(p=>manageCalls(ctx)||text(p.branch_id||'default')===(ctx.branchId||'default'))
    .map(p=>({id:p.id,title:text(p.title||p.name||p.address)||p.id,branch_id:text(p.branch_id||'default'),contacts:(Array.isArray(p.contacts)?p.contacts:[]).map(object).map(c=>({id:text(c.id||c.contact_id),name:text(c.name),phone:text(c.phone||c.phone_number||c.mobile),primary:c.primary===true})),
      appointments:(Array.isArray(p.events)?p.events:[]).map(object).filter(e=>!['canceled','deleted'].includes(text(e.status))).map(e=>({id:text(e.id),title:text(e.title||e.name),start:text(e.start||e.start_at||e.date)}))}))
    .filter(p=>!query||`${p.title} ${p.contacts.map(c=>c.name).join(' ')}`.toLowerCase().includes(query)).slice(0,30);
  return {projects};
}
export function callListViewer(ctx:PlatformAuthContext){return {user_id:ctx.userId,user_ids:[ctx.userId],role_ids:[ctx.role,...strings(ctx.user.role_ids)],branch_id:ctx.branchId||"default",include_all:manageCalls(ctx)};}
export interface QueueTask extends Json {id:string;project_id:string;work_node_id:string;phone:string;name:string;title:string;updated_at:string;blocked_reason:string;ready:boolean;}
export async function queues(ctx:PlatformAuthContext){
  const result=await callListQueue(ctx.orgId,callListViewer(ctx));
  return {...result,columns:(await Promise.all(result.columns.map(async list=>({...list,tasks:(await Promise.all(list.tasks.filter(task=>manageCalls(ctx)||text(object(task.project).branch_id||"default")===(ctx.branchId||"default")).map(async task=>{
    const calls=(await store.listCalls(ctx.orgId,{entry_id:task.id,limit:1}));const phone=text(task.phone);let reason="";
    if(!phone)reason="Missing phone number";
    else{try{if((await store.resource(ctx.orgId,"suppression",normalizePhone(phone))))reason="Do not call";}catch{reason="Invalid phone number";}}
    if(!reason&&text(task.due_at).includes("T")&&Date.parse(text(task.due_at))>Date.now())reason="Not due yet";
    const claim=object((await store.database().prepare("SELECT owner_user_id,expires_at FROM customer_call_claims WHERE organization_id=? AND resource=?").get(ctx.orgId,`entry:${task.id}`)));
    if(!reason&&claim.owner_user_id!==ctx.userId&&text(claim.expires_at)>store.now())reason="In progress with another caller";
    return {...task,blocked_reason:reason,ready:!reason,attempt_count:calls.total,last_attempt:calls.calls[0]||null} as QueueTask;
  })))}))))};
}
export async function readEntry(ctx:PlatformAuthContext,entryId:string){
  const queue=await queues(ctx);const column=queue.columns.find(c=>c.tasks.some(t=>t.id===entryId));
  const entry=column?.tasks.find(t=>t.id===entryId);
  if(!entry)throw notFound("call_entry_unavailable","This call-list entry is unavailable or already completed.");
  return {entry,column:column!};
}
export const createCallSchema=z.object({
  operation_id:z.string().min(8).max(180),mode:z.enum(["external","browser"]).default("external"),direction:z.enum(["outbound","inbound"]).default("outbound"),
  project_id:z.string().max(180).default(""),contact_id:z.string().max(180).default(""),entry_id:z.string().max(180).default(""),
  customer_number:z.string().max(40).default(""),customer_name:z.string().max(250).default(""),business_number:z.string().max(40).default(""),
  purpose:z.string().max(500).default(""),script_id:z.string().max(180).default(""),device_id:z.string().max(180).default(""),
  source_node_ids:z.array(z.string().min(1).max(180)).max(30).default([]),
  entity:z.object({type:z.string().max(80),id:z.string().max(180)}).optional()
});
export async function createCall(ctx:PlatformAuthContext,input:unknown){
  const body=createCallSchema.parse(input);const callId=store.id("call",`${ctx.orgId}:${ctx.userId}:${body.operation_id}`);
  // Fast retry path before queue state can change underneath an accepted request.
  const existing=object((await store.database().prepare("SELECT id,payload_hash FROM customer_call_operations WHERE id=?").get(store.id("cop",`${ctx.orgId}:create:${body.operation_id}`))));
  if(existing.id){const op=(await store.operation(ctx.orgId,"create",body.operation_id,callId,{...body,actor:ctx.userId}));const accepted=(await store.readCall(ctx.orgId,text(op.response.call_id)||callId));return requireCallAccess(ctx,accepted,true);}
  const linked=body.entry_id?await readEntry(ctx,body.entry_id):null;
  if(linked?.entry.blocked_reason&&!(body.customer_number&&['Missing phone number','Invalid phone number'].includes(linked.entry.blocked_reason)))throw conflict("call_entry_blocked",linked.entry.blocked_reason);
  const projectId=linked?.entry.project_id||body.project_id;
  const project=await projectContext(ctx,projectId);const contacts=Array.isArray(project?.contacts)?project.contacts.map(object):[];
  if(body.contact_id&&!contacts.some(c=>text(c.id||c.contact_id)===body.contact_id)){
    const contact=await readDocument(ctx.orgId,'contacts',body.contact_id);if(!manageCalls(ctx)&&text(object(contact.data).branch_id||'default')!==(ctx.branchId||'default'))throw forbidden('contact_branch_forbidden','This contact belongs to another branch.');
  }
  for(const nodeId of body.source_node_ids){const node=(await readNodeRecord(ctx.orgId,nodeId));
    if(!node||text(node.project_id)!==projectId||(!manageCalls(ctx)&&(text(node.branch_id||'default')!==(ctx.branchId||'default')||(strings(node.assigned_user_ids).length&&!strings(node.assigned_user_ids).includes(ctx.userId)))))throw forbidden('source_work_forbidden','This task cannot be attached to your call.');
  }
  const contact=contacts.find(c=>body.contact_id&&text(c.id||c.contact_id)===body.contact_id)||contacts.find(c=>c.primary===true)||contacts[0]||{};
  const phone=normalizePhone(body.customer_number||linked?.entry.phone||contact.phone||contact.phone_number||contact.mobile);
  const suppression=(await store.resource(ctx.orgId,"suppression",phone));
  if(body.direction==="outbound"&&suppression)throw conflict("number_suppressed","This contact has requested no phone calls.");
  const settings=(await voiceSettings(ctx.orgId));let line:Json|undefined;
  if(body.mode==="browser"){
    if(body.direction!=="outbound")throw badRequest("inbound_provider_owned","Incoming phone calls are created by the provider.");
    requireVoiceEnvironment();
    const profile=(await store.resource(ctx.orgId,'outbound_profile'));
    if(profile&&profile.status!=='ready')throw conflict('voice_policy_pending','The provider calling policy is still being updated. Check Phone setup before calling.');
    if(!settings.enabled)throw conflict("voice_not_enabled","Enable FirstMate phone in Phone setup before calling.");
    if(!settings.allowed_country_prefixes.some(p=>phone.startsWith(p)))throw forbidden("destination_not_allowed","This destination is outside your enabled calling regions.");
    if(/^\+1(900|976)/.test(phone))throw forbidden("destination_not_allowed","Premium-rate destinations are not supported.");
    line=(await store.resources(ctx.orgId,"number")).find(n=>n.status==="active"&&text(n.branch_id||'default')===text(project?.branch_id||ctx.branchId||'default')&&(!body.business_number||n.phone_number===body.business_number));
    if(!line)throw conflict("business_line_unavailable","Choose a connected business line.");
    const endpoint=(await store.resource(ctx.orgId,"endpoint",ctx.userId));
    if(text((await store.resource(ctx.orgId,'endpoint_lock',ctx.userId))?.expires_at)>store.now())throw conflict('phone_reconnecting','Wait for your phone connection change to finish.');
    if(!endpoint||endpoint.session_id!==ctx.sessionId||endpoint.device_id!==body.device_id||text(endpoint.heartbeat_at)<new Date(Date.now()-45_000).toISOString()||endpoint.registered!==true)throw conflict("phone_not_ready","Connect this browser's phone before calling.");
    if(Date.parse(text(endpoint.credential_expires_at))<Date.now()+settings.max_call_minutes*60000+60000)throw conflict('phone_refresh_required','Reconnect your phone so its credential lasts through the call.');
    const diagnostic=(await store.resource(ctx.orgId,"diagnostic",`${ctx.userId}:${body.device_id}`));
    if(!diagnostic||!['ready','degraded'].includes(text(diagnostic.verdict))||text(diagnostic.updated_at)<new Date(Date.now()-24*3600_000).toISOString())throw conflict("device_check_required","Run the microphone and network check before your first call on this device.");
  }
  return (await store.transaction(async ()=>{
    const op=(await store.operation(ctx.orgId,"create",body.operation_id,callId,{...body,actor:ctx.userId}));
    if(op.existing)return (await store.readCall(ctx.orgId,callId));
    if(body.mode==="browser"){
      const active=(await store.listCalls(ctx.orgId,{active:true,limit:200}));
      if(active.total>=settings.max_concurrent_calls)throw conflict("voice_capacity","All phone lines are busy. Try again shortly.");
      if(active.calls.some(c=>c.owner_user_id===ctx.userId||c.customer_number===phone))throw conflict("call_in_progress","You or this customer already have an active call.");
      const daily=object((await store.database().prepare("SELECT count(*) AS total FROM customer_calls WHERE organization_id=? AND mode='browser' AND created_at>=?").get(ctx.orgId,new Date(Date.now()-86400_000).toISOString())));
      if(Number(daily.total)>=settings.daily_call_limit)throw conflict("voice_daily_limit","Your daily call limit has been reached.");
    }
    if(body.entry_id)(await store.claimResource(ctx.orgId,`entry:${body.entry_id}`,ctx.userId,callId));
    (await store.claimResource(ctx.orgId,`phone:${phone}`,ctx.userId,callId));
    const script=body.script_id?(await publishedScript(ctx.orgId,body.script_id)):null;
    const call=(await store.insertCall({id:callId,organization_id:ctx.orgId,branch_id:text(project?.branch_id)||ctx.branchId||"default",project_id:projectId,
      contact_id:body.contact_id||text(contact.id||contact.contact_id),owner_user_id:ctx.userId,mode:body.mode,direction:body.direction,
      customer_number:phone,customer_name:body.customer_name||linked?.entry.name||text(contact.name)||phone,business_number:text(line?.phone_number),entry_id:body.entry_id,
      state:body.mode==="browser"?"agent_connecting":"created",metadata:{purpose:body.purpose||linked?.entry.title||"Customer call",entity:body.entity,
        script:script||{},list_settings:linked?.column.settings||{},device_id:body.device_id,source_node_ids:[...new Set([...body.source_node_ids,...(linked?(strings(linked.entry.work_node_ids).length?strings(linked.entry.work_node_ids):linked.entry.work_node_id?[linked.entry.work_node_id]:[]):[])])],entry_updated_at:linked?.entry.updated_at,
        policy:{recording_enabled:settings.recording_enabled,transcription_enabled:settings.transcription_enabled,disclosure:settings.disclosure,retention_days:settings.recording_retention_days},
        consent:{state:"not_requested"},actor_email:text(ctx.identity.email),actor_name:text(ctx.user.name||ctx.identity.name)}}));
    (await store.appendEvent(ctx.orgId,call.id,"communication.call.created",{},`${call.id}:created`));
    if(body.mode==="browser"){
      const endpoint=(await store.resource(ctx.orgId,"endpoint",ctx.userId))!;const app=(await store.resource(ctx.orgId,"application"))!;
      (await store.enqueue(ctx.orgId,call.id,"provider",{path:"dial",role:"agent",payload:{connection_id:app.provider_id,to:`sip:${text(endpoint.sip_username)}@sip.telnyx.com`,from:line!.phone_number,
        webhook_url:voiceWebhookUrl(),client_state:Buffer.from(JSON.stringify({call_id:call.id,role:"agent"})).toString("base64"),
        timeout_secs:settings.ring_seconds,time_limit_secs:settings.max_call_minutes*60,custom_headers:[{name:"X-FirstMate-Call",value:call.id}]}},`${call.id}:dial-agent`));
    }
    (await store.finishOperation(ctx.orgId,op.id,{call_id:call.id}));return call;
  }));
}

export const draftSchema=z.object({revision:z.number().int().positive(),notes:z.string().max(100000),script_answers:z.record(z.string(),z.unknown()).optional(),script_id:z.string().max(180).optional()});
export async function saveDraft(ctx:PlatformAuthContext,callId:string,input:unknown){
  const body=draftSchema.parse(input);const call=requireCallAccess(ctx,(await store.readCall(ctx.orgId,callId)),true);
  const script=body.script_id?(await publishedScript(ctx.orgId,body.script_id)):call.metadata.script;
  return (await store.patchCall(ctx.orgId,callId,{notes:body.notes,metadata:{...call.metadata,script,script_answers:body.script_answers||call.metadata.script_answers}},body.revision));
}
export const wrapUpSchema=z.object({operation_id:z.string().min(8).max(180),revision:z.number().int().positive(),
  disposition:z.enum(["answered","voicemail","no_answer","busy","wrong_number","callback","do_not_call","technical_failure"]),
  notes:z.string().max(100000).default(""),next_action:z.enum(["none","complete","follow_up","scheduled"]).default("none"),
  due_at:z.string().max(100).default(""),timezone:z.string().max(100).default(""),channel:z.enum(["call","email","sms"]).default("call"),
  assigned_user_id:z.string().max(180).default(""),appointment_id:z.string().max(180).default(""),source_node_ids:z.array(z.string().max(180)).max(30).default([]),
  title:z.string().max(500).default(""),use_policy:z.boolean().default(false),outcome_id:z.string().max(180).default('')});
export async function saveWrapUp(ctx:PlatformAuthContext,callId:string,input:unknown){
  const body=wrapUpSchema.parse(input);const call=requireCallAccess(ctx,(await store.readCall(ctx.orgId,callId)),true);
  const {revision:_,...intent}=body;
  const prior=(await store.existingOperation(ctx.orgId,'wrap',body.operation_id,call.id,{...intent,actor:ctx.userId}));
  if(prior)return {call,operation_id:prior.id};
  let configuredOutcome:Json|undefined;
  if(body.outcome_id){
    const outcome=(await followUpOptions(call)).outcomes.find(o=>o.id===body.outcome_id);
    if(!outcome||!['lost'].includes(text(outcome.action)))throw badRequest('outcome_invalid','Choose a supported configured outcome.');
    if(body.next_action!=='complete'||!body.source_node_ids.length||(await Promise.all(body.source_node_ids.map(async id=>!isFollowUpWorkNode(await readNodeRecord(ctx.orgId,id))))).some(Boolean))throw badRequest('outcome_work_required','Select the follow-up work this outcome resolves.');
    configuredOutcome=outcome;
  }
  const policy=body.next_action==='follow_up'&&body.use_policy?(await followUpOptions(call)).suggestions[['voicemail','no_answer'].includes(body.disposition)?body.disposition:'manual_follow_up']:undefined;
  if(policy&&!body.due_at)body.due_at=text(policy.due_at);
  if(call.mode==="browser"&&!store.terminal.has(call.state))throw conflict("call_still_active","End the phone call before saving its outcome.");
  if(body.next_action==="follow_up"&&(!body.due_at||!Number.isFinite(Date.parse(body.due_at))))throw badRequest("follow_up_due_required","Choose a due date for this follow-up.");
  if(body.timezone){try{new Intl.DateTimeFormat("en",{timeZone:body.timezone});}catch{throw badRequest("timezone_invalid","Choose a valid timezone.");}}
  if(body.assigned_user_id&&body.assigned_user_id!==ctx.userId&&!manageCalls(ctx))throw forbidden("assignment_forbidden","A manager must assign callbacks to other staff.");
  if(body.assigned_user_id)await readDocument(ctx.orgId,"users",body.assigned_user_id);
  for(const nodeId of body.source_node_ids){const node=(await readNodeRecord(ctx.orgId,nodeId));if(!node||text(node.project_id)!==call.project_id||!strings(call.metadata.source_node_ids).includes(nodeId))throw badRequest("source_work_mismatch","Choose an obligation linked to this call.");}
  if(body.next_action==="scheduled"){
    const project=await projectContext(ctx,call.project_id);const events=Array.isArray(project?.events)?project.events.map(object):[];
    if(!body.appointment_id||!events.some(e=>text(e.id)===body.appointment_id&&!['canceled','deleted'].includes(text(e.status))))throw conflict("appointment_required","Select the appointment booked for this call.");
  }
  return (await store.transaction(async ()=>{
    // Revisions protect the first write; transport retries may observe a newer revision.
    const op=(await store.operation(ctx.orgId,"wrap",body.operation_id,call.id,{...intent,actor:ctx.userId}));
    if(op.existing)return {call:(await store.readCall(ctx.orgId,call.id)),operation_id:op.id};
    if(call.wrap_up_state!=="draft"&&call.wrap_up_state!=="needs_wrap_up")throw conflict("call_already_saved","This call already has a saved outcome. Edit its note without submitting another outcome.");
    const updated=(await store.patchCall(ctx.orgId,call.id,{notes:body.notes,state:call.mode==="external"?"ended":call.state,ended_at:call.ended_at||store.now(),wrap_up_state:"processing_effects",
      result:{...body,actor_user_id:ctx.userId},metadata:{...call.metadata,wrap_operation_id:op.id}},body.revision));
    if(body.disposition==="do_not_call")(await store.saveResource(ctx.orgId,"suppression",call.customer_number,{reason:"customer_request",actor_user_id:ctx.userId,call_id:call.id}));
    (await store.enqueue(ctx.orgId,call.id,"wrap_up",{...body,policy,configured_outcome:configuredOutcome,operation_id:op.id,actor_user_id:ctx.userId},`${op.id}:effects`));
    (await store.releaseClaims(ctx.orgId,call.id));return {call:updated,operation_id:op.id};
  }));
}
/** Idempotent effects across the separate Work/CRM databases. Each completed effect is checkpointed. */
export async function applyWrapUpEffects(orgId:string,callId:string,payload:Json){
  let call=(await store.readCall(orgId,callId));const checkpoint=()=>object(call.metadata.wrap_effects);
  const done=async (key:string,value:unknown=true)=>{call=(await store.readCall(orgId,callId));call=(await store.patchCall(orgId,callId,{metadata:{...call.metadata,wrap_effects:{...checkpoint(),[key]:value}}}));};
  // Compatibility callers retain their configured outcomes. Deterministic IDs make
  // the older Work/Channels effects safe to resume after an interrupted request.
  if(payload.legacy_disposition){
    if(!call.metadata.legacy_response){
      const response=await recordCallListDisposition(orgId,call.entry_id,{...object(payload.legacy_disposition),call_id:call.id,completed_at:call.ended_at});
      call=(await store.patchCall(orgId,callId,{metadata:{...call.metadata,legacy_response:response},result:{...object(response.entry.result),call_id:call.id}}));
    }
    (await store.patchCall(orgId,callId,{wrap_up_state:'saved'}));(await store.finishOperation(orgId,text(payload.operation_id),{call_id:callId}));
    (await store.appendEvent(orgId,callId,'communication.call.wrap_up_saved',{},`${callId}:wrap-up`));return;
  }
  if(payload.next_action==="follow_up"&&!checkpoint().follow_up){
    const result=await createFollowUpTodo(orgId,{id:store.id("fu",call.id),source_key:`communication-call:${call.id}:follow-up`,project_id:call.project_id,branch_id:call.branch_id,
      due_at:payload.due_at,channel:payload.channel,title:text(payload.title)||`Follow up with ${call.customer_name}`,body:call.notes,assigned_user_ids:[text(payload.assigned_user_id)||text(payload.actor_user_id)],
      metadata:{follow_up:{...object(payload.policy),call_id:call.id,contact_id:call.contact_id,phone:call.customer_number,timezone:text(payload.timezone)||(await voiceSettings(orgId)).timezone,purpose:text(call.metadata.purpose),completion_policy:"explicit"}}});
    (await done("follow_up",text(object(result.node).id)));
  }
  if(["complete","follow_up","scheduled"].includes(text(payload.next_action))){
    for(const nodeId of strings(payload.source_node_ids))if(!checkpoint()[`node:${nodeId}`]){
      const node=(await readNodeRecord(orgId,nodeId));if(!node)throw notFound("source_work_missing","Linked work is no longer available.");
      if(!["completed","canceled","skipped"].includes(text(node.status))){
        if(payload.outcome_id)await resolveFollowUpOutcome(orgId,nodeId,{outcome_id:payload.outcome_id,actor_user_id:payload.actor_user_id},[object(payload.configured_outcome)]);
        else await transitionWorkNode(orgId,nodeId,"completed",{reason:"communication_call_outcome",follow_up_outcome:text(payload.next_action),actor_user_id:payload.actor_user_id,payload:{call_id:call.id}});
      }
      (await done(`node:${nodeId}`));
    }
  }
  if(call.entry_id&&!checkpoint().entry){
    await ensureCallListDatabase();
    const remaining=(await Promise.all(strings(call.metadata.source_node_ids).map(async nodeId=>{const node=await readNodeRecord(orgId,nodeId);return node&&!['completed','canceled','skipped'].includes(text(node.status));}))).some(Boolean);
    const status=payload.disposition==='do_not_call'?'removed':remaining||payload.next_action==='none'?'pending':'completed';
    withLeadDb(db=>db.prepare("UPDATE crm_call_list_entries SET status=?,result_json=?,updated_at=?,completed_at=? WHERE organization_id=? AND id=?")
      .run(status,JSON.stringify({call_id:call.id,...call.result}),store.now(),status==='pending'?'':store.now(),orgId,call.entry_id));(await done("entry"));
  }
  if(!checkpoint().event){
    await emitWorkEvent({organization_id:orgId,branch_id:call.branch_id,project_id:call.project_id,type:"call.completed",idempotency_key:`call.completed:${call.id}`,
      payload:{call_id:call.id,disposition:payload.disposition,outcome:payload.next_action,phone:call.customer_number},context:{actor_user_id:payload.actor_user_id}});(await done("event"));
  }
  (await store.transaction(async ()=>{
    const updated=(await store.patchCall(orgId,call.id,{wrap_up_state:"saved"}));(await store.finishOperation(orgId,text(payload.operation_id),{call_id:updated.id,follow_up_id:checkpoint().follow_up}));
    (await store.appendEvent(orgId,call.id,"communication.call.wrap_up_saved",{},`${call.id}:wrap-up`));
  }));
}

export async function followUps(ctx:PlatformAuthContext,filters:Json={}){
  return (await listNodeRecords(ctx.orgId,{open_only:filters.include_completed!==true,actionable:true})).filter(isFollowUpWorkNode).filter(node=>
    (manageCalls(ctx)||text(node.branch_id||"default")===(ctx.branchId||"default"))&&(!text(filters.project_id)||node.project_id===filters.project_id)&&
    (!text(filters.channel)||object(object(node.metadata).follow_up).channel===filters.channel)&&
    (filters.owner!=="mine"||strings(node.assigned_user_ids).includes(ctx.userId))
  );
}
export async function changeFollowUp(ctx:PlatformAuthContext,nodeId:string,input:Json){
  const node=(await readNodeRecord(ctx.orgId,nodeId));if(!node||!isFollowUpWorkNode(node)||(!manageCalls(ctx)&&text(node.branch_id||'default')!==(ctx.branchId||'default')))throw notFound("follow_up_unavailable","This follow-up is unavailable.");
  if(!manageCalls(ctx)&&strings(node.assigned_user_ids).length&&!strings(node.assigned_user_ids).includes(ctx.userId))throw forbidden("follow_up_owner_required","Only the assigned user or a manager can change this task.");
  if((input.action==='complete'&&node.status==='completed')||(input.action==='cancel'&&node.status==='canceled'))return node;
  if(input.action==="complete"||input.action==="cancel")return transitionWorkNode(ctx.orgId,nodeId,input.action==="complete"?"completed":"canceled",{reason:"communication_follow_up",follow_up_outcome:"explicit",actor_user_id:ctx.userId});
  if(input.action==="snooze"){
    if(!text(input.due_at)||!Number.isFinite(Date.parse(text(input.due_at))))throw badRequest("due_date_required","Choose a valid due date.");
    return patchWorkNode(ctx.orgId,nodeId,{due_at:input.due_at});
  }
  throw badRequest("follow_up_action_invalid","Choose complete, cancel, or snooze.");
}
export async function publishedScript(orgId:string,scriptId:string){
  const latest=object((await store.database().prepare('SELECT status FROM customer_call_scripts WHERE organization_id=? AND id=? ORDER BY version DESC LIMIT 1').get(orgId,scriptId)));
  if(latest.status==='archived')throw notFound('script_archived','This script has been archived.');
  const row=object((await store.database().prepare("SELECT * FROM customer_call_scripts WHERE organization_id=? AND id=? AND status='published' ORDER BY version DESC LIMIT 1").get(orgId,scriptId)));
  if(!row.id)throw notFound("script_not_found","This script is unavailable.");
  return {...row,data:JSON.parse(text(row.data_json)),data_json:undefined};
}
export async function scripts(orgId:string,publishedOnly=false){
  const rows=(await store.database().prepare("SELECT s.* FROM customer_call_scripts s WHERE organization_id=? AND version=(SELECT max(version) FROM customer_call_scripts WHERE organization_id=s.organization_id AND id=s.id) ORDER BY title")
    .all(orgId)).map(row=>({...object(row),data:JSON.parse(text(object(row).data_json)),data_json:undefined}));
  if(!publishedOnly)return rows;
  return (await Promise.all(rows.filter(row=>object(row).status!=='archived').map(async row=>{try{return [(await publishedScript(orgId,text(object(row).id)))];}catch{return [];}}))).flat();
}
export const scriptSchema=z.object({id:z.string().max(180).optional(),title:z.string().trim().min(1).max(250),status:z.enum(["draft","published","archived"]),
  sections:z.array(z.object({title:z.string().max(250),body:z.string().max(10000)})).min(1).max(30),questions:z.array(z.string().max(500)).max(50).default([])});
export async function saveScript(ctx:PlatformAuthContext,input:unknown){
  const body=scriptSchema.parse(input);return (await store.transaction(async db=>{const scriptId=body.id||store.id("script");const row=object((await db.prepare("SELECT max(version) AS version FROM customer_call_scripts WHERE organization_id=? AND id=?").get(ctx.orgId,scriptId)));
    const version=Number(row.version||0)+1;(await db.prepare("INSERT INTO customer_call_scripts(organization_id,id,version,title,status,data_json,created_at,author_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(ctx.orgId,scriptId,version,body.title,body.status,JSON.stringify({sections:body.sections,questions:body.questions}),store.now(),ctx.userId));return {id:scriptId,version,...body};}));
}
export async function people(ctx:PlatformAuthContext){
  return (await listDocuments(ctx.orgId,"users")).map(d=>({id:d.id,...object(d.data)} as Json)).filter(d=>!d.disabled).map(d=>({id:text(d.id),name:text(d.name||d.email),branch_id:text(d.branch_id||"default")}));
}
