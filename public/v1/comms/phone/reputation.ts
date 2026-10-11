import { z } from 'zod';
import type { PlatformAuthContext } from '../../platform/auth.js';
import { conflict, forbidden, notFound } from '../../platform/errors.js';
import { voiceClient } from '../../telephony/telnyx.js';
import { carrierWritesAllowed } from './porting.js';
import { assertManage } from './service.js';
import * as s from '../calls/storage.js';

// Platform operators bind each vetted enterprise to exactly one tenant. Tenant
// admins cannot supply an arbitrary enterprise ID from the shared carrier account.
function enterprise(org:string){
  let map:s.Json={};try{map=s.object(JSON.parse(process.env.TELNYX_REPUTATION_ENTERPRISES||'{}'));}catch{}
  const id=s.text(map[org]);
  return /^[a-zA-Z0-9-]{1,100}$/.test(id)&&Object.values(map).filter(v=>v===id).length===1?id:'';
}
function root(org:string){const id=enterprise(org);if(!id)throw conflict('reputation_setup_required','A platform administrator must connect your approved Telnyx Number Reputation enterprise.');return `/enterprises/${encodeURIComponent(id)}/reputation`;}
export async function reputationWorkspace(ctx:PlatformAuthContext){assertManage(ctx);return {configured:!!enterprise(ctx.orgId),carrier_writes:carrierWritesAllowed(),settings:await s.resource(ctx.orgId,'phone_reputation')||{},numbers:await s.resources(ctx.orgId,'phone_reputation_number')};}

/** List is a cached, non-billable read. Never use single-number GET in polling:
 * Telnyx can bill that request when no cached score exists. */
export async function syncReputation(org:string){
  const path=root(org),client=voiceClient(),settings=await client.data(path),records:s.Json[]=[];
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
  return s.saveResource(org,'phone_reputation','default',{...(await s.resource(org,'phone_reputation')),status:settings.status,loa_status:settings.loa_status,check_frequency:settings.check_frequency,rejection_reasons:settings.rejection_reasons,synced_at:timestamp,last_error:''});
}

export async function changeReputation(ctx:PlatformAuthContext,input:unknown){
  assertManage(ctx);const v=z.object({action:z.enum(['sync','monitor','remove','refresh','frequency']),phone_number:z.string().max(40).default(''),frequency:z.enum(['business_daily','daily','weekly','biweekly','monthly','never']).optional(),confirmed:z.boolean().default(false)}).parse(input);
  const path=root(ctx.orgId);
  if(v.action==='sync'){await syncReputation(ctx.orgId);return reputationWorkspace(ctx);}
  if(!carrierWritesAllowed())throw forbidden('reputation_development_read_only','Development cannot enroll numbers or request billed reputation checks.');
  if(!v.confirmed)throw conflict('reputation_confirmation_required','Confirm the carrier action and applicable Telnyx charges.');
  if(v.action!=='frequency'){
    const number=await s.resource(ctx.orgId,'number',v.phone_number);if(!number||number.status!=='active')throw notFound('reputation_number_missing','Choose an active business number.');assertManage(ctx,number);
  }
  await syncReputation(ctx.orgId);
  const settings=await s.resource(ctx.orgId,'phone_reputation'),client=voiceClient();
  if(settings?.status!=='approved'||settings.loa_status!=='approved')throw conflict('reputation_approval_pending','Telnyx must approve both your business registration and letter of authorization.');
  const monitored=(await s.resource(ctx.orgId,'phone_reputation_number',v.phone_number))?.monitored===true;
  if(v.action==='monitor'&&!monitored)await client.request(path+'/numbers','POST',{phone_numbers:[v.phone_number]});
  if(v.action==='remove'&&monitored)await client.request(path+'/numbers/'+encodeURIComponent(v.phone_number),'DELETE');
  if(v.action==='refresh'){
    if(!monitored)throw conflict('reputation_not_monitored','Enroll this number before requesting a fresh check.');
    const response=await client.data(path+'/numbers/refresh','POST',{phone_numbers:[v.phone_number]});
    if(Number(response.total_failed)>0||Number(response.total_successful)!==1)throw conflict('reputation_refresh_failed','The carrier could not refresh this number. Try again later.');
  }
  if(v.action==='frequency'){
    if(!v.frequency)throw conflict('reputation_frequency_required','Choose a monitoring schedule.');
    await client.request(path+'/frequency','PATCH',{check_frequency:v.frequency});
  }
  await s.appendEvent(ctx.orgId,'','phone.reputation.updated',{action:v.action,phone_number:v.phone_number,frequency:v.frequency,actor_user_id:ctx.userId});
  await syncReputation(ctx.orgId);return reputationWorkspace(ctx);
}

export async function maintainReputation(){
  let map:s.Json={};try{map=s.object(JSON.parse(process.env.TELNYX_REPUTATION_ENTERPRISES||'{}'));}catch{return;}
  for(const org of Object.keys(map)){
    if(!enterprise(org))continue;
    const previous=await s.resource(org,'phone_reputation');
    if(s.text(previous?.next_poll_at)>s.now())continue;
    // A short lease across web/worker instances prevents duplicate inventory polls.
    let acquired=false;await s.transaction(async()=>{const latest=await s.resource(org,'phone_reputation');if(s.text(latest?.next_poll_at)>s.now())return;await s.saveResource(org,'phone_reputation','default',{...latest,next_poll_at:new Date(Date.now()+15*60000).toISOString()});acquired=true;});
    if(!acquired)continue;
    try{await syncReputation(org);}catch{const latest=await s.resource(org,'phone_reputation');await s.saveResource(org,'phone_reputation','default',{...latest,last_error:'Carrier monitoring could not be refreshed. Existing scores may be out of date.'});}
    const latest=await s.resource(org,'phone_reputation');await s.saveResource(org,'phone_reputation','default',{...latest,next_poll_at:new Date(Date.now()+15*60000).toISOString()});
  }
}
