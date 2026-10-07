import {canUseScopedPermission,hasResourcePermission} from '../../workforce/department-access.js';
import {callDepartmentResource,callListDepartmentFilter} from './service.js';
import { hasPermission } from '../../platform/auth.js';
import { badRequest, forbidden } from '../../platform/errors.js';
import { registerDataProvider } from '../../platform/publication/providers.js';
import type { AccessPolicy, PublicationContext, SourceRef, TargetRef, JsonSchema, DataResult } from '../../platform/publication/contracts.js';
import { contentHash } from '../../platform/publication/validation.js';
import { manageCalls, projectContext, requireCallAccess } from './service.js';
import * as store from './storage.js';
import { object, text, strings, type CustomerCall, type Json } from './storage.js';

const string:JsonSchema={type:'string'};
const shape=(properties:Record<string,JsonSchema>,required=Object.keys(properties)):JsonSchema=>({type:'object',properties,required,additionalProperties:false});
const array=(items:JsonSchema):JsonSchema=>({type:'array',items});
const stringFields=['id','branch_id','project_id','contact_id','owner_user_id','mode','direction','state','wrap_up_state','customer_number','business_number','customer_name','entry_id','created_at','updated_at','connected_at','ended_at','notes'];
const resultFields=['disposition','next_action','due_at','appointment_id','actor_user_id','outcome_id'];
const callSchema=shape({
  ...Object.fromEntries(stringFields.map(key=>[key,string])),revision:{type:'integer'},duration_seconds:{type:['number','null']},
  department_ids:array(string),purpose:string,source_node_ids:array(string),result:shape(Object.fromEntries(resultFields.map(key=>[key,string])),[]),
  script:shape({id:string,title:string,version:{type:['string','number','null']},questions:array(string),sections:array(shape({title:string,body:string})),answers:{type:'object',additionalProperties:{type:['string','number','boolean','null','object','array']}}}),
  capture:shape({state:string,consent:string,recording_enabled:{type:'boolean'},transcription_enabled:{type:'boolean'}})
});
const artifactSchema=shape({id:string,kind:string,state:string,created_at:string,expires_at:string,text:{type:['string','null']},media_url:{type:['string','null']}});
const mediaSchema=shape({call:callSchema,artifacts:array(artifactSchema)});
const argsSchema=shape({department_id:string,owner_user_id:string,contact_id:string,project_id:string,direction:{type:'string',enum:['inbound','outbound']},
  mode:{type:'string',enum:['browser','external']},state:{type:'string',enum:['created','agent_connecting','dialing','ringing','queued','connected','held','ended','canceled','failed','busy','no_answer','rejected']},
  query:{type:'string',maxLength:500},created_after:string,created_before:string},[]);
const access:AccessPolicy={scopes:['organization','project'],permissions:['view_comms'],scopedPermissions:true,capabilities:['apps.comms'],systemKinds:[],
  authorize:async(ctx,target)=>{if(!canUseScopedPermission(principal(ctx),'view_comms|view_projects|manage_projects|manage_communications|manage_company_settings'))throw forbidden('call_access_denied','You do not have access to customer calls.');const project=projectId(ctx,target);if(project)await projectContext(principal(ctx),project);}};
function principal(ctx:PublicationContext){if(!ctx.auth)throw forbidden('call_user_required','Call publication requires an authenticated organization member.');return ctx.auth;}
function projectId(ctx:PublicationContext,target:TargetRef){return target.projectId||ctx.projectId||'';}
async function authorizedCall(ctx:PublicationContext,target:TargetRef,id=target.id){
  if(!id)throw badRequest('call_id_required','Choose a call ID, or use the list operation for call history.');
  const call=requireCallAccess(principal(ctx),await store.readCall(ctx.organizationId,id));
  if(call.mode==='diagnostic')throw forbidden('call_diagnostic_private','Device diagnostics are not published customer calls.');
  const project=projectId(ctx,target);if(project&&call.project_id!==project)throw forbidden('call_project_denied','This call is outside the requested project.');
  if(call.project_id)await projectContext(principal(ctx),call.project_id);
  return call;
}
function safeCall(call:CustomerCall){
  const policy=object(call.metadata.policy),capture=object(call.metadata.capture),script=object(call.metadata.script);
  const elapsed=call.connected_at&&call.ended_at?(Date.parse(call.ended_at)-Date.parse(call.connected_at))/1000:NaN;
  return {...Object.fromEntries(stringFields.map(key=>[key,text(call[key])])),revision:Number(call.revision),duration_seconds:Number.isFinite(elapsed)?Math.max(0,elapsed):null,
    department_ids:strings(call.metadata.department_ids),purpose:text(call.metadata.purpose),source_node_ids:strings(call.metadata.source_node_ids),
    result:Object.fromEntries(resultFields.filter(key=>call.result[key]!==undefined).map(key=>[key,text(call.result[key])])),
    script:{id:text(script.id),title:text(script.title),version:typeof script.version==='number'||typeof script.version==='string'?script.version:null,
      questions:Array.isArray(object(script.data).questions)?(object(script.data).questions as unknown[]).map(text):[],
      sections:Array.isArray(object(script.data).sections)?(object(script.data).sections as unknown[]).map(section=>({title:text(object(section).title),body:text(object(section).body)})):[],answers:object(call.metadata.script_answers)},
    capture:{state:text(capture.state)||'off',consent:text(object(call.metadata.consent).state)||'not_requested',recording_enabled:policy.recording_enabled===true,transcription_enabled:policy.transcription_enabled===true}};
}
async function media(ctx:PublicationContext,call:CustomerCall,kind:'transcripts'|'recordings'){
  if(!hasResourcePermission(principal(ctx),'view_call_recordings|manage_communications|manage_company_settings',callDepartmentResource(call)))throw forbidden('recording_access_denied','This call recording is not available.');
  const artifacts=(await store.artifacts(ctx.organizationId,call.id)).filter(a=>text(a.expires_at)>store.now()&&(kind==='transcripts'?a.kind==='transcript':['recording','voicemail'].includes(text(a.kind))));
  return {call:safeCall(call),artifacts:artifacts.map(a=>({id:text(a.id),kind:text(a.kind),state:text(a.state),created_at:text(a.created_at),expires_at:text(a.expires_at),
    text:kind==='transcripts'&&a.state==='ready'?text(object(a.data).text):null,
    media_url:kind==='recordings'&&a.state==='ready'?`/v1/comms/organizations/${encodeURIComponent(ctx.organizationId)}/calls/${encodeURIComponent(call.id)}/artifacts/${encodeURIComponent(text(a.id))}/media`:null}))};
}
function filter(ctx:PublicationContext,ref:SourceRef):Json{
  const args=ref.args||{},project=projectId(ctx,ref.target);
  if(project&&args.project_id&&args.project_id!==project)throw forbidden('call_project_denied','The filter is outside the requested project.');
  for(const key of ['created_after','created_before'])if(args[key]&&(!/^\d{4}-\d\d-\d\dT/.test(text(args[key]))||!Number.isFinite(Date.parse(text(args[key])))))throw badRequest('call_date_invalid','Call date filters must be ISO timestamps.');
  return callListDepartmentFilter(principal(ctx),{...args,...(project?{project_id:project}:{})});
}
function provenance(ctx:PublicationContext,calls:CustomerCall[],values:unknown[],kind:string){
  return {viewerUserId:principal(ctx).userId,callIds:calls.map(c=>c.id),artifactIds:kind==='record'?[]:values.flatMap(v=>((object(v).artifacts||[]) as Json[]).map(a=>({callId:text(object(object(v).call).id),id:text(a.id)}))),collection:'customer_calls'};
}
async function snapshot(ctx:PublicationContext,ref:SourceRef,result:Extract<DataResult,{status:'ready'}>){
  if(result.provenance.viewerUserId!==principal(ctx).userId||!Array.isArray(result.provenance.callIds))throw forbidden('call_snapshot_denied','Call snapshot authorization is unavailable for this viewer.');
  for(const id of result.provenance.callIds){const call=await authorizedCall(ctx,ref.target,text(id));if(ref.export!=='record'&&!hasResourcePermission(principal(ctx),'view_call_recordings|manage_communications|manage_company_settings',callDepartmentResource(call)))throw forbidden('recording_access_denied','You no longer have access to this recording or transcript.');}
  const captured=result.provenance.artifactIds;
  if(!Array.isArray(captured))throw forbidden('call_snapshot_denied','Call artifact authorization is unavailable.');
  for(const item of captured){const entry=object(item);const available=await store.artifacts(ctx.organizationId,text(entry.callId));
    if(!available.some(a=>a.id===entry.id&&text(a.expires_at)>store.now()))throw forbidden('call_artifact_unavailable','A captured recording or transcript was removed or expired.');}
}
let registered=false;
export function registerCallPublication(){
  if(registered)return;registered=true;
  const exports:Parameters<typeof registerDataProvider>[0]['exports']={};
  for(const kind of ['record','transcripts','recordings'] as const){
    const value=async(ctx:PublicationContext,call:CustomerCall)=>kind==='record'?safeCall(call):media(ctx,call,kind);
    exports[kind]={schema:kind==='record'?callSchema:mediaSchema,schemaVersion:'1',argsSchema,access:{...access,
      authorize:async(ctx,target)=>{await access.authorize!(ctx,target);if(kind!=='record'&&!canUseScopedPermission(principal(ctx),'view_call_recordings|manage_communications|manage_company_settings'))throw forbidden('recording_access_denied','You do not have access to recordings and transcripts.');}},
      description:kind==='record'?'Customer call details, notes, outcome, caller, contact, project, timestamps and capture status. List newest first; filter by owner_user_id, contact_id, project_id, direction, state, query or created_after/created_before. Diagnostics excluded.':kind==='transcripts'?'Call details and authorized transcript text, including processing state and retention. List recent calls or filter by user, contact, project and date. Empty artifacts means no retained transcript.':'Call details and authorized recording metadata with authenticated media links; no private storage or provider URLs.',
      units:{[kind==='record'?'/duration_seconds':'/call/duration_seconds']:'seconds'},authorizeRef:async(ctx,ref)=>{filter(ctx,ref);if(ref.target.id)await authorizedCall(ctx,ref.target);},authorizeSnapshot:snapshot,
      read:async(ctx,ref)=>{const call=await authorizedCall(ctx,ref.target),item=await value(ctx,call);return {value:item,revision:contentHash(item),provenance:provenance(ctx,[call],[item],kind)};},
      list:async(ctx,ref,page)=>{
        const filters=kind==='record'?filter(ctx,ref):callListDepartmentFilter(principal(ctx),filter(ctx,ref),'view_call_recordings|manage_communications|manage_company_settings'),signature=contentHash({filters,target:ref.target,viewer:principal(ctx).userId,branch:principal(ctx).branchId,kind});let before='';
        if(page.cursor){try{const cursor=JSON.parse(Buffer.from(page.cursor,'base64url').toString());if(cursor.signature!==signature||typeof cursor.before!=='string')throw Error();const anchor=JSON.parse(Buffer.from(cursor.before,'base64url').toString());if(typeof anchor.at!=='string'||typeof anchor.id!=='string'||!anchor.id||!Number.isFinite(Date.parse(anchor.at)))throw Error();before=cursor.before;}catch{throw badRequest('call_cursor_invalid','The call continuation cursor is invalid or belongs to another query.');}}
        const result=ref.target.id?{calls:[await authorizedCall(ctx,ref.target)],next_cursor:null}:await store.listCalls(ctx.organizationId,{...filters,limit:page.limit,...(before?{before}:{})});
        for(const call of result.calls)await authorizedCall(ctx,ref.target,call.id);
        const items=await Promise.all(result.calls.map(call=>value(ctx,call)));
        return {items,revision:contentHash(items),provenance:provenance(ctx,result.calls,items,kind),...(result.next_cursor?{nextCursor:Buffer.from(JSON.stringify({signature,before:result.next_cursor})).toString('base64url')}: {})};
      }
    };
  }
  registerDataProvider({id:'customer-calls',version:'1',apps:['comms'],exports});
}
