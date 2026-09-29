import { registerDataProvider, readPublishedData } from '../publication/providers.js';
import { notificationStore, listRules } from './store.js';
import { forbidden } from '../errors.js';
import { contentHash } from '../publication/validation.js';
import type { PublicationContext, SourceRef } from '../publication/contracts.js';
async function currentExports(ctx:PublicationContext,ruleId:string,value:unknown){
 const rule=(await listRules(ctx.organizationId,ctx.auth!.userId)).find(r=>r.id===ruleId&&r.enabled);
 if(!rule||!value||typeof value!=='object'||Object.entries(value).some(([key,v])=>rule.exports[key] !== (Array.isArray(v)?'array':v===null?'null':typeof v)))throw forbidden('notification_outputs_revoked','These notification outputs are no longer published.');
}
async function checkDependencies(ctx:PublicationContext,ruleId:string,sources:SourceRef[]){
 const key=`notification:${ctx.auth!.userId}:${ruleId}`;
 if(ctx.dependencyPath?.includes(key)||(ctx.dependencyPath?.length||0)>=8)throw forbidden('notification_dependency_cycle','Notification dependency cycle.');
 for(const source of sources){const checked=await readPublishedData({...ctx,dependencyPath:[...(ctx.dependencyPath||[]),key]},source);if(checked.status!=='ready')throw forbidden('notification_dependency_unavailable','A notification output dependency is no longer available.');}
}
export function registerNotificationProvider(){
 registerDataProvider({id:'notification-rules',version:'1',apps:['settings'],exports:{value:{
  description:'The current user’s explicitly published notification-rule variables. Reads do not execute rules.',schema:{type:'object',additionalProperties:true},schemaVersion:'1',
  argsSchema:{type:'object',properties:{ruleId:{type:'string'}},required:['ruleId'],additionalProperties:false},
  access:{scopes:['organization'],permissions:[],applications:false,capabilities:['apps.notifications'],authorize:ctx=>{if(!ctx.auth)throw forbidden('notification_principal_required','Notification outputs belong to an authenticated user.');}},
  authorizeSnapshot:async(ctx,_ref,result)=>{
   if(result.provenance.ownerId!==ctx.auth!.userId)throw forbidden('notification_output_owner','These outputs belong to another user.');
   await currentExports(ctx,String(result.provenance.ruleId),result.value);
   await checkDependencies(ctx,String(result.provenance.ruleId),result.provenance.dependencies as SourceRef[]||[]);
  },
  read:async(ctx,ref)=>{
   const key=`notification:${ctx.auth!.userId}:${String(ref.args?.ruleId)}`;
   if(ctx.dependencyPath?.includes(key)||(ctx.dependencyPath?.length||0)>=8)return {status:'error',code:'notification_dependency_cycle',message:'Notification output dependency cycle.'};
   const row=await notificationStore().prepare('SELECT * FROM notification_rule_outputs WHERE organization_id=? AND user_id=? AND rule_id=?').get(ctx.organizationId,ctx.auth!.userId,String(ref.args?.ruleId));
   if(!row)return {status:'missing',code:'notification_outputs_missing',message:'This rule has no accepted outputs.'};
   await currentExports(ctx,String(ref.args?.ruleId),JSON.parse(String(row.values_json)));
   const dependencies=JSON.parse(String(row.dependencies_json));await checkDependencies(ctx,String(ref.args?.ruleId),dependencies);
   return {value:JSON.parse(String(row.values_json)),revision:contentHash([row.revision,row.values_json]),provenance:{ownerId:ctx.auth!.userId,ruleId:ref.args?.ruleId,dependencies}};
  }
 }}});
}
