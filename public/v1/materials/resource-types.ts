import { z } from 'zod';
import { hasPermission, type PlatformAuthContext } from '../platform/auth.js';
import { isAppFlagEnabled } from '../platform/app_flags.js';
import { forbidden, badRequest, conflict } from '../platform/errors.js';
import { listDocuments, upsertDocument, type JsonObject } from '../platform/storage.js';
export const RESOURCE_TYPE_COLLECTION='material_resource_types';
export const resourceTypeIdSchema=z.string().trim().regex(/^[a-z][a-z0-9_-]{0,79}$/);
export const resourceTypeInputSchema=z.object({id:resourceTypeIdSchema,name:z.string().trim().max(100),icon:z.string().regex(/^fa-[a-z0-9-]{1,76}$/),color:z.string().regex(/^#[0-9a-fA-F]{6}$/),expected_revision:z.number().int().nonnegative().optional()}).strict();
export const resourceTypeArchiveSchema=z.object({id:resourceTypeIdSchema,expected_revision:z.number().int().nonnegative().optional()}).strict();
export const defaultResourceTypes=[{id:'material',name:'Materials',icon:'fa-boxes-stacked',color:'#d93025',revision:0},{id:'labor',name:'Labor',icon:'fa-helmet-safety',color:'#2563eb',revision:0},{id:'equipment',name:'Equipment',icon:'fa-truck-pickup',color:'#0f766e',revision:0}];
export async function listResourceTypes(orgId:string){
 if(!await isAppFlagEnabled(orgId,'platform','materials'))throw forbidden('app_flag_disabled','Materials are not enabled for this organization.');
 const documents=(await listDocuments(orgId,RESOURCE_TYPE_COLLECTION)).filter(doc=>!doc.data.archived_at),rows=documents.map(doc=>resourceTypeRow({...doc.data,id:doc.id,revision:doc.revision}));
 return [...defaultResourceTypes.map(row=>rows.find(item=>item.id===row.id)||{...row}),...rows.filter(row=>!defaultResourceTypes.some(item=>item.id===row.id))];
}
export async function requireResourceType(orgId:string,value:unknown){const id=resourceTypeIdSchema.parse(value||'material');if(!(await listResourceTypes(orgId)).some(row=>row.id===id))throw badRequest('resource_type_unknown','Choose a registered resource type.');return id;}
export async function saveResourceType(orgId:string,input:unknown,auth:PlatformAuthContext,create=false){
 if(!auth||auth.orgId!==orgId||!hasPermission(auth,'manage_projects'))throw forbidden('resource_type_write_denied','Resource type editing requires project management access.');
 const known=await listResourceTypes(orgId);const {id,expected_revision,...data}=resourceTypeInputSchema.parse(input);if(!create&&!known.some(row=>row.id===id))throw badRequest('resource_type_unknown','This resource type is unavailable.');
 const doc=await upsertDocument(orgId,RESOURCE_TYPE_COLLECTION,{id,expected_revision,data:{...data,updated_by_user_id:auth.userId},metadata:{kind:'material_resource_type'}},{replace:true,createOnly:create||expected_revision===0});
 return resourceTypeRow({...doc.data,id:doc.id,revision:doc.revision});
}
// Removal retires the record instead of deleting it, so its id is never reused by a different column.
export async function archiveResourceType(orgId:string,input:unknown,auth:PlatformAuthContext){
 if(!auth||auth.orgId!==orgId||!hasPermission(auth,'manage_projects'))throw forbidden('resource_type_write_denied','Resource type editing requires project management access.');
 const {id,expected_revision}=resourceTypeArchiveSchema.parse(input);
 if(defaultResourceTypes.some(row=>row.id===id))throw badRequest('resource_type_builtin','Materials, Labor and Equipment cannot be removed.');
 const current=(await listResourceTypes(orgId)).find(row=>row.id===id);if(!current)throw badRequest('resource_type_unknown','This resource type is unavailable.');
 const lists=(await listDocuments(orgId,'material_lists')).filter(doc=>String(doc.data.resource_type||'material')===id&&String(doc.data.status||'').toLowerCase()!=='archived');
 if(lists.length){const projects=new Set(lists.map(doc=>String(doc.data.project_id||'')));throw conflict('resource_type_in_use',`Delete the ${lists.length} ${lists.length===1?'list':'lists'} of this type (in ${projects.size} ${projects.size===1?'project':'projects'}) before removing it.`,{list_count:lists.length,project_count:projects.size});}
 const doc=await upsertDocument(orgId,RESOURCE_TYPE_COLLECTION,{id,expected_revision:expected_revision??current.revision,data:{name:current.name,icon:current.icon,color:current.color,archived_at:new Date().toISOString(),archived_by_user_id:auth.userId,updated_by_user_id:auth.userId},metadata:{kind:'material_resource_type'}},{replace:true});
 return {id:doc.id,archived:true,revision:Number(doc.revision||0)};
}
export function resourceTypeRow(input:JsonObject){return {id:String(input.id),name:String(input.name||''),icon:String(input.icon||'fa-layer-group'),color:String(input.color||'#64748b'),revision:Number(input.revision||0)};}
