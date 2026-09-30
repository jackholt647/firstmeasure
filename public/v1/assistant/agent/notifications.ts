import { assertPersonalNotificationEdit } from '../../platform/notifications/permissions.js';
import { listRules } from '../../platform/notifications/store.js';
import { platformAgentTools } from '../../agents/platform_tools.js';
import { notificationRuleCatalog, configureRule } from '../../platform/notifications/api.js';
import { createHash } from 'node:crypto';
import type { AgentTool, AgentRun } from '../../agents/types.js';
import { notificationCatalog, catalogDefinitions, workflowPreferenceKey } from '../../platform/notification_catalog.js';
import { saveNotificationPreferences } from '../../platform/notification_delivery.js';
import { readAutomationRules, saveAutomationRules } from '../../work/rules.js';
import { readDocument } from '../../platform/storage.js';
import { hasPermission } from '../../platform/auth.js';
import { isAppFlagEnabled } from '../../platform/app_flags.js';
import { readScopeTemplateVersion } from '../../scopes/storage.js';
import { listWorkEventDefinitions } from '../../work/events.js';

type Json = Record<string, unknown>;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const blockedEvents=new Set(['time.cron','proposal.payment.mock_succeeded']);
const gate=(run:AgentRun)=>run.ctx&&run.userId ? true : 'Notification settings require a signed-in user.';
async function catalog(run:AgentRun){
 if(!await isAppFlagEnabled(run.orgId,'apps','notifications'))throw Error('Notifications are not enabled for this company.');
 return notificationCatalog(run.orgId,run.branchId,run.ctx!);
}
export const notificationAssistantInstructions=`
## Notification configuration
When asked to configure notifications, first call inspect_notifications and compare the request against existing general preferences, scope declarations, and custom rules, including disabled ones. Do not create a duplicate because an existing option is off. Explain a likely match in plain language ("You already have ...; it notifies you when ...") and ask whether to use it or how the request differs. Continue the conversation before changing a likely match.
For a new request, clarify the event, any filters, and whether the user wants in-app, push, or both. Summarize the behavior before saving. Notifications configured here notify only the current user. Never invent event names, filter fields, scope IDs or task IDs. Use authorized scope data through platform_search/read or the existing scope tools when needed. Simple exact filters may use configure_notification. For programmable delivery use inspect_delivery_rules and save_delivery_rule. Inspect actual document templates, workflow assignments, the tag catalog labels and stable tag IDs, and published data before authoring. Renamed tags keep their IDs; archived tags retain historical meaning but must not be added to new filters. Notification group/source/tab come from the event declaration and never grant access. New UI registrations live in Custom under the declared event group. Never infer proposal tags from names. A subscribe rule creates a notification for this user; otherwise it modifies matching existing notifications. Use document.signed and payload.document_tags contains for document categories. Code must use data.require with declared typed bindings; missing data is intentionally a repair trigger. Do not build catches, zero defaults, or guessed aliases to conceal unknown fields. Background repair has no user present and uses ordinary notification behavior if it cannot resolve the failure. Preserve hard opt-outs. Preserve existing rule source, bindings, filters, grouping, quiet_exempt_methods and revision when changing only one option. quiet_exempt_methods is an explicit unconditional per-method user exception to quiet hours; use it only when requested. Conditional exceptions belong in the existing program with bypass_quiet authorization. Source references may use $organization, $project, $document and $snapshot target/argument tokens. Read accepted snapshot data for signed-value comparisons, not mutable pricing. Code runs only after the event filter matches. Generic event choices are available as potential triggers and appear in Custom after selection. Every notification definition is a user-owned copy, including initial app and scope notifications. Organization defaults seed copies; later default changes do not overwrite people. Organization removal/full locks are live policy and cannot be bypassed. Only organization notification managers can change locks or publish defaults. Existing scope notifications retain their scope grouping. Disabling a notification does not disable the workflow.
Call configure_notification only after inspecting in this turn. Re-inspect after a conflict. A duplicate response must be discussed, never bypassed by changing the label. Never fire a live event to test a notification. Report exactly what was saved and any unavailable behavior; do not claim a phone received a push.
`;
export const notificationAssistantTools:AgentTool[]=[
 ...platformAgentTools.filter(t=>['platform_search','platform_describe','platform_read','platform_list'].includes(t.name)),
 {name:'inspect_delivery_rules',description:'Inspect personal delivery programs, change history, and existing document templates/types/tags. Inspect before writing a program; do not invent tags.',publication:{effect:'read'},gate,parameters:{type:'object',properties:{},additionalProperties:false},async execute(run){run.scratch.deliveryInspected=true;return await notificationRuleCatalog(run.orgId,run.ctx!);}},
 {name:'save_delivery_rule',description:'Save a personal event/filter subscription or delivery program. Read declared registry fields via await data.require(name). Missing required inputs must fail so backend repair can resolve them; never catch and silently default. Program returns {outputs:{push:{decision:"send",bypass_quiet:true}}}. The host enforces opt-outs and quiet hours. Instructions remain the source of intent.',gate:run=>run.settings.allow_actions!==false&&run.scratch.deliveryInspected===true?true:'Inspect delivery rules first; company actions must be enabled.',parameters:{type:'object',properties:{rule_json:{type:'string',description:'JSON rule: id, revision (0 for new), intent, event, filters [{path,op,value}], source, bindings {name:{source:{provider,export,target,path?,args?},type}}, methods, bypass_quiet, subscribe, title, body. Only filters use event metadata; code may read other authorized registry data. Stable tags use payload.document_tags with contains.'}},required:['rule_json'],additionalProperties:false},async execute(run,args){const rule=await configureRule(run.orgId,run.ctx!,JSON.parse(String(args.rule_json)));run.changeLog.push('Saved notification delivery rule '+rule.id);return {saved:true,rule};}},

 {
  name:'inspect_notifications',description:'Inspect authorized existing notification choices, workflow/scope declarations, custom automation rules, and potential triggers. Required before configuring notifications; compare behavior to avoid duplicates.',
  publication:{effect:'read'},gate,parameters:{type:'object',properties:{},additionalProperties:false},
  async execute(run){
   const groups=await catalog(run),user=await readDocument(run.orgId,'users',run.userId);
   const prefs=obj(obj(user.data).notification_preferences);
   const rules=hasPermission(run.ctx!,'manage_company_settings')?(await readAutomationRules(run.orgId,run.branchId)).rules.filter(r=>r.automation==='notification.create.v1'):[];
   const scopes=[];
   for(const group of groups.filter(g=>g.id.startsWith('scope.'))){
    const id=group.id.slice(6),record=await readScopeTemplateVersion(run.orgId,run.branchId,id);
    const tasks:Json[]=[];
    const walk=(nodes:unknown)=>{for(const raw of Array.isArray(nodes)?nodes:[]){const node=obj(raw);tasks.push({id:node.id,title:node.title});walk(node.children);}};
    walk(obj(obj(record?.definition).work_plan).root_nodes);
    scopes.push({id,label:group.label,tasks});
   }
   run.scratch.notificationsInspected=true;
   return {groups,scopes,preferences:prefs,rules:rules.map(r=>({id:r.id,title:r.title,enabled:r.enabled,event:r.event,conditions:r.conditions,recipients:obj(r.input).target_user_ids,preference_key:workflowPreferenceKey(run.branchId,'organization-automations',String(r.id))})),trigger_fields:listWorkEventDefinitions().filter(e=>catalogDefinitions(groups).some(d=>d.event===e.name)&&!blockedEvents.has(e.name)).map(e=>({event:e.name,payload:e.payload||{}}))};
  }
 },
 {
  name:'configure_notification',description:'Enable or disable an existing personal notification preference, select a potential trigger into Custom, or create a personal conditional notification using a personal event subscription. Exact rule duplicates are reused. Requires inspect_notifications first. All notification registrations are personal and require permission to edit personal notifications.',
  gate:run=>gate(run)!==true?gate(run):run.scratch.actionsAllowed===true&&obj(run.settings).allow_actions===true?true:'Assistant actions are turned off for this company.',
  parameters:{type:'object',properties:{key:{type:'string',description:'Existing preference key, or event.<registered event> for a conditional rule.'},label:{type:'string',maxLength:120},description:{type:'string',maxLength:500},conditions_json:{type:'string',description:'JSON object of exact-equality filters, or {} to configure the existing preference. Allowed fields: declared payload fields, project.id, plan.template_id, node.template_node_id, node.title.'},in_app:{type:'boolean'},push:{type:'boolean'}},required:['key','label','description','conditions_json','in_app','push'],additionalProperties:false},
  async execute(run,args){
   assertPersonalNotificationEdit(run.ctx!);
   if(!run.scratch.notificationsInspected)throw Error('Inspect existing notifications first.');
   const groups=await catalog(run),definitions=catalogDefinitions(groups),key=String(args.key),definition=definitions.find(d=>d.key===key);
   if(!definition||blockedEvents.has(definition.event||''))throw Error('Choose an authorized notification or event from the catalog.');
   const parsed=JSON.parse(String(args.conditions_json));
   if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw Error('Conditions must be an object.');
   const conditions=obj(parsed),fields=Object.keys(conditions);
   if(fields.length>12)throw Error('Use at most twelve conditions.');
   if(!fields.length){
    const user=await readDocument(run.orgId,'users',run.userId),current=obj(obj(user.data).notification_preferences);
    const custom=Array.isArray(current.custom_keys)?current.custom_keys.map(String):[];
    await saveNotificationPreferences(run.orgId,run.userId,{in_app:{[key]:args.in_app},push:{[key]:args.push},custom_keys:[...new Set([...custom,...(key.startsWith('event.')?[key]:[])])]},run.branchId);
    run.changeLog.push(`Updated ${definition.label} notifications.`);
    return {saved:true,key,reused_existing:true};
   }
   if(!definition.event)throw Error('Filters require a registered event trigger.');
   const paths:Record<string,string>={'project.id':'project_id','plan.template_id':'payload.scope_template_id'};
   const allowed=new Set(['project_id','payload.document_id','payload.document_type','payload.document_source','payload.template_id','payload.workflow_id','payload.scope_template_id','payload.work_plan_id']);
   const filters=fields.map(field=>{const path=paths[field]||field;if(!allowed.has(path)||!['string','number','boolean'].includes(typeof conditions[field]))throw Error('Use an inspected event filter or a personal delivery program for '+field);return {path,op:'eq' as const,value:conditions[field] as string|number|boolean};});
   const sorted=filters.sort((a,b)=>a.path.localeCompare(b.path));
   const id='custom_'+createHash('sha256').update(JSON.stringify([definition.event,sorted])).digest('hex').slice(0,32);
   const existing=(await listRules(run.orgId,run.userId)).find(r=>r.id===id);
   if(existing)return {saved:false,duplicate:true,existing:{title:existing.title},message:'This personal notification already exists.'};
   const methods=[...(args.in_app?['in_app']:[]),...(args.push?['push']:[])];
   if(!methods.length)throw Error('Choose at least one delivery method.');
   const rule=await configureRule(run.orgId,run.ctx!,{id,event:definition.event,filters:sorted,intent:String(args.description||args.label),title:String(args.label),body:String(args.description||''),methods,subscribe:true,source:'return {outputs:{}};'});
   run.changeLog.push('Created personal notification '+rule.title);
   return {saved:true,key:workflowPreferenceKey(run.branchId,'personal-notification-rules',run.userId+':'+rule.id),rule_id:rule.id};
  }
 }
];
