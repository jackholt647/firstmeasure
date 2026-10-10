import { registerDataProvider, readPublishedData, authorizeSourceSnapshot } from '../platform/publication/providers.js';
import { readBranchModule, readDocument, listDocuments } from '../platform/storage.js';
import { object } from '../custom_fields/contracts.js';
import { FIELD_OWNERS, type FieldEntity } from '../custom_fields/owners.js';
import { optional, readFieldRecord } from '../custom_fields/records.js';
import { bindFieldSource, inCalculationSession } from '../custom_fields/calculations.js';
import { configuredPriorityFields, BUILTIN_FIELDS } from './contracts.js';
import { contentHash } from '../platform/publication/validation.js';
import { forbidden } from '../platform/errors.js';
import type { AccessPolicy, PublicationContext, SourceRef } from '../platform/publication/contracts.js';

const access:AccessPolicy={scopes:['project'],permissions:['view_projects'],systemKinds:['work','module','agent'],authorize:async(ctx,target)=>{
  const project=await readDocument(ctx.organizationId,'projects',target.projectId!);
  if(target.id && target.id!==target.projectId)throw forbidden('priority_project_target','Project identity must match its target.');
  if(target.branchId && project.data.branch_id && target.branchId!==project.data.branch_id)throw forbidden('priority_branch_target','The project belongs to another branch.');
}};
const text=(v:unknown)=>String(v ?? '').trim();
const values=(v:unknown)=>Array.isArray(v)?v.map(object):[];
function selectedProposal(rows:Record<string,unknown>[]){return rows.find(p=>['signed','accepted','approved'].includes(text(p.status || p.state || object(p.delivery).status || p.delivery_status).toLowerCase())) || rows[0];}
export function projectSummaryDetails(p:Record<string,unknown>,proposals:Record<string,unknown>[]=[]){
  const projection=object(p.work_projection),instances=Array.isArray(projection.active_instances)?values(projection.active_instances):values(projection.instances).filter(i=>['active','pending'].includes(text(i.status)));
  const primary=instances.find(i=>i.kind==='pipeline') || instances[0],lifecycle=object(projection.lifecycle || p.lifecycle);
  const direct=object(p.scope_template || p.scope_set || p.scope),scopeId=text(p.scope_template_id || p.scope_set_id || direct.scope_template_id || direct.template_id || direct.id);
  let scope=text(p.scope_template_name || p.scope_set_name || (scopeId && (direct.name || direct.display_name)));
  if(!scope){const s=object(selectedProposal(proposals)?.scope),stack=values(s.root_items || s.children);while(stack.length){const i=stack.shift()!;if((i.scope_template_id || i.template_id) && (i.scope_template_name || i.template_name || i.display_name || i.name)){scope=text(i.scope_template_name || i.template_name || i.display_name || i.name);break;}stack.push(...values(i.children));}}
  const contact=values(p.contacts).find(c=>c.id===p.primary_contact_id) || values(p.contacts)[0] || {};
  return {scope_type:scope || null,stage:text(primary?.stage_title || primary?.title) || ({lost:'Lost',completed:'Completed',canceled:'Cancelled',cancelled:'Cancelled'} as Record<string,string>)[text(lifecycle.status).toLowerCase()] || null,
    project_type:text(p.project_type) || null,start_date:p.start_date || p.starts_at || p.scheduled_start || null,end_date:p.end_date || p.ends_at || p.scheduled_end || null,
    customer:text(contact.name || p.customer_name || p.primary_contact_name) || null,address:text(p.address) || null,owner:text(p.owner_name || p.project_owner_name || p.assigned_to_name || p.sales_rep_name) || null,
    created_date:p.created_at || null,updated_date:p.updated_at || null,project_number:text(p.project_number || p.job_number || p.number) || null};
}
export async function projectSummaryValue(p:Record<string,unknown>,proposals:Record<string,unknown>[]=[]){
  const financials=object(p.financials),money=object(p.money);
  const candidates=[p.project_total,p.project_total_amount,p.contract_total,p.contract_value,p.sale_total,p.sold_total,p.total_amount,p.total_price,financials.project_total,financials.contract_total,money.project_total,money.project_total_cents!=null?Number(money.project_total_cents)/100:null];
  const direct=candidates.find(v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0);
  if(direct!==undefined)return Number(direct);
  const proposal=selectedProposal(proposals),value=proposal?.total ?? proposal?.grand_total ?? proposal?.total_amount ?? proposal?.amount ?? (proposal?.total_cents!=null?Number(proposal.total_cents)/100:undefined);
  if(value!==undefined&&value!==null&&value!==''&&Number.isFinite(Number(value))&&Number(value)>=0)return Number(value);
  if(proposal && (Array.isArray(proposal.pages) || Array.isArray(object(proposal.scope).root_items)))return (await import('../proposals/storage.js')).proposalTotalCents({content:proposal})/100;
  return null;
}
async function projectState(ctx:PublicationContext,ref:SourceRef){
  const row=await readDocument(ctx.organizationId,'projects',ref.target.projectId!),p=object(row.data);
  const stored=(await listDocuments(ctx.organizationId,'proposals')).filter(r=>r.data.project_id===ref.target.projectId);
  const proposals=[...values(p.proposals),...stored.map(r=>({...object(r.data),id:r.id}))];
  return {row,p,proposals,revision:contentHash({project:row.revision,proposals:stored.map(r=>[r.id,r.revision])})};
}
async function configuration(ctx:PublicationContext,ref:SourceRef,entity:FieldEntity='project',contractOnly=false){
  const owner=entity==='project' && ref.target.scope==='project' || entity!=='project' && (!contractOnly || ref.target.id)
    ?await readFieldRecord(ctx,ref.target,entity):null;
  const branchId=owner?.branch || (FIELD_OWNERS[entity].shared?'default':text(ref.target.branchId || ctx.branchId || 'default'));
  const priorities=await optional(()=>readBranchModule(ctx.organizationId,branchId,'priority_fields'));
  const explicit=object(object(priorities?.data.entities))[entity];
  const legacy=entity==='project'?await optional(()=>readBranchModule(ctx.organizationId,branchId,'project_configuration')):null;
  const customModule=await optional(()=>readBranchModule(ctx.organizationId,branchId,'custom_fields'));
  const custom=values(customModule?.data.fields).filter(f=>(f.entity || 'project')===entity);
  return {entity,fields:configuredPriorityFields(explicit!==undefined?{priority_fields:explicit}:object(legacy?.data),custom,entity),revision:contentHash({priorities:priorities?.revision || 0,legacy:legacy?.revision || 0,custom:customModule?.revision || 0}),branchId};
}
function priorityExports(entity:FieldEntity){
  const scopes=entity==='project'?['project'] as const:entity==='contact'?['organization','project'] as const:['organization'] as const;
  const policy:AccessPolicy={scopes,permissions:[FIELD_OWNERS[entity].readPermission],systemKinds:['work','module','agent'],authorize:async(ctx,target)=>{await readFieldRecord(ctx,target,entity);}};
  const contractPolicy:AccessPolicy={...policy,scopes:entity==='project'?['organization','project']:scopes,authorize:async(ctx,target)=>{if(target.scope==='project' || target.id)await readFieldRecord(ctx,target,entity);}};
  return {
    contract:{description:`Ordered ${entity} priority-field references shared by all quick displays.`,schema:{type:'object',additionalProperties:true},schemaVersion:'1',access:contractPolicy,read:async(ctx:PublicationContext,ref:SourceRef)=>{const c=await configuration(ctx,ref,entity,true);return {value:c,revision:c.revision};}},
    values:{description:`Resolve the ${entity} priority list under current owner and source permissions. Calculations belong to declared fields.`,schema:{type:'object',additionalProperties:true},schemaVersion:'1',access:policy,
      authorizeSnapshot:async(ctx:PublicationContext,_ref:SourceRef,result:any)=>{for(const item of result.provenance.sources || [])await authorizeSourceSnapshot(ctx,item.source,item);},
      read:async(ctx:PublicationContext,ref:SourceRef)=>inCalculationSession(async()=>{
        const identity=`priority:${ctx.organizationId}:${entity}:${ref.target.scope}:${ref.target.projectId || ''}:${ref.target.id || ''}`;
        if(ctx.dependencyPath?.includes(identity))throw forbidden('priority_field_cycle','A priority field cannot depend on its own quick-display list.');
        const c=await configuration(ctx,ref,entity),sources=[];const items=[];
        const child={...ctx,...(ref.target.projectId?{projectId:ref.target.projectId}:{}),dependencyPath:[...(ctx.dependencyPath || []),identity]};
        for(const field of c.fields){const result=await readPublishedData(child,bindFieldSource(field.source,child,{...ref.target,branchId:c.branchId}));if(result.status==='ready')sources.push(result);items.push({...field,result});}
        return {value:{items,entity,branchId:c.branchId},revision:contentHash({config:c.revision,sources:sources.map(r=>r.source)}),provenance:{sources}};
      })}
  };
}
let registered=false;
export function registerPriorityFieldsPublication(){
  if(registered)return;registered=true;
  registerDataProvider({id:'project-summary',version:'1',apps:['projects'],exports:{
    details:{description:'Declared project quick-display fields. Scope type is the project scope-set name with a selected-proposal template fallback.',schema:{type:'object',properties:Object.fromEntries(Object.keys(BUILTIN_FIELDS).filter(k=>k!=='dollar_value').map(k=>[k,{type:['string','number','null']}])),additionalProperties:false},schemaVersion:'1',access,read:async(ctx,ref)=>{const s=await projectState(ctx,ref);return {value:projectSummaryDetails(s.p,s.proposals),revision:s.revision};}},
    value:{description:'Compatibility project value: explicit project total, then accepted or first proposal total and the domain pricing calculation over stored proposal content. Missing is null; zero is valid. New calculations should use declared custom fields.',schema:{type:'object',properties:{amount:{type:['number','null']}},required:['amount'],additionalProperties:false},schemaVersion:'1',units:{'/amount':'USD'},access:{...access,permissions:['view_financials'],capabilities:['platform.money']},read:async(ctx,ref)=>{const s=await projectState(ctx,ref);return {value:{amount:await projectSummaryValue(s.p,s.proposals)},revision:s.revision};}}
  }});
  const exports:Record<string,ReturnType<typeof priorityExports>['contract'] | ReturnType<typeof priorityExports>['values']>={...priorityExports('project')};
  for(const entity of Object.keys(FIELD_OWNERS) as FieldEntity[]){if(entity==='project')continue;const entries=priorityExports(entity);exports[`${entity}-contract`]=entries.contract;exports[`${entity}-values`]=entries.values;}
  registerDataProvider({id:'priority-fields',version:'1',apps:['projects','contacts','settings'],exports});
}
