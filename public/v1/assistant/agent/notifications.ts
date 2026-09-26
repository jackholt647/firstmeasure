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
For a new request, clarify the event, any filters, and whether the user wants in-app, push, or both. Summarize the behavior before saving. Notifications configured here notify only the current user. Never invent event names, filter fields, scope IDs or task IDs. Use authorized scope data through platform_search/read or the existing scope tools when needed. Conditional rules use the existing Work automation engine; no code generation is needed. Generic event choices are available as potential triggers and appear in Custom after selection. Existing scope notifications stay in their scope. Disabling a notification does not disable the workflow.
Call configure_notification only after inspecting in this turn. Re-inspect after a conflict. A duplicate response must be discussed, never bypassed by changing the label. Never fire a live event to test a notification. Report exactly what was saved and any unavailable behavior; do not claim a phone received a push.
`;
export const notificationAssistantTools:AgentTool[]=[
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
  name:'configure_notification',description:'Enable or disable an existing personal notification preference, select a potential trigger into Custom, or create a personal conditional notification using an existing Work automation rule. Exact rule duplicates are reused. Requires inspect_notifications first. Conditional rules require company-settings permission.',
  gate:run=>gate(run)!==true?gate(run):run.scratch.actionsAllowed===true&&obj(run.settings).allow_actions===true?true:'Assistant actions are turned off for this company.',
  parameters:{type:'object',properties:{key:{type:'string',description:'Existing preference key, or event.<registered event> for a conditional rule.'},label:{type:'string',maxLength:120},description:{type:'string',maxLength:500},conditions_json:{type:'string',description:'JSON object of exact-equality filters, or {} to configure the existing preference. Allowed fields: declared payload fields, project.id, plan.template_id, node.template_node_id, node.title.'},in_app:{type:'boolean'},push:{type:'boolean'}},required:['key','label','description','conditions_json','in_app','push'],additionalProperties:false},
  async execute(run,args){
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
   if(!hasPermission(run.ctx!,'manage_company_settings'))throw Error('Creating a conditional automation requires company settings permission.');
   if(!definition.event)throw Error('Filters require a registered event trigger.');
   const event=listWorkEventDefinitions().find(e=>e.name===definition.event)!;
   const allowed=new Set(['project.id','plan.template_id','node.template_node_id','node.title',...Object.keys(event.payload||{}).map(k=>'payload.'+k)]);
   for(const field of fields)if(!allowed.has(field)||!['string','number','boolean'].includes(typeof conditions[field])||String(conditions[field]).length>300)throw Error('Unsupported filter: '+field);
   if((conditions['plan.template_id']||conditions['node.template_node_id']||conditions['node.title'])&&!definition.event.startsWith('work.'))throw Error('Scope and task filters require a workflow or task event.');
   if(conditions['plan.template_id']&&!groups.some(g=>g.id==='scope.'+conditions['plan.template_id']))throw Error('Choose an existing authorized scope.');
   const sorted=Object.fromEntries(fields.sort().map(k=>[k,conditions[k]]));
   const id='custom_notification_'+createHash('sha256').update(JSON.stringify([run.userId,definition.event,sorted])).digest('hex').slice(0,32);
   const snapshot=await readAutomationRules(run.orgId,run.branchId);
   const same=snapshot.rules.find(r=>r.automation==='notification.create.v1'&&r.event===definition.event&&JSON.stringify(Object.fromEntries(Object.entries(obj(r.conditions)).sort(([a],[b])=>a.localeCompare(b))))===JSON.stringify(sorted)&&Array.isArray(obj(r.input).target_user_ids)&&(obj(r.input).target_user_ids as unknown[]).includes(run.userId));
   if(same)return {saved:false,duplicate:true,existing:{title:same.title,key:workflowPreferenceKey(run.branchId,'organization-automations',String(same.id))},message:'This behavior already exists. Discuss it with the user and configure its preference key instead.'};
   if([args.label,args.description].some(v=>String(v).includes('{{')))throw Error('Use plain notification text, without template expressions.');
   if(!String(args.label).trim())throw Error('Give this notification a clear name.');
   const preferenceKey=workflowPreferenceKey(run.branchId,'organization-automations',id);
   await saveAutomationRules(run.orgId,run.branchId,{expected_revision:snapshot.revision,rules:[...snapshot.rules,{id,title:args.label,explainer:args.description,enabled:true,customer_visible:true,event:definition.event,conditions:sorted,automation:'notification.create.v1',input:{title:args.label,body:args.description,target_user_ids:[run.userId],passive:args.in_app===true,push:args.push===true,custom_notification:true,custom_event:definition.event}}]});
   await saveNotificationPreferences(run.orgId,run.userId,{in_app:{[preferenceKey]:args.in_app},push:{[preferenceKey]:args.push}},run.branchId);
   run.changeLog.push(`Created ${args.label} in Custom notifications.`);
   return {saved:true,key:preferenceKey,automation_id:id};
  }
 }
];
