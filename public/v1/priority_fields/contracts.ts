import { FIELD_OWNERS, type FieldEntity } from '../custom_fields/owners.js';
import { z } from 'zod';
import { badRequest } from '../platform/errors.js';
import { fieldSourceSchema } from '../custom_fields/calculations.js';
import type { SourceRef } from '../platform/publication/contracts.js';

export const priorityFieldSchema=z.object({id:z.string().min(1).max(120),label:z.string().min(1).max(160),source:fieldSourceSchema,
  format:z.enum(['text','number','currency','date','json']).default('text'),currency:z.string().regex(/^[A-Z]{3}$/).default('USD'),
  icon:z.string().regex(/^fa-[a-z0-9-]+$/).default('fa-tag'),empty:z.enum(['hide','show']).default('hide')}).strict();
export type PriorityField=z.infer<typeof priorityFieldSchema>;
export const BUILTIN_FIELDS:Record<string,{label:string;format?:PriorityField['format'];icon?:string}>={
  scope_type:{label:'Scope type',icon:'fa-layer-group'},stage:{label:'Stage',icon:'fa-circle-dot'},dollar_value:{label:'Value',format:'currency'},
  start_date:{label:'Start date',format:'date'},end_date:{label:'End date',format:'date'},customer:{label:'Customer',icon:'fa-user'},address:{label:'Address',icon:'fa-location-dot'},
  owner:{label:'Project owner',icon:'fa-user-tie'},project_type:{label:'Property type',icon:'fa-house'},created_date:{label:'Created date',format:'date'},updated_date:{label:'Last updated',format:'date'},project_number:{label:'Project number',icon:'fa-hashtag'}
};
export function builtinPriorityField(id:string):PriorityField {
  const meta=BUILTIN_FIELDS[id];if(!meta)throw badRequest('priority_field_unknown','Unknown compatibility field.');
  return priorityFieldSchema.parse({id,label:meta.label,format:meta.format || 'text',icon:meta.icon || 'fa-tag',source:{provider:'project-summary',export:id==='dollar_value'?'value':'details',target:{scope:'project',organizationId:'$organization',projectId:'$project'},path:id==='dollar_value'?'/amount':`/${id}`}});
}
export function customPriorityField(field:Record<string,any>,entity:FieldEntity = field.entity || "project"):PriorityField {
  const path=String(field.path || field.key);
  return priorityFieldSchema.parse({id:`custom_field:${path}`,label:field.ui?.project_tag_label || field.label || path,format:field.type==='currency'?'currency':['number','integer','formula','slider','percentage'].includes(field.type)?'number':['date','datetime'].includes(field.type)?'date':'text',currency:field.currency || 'USD',icon:field.ui?.project_tag_icon || field.ui?.icon || 'fa-tag',empty:field.ui?.project_tag_empty_behavior || field.ui?.empty_behavior || 'hide',source:{provider:`custom-fields-${entity}`,export:'values',target:entity==='project'?{scope:'project',organizationId:'$organization',projectId:'$project'}:{scope:'organization',organizationId:'$organization',id:'$record'},args:{field:path},path:'/'+path.split('.').map(v=>v.replace(/~/g,'~0').replace(/\//g,'~1')).join('/')}});
}
export function normalizePriorityFields(input:unknown):PriorityField[] {
  const parsed=z.array(priorityFieldSchema).max(32).safeParse(input);
  if(!parsed.success)throw badRequest('priority_fields_invalid','Priority fields must be an ordered list of up to 32 singular published field references.');
  if(new Set(parsed.data.map(f=>f.id)).size!==parsed.data.length)throw badRequest('priority_fields_duplicate','Each priority field needs a unique identity.');
  return parsed.data;
}
export function configuredPriorityFields(config:Record<string,any>,custom:Record<string,any>[]=[],entity:FieldEntity="project"):PriorityField[] {
  if(config.priority_fields!==undefined)return normalizePriorityFields(config.priority_fields);
  if(entity!=="project")return [];
  const legacy=Array.isArray(config.project_header_pills)?config.project_header_pills:['scope_type','stage','dollar_value'];
  const ids=[...new Set([...legacy,...custom.filter(f=>f.ui?.project_tag===true || f.ui?.visible_tag===true).map(f=>`custom_field:${f.path || f.key}`),'project_type'])];
  return ids.flatMap(id=>{
    if(BUILTIN_FIELDS[id])return [builtinPriorityField(id)];
    const f=custom.find(f=>`custom_field:${f.path || f.key}`===id);return f?[customPriorityField(f)]:[];
  }).slice(0,32);
}
export function isCompatibilityField(field:PriorityField,id:string){const ref:SourceRef=builtinPriorityField(id).source;return field.source.provider===ref.provider && field.source.export===ref.export && field.source.path===ref.path;}

/** One namespace, independent ordered lists; project_configuration remains a compatibility fallback. */
export function normalizePriorityConfiguration(input:unknown,branchId='default') {
  const parsed=z.object({entities:z.record(z.array(priorityFieldSchema).max(32)).default({})}).strict().safeParse(input);
  if(!parsed.success)throw badRequest('priority_configuration_invalid','Choose a supported field owner and ordered priority list.');
  for(const [entity,fields] of Object.entries(parsed.data.entities)){
    if(!Object.hasOwn(FIELD_OWNERS,entity))throw badRequest('priority_owner_invalid','Unknown priority field owner.');
    if(branchId!=='default' && FIELD_OWNERS[entity as FieldEntity].shared)throw badRequest('priority_owner_branch','Shared owner priorities belong to the default branch.');
    parsed.data.entities[entity]=normalizePriorityFields(fields);
  }
  return parsed.data;
}
