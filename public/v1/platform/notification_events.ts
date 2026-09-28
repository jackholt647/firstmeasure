import { createHash } from 'node:crypto';
import { backgroundAuthContext, hasPermission } from './auth.js';
import { listDocuments } from './storage.js';
import { builtInEventDefinitions, eventGroups, scopeNotificationDefinitions, workflowPreferenceKey, bindingNotificationId } from './notification_catalog.js';
import { readScopeTemplateVersion } from '../scopes/storage.js';
import { isAppFlagEnabled } from './app_flags.js';
import { badRequest } from './errors.js';

type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
/** Runs under the durable Work event lease. Opt-in subscriptions never broaden the user's permissions. */
export async function notifyWorkEvent(event:Json) {
 const org=String(event.organization_id), branch=String(event.branch_id||'default');
 const key=`event.${event.type}`;
 const definition=builtInEventDefinitions().find(d=>d.key===key);
 if(!definition||!await isAppFlagEnabled(org,'apps','notifications'))return;
 const app=(eventGroups[String(event.type).split('.')[0]!]||eventGroups.project!).app;
 if(app&&!await isAppFlagEnabled(org,'apps',app))return;
 const recipients:string[]=[];
 for(const user of await listDocuments(org,'users')){
  const data=obj(user.data),prefs=obj(data.notification_preferences);
  if(data.disabled===true||data.deleted===true||!(obj(prefs.in_app)[key]===true||obj(prefs.push)[key]===true))continue;
  const auth=await backgroundAuthContext(org,user.id).catch(()=>null);
  if(!auth||!hasPermission(auth,definition.permission)||String(auth.branchId||'default')!==branch)continue;
  recipients.push(user.id);
 }
 if(!recipients.length)return;
 const {createPlatformNotification}=await import('./api.js');
 await createPlatformNotification(org,{
  id:'event_notification_'+createHash('sha256').update(String(event.id)).digest('hex'),
  title:definition.label,body:definition.description,source:'work.event',category:definition.category,preference_key:key,
  target_user_ids:recipients,branch_id:branch,push:true,
  context:{event_id:event.id,project_id:event.project_id},
  frontend_action:event.project_id?{kind:'open_project',project_id:event.project_id}:{}
 });
}
/** Carry the declaration identity across interpolation and code execution. Never use notification text as identity. */
export async function workflowNotificationInput(event:Json,plan:Json,node:Json,binding:Json,bindingId:string,input:Json):Promise<Json> {
 input={...input,id:input.id||'work_notification_'+createHash('sha256').update(JSON.stringify([event.id,bindingId,input.notification_id||''])).digest('hex')};
 const template=String(plan.template_id||''),branch=String(event.branch_id||'default');
 if(bindingId.startsWith('org_rule:') && binding.automation==='notification.create.v1')return {...input,category:'tasks',preference_key:workflowPreferenceKey(branch,'organization-automations',bindingId.slice(9)),preference_defaults:{in_app:input.passive!==false,push:input.push===true},push:true};
 if(!template)return input;
 const version=await readScopeTemplateVersion(String(event.organization_id),branch,template,Number(plan.template_version)||undefined);
 const definitions=scopeNotificationDefinitions(branch,template,obj(version?.definition));
 let id=String(input.notification_id||'');
 if(!id&&binding.automation==='notification.create.v1'){
  const alias='on'+String(event.type).split('.').pop()!.replace(/(^|_)([a-z])/g,(_m,_p,c)=>c.toUpperCase());
  const bindings=obj(node.id?node.automation_bindings:plan.automation_bindings);
  const hook=Array.isArray(bindings[alias])?alias:String(event.type);
  id=bindingNotificationId(String(node.template_node_id||'plan'),hook,binding,Number(bindingId.split(':')[1])||0);
 }
 if(!id)throw badRequest('notification_declaration_required','Custom scope code must send a declared notification_id.');
 const key=workflowPreferenceKey(branch,template,id),definition=definitions.find(d=>d.key===key);
 if(!definition)throw badRequest('notification_not_declared','This notification is not declared in this scope version.');
 return {...input,category:definition.category,preference_key:key,preference_defaults:definition.defaults,push:true,context:{...obj(input.context),scope_template_id:template,notification_id:id}};
}
