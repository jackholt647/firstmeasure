import { backgroundAuthContext, can, type PlatformAuthContext } from '../../platform/auth.js';
import { badRequest, forbidden, notFound } from '../../platform/errors.js';
import { contentHash } from '../../platform/publication/validation.js';
import { hasResourcePermission } from '../../workforce/department-access.js';
import { analyzeSource, analysisChunks, DEFAULT_ANALYSIS_PROMPT, type AnalysisSourceAdapter, type AnalysisRunner } from '../../agents/analysis.js';
import * as results from '../../agents/analysis-store.js';
import * as s from './storage.js';
import { callDepartmentResource, projectContext, requireCallAccess } from './service.js';

const PROVIDER='customer-call-transcripts';
export async function authorizeCallAnalysis(ctx:PlatformAuthContext,callId:string,write=false){
  // Always reload membership and scoped grants, including background execution and replay.
  const fresh=await backgroundAuthContext(ctx.orgId,ctx.userId);
  if(!await can(fresh,'apps.comms'))throw forbidden('comms_disabled','Communications is unavailable.');
  const call=requireCallAccess(fresh,await s.readCall(fresh.orgId,callId));
  if(call.mode==='diagnostic')throw forbidden('analysis_diagnostic_private','Diagnostic calls cannot be analyzed.');
  if(call.project_id)await projectContext(fresh,call.project_id);
  if(!hasResourcePermission(fresh,'view_call_recordings',callDepartmentResource(call)))throw forbidden('recording_access_denied','You cannot access this call transcript.');
  if(write&&!hasResourcePermission(fresh,'analyze_call_recordings',callDepartmentResource(call)))throw forbidden('call_analysis_denied','You cannot create AI notes for this call.');
  return {ctx:fresh,call};
}
export const callTranscriptAdapter:AnalysisSourceAdapter={load:async(ctx,id)=>{
  await authorizeCallAnalysis(ctx,id);
  const artifacts=(await s.artifacts(ctx.orgId,id)).filter(a=>a.kind==='transcript'&&a.state==='ready'&&s.object(a.data).final!==false&&s.text(a.expires_at)>s.now()&&s.text(s.object(a.data).text))
    .sort((a,b)=>s.text(a.created_at).localeCompare(s.text(b.created_at))||s.text(a.id).localeCompare(s.text(b.id)));
  if(!artifacts.length)throw notFound('analysis_transcript_unavailable','No retained transcript is available yet. Record and transcribe the call first.');
  const parts=artifacts.map(a=>({id:s.text(a.id),label:`Call transcript ${s.text(a.created_at)}`,text:s.text(s.object(a.data).text)}));
  return {provider:PROVIDER,id,revision:contentHash(parts),parts,expiresAt:artifacts.map(a=>s.text(a.expires_at)).sort()[0]!};
}};
function publicNote(record:results.AnalysisRecord){
  const {id,state,kind,text,error,question,system_prompt,created_at,source_revision,citations,model}=record;
  const interrupted=state==='running'&&Date.parse(record.updated_at)<Date.now()-360_000;
  return {id,state:interrupted?'failed':state,kind,text,error:interrupted?'The analysis was interrupted. Start a new request.':error,question,system_prompt,created_at,source_revision,citations,model};
}
export const expireAnalyses=results.expireAnalyses;
export async function revokeCallAnalyses(orgId:string,callId:string){await results.revokeSourceAnalyses(orgId,PROVIDER,callId);}
/** Retained notes inherit source access and disappear when any source is deleted, replaced or expired. */
export async function readCallAnalysis(ctx:PlatformAuthContext,callId:string){
  await authorizeCallAnalysis(ctx,callId);
  const source=await callTranscriptAdapter.load(ctx,callId).catch(error=>{if(error?.code==='analysis_transcript_unavailable')return null;throw error;});
  if(!source)return {notes:[],available:false};
  const notes=(await results.listAnalyses(ctx.orgId,PROVIDER,callId)).filter(note=>note.source_revision===source.revision&&note.expires_at>s.now()).map(publicNote);
  return {notes,available:true};
}
/** A durable request is enqueued before returning; no browser request waits on a model. */
export async function generateCallAnalysis(ctx:PlatformAuthContext,callId:string,input:s.Json){
  await authorizeCallAnalysis(ctx,callId,true);
  const operation=s.text(input.operation_id),prompt=s.text(input.system_prompt)||DEFAULT_ANALYSIS_PROMPT,question=s.text(input.question);
  if(!operation||operation.length>200)throw badRequest('analysis_operation_required','Supply an operation ID up to 200 characters.');
  if(prompt.length>4000||question.length>2000)throw badRequest('analysis_input_too_long','Keep instructions under 4,000 characters and questions under 2,000.');
  const source=await callTranscriptAdapter.load(ctx,callId);analysisChunks(source);
  const {record}=await results.reserveAnalysis({organization_id:ctx.orgId,user_id:ctx.userId,provider:PROVIDER,source_id:callId,source_revision:source.revision,
    expires_at:source.expiresAt,citations:source.parts.map(({id,label})=>({id,label})),kind:question?'answer':'summary',question,system_prompt:prompt},operation);
  // Also repair a process exit between reservation and enqueue; enqueue itself is idempotent.
  if(record.state==='pending')await s.enqueue(ctx.orgId,callId,'analysis',{actor_user_id:ctx.userId,analysis_id:record.id},`analysis:${record.id}`);
  return {note:publicNote(record)};
}
export async function processCallAnalysisJob(call:s.CustomerCall,payload:s.Json,options:{runner?:AnalysisRunner;signal?:AbortSignal}={}){
  const record=await results.readAnalysis(call.organization_id,s.text(payload.analysis_id));
  if(!record||record.source_id!==call.id||record.provider!==PROVIDER||record.user_id!==s.text(payload.actor_user_id))throw notFound('analysis_request_missing','Analysis request is unavailable.');
  if(record.state==='ready'||record.state==='failed')return {analysis_id:record.id,state:record.state};
  // Never repeat a model call after a worker crash with uncertain provider costs.
  if(!await results.claimAnalysis(call.organization_id,record.id)){
    const current=await results.readAnalysis(call.organization_id,record.id);
    if(current?.state==='running'&&Date.parse(current.updated_at)<Date.now()-360_000){
      await results.finishAnalysis({...current,state:'failed',text:'',error:'The analysis was interrupted. Start a new request.'});
      return {analysis_id:record.id,state:'failed'};
    }
    return {analysis_id:record.id,state:current?.state||'failed'};
  }
  try{
    const ctx=await backgroundAuthContext(call.organization_id,record.user_id);await authorizeCallAnalysis(ctx,call.id,true);
    const adapter:AnalysisSourceAdapter={load:async(auth,id)=>{await authorizeCallAnalysis(auth,id,true);return callTranscriptAdapter.load(auth,id);}};
    const output=await analyzeSource(ctx,adapter,call.id,{systemPrompt:record.system_prompt,question:record.question,expectedRevision:record.source_revision,...options});
    await results.finishAnalysis({...record,...output,state:'ready',error:''});
    await s.appendEvent(call.organization_id,call.id,'communication.call.analysis_ready',{analysis_id:record.id},`analysis:${record.id}:ready`);
    return {analysis_id:record.id,state:'ready'};
  }catch(error){
    // Provider diagnostics and source content never appear in worker errors or notes history.
    await results.finishAnalysis({...record,state:'failed',text:'',error:'Analysis could not finish. Check transcript access and try a new request.'});
    return {analysis_id:record.id,state:'failed'};
  }
}
