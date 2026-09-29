import type { FastifyInstance } from 'fastify';
import { requirePlatformAuth, hasPermission, can } from '../auth.js';
import { readDocument, upsertDocument } from '../storage.js';
import { notificationCatalog, catalogDefinitions } from '../notification_catalog.js';
import { listRules, saveRule, ruleHistory, notificationStore } from './store.js';
import { quietSchema, ruleSchema } from './contracts.js';
import { acknowledgeDelivery, drainNotifications } from './delivery.js';
import { listDocumentTemplates } from '../../documents/storage.js';
import { documentTags } from '../../documents/tags.js';
import { badRequest } from '../errors.js';
type Json=Record<string,unknown>;
export async function notificationRuleCatalog(org:string,auth:Awaited<ReturnType<typeof requirePlatformAuth>>){
 const templates=hasPermission(auth,'view_documents')&&await can(auth,'platform.documents')?await listDocumentTemplates(org):[];
 const evaluations=await notificationStore().prepare('SELECT notification_id,state,audit_json FROM notification_recipients WHERE organization_id=? AND user_id=? ORDER BY deadline_at DESC LIMIT 50').all(org,auth.userId);
 return {evaluations:evaluations.map(e=>({notification_id:e.notification_id,state:e.state,decisions:JSON.parse(String(e.audit_json))})),rules:await listRules(org,auth.userId),history:await ruleHistory(org,auth.userId),documents:templates.map(t=>({id:t.id,name:t.name,document_type:t.document_type,tags:documentTags(t.tags)}))};
}
export async function configureRule(org:string,auth:Awaited<ReturnType<typeof requirePlatformAuth>>,input:unknown){
 const rule=ruleSchema.parse(input);
 const catalog=catalogDefinitions(await notificationCatalog(org,auth.branchId||'default',auth));
 if(!catalog.some(d=>d.event===rule.event))throw badRequest('notification_event_denied','Choose an authorized event.');
 if(Object.keys(rule.bindings).length>16)throw badRequest('notification_binding_limit','Use at most sixteen data bindings.');
 return saveRule(org,auth.userId,rule);
}
export async function registerNotificationRulesApi(app:FastifyInstance){
 const route='/organizations/:orgId/notification-rules';
 app.get(route,async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications'});return {ok:true,...await notificationRuleCatalog(org,auth)};});
 app.put(route,async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});return {ok:true,rule:await configureRule(org,auth,request.body)};});
 app.patch('/organizations/:orgId/notification-quiet-hours',async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true}),quiet=quietSchema.parse(request.body);try{new Intl.DateTimeFormat('en',{timeZone:quiet.timezone}).format();}catch{throw badRequest('notification_timezone','Choose an IANA timezone.');}const user=await readDocument(org,'users',auth.userId),data=user.data as Json;await upsertDocument(org,'users',{id:user.id,data:{...data,notification_preferences:{...(data.notification_preferences as Json||{}),quiet_hours:quiet}},metadata:user.metadata,expected_revision:user.revision},{replace:true});return {ok:true,quiet_hours:quiet};});
 app.post('/organizations/:orgId/notification-deliveries/:id/ack',async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});const claimed=await acknowledgeDelivery(org,auth.userId,String((request.params as Json).id));return {ok:true,claimed};});
 if(process.env.NODE_ENV!=='test'&&process.env.NOTIFICATION_LANE_DISABLED!=='1'){const timer=setInterval(()=>{void drainNotifications().catch(error=>app.log.warn({err:error},'Notification lane failed'));},2000);timer.unref();app.addHook('onClose',async()=>clearInterval(timer));}
}
