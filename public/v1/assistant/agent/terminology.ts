import type { AgentTool } from '../../agents/types.js';
import { terminologyContract } from '../../platform/localization/terminology.js';

export const terminologyAssistantTools:AgentTool[]=[{
  name:'draft_terminology',
  description:'Prepare display-label drafts for review in the terminology editor. Does not save company settings. Use exact supplied keys, include singular and plural forms when renaming a concept, and leave authored names untouched.',
  permission:'manage_company_settings',
  publication:{effect:'read'},
  parameters:{type:'object',additionalProperties:false,properties:{changes:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,properties:{key:{type:'string'},value:{type:'string',maxLength:160}},required:['key','value']}},focus_keys:{type:'array',items:{type:'string'}}},required:['changes','focus_keys']},
  execute(run,args){
    const catalog=Array.isArray(run.input.catalog)?run.input.catalog as Array<{key:string}>:[];
    const allowed=new Set(catalog.map(row=>row.key).filter(key=>Object.hasOwn(terminologyContract,key)||/^(roles|event_types)\.[a-z0-9_-]+$/.test(key)));
    const changes=(Array.isArray(args.changes)?args.changes:[]).slice(0,100).map(raw=>raw as {key:string;value:string}).filter(change=>allowed.has(change.key)&&typeof change.value==='string'&&change.value.length<=160).map(change=>({key:change.key,value:change.value.trim()}));
    const focus_keys=(Array.isArray(args.focus_keys)?args.focus_keys:[]).filter(key=>typeof key==='string'&&allowed.has(key));
    run.renders.push({type:'terminology_draft',locale:run.input.locale,changes,focus_keys});
    return {prepared:true,saved:false,changes,focus_keys};
  }
}];
