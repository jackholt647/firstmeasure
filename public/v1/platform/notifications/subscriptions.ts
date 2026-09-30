import { initializeUserNotifications, effectiveRules } from './configuration.js';
import { listDocuments } from '../storage.js';
import { backgroundAuthContext, hasPermission } from '../auth.js';
import { isAppFlagEnabled } from '../app_flags.js';
import { builtInEventDefinitions, eventGroups, workflowPreferenceKey } from '../notification_catalog.js';
import { notificationStore, identity } from './store.js';
import { ruleSchema, matchesFilters } from './contracts.js';
import { notificationEvent } from './delivery.js';
import { eventIsSubscribable } from './registration.js';
import { readPlanRecord } from '../../work/storage.js';
type Json=Record<string,unknown>;
export async function notifyRuleSubscriptions(event:Json){
 if(!eventIsSubscribable(String(event.type)))return;
 const org=String(event.organization_id),branch=String(event.branch_id||'default');
 if(!await isAppFlagEnabled(org,'apps','notifications'))return;
 const definition=builtInEventDefinitions().find(d=>d.event===event.type);if(!definition)return;
 const app=eventGroups[String(event.type).split('.')[0]!] ?.app;
 if(app&&!await isAppFlagEnabled(org,'apps',app))return;
 const envelope=notificationEvent(event);
 if(String(event.type).startsWith('work.')){
  const payload=envelope.payload as Json;
  delete payload.scope_template_id;delete payload.work_plan_id;
  const plan=event.plan_id?await readPlanRecord(org,String(event.plan_id)):null;
  if(plan&&String(plan.branch_id||'default')===branch){payload.work_plan_id=plan.id;if(plan.template_id)payload.scope_template_id=plan.template_id;}
 }
 for(const user of await listDocuments(org,'users')){
  const auth=await backgroundAuthContext(org,user.id).catch(()=>null);
  if(!auth||String(auth.branchId||'default')!==branch||!hasPermission(auth,definition.permission))continue;
  await initializeUserNotifications(org,user.id,branch);
  const row={user_id:user.id};
  for(const rule of await effectiveRules(org,user.id,auth)){
  if(!rule.enabled||!rule.subscribe||rule.event!==event.type||!matchesFilters(rule.filters,envelope)||rule.scope_template_id&&rule.scope_template_id!==((envelope.payload||{}) as Json).scope_template_id)continue;
  const {createPlatformNotification}=await import('../api.js');
  await createPlatformNotification(org,{id:'rule_'+identity(event.id,rule.id,row.user_id),title:rule.title,body:rule.body,source:'notification_rule',category:definition.category,preference_key:workflowPreferenceKey(branch,"personal-notification-rules",String(row.user_id)+":"+rule.id),preference_defaults:{in_app:rule.methods.includes("in_app"),push:rule.methods.includes("push")},target_user_ids:[row.user_id],branch_id:branch,
   push:rule.methods.includes('push'),passive:rule.methods.includes('in_app'),delivery_methods:rule.methods,notification_event:envelope,context:{event_id:event.id,project_id:event.project_id,rule_id:rule.id,scope_template_id:(envelope.payload as Json).scope_template_id},frontend_action:event.project_id?{kind:'open_project',project_id:event.project_id}:{}});
  }
 }
}
