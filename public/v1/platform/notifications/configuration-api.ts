import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformAuth } from '../auth.js';
import { readDocument } from '../storage.js';
import { notificationCatalog, catalogDefinitions } from '../notification_catalog.js';
import { readPersonalConfiguration, patchPersonalConfiguration, readOrganizationDefaults, saveOrganizationDefaults, readNotificationLocks, saveNotificationLocks, type NotificationLock } from './defaults.js';
import { initializeUserNotifications, effectivePreferences, assertNotificationChange, lockKey, applicableLocks } from './configuration.js';
import { notificationPermissions } from './permissions.js';
import { listRules } from './store.js';
import { methods } from './contracts.js';
import { badRequest, forbidden } from '../errors.js';
type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
export async function registerNotificationConfigurationApi(app:FastifyInstance){
 const root='/organizations/:orgId';
 app.post(root+'/notification-configuration',async request=>{
  const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});
  const configuration=await initializeUserNotifications(org,auth.userId,auth.branchId||'default');
  return {ok:true,revision:configuration.revision};
 });
 app.patch(root+'/notification-configuration',async request=>{
  const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});
  const body=z.object({revision:z.number().int().positive(),remove_keys:z.array(z.string()).optional(),definitions:z.array(z.object({key:z.string(),label:z.string().trim().min(1).max(140).optional(),description:z.string().max(8000).optional()}).strict()).optional()}).strict().parse(request.body);
  await assertNotificationChange(auth);
  for(const key of body.remove_keys||[])await assertNotificationChange(auth,key,true);
  for(const definition of body.definitions||[])await assertNotificationChange(auth,definition.key);
  return {ok:true,configuration:await patchPersonalConfiguration(org,auth.userId,auth.branchId||'default',body)};
 });
 app.get(root+'/notification-defaults',async request=>{
  const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications'});
  if(!notificationPermissions(auth).organization)throw forbidden('notification_defaults_forbidden','You cannot manage organization notification defaults.');
  const defaults=await readOrganizationDefaults(org),locks=await readNotificationLocks(org);
  const visible=await applicableLocks(org,auth);
  return {ok:true,revision:defaults?.revision||0,locks_revision:locks.revision,locks:Object.entries(visible.locks).map(([key,lock])=>({key,mode:lock.mode,label:lock.rule?.title||lock.definition?.label||key}))};
 });
 app.put(root+'/notification-defaults',async request=>{
  const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});
  if(!notificationPermissions(auth).organization)throw forbidden('notification_defaults_forbidden','You cannot manage organization notification defaults.');
  const {revision}=z.object({revision:z.number().int().nonnegative()}).strict().parse(request.body);
  await initializeUserNotifications(org,auth.userId,auth.branchId||'default');
  const user=await readDocument(org,'users',auth.userId),catalog=await notificationCatalog(org,auth.branchId||'default',auth);
  const preferences=await effectivePreferences(org,auth.userId,auth.branchId||'default',user.data.notification_preferences);
  const personal=await readPersonalConfiguration(org,auth.userId,auth.branchId||'default');
  const defaults=await saveOrganizationDefaults(org,auth.userId,{revision,catalog,preferences,removed_keys:personal?.removed_keys||[],rules:await listRules(org,auth.userId),source_branch_id:auth.branchId||'default'});
  return {ok:true,revision:defaults.revision};
 });
 app.patch(root+'/notification-locks',async request=>{
  const org=String((request.params as Json).orgId),auth=await requirePlatformAuth(request,{orgId:org,capability:'apps.notifications',csrf:true});
  if(!notificationPermissions(auth).organization)throw forbidden('notification_locks_forbidden','You cannot manage organization notification locks.');
  const body=z.object({revision:z.number().int().nonnegative(),key:z.string().min(1).max(200),mode:z.enum(['unlocked','removal','full'])}).strict().parse(request.body);
  const catalog=await notificationCatalog(org,auth.branchId||'default',auth),definition=catalogDefinitions(catalog).find(d=>lockKey(d)===body.key);
  if(!definition&&!(body.mode==='unlocked'&&(await applicableLocks(org,auth)).locks[body.key]))throw badRequest('notification_lock_key','Choose an authorized notification from your configuration.');
  const current=await readNotificationLocks(org),locks={...current.locks};
  if(body.mode==='unlocked')delete locks[body.key];
  else{
   if(!definition)throw badRequest('notification_lock_key','Choose a personal notification to publish protection.');
   const record=await readDocument(org,'users',auth.userId),raw=await effectivePreferences(org,auth.userId,auth.branchId||'default',record.data.notification_preferences);
   const preferences:Json={quiet_hours:raw.quiet_hours||null};
   for(const surface of [...methods,'in_app_sound','in_app_badge','in_app_bell'])preferences[surface]=typeof obj(raw[surface])[definition.key]==='boolean'?obj(raw[surface])[definition.key]:surface==='in_app'?definition.defaults.in_app:surface==='push'?definition.defaults.push:definition.methods?.includes(surface)||false;
   const rule=definition.rule_id?(await listRules(org,auth.userId)).find(r=>r.id===definition.rule_id):undefined;
   if(definition.rule_id&&!rule)throw badRequest('notification_lock_key','The notification rule is unavailable.');
   locks[body.key]={mode:body.mode,preferences,source_user_id:auth.userId,source_branch_id:auth.branchId||'default',...(rule?{rule:{...rule,enabled:true}}:{definition})} as NotificationLock;
  }
  const policy=await saveNotificationLocks(org,auth.userId,{revision:body.revision,locks});
  return {ok:true,revision:policy.revision};
 });
}
