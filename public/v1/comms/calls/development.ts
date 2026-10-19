import { env } from '../../src/config/env.js';
import { conflict, notFound } from '../../platform/errors.js';
import { mutateGlobal } from '../../platform/storage.js';
import type { PlatformAuthContext } from '../../platform/auth.js';
import * as store from './storage.js';
import { voiceSettings } from './settings.js';
import { developmentVoiceDestinations } from '../../telephony/telnyx.js';

export const DEVELOPMENT_CALL_DESTINATION='+14259700671';
export function developmentCalls(){return env.dataEnvironment==='development';}
export async function developmentCallStatus(orgId:string){
  if(!developmentCalls())return undefined;
  const saved=await store.resource(orgId,'development_onboarding');
  return {enabled:true,destination:DEVELOPMENT_CALL_DESTINATION,destinations:developmentVoiceDestinations(),onboarded:saved?.status==='complete',registrations:saved?.registrations||{},live_transport:saved?.live_transport===true};
}
/** No provider registrations, number purchases, attestations or billing are performed here. */
export async function completeDevelopmentOnboarding(ctx:PlatformAuthContext){
  if(!developmentCalls())throw notFound('route_not_found','Development phone setup is unavailable.');
  // Reuse the development host's one verified transport. Provider ownership and inbound routing stay unchanged.
  const rows=await store.database().prepare("SELECT organization_id,id FROM customer_voice_resources WHERE kind='number'").all();
  const candidates=[];
  for(const row of rows){const data=store.object(row),number=await store.resource(store.text(data.organization_id),'number',store.text(data.id));if(number?.status==='active'&&number.provider_id&&!number.development_shared)candidates.push({orgId:store.text(data.organization_id),number});}
  const own=candidates.find(c=>c.orgId===ctx.orgId),template=own||(candidates.length===1?candidates[0]:null);
  if(!template)throw conflict('development_transport_required','The development server needs one verified test business line before mock onboarding can finish.');
  const refs=await Promise.all(['application','connection','outbound_profile'].map(kind=>store.resource(template.orgId,kind)));
  if(refs.some(ref=>!ref?.provider_id))throw conflict('development_transport_required','The development test phone transport is not ready.');
  await store.transaction(async()=>{
    for(const [i,kind] of ['application','connection','outbound_profile'].entries()){
      if(!await store.resource(ctx.orgId,kind))await store.saveResource(ctx.orgId,kind,'default',{...refs[i],development_shared:true,development_provider_id:refs[i]!.provider_id},'');
    }
    if(!(await store.resources(ctx.orgId,'number')).some(n=>n.status==='active'))await store.saveResource(ctx.orgId,'number',store.text(template.number.phone_number),{...template.number,branch_id:ctx.branchId||'default',development_shared:true,development_provider_id:template.number.provider_id,label:'Development test line'},'');
    const settings=await voiceSettings(ctx.orgId);
    await store.saveResource(ctx.orgId,'settings','default',{...settings,enabled:true,service_location:settings.service_location||'Development test transport',emergency_policy_confirmed:true});
    await store.saveResource(ctx.orgId,'development_onboarding','default',{status:'complete',live_transport:true,actor_user_id:ctx.userId,registrations:{brand:'mock_approved',campaign_10dlc:'mock_approved',number:'test_transport',voice:'test_transport'},destination:DEVELOPMENT_CALL_DESTINATION});
    await store.appendEvent(ctx.orgId,'','development.onboarding_completed',{actor_user_id:ctx.userId,mock_registrations:true});
  });
  await mutateGlobal(ctx.orgId,global=>{const data=store.object(global.data),groups=store.object(data.app_groups),communications=store.object(groups.communications);data.app_groups={...groups,communications:{...communications,default:communications.default||'inbox',members:{...store.object(communications.members),center:'standalone'}}};return {data};});
  return developmentCallStatus(ctx.orgId);
}
