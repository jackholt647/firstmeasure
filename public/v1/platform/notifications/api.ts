import { registerNotificationConfigurationApi } from './configuration-api.js';
import { initializeUserNotifications, assertNotificationChange, effectiveRules, applicableLocks } from './configuration.js';
import { notificationPermissions } from './permissions.js';
import { readPersonalConfiguration, patchPersonalConfiguration } from './defaults.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requirePlatformAuth, hasPermission, can } from '../auth.js';
import { readDocument, upsertDocument } from '../storage.js';
import { notificationCatalog, catalogDefinitions, workflowPreferenceKey } from '../notification_catalog.js';
import { listRules, saveRule, savePersonalRemovalLockRule, deleteRule, ruleHistory, notificationStore, identity } from './store.js';
import { quietSchema, ruleSchema, methodSchema } from './contracts.js';
import { acknowledgeDelivery, drainNotifications } from './delivery.js';
import { listDocumentTemplates, listDocumentWorkflows } from '../../documents/storage.js';
import { documentTags } from '../../documents/tags.js';
import { listDocumentTags } from '../../documents/tag-catalog.js';
import { workEventNotification } from '../../work/events.js';
import { getWorkDatabase } from '../../work/storage.js';
import { readAutomationRules, saveAutomationRules } from '../../work/rules.js';
import { eventIsSubscribable, eventTagPath, notificationGroupingPaths, eventGroupingPaths } from './registration.js';
import { badRequest, conflict } from '../errors.js';
type Json=Record<string,unknown>;
export async function notificationRuleCatalog(org:string,auth:Awaited<ReturnType<typeof requirePlatformAuth>>){
 const templates=hasPermission(auth,'view_documents')&&await can(auth,'platform.documents')?await listDocumentTemplates(org):[];
 const document_workflows=hasPermission(auth,'view_documents')&&await can(auth,'platform.documents')?(await listDocumentWorkflows(org)).map(workflow=>({id:String(workflow.id),label:String(workflow.name)})):[];
 const evaluations=await notificationStore().prepare('SELECT notification_id,state,audit_json FROM notification_recipients WHERE organization_id=? AND user_id=? ORDER BY deadline_at DESC LIMIT 50').all(org,auth.userId);
 const events=catalogDefinitions(await notificationCatalog(org,auth.branchId||'default',auth)).filter(d=>d.key.startsWith('event.')&&d.event&&eventIsSubscribable(d.event)).map(d=>({event:d.event!,label:d.label,source_label:d.source_label,description:d.description,notification:workEventNotification(d.event!),tag_path:eventTagPath(d.event!),group_paths:eventGroupingPaths(d.event!)}));
 const tags=hasPermission(auth,'view_documents')&&await can(auth,'platform.documents')?await listDocumentTags(org):[];
 const scopes=hasPermission(auth,'view_projects|manage_company_settings')?(await getWorkDatabase().prepare("SELECT id,name FROM scope_templates WHERE organization_id=? AND branch_id=? AND status!='archived' ORDER BY name").all(org,auth.branchId||'default')).map(row=>({id:String(row.id),label:String(row.name)})):[];
 const policy=await applicableLocks(org,auth);
 const changes=await notificationStore().prepare("SELECT kind,revision,created_at FROM notification_configuration_history WHERE organization_id=? AND (user_id=? OR kind IN ('organization_defaults','organization_defaults_reset','organization_locks')) ORDER BY created_at DESC LIMIT 100").all(org,auth.userId);
 const history=[...await ruleHistory(org,auth.userId),...changes.map(change=>({rule_id:String(change.kind).startsWith('organization_')?'Organization settings':'Personal settings',revision:change.revision,created_at:change.created_at,reason:({organization_defaults:'Organization defaults published',organization_defaults_reset:'System defaults restored for future users',organization_locks:'Organization protection updated',personal_initialized:'Personal defaults initialized',personal_updated:'Personal notification configuration updated',personal_observed:'Notification added to personal configuration'} as Record<string,string>)[String(change.kind)]||String(change.kind)}))].sort((a,b)=>String((b as Json).created_at).localeCompare(String((a as Json).created_at))).slice(0,100);
 return {permissions:notificationPermissions(auth),locks_revision:policy.revision,rule_locks:Object.fromEntries(Object.entries(policy.locks).filter(([key])=>key.startsWith('rule:')).map(([key,lock])=>[key.slice(5),lock.mode])),events,tags,scopes,document_workflows,evaluations:evaluations.map(e=>({notification_id:e.notification_id,state:e.state,decisions:JSON.parse(String(e.audit_json))})),rules:await effectiveRules(org,auth.userId,auth),history,documents:templates.map(t=>({id:t.id,name:t.name,document_type:t.document_type,tags:documentTags(t.tags)}))};
}
export async function configureRule(org:string,auth:Awaited<ReturnType<typeof requirePlatformAuth>>,input:unknown){
 const rule=ruleSchema.parse(input);
 await assertNotificationChange(auth,'rule:'+rule.id,!rule.enabled);
 await initializeUserNotifications(org,auth.userId,auth.branchId||'default');
 const catalog=catalogDefinitions(await notificationCatalog(org,auth.branchId||'default',auth));
 if(!catalog.some(d=>d.event===rule.event))throw badRequest('notification_event_denied','Choose an authorized event.');
 if(rule.subscribe&&!eventIsSubscribable(rule.event))throw badRequest('notification_event_denied','This event uses its app-specific notification controls.');
 if(rule.subscribe&&rule.methods.includes('customer_portal'))throw badRequest('notification_portal_audience','Customer portal delivery requires a workflow with an explicit customer audience and customer copy.');
 if(Object.keys(rule.bindings).length>16)throw badRequest('notification_binding_limit','Use at most sixteen data bindings.');
 if(!notificationPermissions(auth).organization&&!(await listRules(org,auth.userId)).some(existing=>existing.id===rule.id)){
  const policy=await applicableLocks(org,auth);
  if(policy.locks['rule:'+rule.id]?.mode==='removal')return savePersonalRemovalLockRule(org,auth.userId,rule,policy.revision);
 }
 return saveRule(org,auth.userId,rule);
}
const registrationSchema=z.object({request_id:z.string().uuid().optional(),event:z.string().min(1).max(120),title:z.string().trim().min(1).max(140).optional(),tags:z.array(z.string().min(1).max(80)).max(20).default([]),methods:z.array(methodSchema).min(1).max(7),group:ruleSchema.shape.group,scope_template_id:z.string().max(150).optional(),document_workflow_id:z.string().max(150).optional()}).strict();
export async function createNotificationRegistration(org:string,auth:Awaited<ReturnType<typeof requirePlatformAuth>>,input:unknown){
 const data=registrationSchema.parse(input),catalog=await notificationRuleCatalog(org,auth),event=catalog.events.find(e=>e.event===data.event);
 if(!event)throw badRequest('notification_event_denied','Choose an authorized event.');
 if(data.methods.includes('customer_portal'))throw badRequest('notification_portal_audience','Customer portal delivery requires a workflow with an explicit customer audience and customer copy.');
 const tags=documentTags(data.tags);
 if(tags.length&&(!event.tag_path||tags.some(tag=>!catalog.tags.some(t=>t.id===tag&&!t.archived))))throw badRequest('notification_tags_invalid','Choose available tags for this event.');
 if(data.group&&!event.group_paths.includes(data.group.path as typeof notificationGroupingPaths[number]))throw badRequest('notification_group_invalid','Choose an available grouping field.');
 if(data.document_workflow_id&&(!data.event.startsWith('document.')||!catalog.document_workflows.some(workflow=>workflow.id===data.document_workflow_id)))throw badRequest('notification_workflow_denied','Choose an authorized document workflow for a document event.');
 if(data.scope_template_id){
  if(!data.event.startsWith('work.'))throw badRequest('notification_scope_unsupported','Scope selectors apply to scope events. Document events use a document workflow selector.');
  if(!hasPermission(auth,'view_projects|manage_company_settings'))throw badRequest('notification_scope_denied','Choose an authorized scope.');
  const scope=await getWorkDatabase().prepare("SELECT id FROM scope_templates WHERE organization_id=? AND branch_id=? AND id=? AND status!='archived'").get(org,auth.branchId||'default',data.scope_template_id);
  if(!scope)throw badRequest('notification_scope_denied','Choose an authorized scope.');
 }
 const candidate=ruleSchema.parse({id:'custom_'+(data.request_id?identity(org,auth.userId,data.request_id):randomUUID().replaceAll('-','')),event:data.event,title:data.title||event.label,intent:`Notify me when ${event.label}${tags.length?' with all tags '+tags.join(', '):''}.`,filters:[...tags.map(value=>({path:event.tag_path,op:'contains',value})),...(data.document_workflow_id?[{path:'payload.workflow_id',op:'eq',value:data.document_workflow_id}]:[])],methods:[...new Set(data.methods)],subscribe:true,source:'return {outputs:{}};',...(data.group?{group:data.group}:{}),...(data.scope_template_id?{scope_template_id:data.scope_template_id}:{})});
 const previous=()=>listRules(org,auth.userId).then(rules=>rules.find(rule=>rule.id===candidate.id));
 const repeat=(rule:NonNullable<Awaited<ReturnType<typeof previous>>>)=>{
  if(JSON.stringify({...rule,revision:0})!==JSON.stringify(candidate))throw conflict('notification_registration_changed','This request already created a different notification. Open a new registration to create another.');
  return rule;
 };
 if(data.request_id){const existing=await previous();if(existing)return repeat(existing);}
 try{return await configureRule(org,auth,candidate);}catch(error){if(data.request_id){const existing=await previous();if(existing)return repeat(existing);}throw error;}
}
export async function registerNotificationRulesApi(app:FastifyInstance){
 await registerNotificationConfigurationApi(app);
 const route='/organizations/:orgId/notification-rules';
 app.get(route,async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications'});return {ok:true,...await notificationRuleCatalog(org,auth)};});
 app.put(route,async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});return {ok:true,rule:await configureRule(org,auth,request.body)};});
 app.post('/organizations/:orgId/notification-registrations',async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});return {ok:true,rule:await createNotificationRegistration(org,auth,request.body)};});
 app.post('/organizations/:orgId/notification-registrations/remove',async request=>{
  const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true}),{key}=z.object({key:z.string().min(1).max(200)}).strict().parse(request.body);
  await assertNotificationChange(auth,key,true);
  const personal=await initializeUserNotifications(org,auth.userId,auth.branchId||'default');
  if(personal.catalog.some(g=>g.definitions.some(d=>d.key===key))){
   const record=await readDocument(org,'users',auth.userId),stored=(record.data.notification_preferences||{}) as Json,next:Json={...stored,custom_keys:(Array.isArray(stored.custom_keys)?stored.custom_keys:[]).filter(k=>k!==key)};
   for(const method of ['in_app','push','email','sms','toast','audio','celebration'])next[method]={...(stored[method] as Json||{}),[key]:false};
   await upsertDocument(org,'users',{id:record.id,data:{...record.data,notification_preferences:next},metadata:record.metadata,expected_revision:record.revision},{replace:true});
   await patchPersonalConfiguration(org,auth.userId,auth.branchId||'default',{revision:personal.revision,remove_keys:[key]});return {ok:true,deleted:true};
  }
  const user=await readDocument(org,'users',auth.userId),data=user.data as Json,prefs=(data.notification_preferences||{}) as Json;
  const catalog=await notificationCatalog(org,auth.branchId||'default',auth);
  if(!catalogDefinitions(catalog).some(d=>d.key===key))throw badRequest('notification_registration_denied','Choose one of your notification registrations.');
  const customKeys=Array.isArray(prefs.custom_keys)?prefs.custom_keys.map(String):[];
  const legacy=await readAutomationRules(org,auth.branchId||'default');
  const rule=legacy.rules.find(rule=>String(rule.id).startsWith('custom_notification_')&&workflowPreferenceKey(auth.branchId||'default','organization-automations',String(rule.id))===key);
  if(rule){
   const input=(rule.input||{}) as Json,targets=Array.isArray(input.target_user_ids)?input.target_user_ids.map(String):[];
   if(!targets.includes(auth.userId))throw badRequest('notification_registration_denied','Choose one of your notification registrations.');
   const remaining=targets.filter(id=>id!==auth.userId),roles=Array.isArray(input.target_role_ids)?input.target_role_ids:[];
   await saveAutomationRules(org,auth.branchId||'default',{expected_revision:legacy.revision,rules:legacy.rules.flatMap(item=>item!==rule?[item]:remaining.length||roles.length?[{...rule,input:{...input,target_user_ids:remaining}}]:[])});
  }else if(!customKeys.includes(key)&&!key.startsWith('event.'))throw badRequest('notification_registration_denied','This notification is managed by its app.');
  const next:Json={...prefs,custom_keys:customKeys.filter(k=>k!==key)};
  for(const method of ['in_app','push','email','sms','toast','audio','celebration'])next[method]={...(prefs[method] as Json||{}),[key]:false};
  await upsertDocument(org,'users',{id:user.id,data:{...data,notification_preferences:next},metadata:user.metadata,expected_revision:user.revision},{replace:true});
  return {ok:true,deleted:true};
 });
 app.delete(route+'/:id',async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true}),body=z.object({revision:z.number().int().positive()}).strict().parse(request.body);await assertNotificationChange(auth,'rule:'+String((request.params as Json).id),true);return {ok:true,...await deleteRule(org,auth.userId,String((request.params as Json).id),body.revision)};});
 app.patch('/organizations/:orgId/notification-quiet-hours',async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true}),quiet=quietSchema.parse(request.body);await assertNotificationChange(auth);await initializeUserNotifications(org,auth.userId,auth.branchId||'default');try{new Intl.DateTimeFormat('en',{timeZone:quiet.timezone}).format();}catch{throw badRequest('notification_timezone','Choose an IANA timezone.');}const user=await readDocument(org,'users',auth.userId),data=user.data as Json;await upsertDocument(org,'users',{id:user.id,data:{...data,notification_preferences:{...(data.notification_preferences as Json||{}),quiet_hours:quiet}},metadata:user.metadata,expected_revision:user.revision},{replace:true});return {ok:true,quiet_hours:quiet};});
 app.post('/organizations/:orgId/notification-deliveries/:id/ack',async request=>{const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});const claimed=await acknowledgeDelivery(org,auth.userId,String((request.params as Json).id));return {ok:true,claimed};});
 if(process.env.NODE_ENV!=='test'&&process.env.NOTIFICATION_LANE_DISABLED!=='1'){const timer=setInterval(()=>{void drainNotifications().catch(error=>app.log.warn({err:error},'Notification lane failed'));},2000);timer.unref();app.addHook('onClose',async()=>clearInterval(timer));}
}
