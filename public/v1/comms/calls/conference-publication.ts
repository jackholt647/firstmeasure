import {registerDataProvider} from '../../platform/publication/providers.js';
import {registerAction} from '../../platform/publication/actions.js';
import {backendImplementationDigest} from '../../platform/publication/implementation.js';
import type {AccessPolicy,JsonSchema,PublicationContext,TargetRef} from '../../platform/publication/contracts.js';
import {badRequest,forbidden} from '../../platform/errors.js';
import {requireCallAccess,projectContext} from './service.js';
import {callAction} from './voice.js';
import {participants,publicParticipants} from './conference.js';
import * as s from './storage.js';
const string:JsonSchema={type:'string'},shape=(properties:Record<string,JsonSchema>):JsonSchema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const person=shape(Object.fromEntries(['id','user_id','name','phone','state','invited_at','joined_at','ended_at','error'].map(k=>[k,string])));
const schema=shape({call_id:string,state:string,host_user_id:string,host_left_at:string,customer_hold_state:string,participants:{type:'array',items:person}});
function user(ctx:PublicationContext){if(!ctx.auth)throw forbidden('call_user_required','Conference controls require an authenticated member.');return ctx.auth;}
async function authorize(ctx:PublicationContext,target:TargetRef,write=false){
  if(!target.id)throw badRequest('call_id_required','Set target.id to the call.');
  const call=requireCallAccess(user(ctx),await s.readCall(ctx.organizationId,target.id),write);
  if(call.mode==='diagnostic')throw forbidden('call_diagnostic_private','Device checks are not published conference calls.');
  const project=target.projectId||ctx.projectId;if(project&&project!==call.project_id)throw forbidden('call_project_denied','This call is outside the requested project.');
  if(call.project_id)await projectContext(user(ctx),call.project_id);return call;
}
const access:AccessPolicy & {scopedPermissions:boolean}={scopes:['organization','project'],permissions:['view_comms'],capabilities:['apps.comms'],systemKinds:[],scopedPermissions:true,authorize:async(ctx,target)=>{await authorize(ctx,target);}};
let registered=false;
export function registerConferencePublication(){
  if(registered)return;registered=true;
  registerDataProvider({id:'customer-call-conference',version:'1',apps:['comms'],exports:{participants:{schema,schemaVersion:'1',access,argsSchema:shape({}),description:'Authorized conference participants, including prior participants, individual hold states and host departure. No provider controls or credentials.',authorizeSnapshot:async(ctx,ref,result)=>{if(result.provenance.viewerUserId!==user(ctx).userId||result.provenance.callId!==ref.target.id)throw forbidden('snapshot_viewer_denied','This conference snapshot is unavailable.');await authorize(ctx,ref.target);},read:async(ctx,ref)=>{const call=await authorize(ctx,ref.target);return {value:{call_id:call.id,state:call.state,host_user_id:call.owner_user_id,host_left_at:s.text(call.metadata.host_left_at),customer_hold_state:s.text(call.metadata.customer_hold_state)||'connected',participants:publicParticipants(await participants(ctx.organizationId,call.id)).map(p=>Object.fromEntries(Object.keys(person.properties!).map(k=>[k,s.text(p[k as keyof typeof p])])) )},provenance:{viewerUserId:user(ctx).userId,callId:call.id}};}}}});
  const commands={add:'add_participant',remove:'remove_participant',hold:'hold_participant',resume:'resume_participant',leave:'leave_conference',end:'hangup'};
  for(const [name,command]of Object.entries(commands))registerAction({id:`customer-calls.conference.${name}`,version:'1',implementation:backendImplementationDigest(),domain:'comms',description:name==='leave'?'Leave as host while at least two other connected people remain. The company call and billing continue.':name==='end'?'End the conference for everyone.':`${name} a conference participant through the authorized, idempotent call service. For hold/resume, participant_id=customer targets the original caller.`,inputSchema:{type:'object',properties:name==='add'?{target_user_id:{type:'string',maxLength:180},target_phone:{type:'string',maxLength:40},target_name:{type:'string',maxLength:250}}:['remove','hold','resume'].includes(name)?{participant_id:{type:'string',minLength:1,maxLength:180}}:{},...(['remove','hold','resume'].includes(name)?{required:['participant_id']} :{}),additionalProperties:false},outputSchema:shape({call_id:string,state:string}),policy:{...access,permissions:['make_calls'],authorize:async(ctx,target)=>{await authorize(ctx,target,true);}},effect:'external',executionKinds:['api','agent','module','work'],idempotency:'required',execute:async(ctx,target,input,execution)=>{const result=await callAction(user(ctx),target.id!,{...input,action:command,operation_id:execution.receiptId});return {call_id:result.call.id,state:result.call.state};}});
}
