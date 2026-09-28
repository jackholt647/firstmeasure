import { createHash } from "node:crypto";
import { listWorkEventDefinitions } from "../work/events.js";
import { isAppFlagEnabled } from "./app_flags.js";
import { readAutomationRules } from "../work/rules.js";
import { getWorkDatabase } from "../work/storage.js";
import { hasPermission, type PlatformAuthContext } from "./auth.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const rows = (v: unknown): Json[] => Array.isArray(v) ? v.map(obj) : [];
export type NotificationDefinition = { key:string; label:string; description:string; category:string; defaults:{in_app:boolean;push:boolean}; event?:string; permission?:string };
export type NotificationGroup = { id:string; label:string; kind:"app"|"workflow"|"custom"; definitions:NotificationDefinition[]; disabled?:boolean };
const words = (s:string) => s.replace(/[._-]+/g," ").replace(/^./,c=>c.toUpperCase());
export const eventGroups:Record<string,{label:string;app?:string;category:string;permission:string}> = {
 project:{label:"Projects",app:"projects",category:"tasks",permission:"view_projects"}, work:{label:"Tasks & scopes",app:"projects",category:"tasks",permission:"view_projects"},
 document:{label:"Documents",app:"projects",category:"tasks",permission:"view_projects"}, proposal:{label:"Proposals",app:"projects",category:"tasks",permission:"view_projects"},
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
 return listWorkEventDefinitions().map(e=>({key:`event.${e.name}`,label:words(e.name),description:e.description+" Receive these events in your branch, subject to your access permissions.",category:(eventGroups[e.name.split('.')[0]!]||eventGroups.project!).category,permission:(eventGroups[e.name.split('.')[0]!]||eventGroups.project!).permission,event:e.name,defaults:{in_app:false,push:false}}));
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
export async function notificationCatalog(orgId:string,branch='default',auth?:PlatformAuthContext):Promise<NotificationGroup[]> {
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
 const {rules}=await readAutomationRules(orgId,branch);
 if(!auth||hasPermission(auth,'manage_company_settings')){
  const definitions=rules.filter(r=>r.automation==='notification.create.v1'&&!String(r.id).startsWith('custom_notification_')).map(r=>{const input=obj(r.input);return {key:workflowPreferenceKey(branch,'organization-automations',String(r.id)),label:String(r.title||input.title||r.id),description:String(r.explainer||input.body||'Company automation notification.'),category:'tasks',defaults:{in_app:input.passive!==false,push:input.push===true}};});
  groups.push({id:'organization-automations',label:'Company automations',kind:'workflow',definitions});
 }
  const custom=rules.filter(r=>r.automation==='notification.create.v1'&&String(r.id).startsWith('custom_notification_')&&(!auth||(obj(r.input).target_user_ids as unknown[]||[]).includes(auth.userId))).map(r=>({key:workflowPreferenceKey(branch,'organization-automations',String(r.id)),label:String(r.title),description:String(r.explainer||''),category:'tasks',defaults:{in_app:obj(r.input).passive!==false,push:obj(r.input).push===true}}));
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
export const catalogDefinitions=(groups:NotificationGroup[])=>groups.flatMap(g=>g.definitions);
export function definitionPreferences(raw:unknown,definitions:NotificationDefinition[]) {
 const source=obj(raw);return Object.fromEntries(['in_app','push'].map(surface=>[surface,Object.fromEntries(definitions.map(d=>[d.key,typeof obj(source[surface])[d.key]==='boolean'?obj(source[surface])[d.key]:(d.key.startsWith('workflow.') && obj(source[surface])[d.category]===false ? false : d.defaults[surface as 'in_app'|'push'])]))])) as {in_app:Record<string,boolean>;push:Record<string,boolean>};
}
