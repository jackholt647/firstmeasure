import { forbidden, badRequest } from '../../platform/errors.js';
import { registerAction } from '../../platform/publication/actions.js';
import { registerDataProvider } from '../../platform/publication/providers.js';
import type { PublicationContext, TargetRef, JsonSchema, AccessPolicy } from '../../platform/publication/contracts.js';
import { contentHash } from '../../platform/publication/validation.js';
import { canUseScopedPermission } from '../../workforce/department-access.js';
import { authorizeCallAnalysis, generateCallAnalysis, readCallAnalysis } from './analysis.js';
const str:JsonSchema={type:'string'};
const shape=(properties:Record<string,JsonSchema>,required=Object.keys(properties)):JsonSchema=>({type:'object',properties,required,additionalProperties:false});
const note=shape({id:str,state:{type:'string',enum:['pending','running','ready','failed']},kind:{type:'string',enum:['summary','answer']},text:str,error:str,question:str,system_prompt:str,created_at:str,source_revision:str,citations:{type:'array',items:shape({id:str,label:str})},model:str});
function principal(ctx:PublicationContext){if(!ctx.auth)throw forbidden('analysis_user_required','Call analysis requires an authenticated member.');return ctx.auth;}
function callId(target:TargetRef){if(!target.id)throw badRequest('call_id_required','Choose a call ID.');return target.id;}
function policy(write=false):AccessPolicy{return {scopes:['organization','project'],permissions:[write?'analyze_call_recordings':'view_call_recordings'],scopedPermissions:true,capabilities:['apps.comms'],systemKinds:[],authorize:async(ctx,target)=>{
  const auth=principal(ctx);if(!canUseScopedPermission(auth,write?'analyze_call_recordings':'view_call_recordings'))throw forbidden('analysis_access_denied','You cannot access call analysis.');
  if(target.id){const {call}=await authorizeCallAnalysis(auth,target.id,write);const project=target.projectId||ctx.projectId;if(project&&call.project_id!==project)throw forbidden('call_project_denied','This call belongs to a different project.');}
}};}
let registered=false;
export function registerCallAnalysisPublication(){
  if(registered)return;registered=true;
  registerDataProvider({id:'customer-call-analysis',version:'1',apps:['comms'],exports:{notes:{schema:shape({call_id:str,notes:{type:'array',items:note},available:{type:'boolean'}}),schemaVersion:'1',access:policy(),
    description:'AI call analysis status and source-authorized notes. Requires a call ID. Agents receive status and analysis IDs only: direct the user to this call\'s AI notes in Call Center for text and Q&A. Authorized API and binding consumers receive retained notes; recording permissions and source retention apply to every read.',
    read:async(ctx,ref)=>{
      const current=await readCallAnalysis(principal(ctx),callId(ref.target));
      // Generic conversation history has no source-retention dependency yet.
      // Never introduce a permanent answer/prompt copy via assistant tool output.
      const value={...current,call_id:callId(ref.target),notes:ctx.executionKind==='agent'?current.notes.map(note=>({...note,text:'',question:'',system_prompt:'',citations:[]})):current.notes};
      return {value,revision:contentHash(value),provenance:{call_id:ref.target.id,viewer:ctx.auth!.userId,execution_kind:ctx.executionKind,note_ids:value.notes.map(n=>n.id)}};
    },
    authorizeSnapshot:async(ctx,ref,result)=>{
      if(result.provenance.viewer!==principal(ctx).userId)throw forbidden('analysis_snapshot_denied','This snapshot belongs to a different viewer.');
      if(ctx.executionKind==='agent'&&result.provenance.execution_kind!=='agent')throw forbidden('analysis_snapshot_private','View retained AI notes in the authorized call interface.');
      const current=await readCallAnalysis(principal(ctx),callId(ref.target)),ids=result.provenance.note_ids;
      if(!Array.isArray(ids)||ids.some(id=>!current.notes.some(note=>note.id===id)))throw forbidden('analysis_source_unavailable','Source transcripts for these notes are no longer available.');
    }
  }}});
  for(const kind of ['generate','ask'] as const)registerAction({id:`customer-calls.analysis.${kind}`,version:'1',implementation:`customer-calls.analysis.${kind}.v1`,domain:'comms',
    description:kind==='ask'?'Queue a source-grounded question about a retained call transcript. Read customer-call-analysis.notes for status; the user can view the answer in Call Center AI notes.':'Queue AI notes for a retained call transcript. Read customer-call-analysis.notes for status; the user can view the result in Call Center AI notes.',
    effect:'external',idempotency:'required',executionKinds:['api','agent'],policy:policy(true),
    inputSchema:shape({system_prompt:{type:'string',maxLength:4000},...(kind==='ask'?{question:{type:'string',minLength:1,maxLength:2000} as JsonSchema}:{})},kind==='ask'?['question']:[]),
    // Receipts retain only a reference, never generated confidential text or source excerpts.
    outputSchema:shape({analysis_id:str}),execute:async(ctx,target,input,execution)=>{
      const value=await generateCallAnalysis(principal(ctx),callId(target),{...input,operation_id:execution.receiptId});return {analysis_id:value.note.id};
    }});
}
