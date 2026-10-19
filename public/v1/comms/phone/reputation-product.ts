import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PlatformAuthContext} from '../../platform/auth.js';
import {canManageTestAppFlags} from '../../platform/app_flags.js';
import {badRequest,conflict,forbidden} from '../../platform/errors.js';
import {voiceClient} from '../../telephony/telnyx.js';
import {TelnyxError} from '../../messaging/telnyx.js';
import {carrierWritesAllowed} from './porting.js';
import {assertManage} from './service.js';
import * as s from '../calls/storage.js';

export const reputationCapability='comms.reputation';
export const frequencies=['business_daily','daily','weekly','biweekly','monthly','never'] as const;
export const industries=['accounting','finance','billing','collections','business','charity','nonprofit','communications','telecom','customer service','support','delivery','shipping','logistics','education','financial','banking','government','public','healthcare','health','pharmacy','medical','insurance','legal','law','notifications','scheduling','real estate','property','retail','ecommerce','sales','marketing','software','technology','tech','media','surveys','market research','travel','hospitality','hotel'] as const;
const text=z.string().trim().min(1).max(255),phone=z.string().regex(/^\+1[2-9]\d{9}$/),revision=z.number().int().nonnegative();
const contact=z.object({first_name:text,last_name:text,email:z.string().email().max(255),phone_number:z.string().regex(/^\+[1-9]\d{7,14}$/)}).strict();
const address=z.object({street_address:text,extended_address:z.string().max(255).default(''),city:text,administrative_area:text,postal_code:text,country:z.enum(['US','CA'])}).strict();
export const businessSchema=z.object({legal_name:text.min(3).max(64),doing_business_as:text,organization_type:z.enum(['commercial','government','non_profit']),organization_legal_type:z.enum(['corporation','llc','partnership','nonprofit','other']),country_code:z.enum(['US','CA']),jurisdiction_of_incorporation:text,website:z.string().url().refine(v=>/^https?:\/\//.test(v)),industry:z.enum(industries),number_of_employees:z.enum(['1-10','11-50','51-200','201-500','501-2000','2001-10000','10001+']),organization_contact:contact.extend({job_title:text}),billing_contact:contact,organization_physical_address:address,billing_address:address}).strict();
const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export const account=(org:string)=>s.resource(org,'phone_reputation_account');
export async function enterpriseId(org:string){
 const own=await account(org);if(own?.enterprise_id)return s.text(own.enterprise_id);
 let map:s.Json={};try{map=s.object(JSON.parse(process.env.TELNYX_REPUTATION_ENTERPRISES||'{}'));}catch{}
 const id=s.text(map[org]);if(id&&(!/^[a-zA-Z0-9-]{1,100}$/.test(id)||Object.values(map).filter(v=>v===id).length!==1))throw conflict('reputation_enterprise_conflict','The business registration mapping needs operator review.');return id;
}
export async function reputationRoot(org:string){const id=await enterpriseId(org);if(!id)throw conflict('reputation_setup_required','Complete your business registration first.');return `/enterprises/${encodeURIComponent(id)}/reputation`;}
function carrier(){if(!carrierWritesAllowed())throw forbidden('reputation_development_read_only','Carrier enrollment and paid checks are disabled in development. You can prepare business details here.');}
export function onboardingPermission(ctx:PlatformAuthContext){assertManage(ctx);}
export async function saveBusiness(ctx:PlatformAuthContext,input:unknown){
 assertManage(ctx);const v=z.object({revision,profile:businessSchema}).strict().parse(input);const old=await account(ctx.orgId);
 if(old?.enterprise_id||old?.busy)throw conflict('reputation_business_locked','The registered business is locked. Use Correct business details to resubmit it.');
 return s.saveResource(ctx.orgId,'phone_reputation_account','default',{...old,profile:v.profile,status:'draft'},'',v.revision);
}
/** Persist intent before carrier writes. A lost response is never blindly retried.
 * One company operation at a time also protects paid enrollment and cancellation. */
export async function operation(org:string,key:string,action:string,input:unknown,actor:string,run:()=>Promise<s.Json>,quantity=1){
 z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).parse(key);const digest=hash({action,input});let replay:s.Json|null=null;
 await s.transaction(async()=>{
  const old=await s.resource(org,'phone_reputation_operation',key);
  if(old){if(old.digest!==digest)throw conflict('reputation_operation_conflict','This request was already used for a different change.');if(old.state==='completed'){replay=s.object(old.result);return;}throw conflict('reputation_operation_pending','Refresh to reconcile the earlier carrier request before trying again.');}
  const a=await account(org);if(a?.busy)throw conflict('reputation_operation_pending','Another reputation request is being processed. Refresh its status first.');
  await s.saveResource(org,'phone_reputation_operation',key,{action,digest,request:input,state:'running',actor,started_at:s.now(),quantity});
  await s.saveResource(org,'phone_reputation_account','default',{...a,busy:key});
 });
 if(replay)return replay;
 try{
  const result=await run();
  await s.transaction(async()=>{const op=(await s.resource(org,'phone_reputation_operation',key))!;await s.saveResource(org,'phone_reputation_operation',key,{...op,state:'completed',result,completed_at:s.now()});const a=await account(org);await s.saveResource(org,'phone_reputation_account','default',{...a,busy:''});});
  return result;
 }catch(e){
  // A rejection before any known provider effect can be retried with a new request. Network/5xx and local commit failures remain uncertain.
  const op=(await s.resource(org,'phone_reputation_operation',key))!;
  const rejected=!op.provider_effect&&e instanceof TelnyxError&&e.statusCode>=400&&e.statusCode<500;
  await s.saveResource(org,'phone_reputation_operation',key,{...op,state:rejected?'rejected':'uncertain'});
  if(rejected){const a=await account(org);await s.saveResource(org,'phone_reputation_account','default',{...a,busy:''});}
  throw e;
 }
}
export async function productWorkspace(ctx:PlatformAuthContext){
 assertManage(ctx);const a=await account(ctx.orgId);
 return {account:a?{revision:a.revision,profile:a.profile||null,status:a.status||'draft',busy:!!a.busy,loa_version:a.loa_version||'',signed_at:a.signed_at||'',signer_name:a.signer_name||'',schedule:a.schedule||'never',next_check_at:a.next_check_at||'',last_error:a.last_error||'',disabled_at:a.disabled_at||''}:null,
  operator:canManageTestAppFlags(ctx),industries,
  remediation:(await s.resources(ctx.orgId,'phone_reputation_remediation')).map(r=>({id:r.id,status:r.status,numbers:r.numbers,call_purpose:r.call_purpose,created_at:r.created_at,results:r.results||null})),
  operations:(await s.resources(ctx.orgId,'phone_reputation_operation')).filter(r=>['uncertain','running','rejected'].includes(s.text(r.state))).map(r=>({id:r.id,action:r.action,state:r.state,started_at:r.started_at}))};
}
export async function carrierTerms(ctx:PlatformAuthContext,accept=false){
 if(!canManageTestAppFlags(ctx))throw forbidden('reputation_operator_required','Only the platform operator can accept carrier account terms.');carrier();
 if(accept)await voiceClient().request('/terms_of_service/number_reputation/agree','POST');
 return voiceClient().request('/terms_of_service/status?product_type=number_reputation');
}
export async function registerBusiness(ctx:PlatformAuthContext,input:unknown){
 onboardingPermission(ctx);carrier();const v=z.object({operation_id:text,revision,fein:z.string().regex(/^\d{2}-?\d{7}$/)}).strict().parse(input);
 const a=await account(ctx.orgId);if(await enterpriseId(ctx.orgId))throw conflict('reputation_already_registered','This company is already registered.');if(!a?.profile||a.revision!==v.revision)throw conflict('settings_revision_conflict','Save and refresh your business details first.');
 const profile=businessSchema.parse(a.profile),reference=`FirstMate-reputation-${hash(ctx.orgId).slice(0,32)}`;
 // Registration is free. The EIN is sent directly and never persisted in local state or receipts.
 return operation(ctx.orgId,v.operation_id,'register',{profile,revision:v.revision,fein_hash:hash(v.fein)},ctx.userId,async()=>{
  const value=await voiceClient().data('/enterprises','POST',{...profile,fein:v.fein,customer_reference:reference});if(!value.id)throw Error('Carrier registration needs reconciliation.');
  await bindEnterprise(ctx.orgId,s.text(value.id),reference);return {registered:true};
 });
}
async function bindEnterprise(org:string,id:string,reference:string){
 let map:s.Json={};try{map=s.object(JSON.parse(process.env.TELNYX_REPUTATION_ENTERPRISES||'{}'));}catch{}
 if(Object.entries(map).some(([key,value])=>key!==org&&value===id))throw conflict('reputation_enterprise_owned');
 await s.transaction(async()=>{const owner=await s.resourceByProvider('phone_reputation_account',id);if(owner&&owner.organization_id!==org)throw conflict('reputation_enterprise_owned','This business registration is linked to another company.');const a=await account(org);await s.saveResource(org,'phone_reputation_account','default',{...a,enterprise_id:id,customer_reference:reference,status:'registered'},id);});
}
export async function renderAuthorization(ctx:PlatformAuthContext,input:unknown={}){
 assertManage(ctx);carrier();const a0=await account(ctx.orgId);if(a0?.busy)throw conflict('reputation_operation_pending');
 const v=z.object({loa_version:z.string().optional(),signer_name:z.string().min(1).max(255).optional(),signature:z.string().max(1500000).optional()}).strict().parse(input);
 if(v.signature&&(!v.signer_name||!a0?.loa_version||v.loa_version!==a0.loa_version))throw conflict('reputation_loa_stale','Review the current authorization before signing.');
 if(v.signature){const png=Buffer.from(v.signature,'base64');if(png.length>1000000||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw badRequest('reputation_signature_invalid','Draw your signature in the signature box.');}
 const root=await reputationRoot(ctx.orgId),file=await voiceClient().pdf(root+'/loa',v.signature?{signature:{image_base64:v.signature,signer_name:v.signer_name}}:{});
 const version=v.signature?s.text(a0?.loa_version):hash(file.toString('base64'));const a=await account(ctx.orgId);if(a?.busy||a?.revision!==a0?.revision)throw conflict('reputation_loa_stale','Business details changed. Review the current authorization again.');await s.saveResource(ctx.orgId,'phone_reputation_account','default',{...a,loa_version:version,loa_rendered_at:s.now()},'',a?.revision||0);return {file,version};
}
export async function submitAuthorization(ctx:PlatformAuthContext,input:unknown){
 onboardingPermission(ctx);carrier();
 const v=z.object({operation_id:text,loa_version:text,signer_name:text,authorized:z.literal(true),terms_accepted:z.literal(true),file:z.string().min(8).max(11200000)}).strict().parse(input);
 const a=await account(ctx.orgId);if(!a?.loa_version||a.loa_version!==v.loa_version)throw conflict('reputation_loa_stale','Download and review the current authorization before signing.');
 const file=Buffer.from(v.file,'base64');if(file.length>8*1024*1024||file.subarray(0,5).toString()!=='%PDF-')throw badRequest('reputation_loa_invalid','Upload the signed authorization as a PDF up to 8 MB.');
 const root=await reputationRoot(ctx.orgId);const current=await voiceClient().data(root).catch(e=>{if(e instanceof TelnyxError&&e.statusCode===404)return null;throw e;});
 if(current?.loa_status==='approved')throw conflict('reputation_loa_locked','Your authorization is already approved.');
 return operation(ctx.orgId,v.operation_id,'authorize',{loa_version:v.loa_version,signer_name:v.signer_name,file_hash:hash(v.file)},ctx.userId,async()=>{
  const document=await voiceClient().data('/documents','POST',{file:v.file,filename:'reputation-authorization.pdf',customer_reference:`FirstMate-reputation-${hash(ctx.orgId).slice(0,32)}`});if(!document.id)throw Error('Authorization upload needs review.');
  await s.saveResource(ctx.orgId,'phone_reputation_account','default',{...await account(ctx.orgId),loa_document_id:document.id,signed_at:s.now(),signer_name:v.signer_name,signed_by:ctx.userId,signed_hash:hash(v.file),accepted_terms:'https://telnyx.com/terms/reputation-services'});
  await voiceClient().request(current?root+'/loa':root,current?'PATCH':'POST',{loa_document_id:document.id,...(!current?{check_frequency:'never'}:{})});
  await s.saveResource(ctx.orgId,'phone_reputation_account','default',{...await account(ctx.orgId),status:'pending',disabled_at:''});return {submitted:true};
 });
}
export async function correctBusiness(ctx:PlatformAuthContext,input:unknown){
 onboardingPermission(ctx);carrier();const v=z.object({operation_id:text,profile:businessSchema,fein:z.string().regex(/^\d{2}-?\d{7}$/),confirmed:z.literal(true)}).strict().parse(input);const id=await enterpriseId(ctx.orgId);if(!id)throw conflict('reputation_setup_required');
 const settings=await voiceClient().data(await reputationRoot(ctx.orgId));if(settings.status!=='rejected')throw conflict('reputation_business_locked','Corrections are available when business vetting is rejected.');
 return operation(ctx.orgId,v.operation_id,'correct',{profile:v.profile,fein_hash:hash(v.fein)},ctx.userId,async()=>{
  await voiceClient().request(await reputationRoot(ctx.orgId),'DELETE');
  const attempt=(await s.resource(ctx.orgId,'phone_reputation_operation',v.operation_id))!;await s.saveResource(ctx.orgId,'phone_reputation_operation',v.operation_id,{...attempt,provider_effect:true});
  await voiceClient().request(`/enterprises/${encodeURIComponent(id)}`,'PUT',{...v.profile,fein:v.fein,customer_reference:(await account(ctx.orgId))?.customer_reference});
  await s.saveResource(ctx.orgId,'phone_reputation','default',{status:'',loa_status:'',check_frequency:'never'});
  await s.saveResource(ctx.orgId,'phone_reputation_account','default',{...await account(ctx.orgId),profile:v.profile,loa_version:'',signed_at:'',status:'registered'});return {corrected:true};
 });
}
export async function remediation(ctx:PlatformAuthContext,input:unknown){
 onboardingPermission(ctx);carrier();
 const v=z.object({operation_id:text,phone_numbers:z.array(phone).min(1).max(100),call_purpose:z.string().trim().min(1).max(2000),contact_email:z.string().email().optional(),confirmed:z.literal(true)}).strict().parse(input);
 const numbers=[...new Set(v.phone_numbers)];for(const n of numbers){const owned=await s.resource(ctx.orgId,'number',n),monitored=await s.resource(ctx.orgId,'phone_reputation_number',n);if(owned?.status!=='active'||!monitored?.monitored)throw forbidden('reputation_number_missing','Select active monitored numbers belonging to this company.');assertManage(ctx,owned);}
 const root=await reputationRoot(ctx.orgId),settings=await voiceClient().data(root);if(settings.status!=='approved'||settings.loa_status!=='approved')throw conflict('reputation_approval_pending');
 return operation(ctx.orgId,v.operation_id,'remediate',{numbers,call_purpose:v.call_purpose,contact_email:v.contact_email},ctx.userId,async()=>{
  const r=await voiceClient().data(root+'/remediation','POST',{phone_numbers:numbers,call_purpose:v.call_purpose,...(v.contact_email?{contact_email:v.contact_email}:{})});if(!r.id)throw Error('Remediation submission needs reconciliation.');
  await s.saveResource(ctx.orgId,'phone_reputation_remediation',s.text(r.id),{status:r.status,numbers,call_purpose:v.call_purpose,created_at:r.created_at||s.now(),results:r.results||null},s.text(r.id));return {id:r.id,status:r.status};
 },numbers.length);
}
export async function refreshProduct(org:string){
 const a=await account(org);if(!a)return;
 if(a.busy){const op=await s.resource(org,'phone_reputation_operation',s.text(a.busy));if(op&&Date.now()-Date.parse(s.text(op.started_at))>120000){
  // Recover deterministic resources. Ambiguous billed lookups/remediation remain operator-visible.
  let recovered=false;
  if(op.action==='register'){
   const reference=`FirstMate-reputation-${hash(org).slice(0,32)}`;const matches=await voiceClient().findNamed('/enterprises','customer_reference',reference);
   if(matches.length===1){await bindEnterprise(org,s.text(matches[0]!.id),reference);recovered=true;}
  }else if(['monitor','remove','frequency'].includes(s.text(op.action))){
   const root=await reputationRoot(org),request=s.object(op.request);
   if(op.action==='frequency')recovered=(await voiceClient().data(root)).check_frequency===request.frequency;
   else {const inventory=await voiceClient().list(root+'/numbers?page[size]=250');const exists=inventory.some(n=>n.phone_number===request.phone_number);recovered=op.action==='monitor'?exists:!exists&&inventory.length<250;}
  }else if(op.action==='authorize'){
   const settings=await voiceClient().data(await reputationRoot(org));recovered=!!a.loa_document_id&&settings.loa_document_id===a.loa_document_id;
  }
  if(recovered){await s.saveResource(org,'phone_reputation_operation',op.id,{...op,state:'completed',result:{reconciled:true},completed_at:s.now()});await s.saveResource(org,'phone_reputation_account','default',{...await account(org),busy:''});}
 }}
 const id=await enterpriseId(org);if(!id)return;
 for(const row of await s.resources(org,'phone_reputation_remediation'))if(['pending','in_progress'].includes(s.text(row.status))){const r=await voiceClient().data(`${await reputationRoot(org)}/remediation/${encodeURIComponent(row.id)}`);await s.saveResource(org,'phone_reputation_remediation',row.id,{...row,status:r.status,results:r.results||null},row.provider_id);}

}
export async function disableReputation(ctx:PlatformAuthContext,key:string){
 assertManage(ctx);carrier();const a=await account(ctx.orgId);if(a?.busy)throw conflict('reputation_operation_pending','Wait for the current request to finish.');
 const root=await reputationRoot(ctx.orgId);
 return operation(ctx.orgId,key,'disable',{},ctx.userId,async()=>{
 try{await voiceClient().request(root,'DELETE');}catch(e){if(!(e instanceof TelnyxError&&e.statusCode===404))throw e;}
 await s.saveResource(ctx.orgId,'phone_reputation_account','default',{...await account(ctx.orgId),disabled_at:s.now(),status:'disabled',schedule:'never',next_check_at:'',loa_version:''});
 for(const n of await s.resources(ctx.orgId,'phone_reputation_number'))await s.saveResource(ctx.orgId,'phone_reputation_number',n.id,{...n,monitored:false});
 await s.saveResource(ctx.orgId,'phone_reputation','default',{status:'disabled',loa_status:'',check_frequency:'never'});
 return {disabled:true};
 });
}

/** Operators can release an ambiguous attempt only after checking carrier records.
 * This never retries a paid provider operation or invents a successful outcome. */
export async function resolveAttempt(ctx:PlatformAuthContext,input:unknown){
 if(!canManageTestAppFlags(ctx))throw forbidden('reputation_operator_required');assertManage(ctx);
 const v=z.object({id:text,evidence:z.string().trim().min(20).max(2000),confirmed:z.literal(true)}).strict().parse(input);
 return s.transaction(async()=>{const a=await account(ctx.orgId),op=await s.resource(ctx.orgId,'phone_reputation_operation',v.id);
 if(!op||a?.busy!==v.id||!['uncertain','running'].includes(s.text(op.state))||Date.now()-Date.parse(s.text(op.started_at))<120000)throw conflict('reputation_operation_not_reviewable');
 await s.saveResource(ctx.orgId,'phone_reputation_operation',v.id,{...op,state:'reviewed',reviewed_by:ctx.userId,reviewed_at:s.now(),evidence:v.evidence});
 await s.saveResource(ctx.orgId,'phone_reputation_account','default',{...a,busy:''});return {reviewed:true};});
}
