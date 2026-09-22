import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { requirePlatformAuth, hasPermission, type PlatformAuthContext } from "../../platform/auth.js";
import { PlatformError, forbidden, badRequest, conflict } from "../../platform/errors.js";
import { createFollowUpTodo } from "../../work/followups.js";
import { readNodeRecord } from '../../work/storage.js';
import { ensureCallList, upsertCallListEntry, removeCallListEntry } from "../../internal/crm/call_lists.js";
import { verifyTelnyxWebhook } from "../../messaging/telnyx_webhooks.js";
import { voiceSettings, updateVoiceSettings } from "./settings.js";
import { createCall, saveDraft, saveWrapUp, requireCallAccess, queues, readEntry, followUps, changeFollowUp, scripts, saveScript, people, projectContext, callContext, manageCalls } from "./service.js";
import { voiceStatus, provisionVoice, configureVoice, bindNumber, disconnectNumber, endpointToken, disconnectEndpoint, presence, saveDiagnostic, startDiagnostic, callAction } from "./voice.js";
import { startCallWorker } from "./worker.js";
import { streamRecording, deleteArtifact } from "./media.js";
import { changeConversationWorkflow } from "./workflow.js";
import { reconcileCall } from "./recovery.js";
import { voiceHealth } from './operations.js';
import { followUpOptions } from './follow-up-policy.js';
import * as s from "./storage.js";
import { text, object, type Json } from "./storage.js";

const param=(req:FastifyRequest,key:string)=>text(object(req.params)[key]);
const query=(req:FastifyRequest)=>object(req.query);
async function auth(req:FastifyRequest,write=false,admin=false){return requirePlatformAuth(req,{orgId:param(req,"orgId"),csrf:write, capability:"apps.comms",
  permission:admin?"manage_communications|manage_company_settings":write?"make_calls|send_comms|send_communications|manage_projects|manage_company_settings":"view_comms|view_projects|manage_projects|manage_company_settings"});}
const body=(req:FastifyRequest)=>object(req.body);
const boundedId=z.string().min(8).max(180);

export const registerCustomerCallsApi:FastifyPluginAsync=async app=>{
  s.database();
  startCallWorker(app);
  app.addHook('onSend',async(_req,reply,payload)=>{reply.header('Cache-Control','private, no-store');return payload;});
  app.setErrorHandler((error,_req,reply)=>{
    if(error instanceof ZodError)return reply.code(400).send({ok:false,error:"validation_error",message:"Check the highlighted values and try again.",issues:error.issues});
    if(error instanceof PlatformError)return reply.code(error.statusCode).send({ok:false,error:error.code,message:error.message,details:error.details});
    // Provider errors can contain private payloads. Return a bounded diagnostic, not the raw response.
    app.log.error({name:error instanceof Error?error.name:"Error",request_id:_req.id},"Customer calls request failed");
    return reply.code(500).send({ok:false,error:"calls_error",message:"The call request could not be completed. Your saved notes are retained. Check call status before retrying."});
  });
  app.get("/organizations/:orgId/calls",async req=>{
    const ctx=await auth(req);const filter=query(req);
    if(text(filter.project_id))await projectContext(ctx,text(filter.project_id));
    return {ok:true,...(await s.listCalls(ctx.orgId,{...filter,active:filter.active==="true",...(!manageCalls(ctx)?{branch_id:ctx.branchId||"default"}:{})}))};
  });
  app.post("/organizations/:orgId/conversation-workflow",async req=>({ok:true,workflow:await changeConversationWorkflow(await auth(req,true),body(req))}));
  app.get('/organizations/:orgId/call-context',async req=>({ok:true,...await callContext(await auth(req),query(req))}));
  app.post("/organizations/:orgId/calls/:callId/reconcile",async req=>{
    const ctx=await auth(req,true);const call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,'callId'))),true);
    return {ok:true,...await reconcileCall(ctx.orgId,call.id),call:(await s.readCall(ctx.orgId,call.id))};
  });
  app.post('/organizations/:orgId/calls/:callId/retry-work',async req=>{
    const ctx=await auth(req,true),call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,'callId'))),true);
    const jobId=z.string().min(8).max(180).parse(body(req).job_id);
    const job=(await s.jobs(ctx.orgId,call.id)).find(job=>job.id===jobId);
    if(!job||!['wrap_up','recording_ingest','missed_callback'].includes(text(job.kind)))throw badRequest('work_retry_forbidden','Only saved background work can be retried. Check provider status for phone commands.');
    if(job.state!=='failed')return {ok:true,queued:false};
    const changed=(await s.database().prepare("UPDATE customer_call_jobs SET state='pending',attempts=0,error='',available_at=?,lease_owner='',lease_until='',updated_at=? WHERE organization_id=? AND call_id=? AND id=? AND state='failed'").run(s.now(),s.now(),ctx.orgId,call.id,jobId));
    if(changed.changes)(await s.appendEvent(ctx.orgId,call.id,'communication.call.work_retried',{job_id:jobId,actor_user_id:ctx.userId}));
    return {ok:true,queued:!!changed.changes};
  });
  app.post("/organizations/:orgId/calls",async(req,reply)=>{const ctx=await auth(req,true);const call=await createCall(ctx,body(req));return reply.code(201).send({ok:true,call});});
  app.get("/organizations/:orgId/calls/:callId",async req=>{
    const ctx=await auth(req);const call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,"callId"))));
    return {ok:true,call,work:(await Promise.all(s.strings(call.metadata.source_node_ids).map(async id=>(await readNodeRecord(ctx.orgId,id))))).filter(Boolean).map(node=>({id:node!.id,title:node!.title,status:node!.status})),legs:(await s.legs(ctx.orgId,call.id)).map(l=>({id:l.id,role:l.role,state:l.state})),events:(await s.callEvents(ctx.orgId,call.id)),operations:(await s.jobs(ctx.orgId,call.id))};
  });
  app.get('/organizations/:orgId/calls/:callId/follow-up-options',async req=>{const ctx=await auth(req);return {ok:true,...await followUpOptions(requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,'callId')))))};});
  app.patch("/organizations/:orgId/calls/:callId/draft",async req=>({ok:true,call:(await saveDraft(await auth(req,true),param(req,"callId"),body(req)))}));
  app.post('/organizations/:orgId/calls/:callId/lease',async req=>{
    const ctx=await auth(req,true),call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,'callId'))),true);
    if(!s.terminal.has(call.state))(await s.transaction(async ()=>{(await s.claimResource(ctx.orgId,`phone:${call.customer_number}`,ctx.userId,call.id));if(call.entry_id)(await s.claimResource(ctx.orgId,`entry:${call.entry_id}`,ctx.userId,call.id));}));
    return {ok:true};
  });
  app.post("/organizations/:orgId/calls/:callId/wrap-up",async req=>({ok:true,...await saveWrapUp(await auth(req,true),param(req,"callId"),body(req))}));
  app.post("/organizations/:orgId/calls/:callId/actions",async req=>{
    const ctx=await auth(req,true);const action=text(body(req).action);
    if(action.startsWith("record_")||action==="consent")if(!hasPermission(ctx,"record_calls|manage_communications|manage_company_settings"))throw forbidden("recording_forbidden","You do not have permission to record calls.");
    return {ok:true,...(await callAction(ctx,param(req,"callId"),body(req)))};
  });
  app.get("/organizations/:orgId/calls/:callId/artifacts",async req=>{
    const ctx=await auth(req);const call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,"callId"))));
    if(!hasPermission(ctx,"view_call_recordings|manage_communications|manage_company_settings"))throw forbidden("recording_access_denied","You do not have access to recordings and transcripts.");
    return {ok:true,artifacts:(await s.artifacts(ctx.orgId,call.id)).filter(a=>text(a.expires_at)>s.now()).map(a=>({...a,data:{...object(a.data),file_path:undefined,download_url:undefined,provider_urls:undefined}}))};
  });
  app.post("/organizations/:orgId/calls/:callId/link",async req=>{
    const ctx=await auth(req,true);const call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,"callId"))),true);
    const input=z.object({project_id:z.string().max(180),contact_id:z.string().max(180).default(""),revision:z.number().int().positive()}).parse(body(req));
    await projectContext(ctx,input.project_id);const updated=(await s.patchCall(ctx.orgId,call.id,input,input.revision));
    (await s.appendEvent(ctx.orgId,call.id,"communication.call.linked",{project_id:input.project_id,actor_user_id:ctx.userId}));return {ok:true,call:updated};
  });
  app.get("/organizations/:orgId/calls/:callId/artifacts/:artifactId/media",async(req,reply)=>{
    const ctx=await auth(req);const call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,"callId"))));
    if(!hasPermission(ctx,"view_call_recordings|manage_communications|manage_company_settings"))throw forbidden("recording_access_denied","You do not have access to this recording.");
    (await s.appendEvent(ctx.orgId,call.id,"communication.call.recording_accessed",{artifact_id:param(req,"artifactId"),actor_user_id:ctx.userId}));
    return streamRecording(req,reply,ctx.orgId,call.id,param(req,"artifactId"));
  });
  app.delete("/organizations/:orgId/calls/:callId/artifacts/:artifactId",async req=>{
    const ctx=await auth(req,true,true);const call=requireCallAccess(ctx,(await s.readCall(ctx.orgId,param(req,"callId"))));
    await deleteArtifact(ctx.orgId,call.id,param(req,"artifactId"),ctx.userId);return {ok:true};
  });
  app.get("/organizations/:orgId/call-lists/queue",async req=>queues(await auth(req)));
  app.post("/organizations/:orgId/call-lists",async req=>{
    const ctx=await auth(req,true,true);const input=z.object({key:z.string().min(1).max(100),title:z.string().min(1).max(180),description:z.string().max(2000).optional(),status:z.enum(["active","archived"]).optional(),
      assigned_user_ids:z.array(z.string().max(180)).max(100).optional(),assigned_role_ids:z.array(z.string().max(100)).max(100).optional(),settings:z.record(z.string(),z.unknown()).optional()}).parse(body(req));
    return {ok:true,call_list:await ensureCallList(ctx.orgId,{...input,actor_email:text(ctx.identity.email)})};
  });
  app.post("/organizations/:orgId/call-lists/:listKey/entries",async req=>{
    const ctx=await auth(req,true);const input=z.object({project_id:z.string().max(180).default(""),contact_id:z.string().max(180).default(""),name:z.string().max(250),phone:z.string().max(40),title:z.string().max(500),due_at:z.string().max(100).default(""),operation_id:boundedId}).parse(body(req));
    const available=await queues(ctx);if(!available.columns.some(column=>column.key===param(req,'listKey')||column.id===param(req,'listKey')))throw forbidden('call_list_unavailable','Choose a call list assigned to you.');
    await projectContext(ctx,input.project_id);return {ok:true,entry:await upsertCallListEntry(ctx.orgId,param(req,"listKey"),{source_key:`manual:${ctx.userId}:${input.operation_id}`,project_id:input.project_id,subject_id:input.contact_id,subject_type:input.project_id?"project":"contact",title:input.title,due_at:input.due_at,payload:{name:input.name,phone:input.phone,contact_id:input.contact_id}})};
  });
  app.post("/organizations/:orgId/call-list-entries/:entryId/claim",async req=>{
    const ctx=await auth(req,true);await readEntry(ctx,param(req,"entryId"));(await s.transaction(async ()=>(await s.claimResource(ctx.orgId,`entry:${param(req,"entryId")}`,ctx.userId))));return {ok:true};
  });
  app.post("/organizations/:orgId/call-list-entries/:entryId/skip",async req=>{
    const ctx=await auth(req,true);const {entry}=await readEntry(ctx,param(req,"entryId"));const session=z.object({session_id:boundedId}).parse(body(req));
    const key=`${ctx.userId}:${session.session_id}`;const current:Json=(await s.resource(ctx.orgId,"list_session",key))||{};
    const skipped=[...new Set([...s.strings(current.skipped),entry.id])];(await s.saveResource(ctx.orgId,"list_session",key,{...current,skipped}));
    (await s.database().prepare("DELETE FROM customer_call_claims WHERE organization_id=? AND resource=? AND owner_user_id=? AND call_id=''").run(ctx.orgId,`entry:${entry.id}`,ctx.userId));
    return {ok:true,skipped};
  });
  app.delete("/organizations/:orgId/call-list-entries/:entryId",async req=>{
    const ctx=await auth(req,true,true);await readEntry(ctx,param(req,"entryId"));return (await removeCallListEntry(ctx.orgId,{entry_id:param(req,"entryId")}));
  });
  app.get("/organizations/:orgId/follow-ups",async req=>({ok:true,tasks:(await followUps(await auth(req),query(req)))}));
  app.post("/organizations/:orgId/follow-ups",async req=>{
    const ctx=await auth(req,true);const input=z.object({operation_id:boundedId,project_id:z.string().max(180).default(""),contact_id:z.string().max(180).default(""),phone:z.string().max(40).default(""),title:z.string().min(1).max(500),due_at:z.string().min(1).max(100),channel:z.enum(["call","email","sms"]).default("call"),timezone:z.string().max(100).default("")}).parse(body(req));
    if(!Number.isFinite(Date.parse(input.due_at)))throw badRequest("due_date_invalid","Choose a valid due date.");await projectContext(ctx,input.project_id);
    const result=await createFollowUpTodo(ctx.orgId,{...input,id:s.id("fu",`${ctx.orgId}:${ctx.userId}:${input.operation_id}`),source_key:`comms:${ctx.userId}:${input.operation_id}`,branch_id:ctx.branchId||"default",assigned_user_ids:[ctx.userId],metadata:{follow_up:{contact_id:input.contact_id,phone:input.phone,timezone:input.timezone||(await voiceSettings(ctx.orgId)).timezone,completion_policy:"explicit"}}});
    return {ok:true,task:result.node};
  });
  app.post("/organizations/:orgId/follow-ups/:nodeId/actions",async req=>({ok:true,task:await changeFollowUp(await auth(req,true),param(req,"nodeId"),body(req))}));
  app.get("/organizations/:orgId/call-scripts",async req=>{const ctx=await auth(req);return {ok:true,scripts:(await scripts(ctx.orgId,query(req).published==='true'))};});
  app.post("/organizations/:orgId/call-scripts",async req=>({ok:true,script:(await saveScript(await auth(req,true,true),body(req)))}));
  app.get("/organizations/:orgId/voice/status",async req=>({ok:true,...(await voiceStatus(await auth(req)))}));
  app.get('/organizations/:orgId/voice/health',async req=>{const ctx=await auth(req,false,true);return {ok:true,...(await voiceHealth(ctx.orgId))};});
  app.get("/organizations/:orgId/voice/people",async req=>({ok:true,people:await people(await auth(req))}));
  app.put("/organizations/:orgId/voice/settings",async req=>{const ctx=await auth(req,true,true);return {ok:true,settings:await configureVoice(ctx,body(req))};});
  app.post("/organizations/:orgId/voice/provision",async req=>({ok:true,...await provisionVoice(await auth(req,true,true))}));
  app.post("/organizations/:orgId/voice/numbers",async req=>({ok:true,...await bindNumber(await auth(req,true,true),body(req))}));
  app.delete("/organizations/:orgId/voice/numbers/:number",async req=>({ok:true,number:await disconnectNumber(await auth(req,true,true),param(req,"number"))}));
  app.post("/organizations/:orgId/voice/endpoint/token",async(req,reply)=>{
    const ctx=await auth(req,true);const input=z.object({device_id:boundedId}).parse(body(req));reply.header("Cache-Control","no-store");return {ok:true,...await endpointToken(ctx,input.device_id)};
  });
  app.post("/organizations/:orgId/voice/endpoint/presence",async req=>{
    const ctx=await auth(req,true);const input=z.object({device_id:boundedId,registered:z.boolean(),availability:z.enum(["available","unavailable"])}).parse(body(req));const result=(await presence(ctx,input));
    return {ok:true,availability:result.availability,offered_call_id:result.offered_call_id};
  });
  app.post("/organizations/:orgId/voice/endpoint/disconnect",async req=>{const ctx=await auth(req,true);await disconnectEndpoint(ctx,boundedId.parse(body(req).device_id));return {ok:true};});
  app.post("/organizations/:orgId/voice/diagnostics",async req=>{
    const ctx=await auth(req,true);const input=z.object({device_id:boundedId,microphone:z.enum(["ready","denied","unavailable"]),connectivity:z.enum(["ready","blocked","inconclusive"]),provider_verdict:z.string().max(60),metrics:z.object({rtt_ms:z.number().nonnegative().max(60000),jitter_ms:z.number().nonnegative().max(60000),packet_loss_percent:z.number().min(0).max(100)}).optional()}).parse(body(req));return {ok:true,result:(await saveDiagnostic(ctx,input))};
  });
  app.post("/organizations/:orgId/voice/diagnostics/start",async req=>({ok:true,...(await startDiagnostic(await auth(req,true),boundedId.parse(body(req).device_id)))}));
  app.get("/organizations/:orgId/voice/center",async req=>{
    const ctx=await auth(req);const calls=(await s.listCalls(ctx.orgId,{active:true,...(!manageCalls(ctx)?{branch_id:ctx.branchId||"default"}:{})}));
    return {ok:true,...calls,agents:(await s.resources(ctx.orgId,"endpoint")).map(e=>({user_id:e.user_id,name:e.name,availability:text(e.heartbeat_at)<new Date(Date.now()-45_000).toISOString()?"offline":e.availability}))};
  });
  // Isolated parser: signatures must be checked against the original bytes, never reserialized JSON.
  await app.register(async webhook=>{
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser("application/json",{parseAs:"buffer",bodyLimit:2*1024*1024},(_req,raw,done)=>done(null,raw));
    webhook.post("/voice/webhooks/telnyx",async(req,reply)=>{
      const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from("");const verification=verifyTelnyxWebhook(raw,req.headers["telnyx-signature-ed25519"],req.headers["telnyx-timestamp"]);
      if(!verification.ok)return reply.code(401).send({ok:false,error:"invalid_webhook_signature"});
      let parsed:Json;try{parsed=object(JSON.parse(raw.toString("utf8")));}catch{return reply.code(400).send({ok:false,error:"invalid_json"});}
      const envelope=object(parsed.data);if(!text(envelope.id)||!text(envelope.event_type))return reply.code(400).send({ok:false,error:"invalid_voice_event"});
      (await s.database().prepare("INSERT INTO customer_voice_webhooks(event_id,event_type,body_json,received_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(text(envelope.id),text(envelope.event_type),JSON.stringify(parsed),s.now()));
      return reply.code(202).send({ok:true});
    });
  });
};
