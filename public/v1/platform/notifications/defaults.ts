import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NotificationDefinition, NotificationGroup } from '../notification_catalog.js';
import { conflict, badRequest } from '../errors.js';
import { identity, notificationStore } from './store.js';
import { methods, ruleSchema, type NotificationRule } from './contracts.js';
import { eventIsSubscribable } from './registration.js';

type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const surfaces=[...methods,'in_app_sound','in_app_badge','in_app_bell'];
export type PersonalNotificationConfiguration={revision:number;defaults_revision:number;catalog:NotificationGroup[];preferences:Json;removed_keys:string[]};
export type OrganizationNotificationDefaults={system?:boolean;revision:number;catalog:NotificationGroup[];preferences:Json;rules:NotificationRule[];source_user_id:string;source_branch_id:string;removed_keys:string[]};

const definitionSchema=z.object({key:z.string().min(1).max(200),label:z.string().max(140),description:z.string().max(8000),category:z.string().max(100),defaults:z.object({in_app:z.boolean(),push:z.boolean()})}).passthrough();
const catalogSchema=z.array(z.object({id:z.string().max(200),label:z.string().max(140),kind:z.enum(['app','workflow','custom']),definitions:z.array(definitionSchema).max(5000),disabled:z.boolean().optional()})).max(500);
function parseCatalog(value:unknown):NotificationGroup[]{return catalogSchema.parse(value) as NotificationGroup[];}

/** Snapshot only configured notifications. Event discovery itself is not a subscription. */
function configuredCatalog(catalog:NotificationGroup[],preferences:Json){
 const selected=new Set(Array.isArray(preferences.custom_keys)?preferences.custom_keys.map(String):[]);
 return copy(catalog).map(group=>({...group,definitions:group.definitions.filter(definition=>!definition.rule_id&&(!definition.key.startsWith('event.')||selected.has(definition.key)||surfaces.some(surface=>obj(preferences[surface])[definition.key]===true)))})).filter(group=>group.definitions.length);
}
function mergePreferences(seed:Json,overrides:Json):Json{
 const result={...copy(seed),...copy(overrides)};
 for(const surface of surfaces)if(seed[surface]!==undefined||overrides[surface]!==undefined)result[surface]={...obj(seed[surface]),...obj(overrides[surface])};
 if(seed.custom_keys||overrides.custom_keys)result.custom_keys=[...new Set([...(Array.isArray(seed.custom_keys)?seed.custom_keys.map(String):[]),...(Array.isArray(overrides.custom_keys)?overrides.custom_keys.map(String):[])])];
 return result;
}
/** Materialize starting values once so future producer-default changes cannot edit personal choices. */
function materializePreferences(catalog:NotificationGroup[],existing:Json):Json{
 const next=copy(existing);
 for(const group of catalog)for(const definition of group.definitions){
  const key=definition.key;
  const resolve=(surface:string,fallback:boolean)=>typeof obj(existing[surface])[key]==='boolean'?obj(existing[surface])[key]===true:(key.startsWith('workflow.')||key==='channel_replies'&&['in_app','push','in_app_sound','audio'].includes(surface))&&obj(existing[surface])[definition.category]===false?false:fallback;
  const inApp=resolve('in_app',definition.defaults.in_app),sound=resolve('in_app_sound',true);
  const values:Record<string,boolean>={in_app:inApp,push:resolve('push',definition.defaults.push),in_app_sound:sound,in_app_badge:true,in_app_bell:key!=='messages',email:definition.methods?.includes('email')||false,sms:definition.methods?.includes('sms')||false,toast:definition.methods?.includes('toast')||false,celebration:definition.methods?.includes('celebration')||definition.category==='celebrations'&&inApp,audio:definition.methods?.includes('audio')||inApp&&sound,customer_portal:false};
  for(const [surface,fallback] of Object.entries(values)){
   // Older category declarations do not describe every method a producer may
   // explicitly request. Missing metadata is not a personal hard opt-out.
   if(['email','sms','toast','celebration'].includes(surface)&&definition.methods===undefined&&typeof obj(existing[surface])[key]!=='boolean')continue;
   next[surface]={...obj(next[surface]),[key]:resolve(surface,fallback)};
  }
 }
 return next;
}
function copyRulePreferences(preferences:Json,rules:NotificationRule[],sourceUser:string,targetUser:string,sourceBranch:string,targetBranch:string){
 const result=copy(preferences);
 for(const rule of rules){
  const from='workflow.'+identity(sourceBranch,'personal-notification-rules',sourceUser+':'+rule.id);
  const to='workflow.'+identity(targetBranch,'personal-notification-rules',targetUser+':'+rule.id);
  for(const surface of surfaces){const entries=obj(result[surface]);if(Object.hasOwn(entries,from)){entries[to]=entries[from];if(from!==to)delete entries[from];result[surface]=entries;}}
  if(Array.isArray(result.custom_keys))result.custom_keys=result.custom_keys.map(key=>key===from?to:key);
 }
 return result;
}

export async function readPersonalConfiguration(org:string,user:string,branch='default'):Promise<PersonalNotificationConfiguration|null>{
 const row=await notificationStore().prepare('SELECT data_json FROM notification_personal_configurations WHERE organization_id=? AND user_id=? AND branch_id=?').get(org,user,branch);
 return row?JSON.parse(String(row.data_json)):null;
}
export async function readOrganizationDefaults(org:string):Promise<OrganizationNotificationDefaults|null>{
 const row=await notificationStore().prepare('SELECT data_json FROM notification_organization_defaults WHERE organization_id=?').get(org);
 return row?JSON.parse(String(row.data_json)):null;
}

/** Explicit lifecycle initialization only. Catalog GET callers must use readPersonalConfiguration. */
export async function ensurePersonalConfiguration(org:string,user:string,branch:string,systemCatalog:NotificationGroup[],existingPreferences:Json={}):Promise<PersonalNotificationConfiguration>{
 const db=notificationStore();
 return db.transaction(async()=>{
  const existing=await readPersonalConfiguration(org,user,branch);if(existing)return existing;
  const storedDefaults=await readOrganizationDefaults(org),defaults=storedDefaults?.system?null:storedDefaults;
  const seed=defaults?copyRulePreferences(defaults.preferences,defaults.rules,defaults.source_user_id,user,defaults.source_branch_id,branch):{};
  const merged=mergePreferences(seed,existingPreferences);
  const allowed=new Set(systemCatalog.flatMap(group=>group.definitions.map(definition=>definition.key)));
  const removed_keys=(defaults?.removed_keys||[]).filter(key=>!methods.some(method=>obj(existingPreferences[method])[key]===true));
  const catalog=defaults?copy(defaults.catalog).map(group=>({...group,definitions:group.definitions.filter(definition=>allowed.has(definition.key)&&!removed_keys.includes(definition.key))})).filter(group=>group.definitions.length):configuredCatalog(parseCatalog(systemCatalog),merged);
  // An existing explicit personal choice wins over an inherited default removal.
  if(defaults)for(const group of configuredCatalog(systemCatalog,existingPreferences)){
   const restored=group.definitions.filter(definition=>(defaults.removed_keys||[]).includes(definition.key)&&!removed_keys.includes(definition.key));
   if(!restored.length)continue;
   const destination=catalog.find(candidate=>candidate.id===group.id);
   if(destination)destination.definitions.push(...restored.filter(definition=>!destination.definitions.some(existing=>existing.key===definition.key)));else catalog.push({...group,definitions:restored});
  }
  const preferences=materializePreferences(catalog,merged);
  for(const key of removed_keys)for(const method of methods)preferences[method]={...obj(preferences[method]),[key]:false};
  const next:PersonalNotificationConfiguration={revision:1,defaults_revision:storedDefaults?.revision||0,catalog,preferences,removed_keys};
  for(const raw of defaults?.rules||[]){
   if(!systemCatalog.some(group=>group.definitions.some(definition=>definition.key.startsWith('event.')&&definition.event===raw.event))||!eventIsSubscribable(raw.event)||raw.methods.includes('customer_portal'))continue;
   // Same IDs are isolated by user. Existing personal choices and deletion tombstones win.
   if(await db.prepare('SELECT id FROM notification_rule_tombstones WHERE organization_id=? AND user_id=? AND id=?').get(org,user,raw.id))continue;
   const sourceKey='workflow.'+identity(defaults!.source_branch_id,'personal-notification-rules',defaults!.source_user_id+':'+raw.id);
   const personalKey='workflow.'+identity(branch,'personal-notification-rules',user+':'+raw.id);
   const rule=ruleSchema.parse({...raw,revision:1,...(raw.notification_key===sourceKey?{notification_key:personalKey}:{})});
   const inserted=await db.prepare('INSERT INTO notification_rules(organization_id,user_id,id,revision,data_json) VALUES(?,?,?,?,?) ON CONFLICT(organization_id,user_id,id) DO NOTHING').run(org,user,rule.id,1,JSON.stringify(rule));
   if(inserted.changes)await db.prepare('INSERT INTO notification_rule_history(id,organization_id,user_id,rule_id,revision,data_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,rule.id,1,JSON.stringify(rule),`Copied organization defaults revision ${defaults!.revision}`,new Date().toISOString());
  }
  await db.prepare('INSERT INTO notification_personal_configurations(organization_id,user_id,branch_id,revision,data_json) VALUES(?,?,?,?,?)').run(org,user,branch,1,JSON.stringify(next));
  await db.prepare('INSERT INTO notification_configuration_history(id,organization_id,user_id,branch_id,kind,revision,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,branch,'personal_initialized',1,JSON.stringify(next),new Date().toISOString());
  return next;
 },identity('personal-notifications',org,user,branch));
}

/** Called by an authorized producer on first observation, never by catalog reads. */
export async function addPersonalDefinition(org:string,user:string,branch:string,groupId:string,groupLabel:string,raw:NotificationDefinition,legacyPreferences:Json={}):Promise<PersonalNotificationConfiguration>{
 const definition=definitionSchema.parse(raw) as NotificationDefinition,db=notificationStore();
 return db.transaction(async()=>{
  const current=await readPersonalConfiguration(org,user,branch);
  if(!current)throw conflict('notification_configuration_missing','Initialize personal notification configuration first.');
  if(current.removed_keys.includes(definition.key)||current.catalog.some(group=>group.definitions.some(d=>d.key===definition.key)))return current;
  const catalog=copy(current.catalog),group=catalog.find(group=>group.id===groupId);
  if(group)group.definitions.push(definition);else catalog.push({id:groupId,label:groupLabel,kind:'app',definitions:[definition]});
  const observed=materializePreferences([{id:groupId,label:groupLabel,kind:'app',definitions:[definition]}],mergePreferences(current.preferences,legacyPreferences));
  const preferences=copy(current.preferences);
  // Apply inherited choices only to this newly observed definition. Frozen existing settings stay intact.
  for(const surface of surfaces)if(obj(observed[surface])[definition.key]!==undefined)preferences[surface]={...obj(preferences[surface]),[definition.key]:obj(observed[surface])[definition.key]};
  const next={...current,revision:current.revision+1,catalog,preferences};
  await db.prepare('UPDATE notification_personal_configurations SET revision=?,data_json=? WHERE organization_id=? AND user_id=? AND branch_id=?').run(next.revision,JSON.stringify(next),org,user,branch);
  await db.prepare('INSERT INTO notification_configuration_history(id,organization_id,user_id,branch_id,kind,revision,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,branch,'personal_observed',next.revision,JSON.stringify(next),new Date().toISOString());
  return next;
 },identity('personal-notifications',org,user,branch));
}

export type NotificationLock={mode:'removal'|'full';definition?:NotificationDefinition;rule?:NotificationRule;preferences?:Json;source_user_id?:string;source_branch_id?:string};
export type NotificationLocks={revision:number;locks:Record<string,NotificationLock>};
const lockSchema=z.object({mode:z.enum(['removal','full']),definition:definitionSchema.optional(),rule:ruleSchema.optional(),preferences:z.record(z.unknown()).optional(),source_user_id:z.string().max(200).optional(),source_branch_id:z.string().max(200).optional()}).strict();
export async function readNotificationLocks(org:string):Promise<NotificationLocks>{
 const row=await notificationStore().prepare('SELECT data_json FROM notification_organization_locks WHERE organization_id=?').get(org);
 return row?JSON.parse(String(row.data_json)):{revision:0,locks:{}};
}
/** Live organization policy is independent of the seed used for personal copies. */
export async function saveNotificationLocks(org:string,actor:string,input:{revision:number;locks:Record<string,NotificationLock>}):Promise<NotificationLocks>{
 const parsed=z.object({revision:z.number().int().nonnegative(),locks:z.record(z.string().min(1).max(200),lockSchema)}).strict().parse(input),db=notificationStore();
 for(const [key,lock] of Object.entries(parsed.locks)){
  if(lock.rule&&key!=='rule:'+lock.rule.id)throw badRequest('notification_lock_key','Rule locks must use their stable rule identifier.');
  if(lock.definition&&key!==lock.definition.key)throw badRequest('notification_lock_key','Definition locks must use their notification key.');
 }
 return db.transaction(async()=>{
  const current=await readNotificationLocks(org);
  if(current.revision!==parsed.revision)throw conflict('notification_locks_revision','Notification lock revision conflict.');
  const next={revision:current.revision+1,locks:copy(parsed.locks)} as NotificationLocks;
  await db.prepare('INSERT INTO notification_organization_locks(organization_id,revision,data_json) VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json').run(org,next.revision,JSON.stringify(next));
  await db.prepare('INSERT INTO notification_configuration_history(id,organization_id,user_id,branch_id,kind,revision,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,actor,'','organization_locks',next.revision,JSON.stringify(next),new Date().toISOString());
  return next;
 },identity('organization-notification-locks',org));
}

const personalPatchSchema=z.object({revision:z.number().int().positive(),remove_keys:z.array(z.string().min(1).max(200)).max(5000).optional(),definitions:z.array(z.object({key:z.string().min(1).max(200),label:z.string().max(140).optional(),description:z.string().max(8000).optional(),methods:z.array(z.enum(methods)).max(8).optional(),defaults:z.object({in_app:z.boolean(),push:z.boolean()}).optional()}).strict()).max(5000).optional(),preferences:z.record(z.unknown()).optional()}).strict();
export async function patchPersonalConfiguration(org:string,user:string,branch:string,input:unknown):Promise<PersonalNotificationConfiguration>{
 const patch=personalPatchSchema.parse(input),db=notificationStore();
 return db.transaction(async()=>{
  const current=await readPersonalConfiguration(org,user,branch);
  if(!current||current.revision!==patch.revision)throw conflict('notification_configuration_revision','Notification configuration revision conflict.');
  const known=new Set(current.catalog.flatMap(group=>group.definitions.map(definition=>definition.key)));
  for(const key of [...(patch.remove_keys||[]),...(patch.definitions||[]).map(d=>d.key)])if(!known.has(key))throw badRequest('notification_configuration_key','Choose a notification in your personal configuration.');
  const removed=new Set([...current.removed_keys,...(patch.remove_keys||[])]),changes=new Map((patch.definitions||[]).map(d=>[d.key,d]));
  const catalog=current.catalog.map(group=>({...group,definitions:group.definitions.filter(d=>!removed.has(d.key)).map(d=>({...d,...changes.get(d.key)} as NotificationDefinition))})).filter(group=>group.definitions.length);
  const preferences=mergePreferences(current.preferences,patch.preferences||{});
  for(const key of removed)for(const method of methods)preferences[method]={...obj(preferences[method]),[key]:false};
  const next={...current,revision:current.revision+1,catalog,preferences,removed_keys:[...removed]};
  await db.prepare('UPDATE notification_personal_configurations SET revision=?,data_json=? WHERE organization_id=? AND user_id=? AND branch_id=?').run(next.revision,JSON.stringify(next),org,user,branch);
  await db.prepare('INSERT INTO notification_configuration_history(id,organization_id,user_id,branch_id,kind,revision,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,branch,'personal_updated',next.revision,JSON.stringify(next),new Date().toISOString());
  return next;
 },identity('personal-notifications',org,user,branch));
}

export async function saveOrganizationDefaults(org:string,actor:string,input:{revision:number;catalog:NotificationGroup[];preferences:Json;rules:NotificationRule[];source_branch_id?:string;removed_keys?:string[]}):Promise<OrganizationNotificationDefaults>{
 const revision=z.number().int().nonnegative().parse(input.revision),rules=z.array(ruleSchema).max(1000).parse(input.rules),catalog=configuredCatalog(parseCatalog(input.catalog),input.preferences);
 const db=notificationStore();
 return db.transaction(async()=>{
  const current=await readOrganizationDefaults(org);
  if((current?.revision||0)!==revision)throw conflict('notification_defaults_revision','Organization notification defaults revision conflict.');
  const removed_keys=[...new Set(z.array(z.string().min(1).max(200)).max(5000).parse(input.removed_keys||[]))];
  const next:OrganizationNotificationDefaults={revision:revision+1,catalog,preferences:materializePreferences(catalog,input.preferences),rules:copy(rules),source_user_id:actor,source_branch_id:input.source_branch_id||'default',removed_keys};
  await db.prepare('INSERT INTO notification_organization_defaults(organization_id,revision,data_json) VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json').run(org,next.revision,JSON.stringify(next));
  await db.prepare('INSERT INTO notification_configuration_history(id,organization_id,user_id,branch_id,kind,revision,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,actor,next.source_branch_id,'organization_defaults',next.revision,JSON.stringify(next),new Date().toISOString());
  return next;
 },identity('organization-notification-defaults',org));
}

/** Restore dynamic factory defaults for future users without rewriting personal choices or locks. */
export async function resetOrganizationDefaults(org:string,actor:string,revision:number){
 z.number().int().nonnegative().parse(revision);
 const db=notificationStore();
 return db.transaction(async()=>{
  const current=await readOrganizationDefaults(org);
  if((current?.revision||0)!==revision)throw conflict('notification_defaults_revision','Organization notification defaults revision conflict.');
  const next:OrganizationNotificationDefaults={system:true,revision:revision+1,catalog:[],preferences:{},rules:[],source_user_id:actor,source_branch_id:'default',removed_keys:[]};
  await db.prepare('INSERT INTO notification_organization_defaults(organization_id,revision,data_json) VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json').run(org,next.revision,JSON.stringify(next));
  await db.prepare('INSERT INTO notification_configuration_history(id,organization_id,user_id,branch_id,kind,revision,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,actor,'','organization_defaults_reset',next.revision,JSON.stringify(next),new Date().toISOString());
  return next;
 },identity('organization-notification-defaults',org));
}
