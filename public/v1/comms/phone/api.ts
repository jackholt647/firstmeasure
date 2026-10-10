import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePlatformAuth, hasPermission } from '../../platform/auth.js';
import { forbidden, badRequest, notFound } from '../../platform/errors.js';
import { canUseScopedPermission, hasResourcePermission } from '../../workforce/department-access.js';
import { messagingPolicySchema } from './contracts.js';
import { workspace, saveLine, saveGroup, savePersonal, trackingReport, assertManage } from './service.js';
import { createPortDraft, checkPortability, startPort, updatePort, uploadPortDocument, refreshPort, portAction, carrierWritesAllowed } from './porting.js';
import { searchNumbers, purchaseNumber, refreshNumber, enableLineSms } from './numbers.js';
import { requireCallAccess, callDepartmentResource, projectContext } from '../calls/service.js';
import { voiceHealth } from '../calls/operations.js';
import { listUsageEvents } from '../../messaging/communications_storage.js';
import * as s from '../calls/storage.js';
import { saveGreeting, readGreeting } from './greetings.js';

const base='/organizations/:orgId/phone';
const param=(r:FastifyRequest,k:string)=>s.text(s.object(r.params)[k]);
async function auth(r:FastifyRequest,write=false){const ctx=await requirePlatformAuth(r,{orgId:param(r,'orgId'),csrf:write,capability:'apps.comms'});if(!canUseScopedPermission(ctx,'make_calls|send_comms|send_communications|view_comms|manage_communications|manage_company_settings'))throw forbidden('phone_settings_denied','You do not have access to phone settings.');return ctx;}
export function registerPhoneSettingsApi(app:FastifyInstance){
  app.post(`${base}/greetings`,{bodyLimit:6*1024*1024},async r=>({ok:true,greeting:await saveGreeting(await auth(r,true),r.body)}));
  app.get('/phone-greetings/:orgId/:id',async(r,reply)=>{const q=s.object(r.query),audio=await readGreeting(param(r,'orgId'),param(r,'id'),s.text(q.expires),s.text(q.signature));return reply.header('Content-Type',audio.content_type).header('Cache-Control','private, no-store').send(audio.buffer);});
  app.get(base,async r=>({ok:true,...await workspace(await auth(r)),carrier_writes:carrierWritesAllowed()}));
  app.put(`${base}/personal`,async r=>({ok:true,personal:await savePersonal(await auth(r,true),r.body)}));
  app.put(`${base}/lines/:number`,async r=>({ok:true,line:await saveLine(await auth(r,true),param(r,'number'),r.body)}));
  app.put(`${base}/groups/:id`,async r=>({ok:true,group:await saveGroup(await auth(r,true),param(r,'id'),r.body)}));
  app.put(`${base}/messaging`,async r=>{const ctx=await auth(r,true);assertManage(ctx);const input=z.object({revision:z.number().int().nonnegative(),policy:messagingPolicySchema}).parse(r.body);return {ok:true,policy:await s.saveResource(ctx.orgId,'phone_messaging','default',input.policy,'',input.revision)};});
  app.get(`${base}/tracking`,async r=>{const ctx=await auth(r),q=z.object({from:z.string(),to:z.string()}).parse(r.query);return {ok:true,...await trackingReport(ctx,q.from,q.to)};});
  app.put(`${base}/leads/:id`,async r=>{const ctx=await auth(r,true),id=param(r,'id'),lead=await s.resource(ctx.orgId,'phone_lead',id);if(!lead)throw notFound('phone_lead_missing','This inquiry is unavailable.');assertManage(ctx,lead);const value=z.object({project_id:z.string().max(180),status:z.enum(['new','qualified','converted','spam']),revision:z.number().int().nonnegative()}).parse(r.body);if(value.project_id)await projectContext(ctx,value.project_id);return {ok:true,lead:await s.saveResource(ctx.orgId,'phone_lead',id,{...lead,...value},'',value.revision)};});
  app.get(`${base}/voicemail`,async r=>{const ctx=await auth(r);const candidates=await s.database().prepare("SELECT DISTINCT call_id FROM customer_call_artifacts WHERE organization_id=? AND kind='voicemail' AND state='ready' AND expires_at>? ORDER BY call_id LIMIT 300").all(ctx.orgId,s.now());const messages=[];for(const row of candidates){const call=await s.readCall(ctx.orgId,s.text(s.object(row).call_id));try{requireCallAccess(ctx,call);}catch{continue;}if(!hasResourcePermission(ctx,"view_call_recordings|manage_communications|manage_company_settings",callDepartmentResource(call)))continue;messages.push({call_id:call.id,from:call.customer_name||call.customer_number,number:call.business_number,created_at:call.created_at,artifacts:(await s.artifacts(ctx.orgId,call.id)).filter(a=>a.state==='ready'&&s.text(a.expires_at)>s.now()).map(a=>({id:a.id,kind:a.kind,...(a.kind==='transcript'?{text:s.object(a.data).text}:{})})),handled:await s.resource(ctx.orgId,'phone_mailbox',call.id)||null});}return {ok:true,messages};});
  app.put(`${base}/voicemail/:id`,async r=>{const ctx=await auth(r,true),call=await s.readCall(ctx.orgId,param(r,'id'));requireCallAccess(ctx,call);const value=z.object({handled:z.boolean(),revision:z.number().int().nonnegative()}).parse(r.body);return {ok:true,mailbox:await s.saveResource(ctx.orgId,'phone_mailbox',call.id,{handled:value.handled,handled_by:ctx.userId},'',value.revision)};});
  app.get(`${base}/billing`,async r=>{const ctx=await auth(r);if(!hasPermission(ctx,'view_platform_billing|manage_platform_billing|manage_billing'))throw forbidden('phone_billing_denied','You cannot view phone billing.');return {ok:true,health:await voiceHealth(ctx.orgId),numbers:(await s.resources(ctx.orgId,'number')).map(n=>({number:n.id,label:n.label,status:n.status,provider_cost:n.accepted_cost||null})),sms_usage:await listUsageEvents(ctx.orgId,{limit:100}),customer_billing_path:`/v1/platform-billing/organizations/${ctx.orgId}`};});
  app.get(`${base}/numbers/search`,async r=>({ok:true,numbers:await searchNumbers(await auth(r),s.text(s.object(r.query).area_code))}));
  app.post(`${base}/numbers/purchase`,async r=>({ok:true,order:await purchaseNumber(await auth(r,true),r.body)}));
  app.post(`${base}/orders/:id/refresh`,async r=>({ok:true,order:await refreshNumber(await auth(r,true),param(r,'id'))}));
  app.post(`${base}/lines/:number/sms`,async r=>({ok:true,sender:await enableLineSms(await auth(r,true),param(r,'number'),z.object({profile_id:z.string().min(1)}).parse(r.body).profile_id)}));
  app.get(`${base}/ports`,async r=>{const ctx=await auth(r);assertManage(ctx);return {ok:true,ports:await s.resources(ctx.orgId,'phone_port'),orders:await s.resources(ctx.orgId,'phone_order'),carrier_writes:carrierWritesAllowed()};});
  app.post(`${base}/ports`,async r=>({ok:true,port:await createPortDraft(await auth(r,true),r.body)}));
  app.post(`${base}/portability`,async r=>({ok:true,result:await checkPortability(await auth(r,true),z.object({phone_number:z.string()}).parse(r.body).phone_number)}));
  app.post(`${base}/ports/:id/start`,async r=>({ok:true,port:await startPort(await auth(r,true),param(r,'id'))}));
  app.put(`${base}/ports/:id/details`,async r=>({ok:true,port:await updatePort(await auth(r,true),param(r,'id'),r.body)}));
  app.post(`${base}/ports/:id/documents`,{bodyLimit:12*1024*1024},async r=>({ok:true,port:await uploadPortDocument(await auth(r,true),param(r,'id'),r.body)}));
  app.post(`${base}/ports/:id/refresh`,async r=>({ok:true,port:await refreshPort(await auth(r,true),param(r,'id'))}));
  app.post(`${base}/ports/:id/:action`,async r=>{const action=z.enum(['confirm','cancel']).parse(param(r,'action')),v=z.object({confirmed:z.boolean()}).parse(r.body);return {ok:true,port:await portAction(await auth(r,true),param(r,'id'),action,v.confirmed)};});
}
