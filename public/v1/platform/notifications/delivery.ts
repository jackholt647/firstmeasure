import { randomUUID } from 'node:crypto';
import { readDocument, listDocuments, upsertDocument } from '../storage.js';
import { backgroundAuthContext, hasPermission } from '../auth.js';
import { builtInEventDefinitions, eventGroups } from '../notification_catalog.js';
import { notificationPreferenceEnabled, notificationPresentation, deliverNotificationPush } from '../notification_delivery.js';
import { isAppFlagEnabled } from '../app_flags.js';
import { methods, matchesFilters, quietSchema, quietUntil, atPath, type Plan, type Method } from './contracts.js';
import { notificationStore, identity, listRules } from './store.js';
import { evaluateProgram } from './program.js';
import { repairRule } from './repair.js';
type Json=Record<string,unknown>;
const obj=(v:unknown):Json=>v&&typeof v==='object'&&!Array.isArray(v)?v as Json:{};
const strings=(v:unknown)=>Array.isArray(v)?v.map(String):[];
async function authorizedEvent(org:string,user:string,event:Json,note:Json){
 const auth=await backgroundAuthContext(org,user);
 if(auth.branchId&&auth.branchId!==String(note.branch_id||'default'))return false;
 const definition=builtInEventDefinitions().find(d=>d.event===event.type);
 if(definition&&!hasPermission(auth,definition.permission))return false;
 const app=eventGroups[String(event.type||'').split('.')[0]!] ?.app;
 return !app||await isAppFlagEnabled(org,'apps',app);
}
export function baselinePlan(note:Json,preferences:unknown):Plan {
 const prefs=obj(preferences),presentation=notificationPresentation(prefs,note),key=String(note.preference_key||note.category||'system');
 const requested=new Set(strings(note.delivery_methods));
 const enabled:Record<Method,boolean>={in_app:note.passive!==false&&notificationPreferenceEnabled(prefs,note,'in_app'),push:note.push===true&&notificationPreferenceEnabled(prefs,note,'push'),email:requested.has('email'),sms:requested.has('sms'),celebration:requested.has('celebration')||note.kind==='celebration'&&presentation.sound,toast:requested.has('toast'),audio:(requested.has('audio')||presentation.sound)&&obj(prefs.in_app_sound)[key]!==false,customer_portal:false};
 return Object.fromEntries(methods.map(method=>[method,{decision:enabled[method]&&obj(prefs[method])[key]!==false?'send':'suppress'}])) as Plan;
}
export function applyQuiet(plan:Plan,preferences:unknown,now=new Date()):Plan {
 const parsed=quietSchema.safeParse(obj(preferences).quiet_hours);if(!parsed.success)return plan;
 const until=quietUntil(parsed.data,now);if(!until)return plan;
 const result={...plan};for(const method of parsed.data.methods){const d=result[method];if(d&&d.decision!=='suppress'&&!d.bypass_quiet)result[method]={decision:'defer',until:d.until&&d.until>until?d.until:until};}return result;
}
/** The trusted host supplies a safe event envelope, never an arbitrary raw domain payload. */
export function notificationEvent(event:Json):Json {
 const payload=obj(event.payload),safe:Json={};for(const key of ['document_id','document_type','document_tags','document_source','template_id','snapshot_id','project_id','channel_id','scope_template_id','work_plan_id'])if(payload[key]!==undefined)safe[key]=payload[key];
 return {id:event.id,type:event.type,project_id:event.project_id,branch_id:event.branch_id,payload:safe};
}
export async function persistNotificationOccurrence(org:string,note:Json,event:Json={}) {
 const targetUsers=new Set(strings(note.target_user_ids)),targetRoles=new Set(strings(note.target_role_ids));
 const audience:string[]=[];
 for(const row of await listDocuments(org,'users')){
  const user=obj(row.data);if(user.disabled===true||user.deleted===true)continue;
  const roles=strings(user.roles);if(!roles.length&&['owner','admin','super_admin'].includes(String(user.role)))roles.push('inside_sales','sales_appointments');
  if(targetUsers.has(row.id)||roles.some(r=>targetRoles.has(r))||note.broadcast===true)audience.push(row.id);
 }
 const id=identity(org,note.id);
 await notificationStore().prepare('INSERT INTO notification_occurrences(id,organization_id,note_json,event_json,audience_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id,org,JSON.stringify(note),JSON.stringify(event),JSON.stringify(audience));
 return (await notificationStore().prepare('SELECT * FROM notification_occurrences WHERE id=?').get(id))!;
}
export async function enqueueNotification(org:string,note:Json,event:Json={},drain=true) {
 const occurrence=await persistNotificationOccurrence(org,note,event);
 if(occurrence.state==='materialized'){if(drain)await drainNotifications();return;}
 note=JSON.parse(String(occurrence.note_json));event=JSON.parse(String(occurrence.event_json));
 const audience=new Set(JSON.parse(String(occurrence.audience_json)) as string[]);
 for(const row of await listDocuments(org,'users')){
  if(!audience.has(row.id))continue;const user=obj(row.data);
  const id=identity(org,note.id,row.id),baseline=baselinePlan(note,user.notification_preferences);
  await notificationStore().prepare(`INSERT INTO notification_recipients(id,organization_id,notification_id,user_id,note_json,event_json,baseline_json,deadline_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
   .run(id,org,String(note.id),row.id,JSON.stringify(note),JSON.stringify(event),JSON.stringify(baseline),new Date(Date.now()+12000).toISOString());
 }
 const copy=obj(note.customer_copy);
 if(strings(note.target_portal_ids).length&&typeof copy.title==='string'&&copy.title.trim()&&typeof copy.body==='string'){
  for(const portalId of strings(note.target_portal_ids)){
   const portal=await readDocument(org,'customer_portals',portalId).catch(()=>null);if(!portal||obj(portal.data).status==='disabled')continue;
   const safeNote={id:note.id,title:copy.title,body:copy.body,expires_at:note.expires_at,portal_id:portalId,branch_id:note.branch_id};
   const plan=Object.fromEntries(methods.map(m=>[m,{decision:m==='customer_portal'?'send':'suppress'}]));
   await notificationStore().prepare(`INSERT INTO notification_recipients(id,organization_id,notification_id,user_id,note_json,event_json,baseline_json,deadline_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(identity(org,note.id,'portal:'+portalId),org,String(note.id),'portal:'+portalId,JSON.stringify(safeNote),'{}',JSON.stringify(plan),new Date().toISOString());
  }
 }
 await notificationStore().prepare("UPDATE notification_occurrences SET state='materialized' WHERE id=?").run(String(occurrence.id));
 if(drain)await drainNotifications();
}
async function resolveRecipient(row:Json){
 const org=String(row.organization_id),userId=String(row.user_id),note=JSON.parse(String(row.note_json)),event=JSON.parse(String(row.event_json)),audit:Json[]=[];
 if(userId.startsWith('portal:'))return defaultRecipient(row,'Customer portal default delivery');
 const user=await readDocument(org,'users',userId);const prefs=obj(user.data).notification_preferences;
 const base=baselinePlan(note,prefs);let plan={...base};
 const accepted:Array<{rule:Awaited<ReturnType<typeof listRules>>[number];input:Json;reads:Json;patch:Plan}>=[];
 const now=new Date().toISOString();
 let canRepair=Date.now()<Date.parse(String(row.deadline_at));
 if(canRepair){
  for(const rule of await listRules(org,userId)){
   if(!rule.enabled||rule.event!==event.type||!matchesFilters(rule.filters,event)||rule.notification_key&&rule.notification_key!==note.preference_key||rule.scope_template_id&&rule.scope_template_id!==obj(note.context).scope_template_id)continue;
   const input={organizationId:org,userId,event,baseline:applyQuiet(base,prefs),now};
   let patch:Plan|undefined;
   try{const reads:Json={};patch=await evaluateProgram(rule,input,reads);accepted.push({rule,input,reads,patch});audit.push({rule:rule.id,revision:rule.revision,status:'evaluated'});}
   catch(error){
    if(canRepair){canRepair=false;try{const repair=await repairRule(rule,input,error,Date.parse(String(row.deadline_at)));patch=repair.plan;if(patch&&repair.rule&&repair.reads)accepted.push({rule:repair.rule,input,reads:repair.reads,patch});audit.push({rule:rule.id,status:patch?'repaired':'default',task_id:repair.taskId,reason:repair.reason||String(error)});}catch(repairError){audit.push({rule:rule.id,status:'default',reason:String(repairError)});}}
    else audit.push({rule:rule.id,status:'default',reason:String(error)});
   }
   // Hard opt-outs and disabled producer methods cannot be promoted by a rule.
   if(patch)for(const method of rule.methods)if(base[method]?.decision!=='suppress'&&patch[method])plan[method]=patch[method];
   if(rule.group){const value=atPath(event,rule.group.path);if(value!==undefined){const window=Math.floor(Date.parse(now)/(rule.group.window_seconds*1000));const key=identity(org,userId,rule.id,value,window);const group=await notificationStore().transaction(async db=>{const inserted=await db.prepare('INSERT INTO notification_group_members(group_id,recipient_id) VALUES(?,?) ON CONFLICT(group_id,recipient_id) DO NOTHING').run(key,String(row.id));if(inserted.changes)await db.prepare('INSERT INTO notification_groups(id,first_at,last_at,count) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET count=notification_groups.count+1,last_at=excluded.last_at').run(key,now,now);return db.prepare('SELECT count FROM notification_groups WHERE id=?').get(key);},key);audit.push({group:key,count:Number(group?.count||1),alert:rule.group.alert});if(rule.group.alert==='first'&&Number(group?.count)>1)for(const m of ['push','sms','email','audio','toast','celebration'] as Method[])plan[m]={decision:'suppress'};if(rule.group.alert==='digest')for(const m of ['push','sms','email'] as Method[])if(plan[m]?.decision!=='suppress'){const until=new Date((window+1)*rule.group.window_seconds*1000).toISOString();plan[m]={...plan[m],decision:'defer',until:plan[m]?.until&&plan[m]!.until!>until?plan[m]!.until:until};};}}
  }
 }else audit.push({status:'default',reason:'Evaluation deadline elapsed or worker restarted'});
 plan=applyQuiet(plan,prefs);
 await notificationStore().transaction(async db=>{
  const claimed=await db.prepare("UPDATE notification_recipients SET state='planned',audit_json=? WHERE id=? AND token=? AND state='evaluating'").run(JSON.stringify(audit),String(row.id),String(row.token));
  if(!claimed.changes)return;
  // Only the winning evaluation can publish reusable outputs or regression evidence.
  for(const {rule,input,reads,patch} of accepted){
   if(reads.__published)await db.prepare('INSERT INTO notification_rule_outputs(organization_id,user_id,rule_id,revision,values_json,dependencies_json) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id,user_id,rule_id) DO UPDATE SET revision=excluded.revision,values_json=excluded.values_json,dependencies_json=excluded.dependencies_json').run(org,userId,rule.id,rule.revision,JSON.stringify(reads.__published),JSON.stringify(Object.keys(reads).filter(k=>k!=='__published').map(k=>JSON.parse(k))));
   await db.prepare('INSERT INTO notification_rule_samples(id,organization_id,user_id,rule_id,input_json,reads_json,output_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(identity(row.id,rule.id,rule.revision),org,userId,rule.id,JSON.stringify(input),JSON.stringify(reads),JSON.stringify(patch),now);
  }
  for(const method of methods){const d=plan[method]||{decision:'suppress'};await db.prepare('INSERT INTO notification_deliveries(id,recipient_id,method,decision_json,state,due_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(identity(row.id,method),String(row.id),method,JSON.stringify(d),d.decision==='suppress'?'suppressed':'pending',d.until||now);}
 },String(row.id));
}
async function defaultRecipient(row:Json,reason:string){
 const user=await readDocument(String(row.organization_id),'users',String(row.user_id)).catch(()=>null);
 const note=JSON.parse(String(row.note_json));
 const plan=applyQuiet(user?baselinePlan(note,obj(user.data).notification_preferences):JSON.parse(String(row.baseline_json)),obj(user?.data).notification_preferences);
 await notificationStore().transaction(async db=>{
  const changed=await db.prepare("UPDATE notification_recipients SET state='planned',audit_json=? WHERE id=? AND token=? AND state='evaluating'").run(JSON.stringify([{status:'default',reason}]),String(row.id),String(row.token));
  if(!changed.changes)return;
  for(const method of methods){const d=plan[method]||{decision:'suppress'};await db.prepare('INSERT INTO notification_deliveries(id,recipient_id,method,decision_json,state,due_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(identity(row.id,method),String(row.id),method,JSON.stringify(d),d.decision==='suppress'?'suppressed':'pending',d.until||new Date().toISOString());}
 },String(row.id));
}
async function sendDelivery(row:Json){
 const org=String(row.organization_id),userId=String(row.user_id),note=JSON.parse(String(row.note_json)),method=String(row.method) as Method;
 const parent=await readDocument(org,'notifications',String(note.id)).catch(()=>null);
 if(!parent||obj(parent.data).active===false||!['active',''].includes(String(obj(parent.data).status||'')))return {status:'cancelled',reason:'Notification withdrawn'};
 const audit=JSON.parse(String(row.audit_json||'[]')) as Json[];
 const digest=audit.find(a=>a.alert==='digest');
 if(digest&&['push','email','sms'].includes(method)){
  const members=await notificationStore().prepare("SELECT r.id FROM notification_group_members g JOIN notification_recipients r ON r.id=g.recipient_id JOIN notification_deliveries d ON d.recipient_id=r.id WHERE g.group_id=? AND d.method=? AND d.state NOT IN ('suppressed','cancelled') ORDER BY r.id").all(String(digest.group),method);
  if(members.at(-1)?.id!==row.recipient_id)return {status:'grouped',group:digest.group};
  note.title=`${members.length} updates: ${String(note.title)}`;
 }

 if(userId.startsWith('portal:')){
  const portal=await readDocument(org,'customer_portals',userId.slice(7)).catch(()=>null);
  if(!portal||obj(portal.data).status==='disabled'||note.expires_at&&note.expires_at<=new Date().toISOString())return {status:'cancelled'};
  return {status:method==='customer_portal'?'available':'cancelled'};
 }
 const auth=await backgroundAuthContext(org,userId);
 if(!await authorizedEvent(org,userId,JSON.parse(String(row.event_json||'{}')),note))return {status:'cancelled',reason:'Event access revoked'};
 if(auth.branchId&&auth.branchId!==String(note.branch_id||'default'))return {status:'cancelled',reason:'Recipient branch changed'};
 if(!await isAppFlagEnabled(org,'apps','notifications'))return {status:'cancelled'};
 const user=await readDocument(org,'users',userId),prefs=obj(user.data).notification_preferences;
 if(baselinePlan(note,prefs)[method]?.decision==='suppress')return {status:'cancelled',reason:'Preference disabled'};
 const state=obj(obj(obj(user.data).notification_state)[String(note.id)]);
 if(note.expires_at&&String(note.expires_at)<=new Date().toISOString()||state.dismissed_at||state.completed_at)return {status:'cancelled',reason:'Expired or dismissed'};
 const decision=JSON.parse(String(row.decision_json));
 const q=applyQuiet({[method]:decision},prefs)[method];
 if(q?.decision==='defer'&&q.until&&q.until>new Date().toISOString())return {status:'deferred',until:q.until};
 if(method==='push'){
  const attempts=await deliverNotificationPush(org,{...note,target_user_ids:[userId],target_role_ids:[]});
  return {status:attempts.some(a=>a.status==='sent')?'accepted':attempts.some(a=>a.status==='error')?'uncertain':attempts.some(a=>String(a.status).startsWith('provider_')||a.status==='auth_failed')?'failed':'unavailable',attempts};
 }
 if(method==='email'||method==='sms'){
  const address=String(obj(user.data)[method==='email'?'email':'phone']||'');if(!address)return {status:'unavailable',reason:'Recipient has no delivery address'};
  const {sendCommunication}=await import('../../messaging/communications_service.js');const {sendCommunicationSchema}=await import('../../messaging/schemas.js');
  const result=await sendCommunication(org,sendCommunicationSchema.parse({channel:method,branch_id:note.branch_id,recipients:[{address}],content:{subject:note.title,text:note.body||note.title},source:{type:'notification',id:note.id},idempotency_key:String(row.id)}),{branchId:auth.branchId});
  return {status:obj(result.message).status==='failed'?'failed':'accepted',result};
 }
 // Client surfaces are made available independently and acknowledged by the owning user.
 return {status:method==='customer_portal'?'unavailable':'available'};
}
let draining=false;
export async function drainNotifications(limit=20){
 if(draining)return;draining=true;const db=notificationStore();
 try{
  for(const occurrence of await db.prepare("SELECT * FROM notification_occurrences WHERE state='pending' LIMIT 20").all()){
   const note=JSON.parse(String(occurrence.note_json));
   try{await upsertDocument(String(occurrence.organization_id),'notifications',{id:String(note.id),data:note,metadata:{kind:'platform_notification',source:note.source}},{createOnly:true});}catch(error){if((error as {code?:string}).code!=='document_exists')throw error;}
   await enqueueNotification(String(occurrence.organization_id),note,JSON.parse(String(occurrence.event_json)),false);
  }
  await db.prepare("UPDATE notification_recipients SET state='pending' WHERE state='evaluating' AND lease_until<=?").run(new Date().toISOString());
  await db.prepare("UPDATE notification_deliveries SET state='uncertain',result_json=? WHERE state='sending' AND lease_until<=?").run(JSON.stringify({reason:'Worker interrupted; external effect may have occurred'}),new Date().toISOString());
  for(let i=0;i<limit;i++){
   const row=await db.transaction(async()=>{const candidate=await db.prepare("SELECT * FROM notification_recipients WHERE state='pending' ORDER BY deadline_at LIMIT 1").get();if(!candidate)return;const token=randomUUID(),deadline=candidate.token?String(candidate.deadline_at):new Date(Date.now()+12000).toISOString();const changed=await db.prepare("UPDATE notification_recipients SET state='evaluating',token=?,lease_until=?,deadline_at=? WHERE id=? AND state='pending'").run(token,new Date(Date.now()+60000).toISOString(),deadline,String(candidate.id));return changed.changes?{...candidate,token,deadline_at:deadline} as Json:undefined;});
   if(!row)break;
   let deadlineTimer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([resolveRecipient(row),new Promise<void>((resolve,reject)=>{deadlineTimer=setTimeout(()=>{void defaultRecipient(row,'Evaluation deadline elapsed').then(resolve,reject);},Math.max(1,Date.parse(String(row.deadline_at))-Date.now()));})]);}
   catch(error){await defaultRecipient(row,String(error));}
   finally{if(deadlineTimer)clearTimeout(deadlineTimer);} 
  }
  for(let i=0;i<limit*8;i++){
   const row=await db.transaction(async()=>{const candidate=await db.prepare("SELECT d.*,r.organization_id,r.user_id,r.note_json,r.event_json,r.audit_json FROM notification_deliveries d JOIN notification_recipients r ON r.id=d.recipient_id WHERE d.state='pending' AND d.due_at<=? ORDER BY d.due_at LIMIT 1").get(new Date().toISOString());if(!candidate)return;const token=randomUUID();const changed=await db.prepare("UPDATE notification_deliveries SET state='sending',token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND state='pending'").run(token,new Date(Date.now()+120000).toISOString(),String(candidate.id));return changed.changes?{...candidate,token} as Json:undefined;});
   if(!row)break;
   let result:Json;try{result=await sendDelivery(row);}catch(error){result={status:'failed',reason:String(error)};}
   await db.prepare("UPDATE notification_deliveries SET state=?,result_json=?,due_at=? WHERE id=? AND token=? AND state='sending'").run(result.status==='deferred'?'pending':String(result.status),JSON.stringify(result),String(result.until||row.due_at),String(row.id),String(row.token));
  }
 }finally{draining=false;}
}
export async function recipientDeliveries(org:string,user:string){const rows=await notificationStore().prepare('SELECT r.notification_id,r.note_json,r.event_json,r.state AS recipient_state,r.audit_json,d.method,d.state,d.id,d.due_at FROM notification_recipients r LEFT JOIN notification_deliveries d ON d.recipient_id=r.id WHERE r.organization_id=? AND r.user_id=?').all(org,user);const result=new Map<string,Json>();for(const row of rows){if(!await authorizedEvent(org,user,JSON.parse(String(row.event_json)),JSON.parse(String(row.note_json))).catch(()=>false))continue;const value=result.get(String(row.notification_id))||{state:row.recipient_state,methods:{},groups:JSON.parse(String(row.audit_json)).filter((a:Json)=>a.group)};if(row.method)(value.methods as Json)[String(row.method)]={id:row.id,state:row.state,due_at:row.due_at};result.set(String(row.notification_id),value);}return result;}
export async function acknowledgeDelivery(org:string,user:string,id:string){const result=await notificationStore().prepare("UPDATE notification_deliveries SET state='presented' WHERE id=? AND state='available' AND recipient_id IN (SELECT id FROM notification_recipients WHERE organization_id=? AND user_id=?)").run(id,org,user);return result.changes===1;}

/** Called only after resolving an owner portal token; never included in guest projections. */
export async function portalNotifications(org:string,portalId:string){
 const rows=await notificationStore().prepare("SELECT r.note_json FROM notification_recipients r JOIN notification_deliveries d ON d.recipient_id=r.id WHERE r.organization_id=? AND r.user_id=? AND d.method='customer_portal' AND d.state='available' ORDER BY d.due_at DESC LIMIT 50").all(org,'portal:'+portalId);
 return rows.map(r=>JSON.parse(String(r.note_json))).filter(n=>!n.expires_at||n.expires_at>new Date().toISOString()).map(n=>({id:n.id,title:n.title,body:n.body}));
}
