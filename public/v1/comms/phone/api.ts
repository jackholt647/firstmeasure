import {saveBusiness,registerBusiness,renderAuthorization,submitAuthorization,correctBusiness,remediation,carrierTerms,disableReputation,resolveAttempt} from './reputation-product.js';
import { reputationWorkspace, changeReputation } from './reputation.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePlatformAuth, hasPermission } from '../../platform/auth.js';
import { forbidden } from '../../platform/errors.js';
import { canUseScopedPermission, hasResourcePermission } from '../../workforce/department-access.js';
import { workspace, saveLine, saveGroup, savePersonal, trackingReport, assertManage, saveMessaging, saveLead, saveMailbox } from './service.js';
import { createPortDraft, checkPortability, startPort, updatePort, uploadPortDocument, refreshPort, portAction, carrierWritesAllowed } from './porting.js';
import { searchNumbers, purchaseNumber, refreshNumber, enableLineSms } from './numbers.js';
import { requireCallAccess, callDepartmentResource } from '../calls/service.js';
import { voiceHealth } from '../calls/operations.js';
import { listUsageEvents } from '../../messaging/communications_storage.js';
import * as s from '../calls/storage.js';
import { saveGreeting, readGreeting } from './greetings.js';

const base='/organizations/:orgId/phone';
const param=(r:FastifyRequest,k:string)=>s.text(s.object(r.params)[k]);
async function auth(r:FastifyRequest,write=false){const ctx=await requirePlatformAuth(r,{orgId:param(r,'orgId'),csrf:write,capability:'apps.comms'});if(!canUseScopedPermission(ctx,'make_calls|send_comms|send_communications|view_comms|manage_communications|manage_company_settings'))throw forbidden('phone_settings_denied','You do not have access to phone settings.');return ctx;}
export function registerPhoneSettingsApi(app:FastifyInstance){
  app.post(`${base}/reputation/resolve`,async r=>({ok:true,...await resolveAttempt(await auth(r,true),r.body)}));
  app.put(`${base}/reputation/business`,async r=>({ok:true,account:await saveBusiness(await auth(r,true),r.body)}));
  app.post(`${base}/reputation/register`,async r=>({ok:true,...await registerBusiness(await auth(r,true),r.body)}));
  app.post(`${base}/reputation/business/correct`,async r=>({ok:true,...await correctBusiness(await auth(r,true),r.body)}));
  app.post(`${base}/reputation/authorization/render`,{bodyLimit:2*1024*1024},async(r,reply)=>{const pdf=await renderAuthorization(await auth(r,true),r.body||{});return reply.header('Cache-Control','private, no-store').send({ok:true,file:pdf.file.toString('base64'),version:pdf.version});});
  app.post(`${base}/reputation/authorization`,{bodyLimit:12*1024*1024},async r=>({ok:true,...await submitAuthorization(await auth(r,true),r.body)}));
  app.post(`${base}/reputation/remediation`,async r=>({ok:true,...await remediation(await auth(r,true),r.body)}));
  app.post(`${base}/reputation/disable`,async r=>{const v=z.object({confirmed:z.literal(true),operation_id:z.string()}).parse(r.body);return {ok:true,...await disableReputation(await auth(r,true),v.operation_id)};});
  app.get(`${base}/reputation/carrier-terms`,async r=>({ok:true,status:await carrierTerms(await auth(r))}));
  app.post(`${base}/reputation/carrier-terms`,async r=>{z.object({confirmed:z.literal(true)}).parse(r.body);return {ok:true,status:await carrierTerms(await auth(r,true),true)};});

  app.get(`${base}/reputation`,async r=>({ok:true,...await reputationWorkspace(await auth(r))}));
  app.post(`${base}/reputation`,async r=>({ok:true,...await changeReputation(await auth(r,true),r.body)}));
  app.post(`${base}/greetings`,{bodyLimit:6*1024*1024},async r=>({ok:true,greeting:await saveGreeting(await auth(r,true),r.body)}));
  app.get('/phone-greetings/:orgId/:id',async(r,reply)=>{const q=s.object(r.query),audio=await readGreeting(param(r,'orgId'),param(r,'id'),s.text(q.expires),s.text(q.signature));return reply.header('Content-Type',audio.content_type).header('Cache-Control','private, no-store').send(audio.buffer);});
  app.get(base,async r=>({ok:true,...await workspace(await auth(r)),carrier_writes:carrierWritesAllowed()}));
  app.put(`${base}/personal`,async r=>({ok:true,personal:await savePersonal(await auth(r,true),r.body)}));
  app.put(`${base}/lines/:number`,async r=>({ok:true,line:await saveLine(await auth(r,true),param(r,'number'),r.body)}));
  app.put(`${base}/groups/:id`,async r=>({ok:true,group:await saveGroup(await auth(r,true),param(r,'id'),r.body)}));
  app.put(`${base}/messaging`,async r=>({ok:true,policy:await saveMessaging(await auth(r,true),r.body)}));
  app.get(`${base}/tracking`,async r=>{const ctx=await auth(r),q=z.object({from:z.string(),to:z.string()}).parse(r.query);return {ok:true,...await trackingReport(ctx,q.from,q.to)};});
  app.put(`${base}/leads/:id`,async r=>({ok:true,lead:await saveLead(await auth(r,true),param(r,'id'),r.body)}));
  app.get(`${base}/voicemail`,async r=>{const ctx=await auth(r);const candidates=await s.database().prepare("SELECT DISTINCT call_id FROM customer_call_artifacts WHERE organization_id=? AND kind='voicemail' AND state='ready' AND expires_at>? ORDER BY call_id LIMIT 300").all(ctx.orgId,s.now());const messages=[];for(const row of candidates){const call=await s.readCall(ctx.orgId,s.text(s.object(row).call_id));try{requireCallAccess(ctx,call);}catch{continue;}if(!hasResourcePermission(ctx,"view_call_recordings|manage_communications|manage_company_settings",callDepartmentResource(call)))continue;messages.push({call_id:call.id,from:call.customer_name||call.customer_number,number:call.business_number,created_at:call.created_at,artifacts:(await s.artifacts(ctx.orgId,call.id)).filter(a=>a.state==='ready'&&s.text(a.expires_at)>s.now()).map(a=>({id:a.id,kind:a.kind,...(a.kind==='transcript'?{text:s.object(a.data).text}:{})})),handled:await s.resource(ctx.orgId,'phone_mailbox',call.id)||null});}return {ok:true,messages};});
  app.put(`${base}/voicemail/:id`,async r=>({ok:true,mailbox:await saveMailbox(await auth(r,true),param(r,'id'),r.body)}));
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
