import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import {requirePlatformAuth,type PlatformAuthContext} from '../../platform/auth.js';
import {forbidden,notFound} from '../../platform/errors.js';
import {contactOptions} from '../../contacts/service.js';
import {projectContext} from '../calls/service.js';
import {listSenderIdentities} from '../../messaging/communications_storage.js';
import {assertManage,canUseLine} from './service.js';
import {saveSource,savePool,authorizePool,assignVisitor,releaseVisitor,trackingCalls,trackingVisits} from './tracking.js';
import {saveBroadcast,addAudience,removeAudience,previewBroadcast,commandBroadcast,broadcastRecipients,broadcastReport} from './broadcast.js';
import * as s from '../calls/storage.js';

const base='/organizations/:orgId/phone',param=(r:FastifyRequest,k:string)=>s.text(s.object(r.params)[k]);
async function auth(r:FastifyRequest,write=false){const ctx=await requirePlatformAuth(r,{orgId:param(r,'orgId'),csrf:write,capability:'apps.comms'});assertManage(ctx);return ctx;}
async function authorizedRows(ctx:PlatformAuthContext,kind:string){const out:s.Json[]=[];for(const row of await s.resources(ctx.orgId,kind))try{if(kind==='phone_tracking_pool')await authorizePool(ctx,row);else assertManage(ctx,row);out.push(row);}catch{}return out;}
export function registerPhoneMarketingApi(app:FastifyInstance){
 app.get(`${base}/marketing`,async r=>{const ctx=await auth(r),senders=[];for(const row of await listSenderIdentities(ctx.orgId,'','sms'))if(row.status==='active'&&await canUseLine(ctx,s.text(row.address)))senders.push({id:row.id,label:row.display_name||row.address,address:row.address});return {ok:true,sources:await authorizedRows(ctx,'phone_tracking_source'),pools:await authorizedRows(ctx,'phone_tracking_pool'),broadcasts:await authorizedRows(ctx,'phone_broadcast'),senders};});
 app.put(`${base}/sources/:id`,async r=>({ok:true,source:await saveSource(await auth(r,true),param(r,'id'),r.body)}));
 app.put(`${base}/website-pools/:id`,async r=>({ok:true,pool:await savePool(await auth(r,true),param(r,'id'),r.body)}));
 app.get(`${base}/website-pools/:id/visits`,async r=>{const q=s.object(r.query);return {ok:true,...await trackingVisits(await auth(r),param(r,'id'),Number(q.limit)||100,s.text(q.after))};});
 app.get(`${base}/tracking-calls`,async r=>{const q=s.object(r.query),{limit,cursor,...filter}=q;return {ok:true,...await trackingCalls(await auth(r),filter,Number(limit)||100,s.text(cursor))};});
 app.get(`${base}/marketing/contacts`,async r=>{const ctx=await auth(r),q=s.object(r.query),query=s.text(q.query).toLowerCase(),limit=Math.min(200,Math.max(1,Number(q.limit)||100)),after=s.text(q.after),items=[];let last='';
  for(const c of (await contactOptions(ctx.orgId,'human')).sort((a,b)=>s.text(a.contact_id).localeCompare(s.text(b.contact_id)))){if(s.text(c.contact_id)<=after||query&&!s.text(c.name).toLowerCase().includes(query))continue;try{await projectContext(ctx,s.text(c.project_id));}catch{continue;}if(items.length===limit)return {ok:true,items,nextCursor:last};items.push(c);last=s.text(c.contact_id);}return {ok:true,items};});
 app.put(`${base}/broadcasts/:id`,async r=>({ok:true,campaign:await saveBroadcast(await auth(r,true),param(r,'id'),r.body)}));
 app.post(`${base}/broadcasts/:id/audience`,async r=>({ok:true,...await addAudience(await auth(r,true),param(r,'id'),r.body)}));
 app.delete(`${base}/broadcasts/:id/audience/:recipient`,async r=>({ok:true,campaign:await removeAudience(await auth(r,true),param(r,'id'),param(r,'recipient'),z.object({revision:z.number().int().nonnegative()}).parse(r.body).revision)}));
 app.get(`${base}/broadcasts/:id/preview`,async r=>({ok:true,...await previewBroadcast(await auth(r),param(r,'id'),Number(s.object(r.query).limit)||500,s.text(s.object(r.query).cursor))}));
 app.post(`${base}/broadcasts/:id/control`,async r=>({ok:true,campaign:await commandBroadcast(await auth(r,true),param(r,'id'),r.body)}));
 app.get(`${base}/broadcasts/:id/recipients`,async r=>{const q=s.object(r.query);return {ok:true,...await broadcastRecipients(await auth(r),param(r,'id'),Number(q.limit)||100,s.text(q.after))};});
 app.get(`${base}/broadcasts/:id/report`,async r=>({ok:true,...await broadcastReport(await auth(r),param(r,'id'))}));
 const publicBase='/phone-tracking/:orgId/pools/:id';
 async function origin(r:FastifyRequest,reply:FastifyReply){const origin=s.text(r.headers.origin),pool=await s.resource(param(r,'orgId'),'phone_tracking_pool',param(r,'id'));if(!pool)throw notFound('tracking_pool_missing');if(!s.strings(pool.origins).includes(origin))throw forbidden('tracking_origin_denied');reply.header('Access-Control-Allow-Origin',origin).header('Vary','Origin').header('Cache-Control','no-store');return origin;}
 app.options(`${publicBase}/:action`,async(r,reply)=>{await origin(r,reply);return reply.header('Access-Control-Allow-Methods','POST, OPTIONS').header('Access-Control-Allow-Headers','Content-Type').code(204).send();});
 app.post(`${publicBase}/assign`,{bodyLimit:8192},async(r,reply)=>({ok:true,...await assignVisitor(param(r,'orgId'),param(r,'id'),await origin(r,reply),r.ip,r.body)}));
 app.post(`${publicBase}/release`,{bodyLimit:2048},async(r,reply)=>({ok:true,...await releaseVisitor(param(r,'orgId'),param(r,'id'),await origin(r,reply),z.object({visitor_key:z.string()}).strict().parse(r.body).visitor_key)}));
}
