import { readPersonalConfiguration } from "./notifications/defaults.js";
import { listRules } from "./notifications/store.js";
import { createHash } from "node:crypto";
import { listWorkEventDefinitions, workEventNotification, notificationEventGroups, notificationEventSources } from "../work/events.js";
import { isAppFlagEnabled } from "./app_flags.js";
import { readAutomationRules } from "../work/rules.js";
import { getWorkDatabase } from "../work/storage.js";
import { hasPermission, type PlatformAuthContext } from "./auth.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const rows = (v: unknown): Json[] => Array.isArray(v) ? v.map(obj) : [];
export type NotificationDefinition = { key:string; label:string; description:string; category:string; defaults:{in_app:boolean;push:boolean}; event?:string; permission?:string; tab?:string; group_id?:string; group_label?:string; source_id?:string; source_label?:string; rule_id?:string; rule_revision?:number; methods?:string[]; personal?:boolean; personal_removed?:boolean; lock_mode?:'unlocked'|'removal'|'full'; editable?:boolean; removable?:boolean };
export type NotificationGroup = { id:string; label:string; kind:"app"|"workflow"|"custom"; definitions:NotificationDefinition[]; disabled?:boolean };
export function notificationMetadata(event:string) {
 const meta=workEventNotification(event);
 return {tab:meta.tab,group_id:meta.group,group_label:notificationEventGroups[meta.group].label,source_id:meta.source,source_label:notificationEventSources[meta.source].label};
}
const words = (s:string) => s.replace(/[._-]+/g," ").replace(/^./,c=>c.toUpperCase());
export const eventGroups:Record<string,{label:string;app?:string;category:string;permission:string}> = {
 channels:{label:"Channels",app:"channels",category:"messages",permission:"view_projects"}, chat:{label:"Chat",app:"chat",category:"messages",permission:"view_projects"},
 canvassing:{label:"Canvassing",app:"canvassing",category:"leads",permission:"view_projects"}, lead:{label:"Leads",app:"crm",category:"leads",permission:"view_projects"},
 measurement:{label:"Measurements",app:"firstmeasure",category:"measurements",permission:"view_projects"}, media:{label:"Media",app:"projects",category:"tasks",permission:"view_projects"}, note:{label:"Notes",app:"projects",category:"tasks",permission:"view_projects"},portal:{label:"Customer portal",app:"projects",category:"messages",permission:"view_projects"},
 project:{label:"Projects",app:"projects",category:"tasks",permission:"view_projects"}, work:{label:"Tasks & scopes",app:"projects",category:"tasks",permission:"view_projects"},
 document:{label:"Documents",app:"projects",category:"tasks",permission:"view_documents"}, proposal:{label:"Proposals",app:"projects",category:"tasks",permission:"view_projects"},
 payment:{label:"Payments",app:"billing",category:"payments",permission:"manage_billing"}, invoice:{label:"Invoices",app:"billing",category:"payments",permission:"manage_billing"},
 payroll:{label:"Payroll",app:"payroll",category:"payments",permission:"manage_payroll"}, expense:{label:"Expenses",app:"billing",category:"payments",permission:"manage_billing"}, receipt:{label:"Receipts",app:"billing",category:"payments",permission:"manage_billing"},
 material:{label:"Materials",app:"projects",category:"tasks",permission:"view_projects"}, crew:{label:"Field work",app:"crew",category:"tasks",permission:"view_projects"},
 customer:{label:"Customer portal",app:"projects",category:"messages",permission:"view_projects"}, punch_list:{label:"Punch lists",app:"projects",category:"tasks",permission:"view_projects"},
 communication:{label:"Communications",app:"messaging",category:"messages",permission:"view_projects"}, call:{label:"Calls",app:"crm",category:"messages",permission:"view_projects"},
 tagging:{label:"Mentions",app:"projects",category:"mentions",permission:"view_projects"}, website:{label:"Websites",app:"web_editor",category:"system",permission:"manage_company_settings"},
 feedback:{label:"Customer feedback",app:"feedback",category:"tasks",permission:"view_projects"}, recurrence:{label:"Recurring work",app:"projects",category:"tasks",permission:"view_projects"},
 organization:{label:"Company",category:"system",permission:"manage_company_settings"}, time:{label:"Scheduled triggers",category:"system",permission:"manage_company_settings"}
};
export function builtInEventDefinitions():NotificationDefinition[] {
 return listWorkEventDefinitions().map(e=>({key:`event.${e.name}`,...notificationMetadata(e.name),label:words(e.name),description:e.description+" Receive these events in your branch, subject to your access permissions.",category:(eventGroups[e.name.split('.')[0]!]||eventGroups.project!).category,permission:(eventGroups[e.name.split('.')[0]!]||eventGroups.project!).permission,event:e.name,defaults:{in_app:false,push:false}}));
}
export function workflowPreferenceKey(branch:string,template:string,id:string) {
 return 'workflow.'+createHash('sha256').update(JSON.stringify([branch,template,id])).digest('hex');
}
export function bindingNotificationId(node:string,hook:string,binding:Json,index:number) {
 return String(obj(binding.input).notification_id || `${node}:${hook}:${binding.id || index}`);
}
export function scopeNotificationDefinitions(branch:string,template:string,definition:Json):NotificationDefinition[] {
 const result=new Map<string,NotificationDefinition>();
 const add=(id:string,value:Json,defaults={in_app:true,push:false})=>{
  const key=workflowPreferenceKey(branch,template,id);
  result.set(key,{key,label:String(value.label||value.title||words(id)),description:String(value.description||value.body||'Notification from this workflow.'),category:'tasks',defaults:{in_app:obj(value.defaults).in_app===undefined?defaults.in_app:obj(value.defaults).in_app===true,push:obj(value.defaults).push===undefined?defaults.push:obj(value.defaults).push===true}});
 };
 const walk=(container:Json)=>{
  for(const [hook,bindings] of Object.entries(obj(container.automation_bindings))) rows(bindings).forEach((binding,index)=>{
   if(binding.automation==='notification.create.v1') add(bindingNotificationId(String(container.id||'plan'),hook,binding,index),obj(binding.input),{in_app:obj(binding.input).passive!==false,push:obj(binding.input).push===true});
  });
  rows(container.children||container.root_nodes).forEach(walk);
 };
 walk(obj(definition.work_plan));
 // Explicit declarations cover conditional notifications emitted by custom code.
 rows(definition.notifications).forEach(n=>add(String(n.id),n));
 return [...result.values()];
}
export async function notificationSourceCatalog(orgId:string,branch='default',auth?:PlatformAuthContext):Promise<NotificationGroup[]> {
 const groups:NotificationGroup[]=[];
 if(!await isAppFlagEnabled(orgId,'apps','notifications'))return groups;
 if(await isAppFlagEnabled(orgId,'apps','firstmeasure'))groups.push({id:'measurements',label:'Measurements',kind:'app',definitions:[
  ['report_delivered','Report delivered','Your report is ready to view and download.'],['report_revised','Corrected report delivered','A corrected report is ready.'],['report_canceled','Order canceled','An order was canceled.'],['report_rejected','Order rejected','An order could not be accepted.'],['report_status','Order progress','An order moved to the next stage.']
 ].map(([id,label,description])=>({key:`measurements.${id}`,label:label!,description:description!,category:'measurements',defaults:{in_app:true,push:id!=='report_status'}}))});
 if(!await isAppFlagEnabled(orgId,'platform','expanded_access'))return groups;
 const flags=new Map<string,boolean>();
 for(const d of builtInEventDefinitions()){
  const prefix=d.event!.split('.')[0]!, meta=eventGroups[prefix]||eventGroups.project!;
  if(auth&&!hasPermission(auth,meta.permission))continue;
  if(meta.app){if(!flags.has(meta.app))flags.set(meta.app,await isAppFlagEnabled(orgId,'apps',meta.app));if(!flags.get(meta.app))continue;}
  let group=groups.find(g=>g.id===`events.${prefix}`);if(!group){group={id:`events.${prefix}`,label:meta.label,kind:'app',definitions:[]};groups.push(group);}group.definitions.push(d);
 }
 // Preserve controls for existing direct producers while they adopt named event keys.
 for(const [key,label,app] of [['messages','Messages','messaging'],['mentions','Mentions','projects'],['leads','Leads','crm'],['tasks','Task updates','projects'],['scheduling','Scheduling','scheduling'],['payments','Payment updates','billing'],['celebrations','Celebrations','projects'],['system','System updates','']] as [string,string,string][] ){
  if(app&&!await isAppFlagEnabled(orgId,app==='scheduling'?'platform':'apps',app))continue;
  groups.push({id:`legacy.${key}`,label,kind:'app',definitions:[{key,label,description:'Notifications created directly by this app.',category:key,defaults:{in_app:true,push:key!=='celebrations'}}]});
 }
 if(auth){const personal=await listRules(orgId,auth.userId);groups.push({id:'personal-rules',label:'Custom notification rules',kind:'custom',definitions:personal.filter(r=>r.subscribe).map(r=>({key:workflowPreferenceKey(branch,'personal-notification-rules',auth.userId+':'+r.id),label:r.title,description:r.intent,event:r.event,...notificationMetadata(r.event),rule_id:r.id,rule_revision:r.revision,methods:r.methods,category:'tasks',defaults:{in_app:r.methods.includes('in_app'),push:r.methods.includes('push')}}))});}
 const {rules}=await readAutomationRules(orgId,branch);
 if(!auth||hasPermission(auth,'manage_company_settings')){
  const definitions=rules.filter(r=>r.automation==='notification.create.v1'&&!String(r.id).startsWith('custom_notification_')).map(r=>{const input=obj(r.input);return {key:workflowPreferenceKey(branch,'organization-automations',String(r.id)),label:String(r.title||input.title||r.id),...(r.event?{event:String(r.event),...notificationMetadata(String(r.event))}:{}),description:String(r.explainer||input.body||'Company automation notification.'),category:'tasks',defaults:{in_app:input.passive!==false,push:input.push===true}};});
  groups.push({id:'organization-automations',label:'Company automations',kind:'workflow',definitions});
 }
  const custom=rules.filter(r=>r.automation==='notification.create.v1'&&String(r.id).startsWith('custom_notification_')&&(!auth||(obj(r.input).target_user_ids as unknown[]||[]).includes(auth.userId))).map(r=>({key:workflowPreferenceKey(branch,'organization-automations',String(r.id)),label:String(r.title),...(r.event?{event:String(r.event),...notificationMetadata(String(r.event))}:{}),description:String(r.explainer||''),category:'tasks',defaults:{in_app:obj(r.input).passive!==false,push:obj(r.input).push===true}}));
  if(custom.length)groups.push({id:'custom-automations',label:'Custom automations',kind:'custom',definitions:custom});
 if(auth&&!hasPermission(auth,'view_projects|manage_company_settings'))return groups;
 // Pure SQL projection: opening preferences must never install templates or change flags.
 const templates=await getWorkDatabase().prepare(`SELECT t.id,t.name,t.status,v.definition_json FROM scope_templates t JOIN scope_template_versions v ON v.organization_id=t.organization_id AND v.branch_id=t.branch_id AND v.template_id=t.id AND v.version=t.current_version WHERE t.organization_id=? AND t.branch_id=? ORDER BY t.sort_order,t.name`).all(orgId,branch);
 for(const raw of templates){const t=obj(raw);let definition:Json={};try{definition=JSON.parse(String(t.definition_json));}catch{continue;}
  const declared=new Map(scopeNotificationDefinitions(branch,String(t.id),definition).map(d=>[d.key,d]));
  const activeVersions=await getWorkDatabase().prepare(`SELECT DISTINCT v.definition_json FROM scope_template_versions v JOIN work_plans p ON p.organization_id=v.organization_id AND p.branch_id=v.branch_id AND p.template_id=v.template_id AND p.template_version=v.version WHERE v.organization_id=? AND v.branch_id=? AND v.template_id=? AND p.status IN ('pending','active')`).all(orgId,branch,String(t.id));
  for(const old of activeVersions)for(const d of scopeNotificationDefinitions(branch,String(t.id),JSON.parse(String(obj(old).definition_json))))if(!declared.has(d.key))declared.set(d.key,d);
  groups.push({id:`scope.${t.id}`,label:String(t.name),kind:'workflow',disabled:t.status==='archived',definitions:[...declared.values()]});
 }
 return groups;
}
/** User-owned copies are authoritative; source declarations remain discovery templates. */
export async function notificationCatalog(orgId:string,branch='default',auth?:PlatformAuthContext):Promise<NotificationGroup[]> {
 const source=await notificationSourceCatalog(orgId,branch,auth);
 if(!auth)return source;
 const personal=await readPersonalConfiguration(orgId,auth.userId,branch);
 const {applicableLocks,effectiveRules}=await import('./notifications/configuration.js');
 const {notificationPermissions}=await import('./notifications/permissions.js');
 const permissions=notificationPermissions(auth),policy=await applicableLocks(orgId,auth);
 if(!personal)return source;
 const allowed=new Set(source.flatMap(g=>g.definitions.map(d=>d.key))),removed=new Set(personal.removed_keys);
 const groups:NotificationGroup[]=personal.catalog.map(g=>({...g,definitions:g.definitions.filter(d=>allowed.has(d.key)&&(!removed.has(d.key)||!!policy.locks[d.key])).map(d=>({...d,personal:true}))})).filter(g=>g.definitions.length);
 const keys=new Set(groups.flatMap(g=>g.definitions.map(d=>d.key)));
 for(const group of source){
  const definitions=group.definitions.filter(d=>d.key.startsWith('event.')&&!keys.has(d.key)).map(d=>({...d,...(removed.has(d.key)?{personal_removed:true}:{})}));
  if(definitions.length)groups.push({...group,definitions});
 }
 for(const [key,lock] of Object.entries(policy.locks))if(lock.definition&&!lock.rule){
  const group=groups.find(g=>g.definitions.some(d=>d.key===key));
  if(group&&lock.mode==='full'&&!permissions.organization)group.definitions=group.definitions.map(d=>d.key===key?{...lock.definition!,personal:true}:d);
  if(!group)groups.push({id:'required.'+key,label:'Organization notifications',kind:'app',definitions:[{...lock.definition,personal:true}]});
 }
 const rules=await effectiveRules(orgId,auth.userId,auth);
 groups.push({id:'personal-rules',label:'Personal notification rules',kind:'custom',definitions:rules.filter(r=>r.subscribe).map(r=>({key:workflowPreferenceKey(branch,'personal-notification-rules',auth.userId+':'+r.id),label:r.title,description:r.intent,event:r.event,...notificationMetadata(r.event),rule_id:r.id,rule_revision:r.revision,methods:r.methods,category:'tasks',personal:true,defaults:{in_app:r.methods.includes('in_app'),push:r.methods.includes('push')}}))});
 for(const group of groups)for(const d of group.definitions){
  const mode=policy.locks[d.rule_id?'rule:'+d.rule_id:d.key]?.mode||'unlocked';
  d.lock_mode=mode;d.editable=permissions.personal&&(permissions.organization||mode!=='full');d.removable=permissions.personal&&(permissions.organization||mode==='unlocked');
 }

 return groups;
}
export const catalogDefinitions=(groups:NotificationGroup[])=>groups.flatMap(g=>g.definitions);
export function definitionPreferences(raw: unknown, definitions: NotificationDefinition[]) {
 const source = obj(raw);
 const surfaces = ['in_app', 'push', 'email', 'sms', 'celebration', 'toast', 'audio', 'in_app_sound', 'in_app_badge', 'in_app_bell'];
 return Object.fromEntries(surfaces.map(surface => [surface, Object.fromEntries(definitions.map(d => {
  const explicit = obj(source[surface])[d.key];
  if (typeof explicit === 'boolean') return [d.key, explicit];
  if (surface.startsWith('in_app_')) return [d.key, surface !== 'in_app_bell' || d.key !== 'messages'];
  if(surface==='audio')return [d.key,(d.methods?.includes('audio')||(obj(source.in_app)[d.key]??d.defaults.in_app))&&obj(source.in_app_sound)[d.key]!==false];
  if (!['in_app','push'].includes(surface)) return [d.key,d.methods?.includes(surface)||false];
  const categoryDisabled = d.key.startsWith('workflow.') && obj(source[surface])[d.category] === false;
  return [d.key, categoryDisabled ? false : d.defaults[surface as 'in_app' | 'push']];
 }))])) as Record<string, Record<string, boolean>>;
}
