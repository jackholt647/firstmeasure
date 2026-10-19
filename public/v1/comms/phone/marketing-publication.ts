import {sourceSchema,poolSchema,broadcastSchema,audienceSchema,broadcastCommandSchema} from './marketing-contracts.js';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {registerDataProvider,type DataExport} from '../../platform/publication/providers.js';
import {registerAction} from '../../platform/publication/actions.js';
import {backendImplementationDigest} from '../../platform/publication/implementation.js';
import {contentHash} from '../../platform/publication/validation.js';
import type {PublicationContext,AccessPolicy,JsonSchema,SourceRef} from '../../platform/publication/contracts.js';
import {badRequest,forbidden,notFound} from '../../platform/errors.js';
import {requireCallAccess,projectContext} from '../calls/service.js';
import {assertManage,assertPhoneAccess} from './service.js';
import {saveSource,savePool,authorizePool,trackingCalls,trackingVisits,trackingQuerySchema} from './tracking.js';
import {saveBroadcast,addAudience,commandBroadcast,previewBroadcast,broadcastRecipients,broadcastReport,campaign} from './broadcast.js';
import * as s from '../calls/storage.js';

const str=z.string(),meta={id:str,revision:z.number(),updated_at:str};
export const marketingAttributionSchema=z.object(Object.fromEntries(['number','source','medium','campaign','ad_id','landing_page','captured_at','lead_source_id','marketing_campaign_id','pool_id','visit_id','attribution_kind','keyword','referrer_host'].map(k=>[k,str.default('')]))).extend({enabled:z.boolean().default(false)});
const callSchema=z.object({id:str,created_at:str,customer_number:str,business_number:str,contact_id:str,project_id:str,state:str,connected_at:str,ended_at:str,attribution:marketingAttributionSchema});
const visitSchema=z.object({id:str,phone_number:str,lease_until:str,reuse_after:str,created_at:str,updated_at:str,attribution:marketingAttributionSchema});
const recipientSchema=z.object({id:str,address:str,name:str,first_name:str,last_name:str,company_name:str,project_id:str,contact_id:str,state:str,reason:str,message_id:str,replied_at:str,opted_out_at:str,deliveries:z.array(z.object({id:str,status:str,sent_at:str,delivered_at:str,failed_at:str}))});
const sourceRecord=sourceSchema.extend(meta).strip(),poolRecord=poolSchema.extend(meta).strip(),broadcastRecord=broadcastSchema.extend({...meta,status:str,started_at:str,owner_user_id:str,last_error:str,sender_number:str}).strip();
const reportSchema=z.object({id:str,status:str,label:str,started_at:str,last_error:str,counts:z.object(Object.fromEntries(['total','pending','queued','sent','delivered','failed','skipped','canceled','replied','opted_out'].map(k=>[k,z.number()]))) });
const json=(schema:z.ZodTypeAny)=>zodToJsonSchema(schema,{$refStrategy:'none'}) as JsonSchema;
function principal(ctx:PublicationContext){if(!ctx.auth||ctx.auth.orgId!==ctx.organizationId)throw forbidden('phone_user_required');assertPhoneAccess(ctx.auth);assertManage(ctx.auth);return ctx.auth;}
const policy:AccessPolicy={scopes:['organization'],permissions:[],scopedPermissions:true,capabilities:['apps.comms'],systemKinds:[],authorize:c=>{principal(c);}};
function targetId(ref:SourceRef){if(!ref.target.id)throw badRequest('phone_id_required');return ref.target.id;}
function binding(ctx:PublicationContext,ref:SourceRef,cursor=''){const signature=s.digest({org:ctx.organizationId,user:principal(ctx).userId,kind:ref.export,args:ref.args,target:ref.target.id});let after='';if(cursor){let value:s.Json={};try{value=s.object(JSON.parse(Buffer.from(cursor,'base64url').toString()));}catch{throw badRequest('phone_cursor_invalid');}if(value.signature!==signature)throw badRequest('phone_cursor_invalid');after=s.text(value.after);}return {after,wrap:(after:string)=>Buffer.from(JSON.stringify({signature,after})).toString('base64url')};}
async function record(ctx:PublicationContext,kind:string,id:string){const auth=principal(ctx),row=await s.resource(ctx.organizationId,kind,id);if(!row)throw notFound('phone_record_missing');if(kind==='phone_tracking_pool')await authorizePool(auth,row);else assertManage(auth,row);return row;}
async function call(ctx:PublicationContext,id:string){const c=requireCallAccess(principal(ctx),await s.readCall(ctx.organizationId,id));if(!s.object(c.metadata.attribution).enabled)throw notFound('tracking_call_missing');if(c.project_id)await projectContext(principal(ctx),c.project_id);return callSchema.parse({...c,attribution:s.object(c.metadata.attribution)});}
let registered=false;
export function registerPhoneMarketingPublication(){
 if(registered)return;registered=true;
 const exports:Record<string,DataExport>={};
 for(const [kind,resource,schema]of [['source','phone_tracking_source',sourceRecord],['pool','phone_tracking_pool',poolRecord],['broadcast','phone_broadcast',broadcastRecord]] as const){
  const project=(row:s.Json)=>schema.parse(kind==='broadcast'?{...row,started_at:row.started_at||'',last_error:row.last_error||''}:row);
  exports[kind]={schema:json(schema),schemaVersion:'1',description:`Permission-checked ${kind} configuration. No provider secrets or visitor keys.`,access:policy,
   read:async(ctx,ref)=>{const value=project(await record(ctx,resource,targetId(ref)));return {value,revision:contentHash(value),provenance:{ids:[value.id]}};},
   authorizeSnapshot:async(ctx,_ref,result)=>{for(const id of s.strings(result.provenance.ids))await record(ctx,resource,id);},
   list:async(ctx,ref,page)=>{const cursor=binding(ctx,ref,page.cursor),rows=(await s.resources(ctx.organizationId,resource)).sort((a,b)=>a.id.localeCompare(b.id)).filter(r=>r.id>cursor.after),items:unknown[]=[];let last='';for(const row of rows){last=row.id;try{items.push(project(await record(ctx,resource,row.id)));}catch{continue;}if(items.length===page.limit)break;}return {items,...(rows.some(r=>r.id>last)?{nextCursor:cursor.wrap(last)}:{})};}
  };
 }
 exports.call={schema:json(callSchema),schemaVersion:'1',argsSchema:json(trackingQuerySchema.partial()),description:'Tracked calls with immutable source/campaign/visitor attribution. List using from/to and optional number/source/campaign/pool/visit filters.',access:policy,
  read:async(ctx,ref)=>{const value=await call(ctx,targetId(ref));return {value,revision:contentHash(value),provenance:{ids:[value.id]}};},authorizeSnapshot:async(ctx,_ref,result)=>{for(const id of s.strings(result.provenance.ids))await call(ctx,id);},
  list:async(ctx,ref,page)=>{const value=await trackingCalls(principal(ctx),ref.args,page.limit,page.cursor);return {...value,items:value.items.map(r=>callSchema.parse(r))};}};
 exports.visit={schema:json(visitSchema),schemaVersion:'1',argsSchema:json(z.object({pool_id:str})),description:'Visitor assignment history with sanitized observed source data. Visitor cookie keys, IP addresses and full URL queries are excluded.',access:policy,
  read:async(ctx,ref)=>{const pool=s.text(ref.args?.pool_id);await record(ctx,'phone_tracking_pool',pool);const raw=s.object(await s.database().prepare('SELECT * FROM phone_tracking_sessions WHERE organization_id=? AND pool_id=? AND id=?').get(ctx.organizationId,pool,targetId(ref)));if(!raw.id)throw notFound('tracking_visit_missing');const value=visitSchema.parse({...raw,attribution:JSON.parse(s.text(raw.attribution_json))});return {value,revision:contentHash(value),provenance:{pool,visit:value.id}};},
  authorizeSnapshot:async(ctx,_ref,result)=>{await record(ctx,'phone_tracking_pool',s.text(result.provenance.pool));if(!await s.database().prepare('SELECT id FROM phone_tracking_sessions WHERE organization_id=? AND pool_id=? AND id=?').get(ctx.organizationId,s.text(result.provenance.pool),s.text(result.provenance.visit)))throw notFound('tracking_visit_expired');},
  list:async(ctx,ref,page)=>{const bound=binding(ctx,ref,page.cursor),value=await trackingVisits(principal(ctx),s.text(ref.args?.pool_id),page.limit,bound.after);return {items:value.items.map(v=>visitSchema.parse(v)),...(value.nextCursor?{nextCursor:bound.wrap(value.nextCursor)}:{})};}};
 exports.recipient={schema:json(recipientSchema),schemaVersion:'1',argsSchema:json(z.object({broadcast_id:str})),description:'Campaign recipient preparation, delivery and response status. Rechecks access to each linked contact/project.',access:policy,
  read:async(ctx,ref)=>{const broadcast=s.text(ref.args?.broadcast_id);await campaign(principal(ctx),broadcast);const row=s.object(await s.database().prepare('SELECT recipient_json FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=? AND id=?').get(ctx.organizationId,broadcast,targetId(ref)));if(!row.recipient_json)throw notFound('broadcast_recipient_missing');const r=s.object(JSON.parse(s.text(row.recipient_json)));await projectContext(principal(ctx),s.text(r.project_id));const page=await broadcastRecipients(principal(ctx),broadcast,200);let value=page.items.find(v=>v.id===ref.target.id);let cursor=page.nextCursor;while(!value&&cursor){const next=await broadcastRecipients(principal(ctx),broadcast,200,cursor);value=next.items.find(v=>v.id===ref.target.id);cursor=next.nextCursor;}if(!value)throw notFound('broadcast_recipient_missing');const safe=recipientSchema.parse(value);return {value:safe,revision:contentHash(safe),provenance:{broadcast,project:r.project_id,recipient:safe.id}};},
  authorizeSnapshot:async(ctx,_ref,result)=>{await campaign(principal(ctx),s.text(result.provenance.broadcast));if(!await s.database().prepare('SELECT id FROM phone_broadcast_recipients WHERE organization_id=? AND campaign_id=? AND id=?').get(ctx.organizationId,s.text(result.provenance.broadcast),s.text(result.provenance.recipient)))throw notFound('broadcast_recipient_missing');await projectContext(principal(ctx),s.text(result.provenance.project));},
  list:async(ctx,ref,page)=>{const bound=binding(ctx,ref,page.cursor),value=await broadcastRecipients(principal(ctx),s.text(ref.args?.broadcast_id),page.limit,bound.after);return {items:value.items.map(v=>recipientSchema.parse(v)),...(value.nextCursor?{nextCursor:bound.wrap(value.nextCursor)}:{})};}};
 exports.broadcast_report={schema:json(reportSchema),schemaVersion:'1',description:'Live campaign delivery, skipped, reply and opt-out totals. Aggregates recheck linked project access.',access:policy,
  read:async(ctx,ref)=>{const value=reportSchema.parse(await broadcastReport(principal(ctx),targetId(ref)));return {value,revision:contentHash(value),provenance:{broadcast:value.id}};},authorizeSnapshot:async(ctx,_ref,result)=>{await broadcastReport(principal(ctx),s.text(result.provenance.broadcast));}};
 registerDataProvider({id:'phone-marketing',version:'1',apps:['settings','comms'],exports});
 const output=z.object({id:str,revision:z.number()});
 const actions=[
  {id:'source.save',schema:sourceSchema,run:(ctx:PublicationContext,id:string,input:unknown)=>saveSource(principal(ctx),id,input)},
  {id:'pool.save',schema:poolSchema,run:(ctx:PublicationContext,id:string,input:unknown)=>savePool(principal(ctx),id,input)},
  {id:'broadcast.save',schema:broadcastSchema,run:(ctx:PublicationContext,id:string,input:unknown)=>saveBroadcast(principal(ctx),id,input)},
  {id:'broadcast.audience.add',schema:audienceSchema,run:(ctx:PublicationContext,id:string,input:unknown)=>addAudience(principal(ctx),id,input)},
  {id:'broadcast.control',schema:broadcastCommandSchema,run:(ctx:PublicationContext,id:string,input:unknown)=>commandBroadcast(principal(ctx),id,input)}
 ];
 for(const def of actions)registerAction({id:'phone-marketing.'+def.id,version:'1',implementation:backendImplementationDigest(),domain:'phone-marketing',description:`${def.id} through the phone domain service. Revision and current organization/record permissions are required.`,inputSchema:json(def.schema),outputSchema:json(output),effect:def.id==='broadcast.control'?'external':'write',executionKinds:['api','agent','module','work'],idempotency:'required',policy,validateInput:i=>{def.schema.parse(i);},execute:async(ctx,target,input)=>{if(!target.id)throw badRequest('phone_id_required');const value=await def.run(ctx,target.id,input);return {id:value.id,revision:value.revision};}});
 registerAction({id:'phone-marketing.broadcast.preview',version:'1',implementation:backendImplementationDigest(),domain:'phone-marketing',description:'Preview rendered messages, eligibility and skip reasons without sending or changing campaign state.',inputSchema:json(z.object({limit:z.number().int().min(1).max(500).optional(),cursor:str.optional()}).strict()),outputSchema:json(z.object({id:str,revision:z.number(),total:z.number(),examined:z.number(),nextCursor:str,eligible:z.number(),skipped:z.number(),reasons:z.record(z.number()),samples:z.array(z.object({name:str,text:str,eligible:z.boolean(),reason:str}))})),effect:'read',executionKinds:['api','agent','module','work'],idempotency:'none',policy,execute:async(ctx,target,input)=>{if(!target.id)throw badRequest('phone_id_required');return previewBroadcast(principal(ctx),target.id,Number(input.limit)||500,s.text(input.cursor));}});
}
