import { z } from 'zod';
import type { PlatformAuthContext } from '../../platform/auth.js';
import { conflict, forbidden, notFound } from '../../platform/errors.js';
import { voiceClient } from '../../telephony/telnyx.js';
import { carrierWritesAllowed } from './porting.js';
import { assertManage } from './service.js';
import * as s from '../calls/storage.js';

import {account,enterpriseId,reputationRoot,productWorkspace,operation,refreshProduct} from './reputation-product.js';
import {TelnyxError} from '../../messaging/telnyx.js';
export async function reputationWorkspace(ctx:PlatformAuthContext){assertManage(ctx);return {configured:!!await enterpriseId(ctx.orgId),carrier_writes:carrierWritesAllowed(),settings:await s.resource(ctx.orgId,'phone_reputation')||{},numbers:await s.resources(ctx.orgId,'phone_reputation_number'),...await productWorkspace(ctx)};}

/** List is a cached, non-billable read. Never use single-number GET in polling:
 * Telnyx can bill that request when no cached score exists. */
export async function syncReputation(org:string){
  const path=await reputationRoot(org),client=voiceClient(),settings=await client.data(path),records:s.Json[]=[];
  for(let page=1;page<=100;page++){
    const response=s.object(await client.request(`${path}/numbers?page[number]=${page}&page[size]=250`));
    const rows=Array.isArray(response.data)?response.data.map(s.object):[];records.push(...rows);
    if(rows.length<250||Number(s.object(response.meta).total_pages)<=page)break;
    if(page===100)throw conflict('reputation_inventory_limit','The monitoring inventory could not be fully retrieved.');
  }
  const owned=await s.resources(org,'number'),timestamp=s.now();
  for(const number of owned){
    const provider=records.find(r=>r.phone_number===number.id),previous=await s.resource(org,'phone_reputation_number',number.id);
    if(!provider&&!previous)continue;
    const data=provider?.reputation_data?s.object(provider.reputation_data):null;
    const history=Array.isArray(previous?.history)?previous.history:[];
    if(data&&data.last_refreshed_at!==s.object(previous?.reputation_data).last_refreshed_at)history.push(data);
    await s.saveResource(org,'phone_reputation_number',number.id,{phone_number:number.id,monitored:!!provider,reputation_data:data,synced_at:timestamp,history:history.slice(-30)});
  }
  const enrollment=await account(org);if(enrollment){const status=settings.status==='approved'&&settings.loa_status==='approved'?'approved':settings.status==='rejected'||settings.loa_status==='rejected'?'rejected':'pending';if(enrollment.status!==status)await s.saveResource(org,'phone_reputation_account','default',{...enrollment,status});}
  return s.saveResource(org,'phone_reputation','default',{...(await s.resource(org,'phone_reputation')),status:settings.status,loa_status:settings.loa_status,check_frequency:settings.check_frequency,rejection_reasons:settings.rejection_reasons,synced_at:timestamp,last_error:''});
}

export async function changeReputation(ctx:PlatformAuthContext,input:unknown){
  assertManage(ctx);const v=z.object({action:z.enum(['sync','monitor','remove','refresh','frequency']),operation_id:z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).optional(),phone_number:z.string().max(40).default(''),frequency:z.enum(['business_daily','daily','weekly','biweekly','monthly','never']).optional(),confirmed:z.boolean().default(false)}).parse(input);
  if(v.action==='sync'){await refreshProduct(ctx.orgId);if(!await enterpriseId(ctx.orgId))return reputationWorkspace(ctx);try{await syncReputation(ctx.orgId);}catch(e){if(!(e instanceof TelnyxError&&e.statusCode===404))throw e;}return reputationWorkspace(ctx);}
  const path=await reputationRoot(ctx.orgId);
  if(!carrierWritesAllowed())throw forbidden('reputation_development_read_only','Development cannot enroll numbers or request billed reputation checks.');
  if(!v.confirmed)throw conflict('reputation_confirmation_required','Confirm the carrier action and applicable Telnyx charges.');
  if(v.action!=='frequency'){
    const number=await s.resource(ctx.orgId,'number',v.phone_number);if(!number||number.status!=='active')throw notFound('reputation_number_missing','Choose an active business number.');assertManage(ctx,number);
  }
  await syncReputation(ctx.orgId);
  const settings=await s.resource(ctx.orgId,'phone_reputation'),client=voiceClient();
  if(settings?.status!=='approved'||settings.loa_status!=='approved')throw conflict('reputation_approval_pending','Telnyx must approve both your business registration and letter of authorization.');
  const monitored=(await s.resource(ctx.orgId,'phone_reputation_number',v.phone_number))?.monitored===true;
  if(!v.operation_id)throw conflict('reputation_operation_required','A unique request ID is required.');
  if(v.action==='refresh'&&!monitored)throw conflict('reputation_not_monitored','Enroll this number first.');
  if(v.action==='monitor'&&monitored||v.action==='remove'&&!monitored)return reputationWorkspace(ctx);
  if(v.action==='frequency'&&!v.frequency)throw conflict('reputation_frequency_required','Choose a monitoring schedule.');
  await operation(ctx.orgId,v.operation_id,v.action,{phone_number:v.phone_number,frequency:v.frequency},ctx.userId,async()=>{
    if(v.action==='monitor')await client.request(path+'/numbers','POST',{phone_numbers:[v.phone_number]});
    if(v.action==='remove')await client.request(path+'/numbers/'+encodeURIComponent(v.phone_number),'DELETE');
    if(v.action==='frequency')await client.request(path+'/frequency','PATCH',{check_frequency:v.frequency});
    if(v.action==='refresh'){
      const result=await client.data(path+'/numbers/refresh','POST',{phone_numbers:[v.phone_number]});
      if(Number(result.total_failed)>0||Number(result.total_successful)!==1)throw conflict('reputation_refresh_failed','The carrier could not confirm this lookup. Refresh status before retrying.');
    }
    return {action:v.action,phone_number:v.phone_number};
  });
  await s.appendEvent(ctx.orgId,'','phone.reputation.updated',{action:v.action,phone_number:v.phone_number,frequency:v.frequency,actor_user_id:ctx.userId});
  await syncReputation(ctx.orgId);return reputationWorkspace(ctx);
}

export async function maintainReputation(){
  let map:s.Json={};try{map=s.object(JSON.parse(process.env.TELNYX_REPUTATION_ENTERPRISES||'{}'));}catch{return;}
  const rows=await s.database().prepare("SELECT organization_id FROM customer_voice_resources WHERE kind='phone_reputation_account'").all();
  for(const org of new Set([...Object.keys(map),...rows.map(r=>s.text(s.object(r).organization_id))])){
    if((await account(org))?.disabled_at)continue;
    const previous=await s.resource(org,'phone_reputation');
    if(s.text(previous?.next_poll_at)>s.now())continue;
    // A short lease across web/worker instances prevents duplicate inventory polls.
    let acquired=false;await s.transaction(async()=>{const latest=await s.resource(org,'phone_reputation');if(s.text(latest?.next_poll_at)>s.now())return;await s.saveResource(org,'phone_reputation','default',{...latest,next_poll_at:new Date(Date.now()+15*60000).toISOString()});acquired=true;});
    if(!acquired)continue;
    try{await refreshProduct(org);if(await enterpriseId(org))await syncReputation(org);}catch{const latest=await s.resource(org,'phone_reputation');await s.saveResource(org,'phone_reputation','default',{...latest,last_error:'Carrier monitoring could not be refreshed. Existing scores may be out of date.'});}
    const latest=await s.resource(org,'phone_reputation');await s.saveResource(org,'phone_reputation','default',{...latest,next_poll_at:new Date(Date.now()+15*60000).toISOString()});
  }
}
