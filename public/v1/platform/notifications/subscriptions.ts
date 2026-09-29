import { backgroundAuthContext, hasPermission } from '../auth.js';
import { isAppFlagEnabled } from '../app_flags.js';
import { builtInEventDefinitions, eventGroups, workflowPreferenceKey } from '../notification_catalog.js';
import { notificationStore, identity } from './store.js';
import { ruleSchema, matchesFilters } from './contracts.js';
import { notificationEvent } from './delivery.js';
type Json=Record<string,unknown>;
export async function notifyRuleSubscriptions(event:Json){
 const org=String(event.organization_id),branch=String(event.branch_id||'default');
 if(!await isAppFlagEnabled(org,'apps','notifications'))return;
 const definition=builtInEventDefinitions().find(d=>d.event===event.type);if(!definition)return;
 const app=eventGroups[String(event.type).split('.')[0]!] ?.app;
 if(app&&!await isAppFlagEnabled(org,'apps',app))return;
 for(const row of await notificationStore().prepare('SELECT user_id,data_json FROM notification_rules WHERE organization_id=?').all(org)){
  const rule=ruleSchema.parse(JSON.parse(String(row.data_json)));const envelope=notificationEvent(event);
  if(!rule.enabled||!rule.subscribe||rule.event!==event.type||!matchesFilters(rule.filters,envelope)||rule.scope_template_id&&rule.scope_template_id!==((envelope.payload||{}) as Json).scope_template_id)continue;
  const auth=await backgroundAuthContext(org,String(row.user_id)).catch(()=>null);
  if(!auth||String(auth.branchId||'default')!==branch||!hasPermission(auth,definition.permission))continue;
  const {createPlatformNotification}=await import('../api.js');
  await createPlatformNotification(org,{id:'rule_'+identity(event.id,rule.id,row.user_id),title:rule.title,body:rule.body,source:'notification_rule',category:definition.category,preference_key:workflowPreferenceKey(branch,"personal-notification-rules",String(row.user_id)+":"+rule.id),preference_defaults:{in_app:rule.methods.includes("in_app"),push:rule.methods.includes("push")},target_user_ids:[row.user_id],branch_id:branch,
   push:rule.methods.includes('push'),passive:rule.methods.includes('in_app'),delivery_methods:rule.methods,notification_event:envelope,context:{event_id:event.id,project_id:event.project_id,rule_id:rule.id,scope_template_id:(envelope.payload as Json).scope_template_id},frontend_action:event.project_id?{kind:'open_project',project_id:event.project_id}:{}});
 }
}
