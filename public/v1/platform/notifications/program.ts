import { runModuleCode } from '../../documents/modules/runtime.js';
import { backgroundAuthContext } from '../auth.js';
import { initializePublication } from '../publication/bootstrap.js';
import { userPublicationContext } from '../publication/context.js';
import { readPublishedData } from '../publication/providers.js';
import { decisionSchema, type NotificationRule, type Plan } from './contracts.js';
import type { SourceRef } from '../publication/contracts.js';
type Json=Record<string,unknown>;
export type ProgramInput={organizationId:string;userId:string;event:Json;baseline:Plan;now:string};
export async function evaluateProgram(rule:NotificationRule,input:ProgramInput, evidence:Record<string,unknown>={}, replay=false):Promise<Plan>{
 initializePublication();
 delete evidence.__published;
 let fault:Error|undefined;
 const cache=new Map<string,unknown>();
 const payload=(input.event.payload||{}) as Json;
 const tokens:Record<string,string>={'$organization':input.organizationId,'$project':String(input.event.project_id||payload.project_id||''),'$document':String(payload.document_id||''),'$snapshot':String(payload.snapshot_id||'')};
 const source=`
 function requiredValue(value,path){
   if(value===null||typeof value!=='object')return value;
   return new Proxy(value,{get(target,key){
     // Promise resolution and JSON serialization probe these optional protocol methods.
     if((key==='then'||key==='toJSON')&&!Object.prototype.hasOwnProperty.call(target,key))return undefined;
     if(typeof key==='symbol'||Array.isArray(target)&&['constructor','length','map','filter','reduce','some','every','find','findIndex','includes','slice','at','forEach','entries','keys','values','join'].includes(key))return Reflect.get(target,key);
     if(!Object.prototype.hasOwnProperty.call(target,key)){
       void api.data.read('notificationRequiredFault').catch(()=>{});
       throw new Error('Required field missing: '+path+'.'+String(key));
     }
     return requiredValue(target[key],path+'.'+String(key));
   }});
 }
 const data=Object.freeze({require:async name=>requiredValue(await api.data.read(name),name)});
 ${rule.source}`;
 const result=await runModuleCode({source,inputs:{event:input.event,baseline:input.baseline},now:input.now,mode:'evaluate',limits:{milliseconds:1500,calls:16}}, {
  read:async(name)=>{
   try{
    if(cache.has(name))return cache.get(name);
    if(name==='notificationRequiredFault')throw Error('Required nested field is missing');
    const binding=rule.bindings[name];if(!binding)throw Error('Required binding not declared: '+name);
    const ref=JSON.parse(JSON.stringify(binding.source)) as SourceRef;
    for(const [key,value] of Object.entries(ref.target))if(typeof value==='string'&&value.startsWith('$')){if(!tokens[value])throw Error('Missing source identity '+value);(ref.target as unknown as Json)[key]=tokens[value];}
    for(const [key,value] of Object.entries(ref.args||{}))if(typeof value==='string'&&value.startsWith('$')){if(!tokens[value])throw Error('Missing source identity '+value);ref.args![key]=tokens[value];}
    const evidenceKey=JSON.stringify(ref);
    if(replay){if(!Object.hasOwn(evidence,evidenceKey))throw Error('Repair requires an uncaptured historical input');const value=evidence[evidenceKey];cache.set(name,value);return value;}
    const auth=await backgroundAuthContext(input.organizationId,input.userId);
    const response=await readPublishedData(userPublicationContext(auth,{executionKind:'module',mode:'evaluate'}),ref);
    if(response.status!=='ready')throw Error(`Required binding ${name}: ${response.status} (${response.code})`);
    const value=response.value;
    const actual=Array.isArray(value)?'array':value===null?'null':typeof value;
    if(actual!==binding.type || (actual==='number'&&!Number.isFinite(value)))throw Error('Required binding has wrong type: '+name);
    evidence[evidenceKey]=value;cache.set(name,value);return value;
   }catch(error){fault=error instanceof Error?error:Error(String(error));throw fault;}
  },invoke:async()=>{fault=Error('Notification programs cannot invoke actions');throw fault;}
 });
 // Catching a failed require inside guest code cannot disguise unresolved inputs.
 if(fault)throw fault;
 const plan:Plan={};
 for(const [method,value] of Object.entries(result.outputs)){
  if(method==='variables'){
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Published variables must be an object');
   for(const [name,v] of Object.entries(value)){const actual=Array.isArray(v)?'array':v===null?'null':typeof v;if(rule.exports[name]!==actual)throw Error('Undeclared or invalid notification output: '+name);}
   evidence.__published=value;continue;
  }
  if(!rule.methods.includes(method as never))throw Error('Program changed an undeclared delivery method');
  const decision=decisionSchema.parse(value);
  if(decision.bypass_quiet&&!rule.bypass_quiet)throw Error('Rule cannot bypass quiet hours');
  if(decision.decision==='defer'&&(!decision.until||Date.parse(decision.until)<=Date.parse(input.now)))throw Error('A deferred delivery needs a future time');
  plan[method as keyof Plan]=decision;
 }
 return plan;
}
