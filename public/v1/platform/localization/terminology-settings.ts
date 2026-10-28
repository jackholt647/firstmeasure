import {readBranchModule} from '../storage.js';
import {readWorkforceTerminology} from '../../workforce/storage.js';
import {terminologyContract} from './terminology-defaults.js';
import type {Terminology} from './core.js';
type Json=Record<string,any>;
const object=(value:unknown):Json=>value&&typeof value==='object'&&!Array.isArray(value)?value as Json:{};
async function optionalModule(orgId:string,branchId:string,id:string){
 try{return await readBranchModule(orgId,branchId,id);}catch(error:any){if(error.statusCode===404||error.code==='ENOENT')return null;throw error;}
}
/** One read-only projection for browsers, public portals and frozen documents.
 * Legacy work/workforce records are fallbacks; they are never rewritten on read.
 */
export async function readTerminologyMappings(orgId:string,branchId='default'):Promise<Terminology>{
 const [mapping,work,workforce,main]=await Promise.all([optionalModule(orgId,branchId,'variable_mappings'),optionalModule(orgId,branchId,'work_configuration'),readWorkforceTerminology(orgId),branchId==='default'?null:optionalModule(orgId,'default','variable_mappings')]);
 const data=object(mapping?.data),old=object(workforce);
 // What an organization calls a branch and a region is kept with the default branch and applies in every branch.
 const mainBranches=object(object(object(main?.data).labels).branches);
 const labels=Object.keys(mainBranches).length?{...object(data.labels),branches:{...mainBranches,...object(object(data.labels).branches)}}:object(data.labels);
 const workforceLabels={resource_group_singular:old.resource_group?.singular,resource_group_plural:old.resource_group?.plural,worker_singular:old.resource_group_member?.singular,worker_plural:old.resource_group_member?.plural,organization_connection_singular:old.organization_connection?.singular,organization_connection_plural:old.organization_connection?.plural,management_application:old.applications?.management,field_application:old.applications?.field};
 const merge=(namespace:string,legacy:Json)=>({...Object.fromEntries(Object.entries(legacy).filter(([,value])=>typeof value==='string')),...Object.fromEntries(Object.entries(object(labels[namespace])).filter(([key,value])=>value!==terminologyContract()[`${namespace}.${key}`]?.label))});
 return {labels:{...labels,work:merge('work',object(object(work?.data).terminology)),workforce:merge('workforce',workforceLabels)},localized_labels:object(data.localized_labels)};
}
