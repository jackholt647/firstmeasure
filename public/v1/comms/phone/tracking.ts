import {sourceSchema,poolSchema} from './marketing-contracts.js';
export {sourceSchema,poolSchema} from './marketing-contracts.js';
import {z} from 'zod';
import type {PlatformAuthContext} from '../../platform/auth.js';
import {badRequest,conflict,forbidden,notFound} from '../../platform/errors.js';
import {assertManage} from './service.js';
import {requireCallAccess,projectContext} from '../calls/service.js';
import {phone,scheduleSchema} from './contracts.js';
import * as s from '../calls/storage.js';

const key=z.string().trim().regex(/^[a-zA-Z0-9_-]{1,180}$/),label=z.string().trim().min(1).max(160);
const ref=z.string().trim().max(180).default('');
export async function validateSource(org:string,id:string){if(id&&!(await s.resource(org,'phone_tracking_source',id))?.enabled)throw badRequest('tracking_source_missing','Choose an enabled lead source.');}
export async function saveSource(ctx:PlatformAuthContext,id:string,input:unknown){assertManage(ctx);key.parse(id);const v=sourceSchema.parse(input);return s.saveResource(ctx.orgId,'phone_tracking_source',id,v,'',v.revision);}
export async function authorizePool(ctx:PlatformAuthContext,pool:s.Json){assertManage(ctx);for(const n of [...s.strings(pool.numbers),s.text(pool.fallback_number)]){const row=await s.resource(ctx.orgId,'number',n);if(!row)throw notFound('tracking_number_missing');assertManage(ctx,{...row,...await s.resource(ctx.orgId,'phone_line',n)});}}
export async function savePool(ctx:PlatformAuthContext,id:string,input:unknown){
 assertManage(ctx);key.parse(id);const v=poolSchema.parse(input);await authorizePool(ctx,v);
 if(v.numbers.includes(v.fallback_number))throw badRequest('tracking_fallback_reserved','The fallback must be a separate business number.');
 if(v.retention_days*24<=v.reuse_hours+v.lease_minutes/60)throw badRequest('tracking_retention_short');
 for(const n of [...v.numbers,v.fallback_number])if((await s.resource(ctx.orgId,'number',n))?.status!=='active')throw badRequest('tracking_number_inactive','Use active voice numbers.');
 for(const n of v.numbers)if(s.object((await s.resource(ctx.orgId,'phone_line',n))?.tracking).enabled)throw conflict('tracking_static_conflict','Remove static attribution before using a number in a website pool.');
 for(const source of [v.lead_source_id,...v.rules.map(r=>r.lead_source_id)])await validateSource(ctx.orgId,source);
 return s.transaction(async()=>{
  const old=await s.resource(ctx.orgId,'phone_tracking_pool',id);
  for(const pool of await s.resources(ctx.orgId,'phone_tracking_pool'))if(pool.id!==id&&(v.numbers.some(n=>s.strings(pool.numbers).includes(n))||s.strings(pool.numbers).includes(v.fallback_number)||v.numbers.includes(s.text(pool.fallback_number))))throw conflict('tracking_pool_number_reserved','A number is reserved by another website pool.');
  for(const removed of s.strings(old?.numbers).filter(n=>!v.numbers.includes(n)))if(await s.database().prepare('SELECT id FROM phone_tracking_sessions WHERE organization_id=? AND phone_number=? AND reuse_after>? LIMIT 1').get(ctx.orgId,removed,s.now()))throw conflict('tracking_number_in_use','Wait until visitor assignments and their reuse holds expire before removing this number.');
  return s.saveResource(ctx.orgId,'phone_tracking_pool',id,{...old,...v},'',v.revision);
 });
}
export async function reservedPool(org:string,number:string){return (await s.resources(org,'phone_tracking_pool')).find(p=>s.strings(p.numbers).includes(number))||null;}
const assignmentSchema=z.object({visitor_key:z.string().regex(/^[a-zA-Z0-9_-]{20,100}$/),consent:z.boolean(),page_url:z.string().url().max(2000),referrer:z.string().max(2000).default('')}).strict();
function parseJson(v:unknown){try{return s.object(JSON.parse(s.text(v)));}catch{return {};}}
function observedAttribution(pool:s.Json,page:URL,referrer:string){
 let host='';try{host=new URL(referrer).hostname.toLowerCase();}catch{}
 const tag=(k:string,max=160)=>s.text(page.searchParams.get(k)).slice(0,max);
 const utm_source=tag('utm_source'),utm_medium=tag('utm_medium',100),utm_campaign=tag('utm_campaign'),utm_content=tag('utm_content'),utm_term=tag('utm_term');
 const rule=(Array.isArray(pool.rules)?pool.rules:[]).map(s.object).find(r=>(!r.utm_source||r.utm_source===utm_source)&&(!r.utm_campaign||r.utm_campaign===utm_campaign)&&(!r.referrer_host||s.text(r.referrer_host).toLowerCase()===host));
 const source=utm_source||(!host||host===page.hostname?'direct':host),medium=utm_medium||(!host||host===page.hostname?'direct':/(^|\.)(google\.[a-z.]+|bing.com|duckduckgo.com)$/.test(host)?'organic':'referral');
 return {enabled:true,source,medium,campaign:utm_campaign,ad_id:utm_content,keyword:utm_term,landing_page:page.origin+page.pathname,
  referrer_host:host,lead_source_id:s.text(rule?.lead_source_id||pool.lead_source_id),marketing_campaign_id:s.text(rule?.marketing_campaign_id||pool.marketing_campaign_id),pool_id:pool.id,attribution_kind:'website_session',captured_at:s.now()};
}
/** Public, non-billable visitor allocation. Exact website origins and bounded counters precede allocation. */
export async function assignVisitor(org:string,id:string,origin:string,ip:string,input:unknown,at=new Date()){
 const pool=await s.resource(org,'phone_tracking_pool',id);if(!pool)throw notFound('tracking_pool_missing');
 if(!s.strings(pool.origins).includes(origin))throw forbidden('tracking_origin_denied');
 const v=assignmentSchema.parse(input),page=new URL(v.page_url);if(page.origin!==origin)throw forbidden('tracking_page_origin_denied');
 if(!v.consent||!pool.enabled)return {number:s.text(pool.fallback_number),status:v.consent?'disabled':'consent_required',expires_at:'',session_id:''};
 const now=at.toISOString(),visitor=s.digest({org,id,key:v.visitor_key}),sessionId=s.id('visit',visitor);
 return s.transaction(async()=>{
  const current=await s.resource(org,'phone_tracking_pool',id);if(current?.revision!==pool.revision)throw conflict('tracking_configuration_changed');
  const minute=Math.floor(at.getTime()/60000);for(const [rate,max] of [[s.id('rate',`${org}:${id}:${s.digest(ip)}:${minute}`),60],[s.id('rate',`${org}:${id}:${minute}`),1200]] as const){
   const old=s.object(await s.database().prepare('SELECT count FROM phone_tracking_rate WHERE id=?').get(rate));if(Number(old.count||0)>=max)return {number:s.text(pool.fallback_number),status:'rate_limited',expires_at:'',session_id:''};
   await s.database().prepare('INSERT INTO phone_tracking_rate(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=phone_tracking_rate.count+1').run(rate,new Date(at.getTime()+120000).toISOString());
  }
  const existing=s.object(await s.database().prepare('SELECT * FROM phone_tracking_sessions WHERE organization_id=? AND pool_id=? AND visitor_hash=?').get(org,id,visitor));
  const retained=existing.reuse_after&&s.text(existing.reuse_after)>now&&s.strings(pool.numbers).includes(s.text(existing.phone_number));let number=retained?s.text(existing.phone_number):'';
  if(!number){
   const busy=new Set((await s.database().prepare('SELECT phone_number FROM phone_tracking_sessions WHERE organization_id=? AND reuse_after>?').all(org,now)).map(r=>s.text(s.object(r).phone_number)));
   for(const row of await s.database().prepare("SELECT business_number FROM customer_calls WHERE organization_id=? AND direction='inbound' AND state NOT IN ('ended','canceled','failed','busy','no_answer','rejected')").all(org))busy.add(s.text(s.object(row).business_number));
   const active=new Set((await s.database().prepare("SELECT id,data_json FROM customer_voice_resources WHERE organization_id=? AND kind='number'").all(org)).filter(r=>parseJson(s.object(r).data_json).status==='active').map(r=>s.text(s.object(r).id)));
   number=s.strings(pool.numbers).find(candidate=>active.has(candidate)&&!busy.has(candidate))||'';
  }
  if(!number)return {number:s.text(pool.fallback_number),status:'exhausted',expires_at:'',session_id:''};
  const expires=new Date(at.getTime()+Number(pool.lease_minutes)*60000).toISOString(),reuse=new Date(Date.parse(expires)+Number(pool.reuse_hours)*3600000).toISOString();
  const attribution=retained?parseJson(existing.attribution_json):{...observedAttribution(pool,page,v.referrer),number,visit_id:sessionId};
  await s.database().prepare(`INSERT INTO phone_tracking_sessions(organization_id,pool_id,id,visitor_hash,phone_number,lease_until,reuse_after,attribution_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(organization_id,pool_id,visitor_hash) DO UPDATE SET phone_number=excluded.phone_number,lease_until=excluded.lease_until,reuse_after=excluded.reuse_after,attribution_json=excluded.attribution_json,created_at=excluded.created_at,updated_at=excluded.updated_at`).run(org,id,sessionId,visitor,number,expires,reuse,JSON.stringify(attribution),retained?s.text(existing.created_at):now,now);
  return {number,status:'assigned',expires_at:expires,session_id:sessionId};
 });
}
export async function releaseVisitor(org:string,id:string,origin:string,visitorKey:string){const pool=await s.resource(org,'phone_tracking_pool',id);if(!pool||!s.strings(pool.origins).includes(origin))throw forbidden('tracking_origin_denied');assignmentSchema.shape.visitor_key.parse(visitorKey);await s.database().prepare('UPDATE phone_tracking_sessions SET lease_until=?,updated_at=? WHERE organization_id=? AND pool_id=? AND visitor_hash=?').run(s.now(),s.now(),org,id,s.digest({org,id,key:visitorKey}));return {released:true};}
export async function websiteSnapshot(org:string,number:string,at=new Date()){
 const pool=await reservedPool(org,number);if(!pool)return null;
 const row=s.object(await s.database().prepare('SELECT * FROM phone_tracking_sessions WHERE organization_id=? AND phone_number=? AND reuse_after>? AND created_at<=? ORDER BY updated_at DESC LIMIT 1').get(org,number,at.toISOString(),at.toISOString()));
 if(row.id)return {...parseJson(row.attribution_json),attribution_kind:s.text(row.lease_until)>at.toISOString()?'website_session':'retained_session',captured_at:at.toISOString()};
 return {enabled:true,number,pool_id:pool.id,visit_id:'',source:'unattributed website call',medium:'unknown',campaign:'',ad_id:'',lead_source_id:'',marketing_campaign_id:'',attribution_kind:'unattributed',captured_at:at.toISOString()};
}
export async function indexTrackingCall(call:s.CustomerCall){const a=s.object(call.metadata.attribution);if(!a.enabled)return;await s.database().prepare(`INSERT INTO phone_tracking_call_index(organization_id,call_id,phone_number,lead_source_id,marketing_campaign_id,pool_id,visit_id,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,call_id) DO NOTHING`).run(call.organization_id,call.id,call.business_number,s.text(a.lead_source_id),s.text(a.marketing_campaign_id),s.text(a.pool_id),s.text(a.visit_id),call.created_at);}
export const trackingQuerySchema=z.object({from:z.string().datetime(),to:z.string().datetime(),phone_number:z.string().max(40).optional(),lead_source_id:key.optional(),marketing_campaign_id:z.string().trim().max(180).optional(),pool_id:key.optional(),visit_id:key.optional()}).strict();
export async function trackingCalls(ctx:PlatformAuthContext,input:unknown,limit=100,cursor=''){
 assertManage(ctx);const v=trackingQuerySchema.parse(input);if(Date.parse(v.to)<=Date.parse(v.from)||Date.parse(v.to)-Date.parse(v.from)>366*86400000)throw badRequest('phone_report_range');
 const signature=s.digest({org:ctx.orgId,user:ctx.userId,v}),after=cursor?parseJson(Buffer.from(cursor,'base64url').toString()):{};if(cursor&&after.signature!==signature)throw badRequest('tracking_cursor_invalid');
 const clauses=['i.organization_id=?','i.created_at>=?','i.created_at<?'],params: any[]=[ctx.orgId,v.from,v.to];
 for(const f of ['phone_number','lead_source_id','marketing_campaign_id','pool_id','visit_id'] as const)if(v[f]){clauses.push(`i.${f}=?`);params.push(v[f]);}
 if(after.id){clauses.push('(i.created_at>? OR (i.created_at=? AND i.call_id>?))');params.push(after.created_at,after.created_at,after.id);}
 const bounded=Math.min(200,Math.max(1,limit)),items:s.Json[]=[];let nextCursor='';
 // Scan bounded SQL pages and advance across denied calls without exposing their identities.
 for(let batch=0;batch<10;batch++){
  const rows=await s.database().prepare(`SELECT i.* FROM phone_tracking_call_index i WHERE ${clauses.join(' AND ')} ORDER BY i.created_at,i.call_id LIMIT ?`).all(...params,bounded+1);
  if(!rows.length)break;let scanned:s.Json={};
  for(const raw of rows){const row=s.object(raw),call=await s.readCall(ctx.orgId,s.text(row.call_id));scanned=row;try{requireCallAccess(ctx,call);if(call.project_id)await projectContext(ctx,call.project_id);}catch{continue;}
   if(items.length===bounded){nextCursor=Buffer.from(JSON.stringify({signature,id:items[items.length-1]!.id,created_at:items[items.length-1]!.created_at})).toString('base64url');return {items,nextCursor};}
   items.push({id:call.id,created_at:call.created_at,customer_number:call.customer_number,business_number:call.business_number,contact_id:call.contact_id,project_id:call.project_id,state:call.state,connected_at:call.connected_at,ended_at:call.ended_at,attribution:s.object(call.metadata.attribution)});
  }
  if(rows.length<bounded+1)break;
  if(!after.id){clauses.push('(i.created_at>? OR (i.created_at=? AND i.call_id>?))');params.push(scanned.created_at,scanned.created_at,scanned.call_id);after.id=scanned.call_id;}
  else params.splice(params.length-3,3,scanned.created_at,scanned.created_at,scanned.call_id);
  nextCursor=Buffer.from(JSON.stringify({signature,id:scanned.call_id,created_at:scanned.created_at})).toString('base64url');
 }
 return {items,...(nextCursor?{nextCursor}:{})};
}
export async function trackingVisits(ctx:PlatformAuthContext,poolId:string,limit=100,after=''){
 const pool=await s.resource(ctx.orgId,'phone_tracking_pool',poolId);if(!pool)throw notFound('tracking_pool_missing');await authorizePool(ctx,pool);
 const rows=await s.database().prepare('SELECT id,phone_number,lease_until,reuse_after,attribution_json,created_at,updated_at FROM phone_tracking_sessions WHERE organization_id=? AND pool_id=? AND id>? ORDER BY id LIMIT ?').all(ctx.orgId,poolId,after,Math.min(200,Math.max(1,limit))+1);
 const items=rows.slice(0,limit).map(r=>{const row=s.object(r);return {id:row.id,phone_number:row.phone_number,lease_until:row.lease_until,reuse_after:row.reuse_after,created_at:row.created_at,updated_at:row.updated_at,attribution:parseJson(row.attribution_json)};});return {items,...(rows.length>limit?{nextCursor:s.text(items[items.length-1]?.id)}:{})};
}
export async function maintainTracking(){await backfillTrackingCalls();await s.database().prepare('DELETE FROM phone_tracking_rate WHERE expires_at<?').run(s.now());for(const raw of await s.database().prepare("SELECT organization_id,id FROM customer_voice_resources WHERE kind='phone_tracking_pool'").all()){const r=s.object(raw),pool=await s.resource(s.text(r.organization_id),'phone_tracking_pool',s.text(r.id));await s.database().prepare('DELETE FROM phone_tracking_sessions WHERE organization_id=? AND pool_id=? AND reuse_after<? AND updated_at<?').run(s.text(r.organization_id),s.text(r.id),s.now(),new Date(Date.now()-Number(pool?.retention_days||30)*86400000).toISOString());}}

export async function backfillTrackingCalls(limit=200){
 const cursor=s.object(await s.database().prepare("SELECT * FROM phone_tracking_scan WHERE id='history'").get()),rows=await s.database().prepare("SELECT organization_id,id,created_at FROM customer_calls WHERE direction='inbound' AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?").all(s.text(cursor.last_created_at),s.text(cursor.last_created_at),s.text(cursor.last_call_id),Math.min(1000,Math.max(1,limit)));
 for(const raw of rows){const r=s.object(raw);await indexTrackingCall(await s.readCall(s.text(r.organization_id),s.text(r.id)));}
 const last=s.object(rows[rows.length-1]);if(last.id)await s.database().prepare("INSERT INTO phone_tracking_scan(id,last_created_at,last_call_id) VALUES('history',?,?) ON CONFLICT(id) DO UPDATE SET last_created_at=excluded.last_created_at,last_call_id=excluded.last_call_id WHERE phone_tracking_scan.last_created_at<excluded.last_created_at OR (phone_tracking_scan.last_created_at=excluded.last_created_at AND phone_tracking_scan.last_call_id<excluded.last_call_id)").run(s.text(last.created_at),s.text(last.id));return rows.length;
}
