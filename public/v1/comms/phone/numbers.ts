import { z } from 'zod';
import { type PlatformAuthContext } from '../../platform/auth.js';
import { conflict, badRequest } from '../../platform/errors.js';
import { TelnyxClient, TelnyxError } from '../../messaging/telnyx.js';
import { claimPhoneNumberOwnership, findPhoneNumberOwner, upsertSenderIdentity } from '../../messaging/communications_storage.js';
import { ensureMessagingOrganization, listSmsComplianceProfiles } from '../../messaging/storage.js';
import { smsAutoresponsesReady } from '../../messaging/autoresponses.js';
import { carrierWritesAllowed } from './porting.js';
import { assertManage } from './service.js';
import { voiceClient } from '../../telephony/telnyx.js';
import { phone } from './contracts.js';
import * as s from '../calls/storage.js';

const client=()=>new TelnyxClient();
const rows=(r:unknown)=>Array.isArray(s.object(r).data)?(s.object(r).data as unknown[]).map(s.object):[];
function live(){if(!carrierWritesAllowed())throw conflict('carrier_changes_unavailable','Purchases and carrier registration changes are disabled in development.');}
export async function searchNumbers(ctx:PlatformAuthContext,area:string){assertManage(ctx);live();z.string().regex(/^\d{3}$/).parse(area);const list=rows(await client().request(`/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=${area}&filter[features]=voice,sms&filter[limit]=12&filter[best_effort]=false&filter[exclude_held_numbers]=true`));return list.map(n=>({phone_number:n.phone_number,cost_information:n.cost_information,features:n.features}));}
export async function purchaseNumber(ctx:PlatformAuthContext,input:unknown){
  assertManage(ctx);live();const value=z.object({phone_number:phone,operation_id:z.string().min(8).max(180),accepted_cost:z.record(z.unknown()),label:z.string().min(1).max(100)}).parse(input);
  const id=s.id('number_order',`${ctx.orgId}:${value.operation_id}`),reference=`FirstMate ${id}`;let saved=await s.resource(ctx.orgId,'phone_order',id);
  if(saved&&saved.phone_number!==value.phone_number)throw conflict('number_operation_conflict','This request already belongs to another number.');
  let providerId=s.text(saved?.provider_id);
  if(saved&&!providerId&&['creating','uncertain'].includes(s.text(saved.status))){const matches=await client().findNumberOrdersByCustomerReference(reference);if(matches.length!==1)throw conflict('number_order_reconciliation','A previous purchase needs reconciliation; another charge will not be submitted.');providerId=s.text(matches[0]!.id);}
  if(!providerId){
    const inventory=rows(await client().request(`/available_phone_numbers?filter[phone_number]=${encodeURIComponent(value.phone_number)}&filter[limit]=1&filter[best_effort]=false`));const number=inventory.find(n=>n.phone_number===value.phone_number);
    if(!number||s.digest(number.cost_information)!==s.digest(value.accepted_cost))throw conflict('number_quote_changed','Number availability or price changed. Search again and review the current quote.');
    const owner=await findPhoneNumberOwner(value.phone_number);if(owner&&!(saved?.status==='failed'&&owner.organization_id===ctx.orgId&&owner.status==='pending'))throw conflict('number_already_owned','This number already has an ownership record.');
    await claimPhoneNumberOwnership({phone_number:value.phone_number,organization_id:ctx.orgId,status:'pending'});
    saved=await s.saveResource(ctx.orgId,'phone_order',id,{phone_number:value.phone_number,label:value.label,branch_id:ctx.branchId||'default',accepted_cost:value.accepted_cost,customer_reference:reference,status:'creating'},'',saved?.revision||0);
    try{const response=s.object(s.object(await client().request('/number_orders',{method:'POST',body:JSON.stringify({phone_numbers:[{phone_number:value.phone_number}],customer_reference:reference})})).data);if(!response.id)throw new Error('Missing order ID');providerId=s.text(response.id);}
    catch(error){await s.saveResource(ctx.orgId,'phone_order',id,{...saved,status:error instanceof TelnyxError&&s.object(error.details).submission_unknown!==true?'failed':'uncertain'});throw error;}
  }
  await s.saveResource(ctx.orgId,'phone_order',id,{...saved,phone_number:value.phone_number,label:value.label,status:'pending'},providerId);return refreshNumber(ctx,id);
}
export async function refreshNumber(ctx:PlatformAuthContext,id:string){
  assertManage(ctx);live();const saved=await s.resource(ctx.orgId,'phone_order',id);if(!saved?.provider_id)throw badRequest('number_order_missing','This order is unavailable.');
  const provider=s.object(s.object(await client().getNumberOrder(saved.provider_id)).data);if(provider.customer_reference!==saved.customer_reference)throw conflict('number_order_mismatch','The order reference does not match.');
  const result=await s.saveResource(ctx.orgId,'phone_order',id,{...saved,status:s.text(provider.status)},saved.provider_id);
  if(['success','active'].includes(s.text(provider.status))){const number=await client().findOwnedPhoneNumber(s.text(saved.phone_number));if(number?.id){await claimPhoneNumberOwnership({phone_number:saved.phone_number,organization_id:ctx.orgId,provider_phone_number_id:number.id,status:'active'});const app=await s.resource(ctx.orgId,'application');if(app?.provider_id){await voiceClient().bindNumber(s.text(number.id),app.provider_id);if((await voiceClient().readNumber(s.text(number.id))).connection_id!==app.provider_id)throw conflict('number_route_pending','The number is purchased; voice routing is pending.');}await s.saveResource(ctx.orgId,'number',s.text(saved.phone_number),{phone_number:saved.phone_number,label:saved.label,branch_id:saved.branch_id,status:app?.provider_id?'active':'unbound',application_id:app?.provider_id||'',accepted_cost:saved.accepted_cost},s.text(number.id));}}
  return result;
}
export async function enableLineSms(ctx:PlatformAuthContext,number:string,profileId:string){
  assertManage(ctx);live();const owned=await findPhoneNumberOwner(number),line=await s.resource(ctx.orgId,'number',number);if(!owned||owned.organization_id!==ctx.orgId||!owned.provider_phone_number_id||!line)throw badRequest('number_unavailable','Choose an owned phone number.');
  const org=await ensureMessagingOrganization(ctx.orgId),profile=(await listSmsComplianceProfiles(org.id)).find(p=>p.id===profileId);
  if(!profile||s.text(profile.campaign_status).toLowerCase()!=='mno_provisioned'||!smsAutoresponsesReady(profile))throw conflict('campaign_not_ready','Complete the existing 10DLC registration first.');
  const refs=s.object(profile.provider_refs),campaignId=s.text(refs.telnyx_campaign_id),messagingId=s.text(refs.telnyx_messaging_profile_id);if(!campaignId||!messagingId)throw conflict('campaign_not_ready','Carrier campaign references are missing.');
  let binding:s.Json={};try{binding=s.object(await client().getPhoneNumberCampaign(number));binding=s.object(binding.data||binding);}catch(e){if(!(e instanceof TelnyxError&&e.statusCode===404))throw e;}
  if((binding.telnyxCampaignId||binding.campaignId)&&![binding.telnyxCampaignId,binding.campaignId].includes(campaignId))throw conflict('number_campaign_conflict','This number is attached to another campaign. Resolve its registration before changing it.');
  const previous=await s.resource(ctx.orgId,'phone_sms',number);
  if(!binding.telnyxCampaignId&&!binding.campaignId){if(previous?.assignment_status==='uncertain'||previous?.assignment_status==='assigning')throw conflict('sms_assignment_reconciliation','An earlier assignment needs carrier reconciliation. Refresh it before trying again.');await s.saveResource(ctx.orgId,'phone_sms',number,{assignment_status:'assigning',campaign_id:campaignId},'',previous?.revision||0);try{await client().assignPhoneNumberToCampaign(number,campaignId);}catch(e){await s.saveResource(ctx.orgId,'phone_sms',number,{assignment_status:'uncertain',campaign_id:campaignId});throw e;}binding=s.object(await client().getPhoneNumberCampaign(number));binding=s.object(binding.data||binding);}
  const rawStatus=s.text(binding.status||binding.assignmentStatus).toLowerCase(),status=rawStatus==='success'?'assigned':rawStatus;
  await s.saveResource(ctx.orgId,'phone_sms',number,{campaign_id:campaignId,assignment_status:status,compliance_profile_id:profile.id});
  if(status!=='assigned'||![binding.telnyxCampaignId,binding.campaignId].includes(campaignId))throw conflict('sms_assignment_pending','The carrier is still assigning this number. Refresh again after approval.');
  await client().request(`/phone_numbers/${encodeURIComponent(s.text(owned.provider_phone_number_id))}/messaging`,{method:'PATCH',body:JSON.stringify({messaging_profile_id:messagingId})});
  const verified=s.object(s.object(await client().request(`/phone_numbers/${encodeURIComponent(s.text(owned.provider_phone_number_id))}/messaging`)).data);if(verified.messaging_profile_id!==messagingId)throw conflict('sms_profile_pending','The carrier has not confirmed the messaging profile.');
  await claimPhoneNumberOwnership({phone_number:number,organization_id:ctx.orgId,compliance_profile_id:profile.id,messaging_profile_id:messagingId,provider_phone_number_id:owned.provider_phone_number_id,status:'active'});
  return upsertSenderIdentity({id:s.id('phone_sms',number),organization_id:ctx.orgId,branch_id:line.branch_id||'default',channel:'sms',provider:'telnyx',address:number,provider_profile_id:messagingId,status:'active',is_default:false,display_name:line.label,capabilities:{sms:true,mms:true},metadata:{compliance_profile_id:profile.id,managed_by:'phone_settings'}});
}
