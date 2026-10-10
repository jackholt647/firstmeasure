import { z } from 'zod';
import { env } from '../../src/config/env.js';
import { type PlatformAuthContext } from '../../platform/auth.js';
import { badRequest, conflict, notFound } from '../../platform/errors.js';
import { TelnyxClient, TelnyxError } from '../../messaging/telnyx.js';
import { claimPhoneNumberOwnership, findPhoneNumberOwner } from '../../messaging/communications_storage.js';
import { voiceClient } from '../../telephony/telnyx.js';
import { assertManage } from './service.js';
import { phone, key } from './contracts.js';
import * as s from '../calls/storage.js';

const client=()=>new TelnyxClient();
const data=(response:unknown)=>s.object(s.object(response).data);
const rows=(response:unknown)=>Array.isArray(s.object(response).data)?(s.object(response).data as unknown[]).map(s.object):[];
export function carrierWritesAllowed(){return env.dataEnvironment!=='development'&&!!env.telnyxApiKey;}
function live(){if(!carrierWritesAllowed())throw conflict('carrier_changes_unavailable','Carrier transfers and purchases are disabled in development. Drafts can be prepared here; no numbers will move or be charged.');}
async function ownedOrder(ctx:PlatformAuthContext,id:string){assertManage(ctx);const row=await s.resource(ctx.orgId,'phone_port',id);if(!row)throw notFound('port_not_found','This port request is unavailable.');return row;}
function summary(provider:s.Json){return {provider_status:s.text(s.object(provider.status).value||provider.status),requirements:provider.requirements,activation_settings:provider.activation_settings,phone_numbers:provider.phone_numbers,documents:provider.documents,updated_at:provider.updated_at,customer_reference:provider.customer_reference};}
export const portDraftSchema=z.object({phone_number:phone,label:z.string().min(1).max(100),operation_id:key});
export async function createPortDraft(ctx:PlatformAuthContext,input:unknown){
  assertManage(ctx);const v=portDraftSchema.parse(input),id=s.id('port',`${ctx.orgId}:${v.operation_id}`),prior=await s.resource(ctx.orgId,'phone_port',id);
  if(prior){if(prior.phone_number!==v.phone_number)throw conflict('port_operation_conflict','This request ID already belongs to another number.');return prior;}
  const owner=await findPhoneNumberOwner(v.phone_number);if(owner&&s.text(owner.organization_id)!==ctx.orgId)throw conflict('number_unavailable','This number is already managed by another organization.');
  return s.saveResource(ctx.orgId,'phone_port',id,{phone_number:v.phone_number,label:v.label,status:'draft',branch_id:ctx.branchId||'default',customer_reference:`FirstMate ${id}`,created_by:ctx.userId},'',0);
}
export async function checkPortability(ctx:PlatformAuthContext,number:string){assertManage(ctx);phone.parse(number);live();return client().request('/portability_checks',{method:'POST',body:JSON.stringify({phone_numbers:[number]})});}
export async function startPort(ctx:PlatformAuthContext,id:string){
  live();let row=await ownedOrder(ctx,id);if(row.provider_id)return refreshPort(ctx,id);
  if(['creating','uncertain'].includes(s.text(row.status))){
    const found=rows(await client().request(`/porting_orders?filter[customer_reference]=${encodeURIComponent(s.text(row.customer_reference))}&page[size]=100`)).filter(v=>v.customer_reference===row.customer_reference);
    if(found.length!==1)throw conflict('port_reconciliation_required','An earlier request needs carrier reconciliation. Refresh before retrying; a duplicate transfer will not be created.');
    await s.saveResource(ctx.orgId,'phone_port',id,{...row,...summary(found[0]!),status:'created'},s.text(found[0]!.id));return refreshPort(ctx,id);
  }
  const priorOwner=await findPhoneNumberOwner(s.text(row.phone_number));if(priorOwner&&s.text(priorOwner.organization_id)!==ctx.orgId)throw conflict('number_unavailable','This number is managed by another organization.');
  await claimPhoneNumberOwnership({phone_number:row.phone_number,organization_id:ctx.orgId,status:'pending'});
  row=await s.saveResource(ctx.orgId,'phone_port',id,{...row,status:'creating'},'',row.revision);
  try{
    const result=await client().request('/porting_orders',{method:'POST',body:JSON.stringify({phone_numbers:[row.phone_number],customer_reference:row.customer_reference})});
    const provider=rows(result)[0]||data(result);if(!provider.id)throw new Error('Missing porting order ID');
    await s.saveResource(ctx.orgId,'phone_port',id,{...row,...summary(provider),status:'created'},s.text(provider.id));return refreshPort(ctx,id);
  }catch(error){await s.saveResource(ctx.orgId,'phone_port',id,{...row,status:error instanceof TelnyxError&&s.object(error.details).submission_unknown!==true?'failed':'uncertain'});throw error;}
}
const bounded=z.string().trim().max(250);
export const portDetailsSchema=z.object({
  end_user:z.object({admin:z.object({entity_name:bounded.min(1),auth_person_name:bounded.min(1),billing_phone_number:bounded.min(1),account_number:bounded.min(1),pin_passcode:bounded.optional()}),location:z.object({street_address:bounded.min(1),extended_address:bounded.optional(),locality:bounded.min(1),administrative_area:bounded.min(1),postal_code:bounded.min(1),country_code:z.string().regex(/^[A-Z]{2}$/)})}),
  activation_settings:z.object({foc_datetime_requested:z.string().datetime({offset:true})}).optional(),
  messaging:z.object({enable_messaging:z.boolean()}).default({enable_messaging:false})
});
export async function updatePort(ctx:PlatformAuthContext,id:string,input:unknown){
  live();const row=await ownedOrder(ctx,id),value=portDetailsSchema.parse(input);if(!row.provider_id)throw conflict('port_not_started','Create the carrier draft first.');
  // Account numbers and PINs travel directly to the carrier and are never persisted in our resource JSON or audit logs.
  const app=await s.resource(ctx.orgId,'application');
  await client().request(`/porting_orders/${encodeURIComponent(row.provider_id)}`,{method:'PATCH',body:JSON.stringify({...value,...(app?.provider_id?{phone_number_configuration:{connection_id:app.provider_id}}:{})})});return refreshPort(ctx,id);
}
export async function uploadPortDocument(ctx:PlatformAuthContext,id:string,input:unknown){
  live();const row=await ownedOrder(ctx,id);if(!row.provider_id)throw conflict('port_not_started','Create the carrier draft first.');
  const v=z.object({kind:z.enum(['loa','invoice','csr','other']),filename:z.string().regex(/^[a-zA-Z0-9_. -]{1,120}\.(pdf|png|jpg|jpeg)$/i),file:z.string().min(4).max(11200000)}).parse(input);
  const bytes=Buffer.from(v.file,'base64');if(bytes.length>8*1024*1024||!(bytes.subarray(0,5).toString()==='%PDF-'||bytes.subarray(0,4).equals(Buffer.from([137,80,78,71]))||bytes.subarray(0,3).equals(Buffer.from([255,216,255]))))throw badRequest('port_document_invalid','Upload a PDF, PNG, or JPEG up to 8 MB.');
  const uploaded=data(await client().request('/documents',{method:'POST',body:JSON.stringify({file:v.file,filename:v.filename,customer_reference:s.text(row.customer_reference)})}));if(!uploaded.id)throw conflict('port_document_pending','The carrier did not confirm the document.');
  // Telnyx deletes unlinked uploads after 30 minutes. Link immediately and retain only the provider reference.
  if(v.kind==='loa'||v.kind==='invoice')await client().request(`/porting_orders/${encodeURIComponent(row.provider_id)}`,{method:'PATCH',body:JSON.stringify({documents:{[v.kind]:uploaded.id}})});
  else await client().request(`/porting_orders/${encodeURIComponent(row.provider_id)}/additional_documents`,{method:'POST',body:JSON.stringify({additional_documents:[{document_type:v.kind,document_id:uploaded.id}]})});
  return refreshPort(ctx,id);
}
export async function refreshPort(ctx:PlatformAuthContext,id:string){
  const row=await ownedOrder(ctx,id);if(!row.provider_id)return row;live();
  const provider=data(await client().request(`/porting_orders/${encodeURIComponent(row.provider_id)}?include_phone_numbers=true`));
  if(provider.customer_reference!==row.customer_reference)throw conflict('port_identity_mismatch','The carrier order does not match this request.');
  const requirements=rows(await client().request(`/porting_orders/${encodeURIComponent(row.provider_id)}/requirements?page[size]=100`));
  const providerStatus=s.text(s.object(provider.status).value||provider.status);
  const resolvedAction=(row.action_pending==='confirm'&&!['draft',''].includes(providerStatus))||(row.action_pending==='cancel'&&['cancel-pending','cancelled'].includes(providerStatus));
  const saved=await s.saveResource(ctx.orgId,'phone_port',id,{...row,...summary(provider),action_pending:resolvedAction?'':row.action_pending,requirements,status:s.text(s.object(provider.status).value||provider.status)||row.status},row.provider_id);
  if(saved.status==='ported'){
    const number=await client().findOwnedPhoneNumber(s.text(row.phone_number));
    if(number?.id){await claimPhoneNumberOwnership({phone_number:row.phone_number,organization_id:ctx.orgId,provider_phone_number_id:number.id,status:'active'});
      const app=await s.resource(ctx.orgId,'application');if(app?.provider_id){await voiceClient().bindNumber(s.text(number.id),app.provider_id);const verified=await voiceClient().readNumber(s.text(number.id));if(verified.connection_id!==app.provider_id)throw conflict('port_route_pending','Port completed; voice routing is still being confirmed.');}
      await s.saveResource(ctx.orgId,'number',s.text(row.phone_number),{phone_number:row.phone_number,label:row.label,branch_id:row.branch_id,status:app?.provider_id?'active':'unbound',application_id:app?.provider_id||'',port_id:id},s.text(number.id));
    }
  }
  return saved;
}
export async function portAction(ctx:PlatformAuthContext,id:string,action:'confirm'|'cancel',confirmed:boolean){
  live();if(!confirmed)throw badRequest('port_confirmation_required','Confirm this carrier action.');const row=await ownedOrder(ctx,id);
  if(!row.provider_id)throw conflict('port_not_started','Create the carrier draft first.');
  if(action==='confirm'&&['in-process','submitted','foc-date-confirmed','ported'].includes(s.text(row.status)))return refreshPort(ctx,id);
  if(action==='cancel'&&['cancel-pending','cancelled'].includes(s.text(row.status)))return refreshPort(ctx,id);
  if(action==='cancel'&&row.status==='ported')throw conflict('port_already_completed','This transfer is complete and cannot be cancelled.');
  if(row.action_pending)throw conflict('port_action_pending','Refresh the carrier status before repeating this action.');
  await s.saveResource(ctx.orgId,'phone_port',id,{...row,action_pending:action},row.provider_id,row.revision);
  try{await client().request(`/porting_orders/${encodeURIComponent(row.provider_id)}/actions/${action}`,{method:'POST'});}
  catch(error){if(error instanceof TelnyxError&&s.object(error.details).submission_unknown!==true)await s.saveResource(ctx.orgId,'phone_port',id,{...row,action_pending:''});throw error;}
  await s.saveResource(ctx.orgId,'phone_port',id,{...row,action_pending:''});return refreshPort(ctx,id);
}
