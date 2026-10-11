import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {hasPermission} from '../../platform/auth.js';
import {badRequest,forbidden,notFound,PlatformError} from '../../platform/errors.js';
import {canUseScopedPermission,hasResourcePermission} from '../../workforce/department-access.js';
import {registerDataProvider,type DataExport} from '../../platform/publication/providers.js';
import {registerAction} from '../../platform/publication/actions.js';
import {backendImplementationDigest} from '../../platform/publication/implementation.js';
import {contentHash} from '../../platform/publication/validation.js';
import type {AccessPolicy,PublicationContext,TargetRef,JsonSchema} from '../../platform/publication/contracts.js';
import {assertPhoneAccess,assertManage,savePersonal,saveLine,saveGroup,saveMessaging,saveLead,saveMailbox,authorizeMailbox,trackingReport} from './service.js';
import {personalSchema,lineSchema,groupSchema,messagingPolicySchema,messagingInputSchema,leadInputSchema,mailboxInputSchema} from './contracts.js';
import {createPortDraft,portDraftSchema} from './porting.js';
import {projectContext,requireCallAccess} from '../calls/service.js';
import * as s from '../calls/storage.js';

const str=z.string(),revision=z.number().int().nonnegative(),meta={id:str,revision,updated_at:str};
const touch=z.object({enabled:z.boolean().default(false),number:str.default(''),label:str.default(''),source:str.default(''),medium:str.default(''),campaign:str.default(''),ad_id:str.default(''),landing_page:str.default(''),captured_at:str.default('')});
const score=z.object({spam_risk:str.nullable().default(null),spam_category:str.nullable().default(null),connection_score:z.number().nullable().default(null),engagement_score:z.number().nullable().default(null),sentiment_score:z.number().nullable().default(null),maturity_score:z.number().nullable().default(null),last_refreshed_at:str.nullable().default(null)});
const cost=z.object({monthly_cost:str.default(''),upfront_cost:str.default(''),currency:str.default('')});
const schemas={
  personal:personalSchema.extend(meta),
  line:z.object({...meta,phone_number:str,label:str,status:str,branch_id:str,config:lineSchema.nullable(),sms_status:str}),
  group:groupSchema.extend({...meta,branch_id:str}),
  messaging:messagingPolicySchema.extend(meta),
  lead:z.object({...meta,customer_number:str,project_id:str,contact_id:str,status:str,department_ids:z.array(str),first_call_id:str,last_call_id:str,first_seen:str,last_seen:str,first_touch:touch,last_touch:touch}),
  port:z.object({...meta,phone_number:str,label:str,branch_id:str,status:str,provider_status:str}),
  order:z.object({...meta,phone_number:str,label:str,branch_id:str,status:str}),
  reputation:z.object({...meta,phone_number:str,monitored:z.boolean(),reputation_data:score.nullable(),synced_at:str,history:z.array(score)}),
  reputation_settings:z.object({...meta,status:str,loa_status:str,check_frequency:str,synced_at:str,last_error:str}),
  greeting:z.object({...meta,owner_user_id:str,name:str,content_type:str}),
  voicemail:z.object({...meta,call_id:str,handled:z.boolean(),handled_by:str}),
  billing:z.object({...meta,phone_number:str,label:str,status:str,provider_cost:cost.nullable()})
};
type Kind=keyof typeof schemas;
const resourceKinds:Record<Kind,string>={personal:'phone_personal',line:'number',group:'phone_group',messaging:'phone_messaging',lead:'phone_lead',port:'phone_port',order:'phone_order',reputation:'phone_reputation_number',reputation_settings:'phone_reputation',greeting:'phone_greeting',voicemail:'phone_mailbox',billing:'number'};
const descriptions:Record<Kind,string>={
 personal:'Own work hours, availability, voicemail greeting, notifications, outgoing voicemail drop and power dial pool. Own user only; read has no side effects.',
 line:'Business numbers, assignments, routing, ring groups, department routing, tracking campaigns and SMS status. Manager access to each line; no provider credentials.',
 group:'Ring and department groups, members, hours and routing. Manager access to each group.',
 messaging:'Organization messaging windows, contact timezone policy, expiry, reply cancellation and automatic replies.',
 lead:'Tracking number attribution inquiries with first/last campaign touch, linked contact/project and qualification status. Manager and linked project access required.',
 port:'Local number port status. Excludes account numbers, PINs, documents and carrier references. Carrier submissions use the dedicated confirmed Phone Settings flow.',
 order:'Local number purchase status. No carrier requests or charges on read.',
 reputation:'Cached number reputation, nullable scores and recent history. No billable checks on read. Per-number manager access required.',
 reputation_settings:'Cached reputation registration, approval and polling status. Enterprise identifiers and authorization documents excluded.',
 greeting:'Own uploaded greeting metadata, for selecting a greeting or outgoing voicemail drop. No audio bytes or signed links.',
 voicemail:'Retained voicemail handled state. Read customer-calls.recordings or transcripts for authorized media; both source retention and recording permissions apply.',
 billing:'Recorded accepted carrier number costs; not a customer invoice or current quote. Billing permission required; subscriptions and charges use Platform Billing.'
};
const json=(schema:z.ZodTypeAny)=>zodToJsonSchema(schema,{$refStrategy:'none'}) as JsonSchema;
function principal(ctx:PublicationContext){if(!ctx.auth||ctx.auth.orgId!==ctx.organizationId)throw forbidden('phone_user_required','Phone publications require an authenticated organization member.');assertPhoneAccess(ctx.auth);return ctx.auth;}
function idFor(ctx:PublicationContext,target:TargetRef,kind:Kind){
 if(kind==='personal'){if(target.id&&target.id!==principal(ctx).userId)throw forbidden('phone_subject_denied','Only your own phone preferences are available.');return principal(ctx).userId;}
 if(kind==='messaging'||kind==='reputation_settings'){if(target.id&&target.id!=='default')throw badRequest('phone_id_invalid','This setting uses the default record.');return 'default';}
 if(!target.id)throw badRequest('phone_id_required','Choose a record ID or list the available records.');return target.id;
}
async function authorizeRow(ctx:PublicationContext,kind:Kind,id:string){
 const auth=principal(ctx);
 if(kind==='personal'){if(id!==auth.userId)throw forbidden('phone_subject_denied','Only your own preferences are available.');return;}
 if(kind==='voicemail'){await authorizeMailbox(auth,id);return;}
 const row=await s.resource(ctx.organizationId,resourceKinds[kind],id);
 if(!row&& !['messaging','reputation_settings'].includes(kind))throw notFound('phone_record_missing','This phone record is unavailable.');
 if(kind==='greeting'){if(row?.owner_user_id!==auth.userId)throw forbidden('phone_subject_denied','Only your own greetings are available.');return;}
 if(kind==='billing'){if(!hasPermission(auth,'view_platform_billing|manage_platform_billing|manage_billing'))throw forbidden('phone_billing_denied','You cannot view phone billing.');return;}
 const resource=kind==='line'||kind==='reputation'?{...await s.resource(ctx.organizationId,'number',id),...await s.resource(ctx.organizationId,'phone_line',id)}:row||{};
 if(kind==='reputation'&&!await s.resource(ctx.organizationId,'number',id))throw notFound('phone_number_missing','This number is no longer available.');
 assertManage(auth,resource);
 if(kind==='lead'&&row)for(const callId of s.strings([row.first_call_id,row.last_call_id]))requireCallAccess(auth,await s.readCall(ctx.organizationId,callId));
 if(row?.project_id)await projectContext(auth,s.text(row.project_id));
}
function policy(kind:Kind,creating=false):AccessPolicy{return {scopes:['organization'],permissions:[],scopedPermissions:true,capabilities:['apps.comms'],systemKinds:[],authorize:async(ctx,target)=>{
 const auth=principal(ctx);
 if(kind==='personal'||kind==='messaging'||kind==='reputation_settings')await authorizeRow(ctx,kind,idFor(ctx,target,kind));
 else if(target.id){if(creating&&!await s.resource(ctx.organizationId,resourceKinds[kind],target.id)){assertManage(auth);return;}await authorizeRow(ctx,kind,target.id);}
 else if(!['greeting','voicemail'].includes(kind)&&kind!=='billing'&&!canUseScopedPermission(auth,'manage_communications|manage_company_settings'))throw forbidden('phone_settings_denied','You cannot manage phone settings.');
 else if(kind==='billing'&&!hasPermission(auth,'view_platform_billing|manage_platform_billing|manage_billing'))throw forbidden('phone_billing_denied','You cannot view phone billing.');
 }};}
async function projectRow(ctx:PublicationContext,kind:Kind,id:string){
 await authorizeRow(ctx,kind,id);
 const row:s.Json=await s.resource(ctx.organizationId,resourceKinds[kind],id)||{id,revision:0,updated_at:''};
 const base={id,revision:Number(row.revision),updated_at:s.text(row.updated_at)};
 const texts=(keys:string[])=>Object.fromEntries(keys.map(k=>[k,s.text(row[k])]));
 let value:unknown;
 switch(kind){
 case 'personal':case 'group':case 'messaging':value={...row,...base,...(kind==='group'?{branch_id:s.text(row.branch_id)||'default'}:{})};break;
 case 'line':{const config=await s.resource(ctx.organizationId,'phone_line',id),sms=await s.resource(ctx.organizationId,'phone_sms',id);value={...base,revision:Number(config?.revision)||0,updated_at:s.text(config?.updated_at||row.updated_at),phone_number:id,label:s.text(config?.label||row.label)||id,status:s.text(row.status),branch_id:s.text(row.branch_id)||'default',config:config?lineSchema.parse(config):null,sms_status:s.text(sms?.assignment_status)};break;}
 case 'lead':value={...base,...texts(['customer_number','project_id','contact_id','status','first_call_id','last_call_id','first_seen','last_seen']),department_ids:s.strings(row.department_ids),first_touch:touch.parse(s.object(row.first_touch)),last_touch:touch.parse(s.object(row.last_touch))};break;
 case 'port':case 'order':value={...base,...texts(['phone_number','label','branch_id','status',...(kind==='port'?['provider_status']:[])])};break;
 case 'reputation':value={...base,phone_number:id,monitored:row.monitored===true,reputation_data:row.reputation_data?score.parse(row.reputation_data):null,synced_at:s.text(row.synced_at),history:Array.isArray(row.history)?row.history.map(v=>score.parse(v)):[]};break;
 case 'reputation_settings':value={...base,...texts(['status','loa_status','check_frequency','synced_at','last_error'])};break;
 case 'greeting':value={...base,...texts(['owner_user_id','name','content_type'])};break;
 case 'voicemail':value={...base,call_id:id,handled:row.handled===true,handled_by:s.text(row.handled_by)};break;
 case 'billing':value={...base,phone_number:id,...texts(['label','status']),provider_cost:row.accepted_cost?cost.parse(row.accepted_cost):null};break;
 }
 return schemas[kind].parse(value);
}
let registered=false;
export function registerPhonePublication(){
 if(registered)return;registered=true;
 const exports:Record<string,DataExport>={};
 for(const kind of Object.keys(schemas) as Kind[]){
  const singleton=['personal','messaging','reputation_settings'].includes(kind);
  exports[kind]={schema:json(schemas[kind]),schemaVersion:'1',description:descriptions[kind],access:policy(kind),
   read:async(ctx,ref)=>{const id=idFor(ctx,ref.target,kind),value=await projectRow(ctx,kind,id);return {value,revision:contentHash(value),provenance:{viewer:principal(ctx).userId,ids:[id]}};},
   authorizeSnapshot:async(ctx,_ref,result)=>{if(result.provenance.viewer!==principal(ctx).userId||!Array.isArray(result.provenance.ids))throw forbidden('phone_snapshot_denied','This snapshot cannot be authorized.');for(const id of result.provenance.ids)await authorizeRow(ctx,kind,s.text(id));},
   ...(!singleton?{list:async(ctx:PublicationContext,ref:Parameters<NonNullable<DataExport['list']>>[1],page:{limit:number;cursor?:string})=>{
    const signature=contentHash({kind,target:ref.target,viewer:principal(ctx).userId,branch:principal(ctx).branchId});let after='';
    if(page.cursor)try{const c=JSON.parse(Buffer.from(page.cursor,'base64url').toString());if(c.signature!==signature||typeof c.after!=='string')throw Error();after=c.after;}catch{throw badRequest('phone_cursor_invalid','This continuation belongs to another query.');}
    let ids:string[];
    if(ref.target.id)ids=[ref.target.id];
    else if(kind==='voicemail')ids=(await s.database().prepare("SELECT DISTINCT call_id FROM customer_call_artifacts WHERE organization_id=? AND kind='voicemail' AND state='ready' AND expires_at>?").all(ctx.organizationId,s.now())).map(r=>s.text(s.object(r).call_id));
    else ids=(await s.resources(ctx.organizationId,resourceKinds[kind])).map(r=>r.id);
    const items:unknown[]=[],selected:string[]=[];
    for(const id of ids.sort().filter(id=>id>after)){try{const value=await projectRow(ctx,kind,id);items.push(value);selected.push(id);if(items.length>page.limit)break;}catch(error){if(!(error instanceof PlatformError)||![403,404].includes(error.statusCode))throw error;}}
    return {items:items.slice(0,page.limit),...(items.length>page.limit?{nextCursor:Buffer.from(JSON.stringify({signature,after:selected[page.limit-1]})).toString('base64url')}:{})};
   }}:{})
  };
 }
 const reportSchema=z.object({from:str,to:str,projects:z.array(z.object({id:str,label:str})),
  sources:z.array(z.object({number:str,source:str,medium:str,campaign:str,ad_id:str,calls:z.number(),answered:z.number(),missed:z.number(),voicemails:z.number(),talk_seconds:z.number(),unique_callers:z.number(),new_leads:z.number(),qualified:z.number(),converted:z.number()})),
  calls:z.array(z.object({id:str,created_at:str,customer_number:str,project_id:str,state:str,attribution:touch})),leads:z.array(schemas.lead)});
 exports.tracking_report={description:'Tracking number call and lead attribution report for from/to ISO timestamps (exclusive end; maximum 366 days). First-touch lead counts and current qualification status; static tracking numbers, not dynamic number insertion.',schema:json(reportSchema),schemaVersion:'1',argsSchema:json(z.object({from:str,to:str})),access:policy('lead'),
  read:async(ctx,ref)=>{const report=await trackingReport(principal(ctx),s.text(ref.args?.from),s.text(ref.args?.to));
   const value=reportSchema.parse({...report,leads:await Promise.all(report.leads.map(r=>projectRow(ctx,'lead',r.id)))});
   return {value,revision:contentHash(value),provenance:{viewer:principal(ctx).userId,callIds:value.calls.map(c=>c.id),leadIds:value.leads.map(l=>l.id),projectIds:value.projects.map(p=>p.id)}};},
  authorizeSnapshot:async(ctx,_ref,result)=>{assertManage(principal(ctx));const p=result.provenance;if(p.viewer!==principal(ctx).userId||![p.callIds,p.leadIds,p.projectIds].every(Array.isArray))throw forbidden('phone_snapshot_denied','This report snapshot cannot be authorized.');
   for(const id of p.callIds as string[]){const call=requireCallAccess(principal(ctx),await s.readCall(ctx.organizationId,id));if(call.project_id)await projectContext(principal(ctx),call.project_id);}
   for(const id of p.leadIds as string[])await authorizeRow(ctx,'lead',id);
   for(const id of p.projectIds as string[])await projectContext(principal(ctx),id);
  }};
 registerDataProvider({id:'phone-settings',version:'1',apps:['settings','comms'],exports});
 const definitions=[
  {name:'personal.save',kind:'personal' as Kind,schema:personalSchema,write:(ctx:PublicationContext,_id:string,input:unknown)=>savePersonal(principal(ctx),input)},
  {name:'line.save',kind:'line' as Kind,schema:lineSchema,write:(ctx:PublicationContext,id:string,input:unknown)=>saveLine(principal(ctx),id,input)},
  {name:'group.save',kind:'group' as Kind,schema:groupSchema,write:(ctx:PublicationContext,id:string,input:unknown)=>saveGroup(principal(ctx),id,input)},
  {name:'messaging.save',kind:'messaging' as Kind,schema:messagingInputSchema,write:(ctx:PublicationContext,_id:string,input:unknown)=>saveMessaging(principal(ctx),input)},
  {name:'lead.save',kind:'lead' as Kind,schema:leadInputSchema,write:(ctx:PublicationContext,id:string,input:unknown)=>saveLead(principal(ctx),id,input)},
  {name:'voicemail.handle',kind:'voicemail' as Kind,schema:mailboxInputSchema,write:(ctx:PublicationContext,id:string,input:unknown)=>saveMailbox(principal(ctx),id,input)}
 ];
 const output=z.object({id:str,revision});
 for(const def of definitions)registerAction({id:`phone-settings.${def.name}`,version:'1',implementation:backendImplementationDigest(),domain:'phone-settings',description:`Update ${def.kind} using the same validation as Phone Settings. Supply the current revision; replacement settings use the documented defaults for omitted fields.`,inputSchema:json(def.schema),outputSchema:json(output),effect:'write',executionKinds:['api','agent','module','work'],idempotency:'required',policy:policy(def.kind,def.kind==='group'),validateInput:input=>{def.schema.parse(input);},execute:async(ctx,target,input)=>{const value=await def.write(ctx,idFor(ctx,target,def.kind),input);return {id:value.id,revision:value.revision};}});
 const draft=portDraftSchema.omit({operation_id:true});
 registerAction({id:'phone-settings.port.draft',version:'1',implementation:backendImplementationDigest(),domain:'phone-settings',description:'Create a local porting draft. Does not contact the carrier, transfer a number, submit credentials or incur charges. Continue in Phone Settings for carrier confirmation.',inputSchema:json(draft),outputSchema:json(output),effect:'write',executionKinds:['api','agent','module','work'],idempotency:'required',policy:policy('port'),validateInput:input=>{draft.parse(input);},execute:async(ctx,_target,input,execution)=>{const row=await createPortDraft(principal(ctx),{...input,operation_id:execution.receiptId});return {id:row.id,revision:row.revision};}});
}
