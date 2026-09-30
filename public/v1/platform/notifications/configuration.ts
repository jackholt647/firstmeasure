import { backgroundAuthContext, hasPermission, type PlatformAuthContext } from '../auth.js';
import { readDocument } from '../storage.js';
import { notificationSourceCatalog, catalogDefinitions, definitionPreferences, workflowPreferenceKey, type NotificationDefinition } from '../notification_catalog.js';
import { readPersonalConfiguration, ensurePersonalConfiguration, addPersonalDefinition, readNotificationLocks, type NotificationLock } from './defaults.js';
import { listRules } from './store.js';
import { methods, type NotificationRule } from './contracts.js';
import { forbidden } from '../errors.js';
import { notificationPermissions, assertPersonalNotificationEdit } from './permissions.js';

type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const surfaces=[...methods,'in_app_sound','in_app_badge','in_app_bell'];
export async function initializeUserNotifications(org:string,user:string,branch='default'){
 const current=await readPersonalConfiguration(org,user,branch);if(current)return current;
 const auth=await backgroundAuthContext(org,user),record=await readDocument(org,'users',user);
 const catalog=await notificationSourceCatalog(org,branch,auth);
 const preferences=obj(record.data.notification_preferences);
 return ensurePersonalConfiguration(org,user,branch,catalog,preferences);
}
export function lockKey(definition:Pick<NotificationDefinition,'key'|'rule_id'>){return definition.rule_id?'rule:'+definition.rule_id:definition.key;}
export async function applicableLocks(org:string,auth:PlatformAuthContext){
 const policy=await readNotificationLocks(org);if(!Object.keys(policy.locks).length)return policy;
 const source=await notificationSourceCatalog(org,auth.branchId||'default',auth);
 const keys=new Set(catalogDefinitions(source).map(d=>d.key)),events=new Set(catalogDefinitions(source).filter(d=>d.key.startsWith('event.')).map(d=>d.event));
 return {...policy,locks:Object.fromEntries(Object.entries(policy.locks).filter(([,lock])=>lock.rule?events.has(lock.rule.event):lock.definition&&keys.has(lock.definition.key)))};
}
export async function assertNotificationChange(auth:PlatformAuthContext,key?:string,remove=false){
 await assertPersonalNotificationEdit(auth);
 if(!key||(await notificationPermissions(auth)).organization)return;
 const policy=await readNotificationLocks(auth.orgId);
 const lock=policy.locks[key];
 if(lock?.mode==='full'||remove&&lock)throw forbidden('notification_locked',lock.mode==='full'?'This notification is locked by your organization.':'Your organization requires this notification to remain registered.');
}
export async function effectiveRules(org:string,user:string,auth?:PlatformAuthContext):Promise<NotificationRule[]>{
 const own=await listRules(org,user),ctx=auth||await backgroundAuthContext(org,user);
 if((await notificationPermissions(ctx)).organization)return own;
 const locks=await applicableLocks(org,ctx),result=new Map(own.map(r=>[r.id,r]));
 for(const lock of Object.values(locks.locks))if(lock.rule){
  const current=result.get(lock.rule.id),rule=lock.mode==='full'||!current?{...lock.rule,enabled:true}: {...current,enabled:true};
  if(lock.source_user_id&&rule.notification_key===workflowPreferenceKey(lock.source_branch_id||'default','personal-notification-rules',lock.source_user_id+':'+rule.id))rule.notification_key=workflowPreferenceKey(ctx.branchId||'default','personal-notification-rules',user+':'+rule.id);
  result.set(rule.id,rule);
 }
 return [...result.values()].sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
}
export async function effectivePreferences(org:string,user:string,branch:string,raw:unknown):Promise<Json>{
 const config=await readPersonalConfiguration(org,user,branch),legacy=obj(raw),result:Json={...obj(config?.preferences),...legacy};
 for(const surface of surfaces)result[surface]={...obj(config?.preferences[surface]),...obj(legacy[surface])};
 const auth=await backgroundAuthContext(org,user),policy=await applicableLocks(org,auth),admin=(await notificationPermissions(auth)).organization;
 for(const key of config?.removed_keys||[])for(const surface of methods)obj(result[surface])[key]=false;
 if(!admin)for(const lock of Object.values(policy.locks)){
  const key=lock.rule?workflowPreferenceKey(branch,'personal-notification-rules',user+':'+lock.rule.id):lock.definition!.key;
  if(lock.mode==='full')for(const surface of surfaces)if(typeof obj(lock.preferences)[surface]==='boolean')obj(result[surface])[key]=obj(lock.preferences)[surface];
  if(lock.mode==='removal'&&config?.removed_keys.includes(key))for(const surface of surfaces)if(typeof obj(lock.preferences)[surface]==='boolean')obj(result[surface])[key]=obj(lock.preferences)[surface];
 }
 return result;
}
export async function observePersonalNotification(org:string,user:string,branch:string,note:Json){
 await initializeUserNotifications(org,user,branch);
 if(note.source==='notification_rule')return;
 const key=String(note.preference_key||note.category||'system'),auth=await backgroundAuthContext(org,user),source=await notificationSourceCatalog(org,branch,auth);
 const group=source.find(g=>g.definitions.some(d=>d.key===key)),definition=group?.definitions.find(d=>d.key===key);
 if(definition){const record=await readDocument(org,'users',user);await addPersonalDefinition(org,user,branch,group!.id,group!.label,definition,obj(record.data.notification_preferences));}
}
export async function fullLockForNote(org:string,user:string,note:Json):Promise<NotificationLock|undefined>{
 if(!Object.keys((await readNotificationLocks(org)).locks).length)return;
 const auth=await backgroundAuthContext(org,user);if((await notificationPermissions(auth)).organization)return;
 const policy=await applicableLocks(org,auth),key=obj(note.context).rule_id?'rule:'+String(obj(note.context).rule_id):String(note.preference_key||note.category||'system');
 return policy.locks[key]?.mode==='full'?policy.locks[key]:undefined;
}

export async function preferencesForNote(org:string,user:string,note:Json,raw:unknown){
 const preferences=await effectivePreferences(org,user,String(note.branch_id||'default'),raw),lock=await fullLockForNote(org,user,note);
 if(lock)preferences.quiet_hours=lock.preferences?.quiet_hours||undefined;
 return preferences;
}
