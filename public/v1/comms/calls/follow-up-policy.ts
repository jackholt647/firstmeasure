import { readWorkConfiguration } from '../../work/config.js';
import { readNodeRecord } from '../../work/storage.js';
import { voiceSettings } from './settings.js';
import { isFollowUpWorkNode } from '../../work/followups.js';
import { text,object,strings,type CustomerCall,type Json } from './storage.js';

/** Calendar intervals use the organization's civil date, independent of the server timezone. */
export function policyDueAt(timezone:string,amount:number,unit:string,clock='',now=new Date()){
  const parts=(date:Date)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  const civil=parts(now),date=new Date(Date.UTC(Number(civil.year),Number(civil.month)-1,Number(civil.day),12));
  if(unit==='months'){const day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+amount);const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));}else date.setUTCDate(date.getUTCDate()+amount*(unit==='weeks'?7:1));
  const day=date.toISOString().slice(0,10);if(!clock)return day;
  const target=Date.parse(`${day}T${clock}:00Z`);let instant=target,afterGap=Infinity;
  for(let n=0;n<4;n++){const observed=parts(new Date(instant)),wall=Date.parse(`${observed.year}-${observed.month}-${observed.day}T${observed.hour}:${observed.minute}:00Z`);const delta=target-wall;if(!delta)return new Date(instant).toISOString();if(wall>target)afterGap=Math.min(afterGap,instant);instant+=delta;}
  // A nonexistent time during the spring clock change moves to the next valid hour.
  return new Date(Number.isFinite(afterGap)?afterGap:instant).toISOString();
}
export async function followUpOptions(call:CustomerCall,now=new Date()){
  const config=await readWorkConfiguration(call.organization_id,call.branch_id),global=object(config.follow_ups);
  const settings=object(call.metadata.list_settings),overrides={...settings,...object(settings.follow_ups)};
  const resolved:Json={...global,...overrides,retry_policy:{...object(global.retry_policy),...object(overrides.retry_policy)}};
  const policy=object(resolved.retry_policy),steps=(Array.isArray(policy.steps)?policy.steps:[]).map(object);
  const node=(await Promise.all(strings(call.metadata.source_node_ids).map(async id=>(await readNodeRecord(call.organization_id,id))))).find(Boolean);
  const previous=object(object(node?.metadata).follow_up),timezone=(await voiceSettings(call.organization_id)).timezone;
  let index=Number.isInteger(previous.policy_step_index)?Number(previous.policy_step_index)+1:0;
  if(index>=steps.length)index=policy.after_last==='stop'?-1:steps.length-1;
  const step=steps[index],suggestions:Record<string,Json>={};
  if(policy.enabled!==false&&step)for(const trigger of strings(policy.triggers))suggestions[trigger]={due_at:policyDueAt(timezone,Math.max(1,Number(step.amount)||1),text(step.unit)||'days',text(resolved.default_time),now),policy_step_index:index,policy_step_id:text(step.id),policy_step_label:text(step.label),policy_trigger:trigger};
  const quick=(Array.isArray(resolved.quick_options)?resolved.quick_options:[]).map(object).map(option=>({label:text(option.label),due_at:policyDueAt(timezone,Math.max(1,Number(option.amount)||1),text(option.unit)||'days',text(resolved.default_time),now)}));
  const outcomes=(Array.isArray(resolved.outcomes)?resolved.outcomes:[]).map(object);
  return {timezone,suggestions,quick_options:quick,outcomes,follow_up_node_ids:(await Promise.all(strings(call.metadata.source_node_ids).map(async id=>({id,keep:isFollowUpWorkNode(await readNodeRecord(call.organization_id,id))})))).filter(item=>item.keep).map(item=>item.id)};
}
