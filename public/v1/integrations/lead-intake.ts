import { z } from "zod";
import { backgroundAuthContext, hasPermission, requireCapability, type PlatformAuthContext } from "../platform/auth.js";
import { importedLeadSchema, importLead, recordLeadRejection } from "../leads/intake.js";
import { runModuleCode } from "../documents/modules/runtime.js";
import { runPlatformTask } from "../platform/worker_tasks.js";
import { connection, definition } from "./service.js";
import { db, read, save } from "./storage.js";
import { at, object, type Connector, type Obj } from "./contracts.js";
import { badRequest, forbidden } from "../platform/errors.js";

export async function authorizeLeadImport(ctx:PlatformAuthContext,branch:string){
 ctx=await backgroundAuthContext(ctx.orgId,ctx.userId);
 if(!hasPermission(ctx,"manage_projects"))throw forbidden("lead_permission","Project management permission is required for lead import.");await requireCapability(ctx,"platform.lead_import");
 if(ctx.branchId&&ctx.branchId!==branch)throw badRequest("lead_branch","Lead import must use the authorized branch.");
}
export async function mapConnectionLead(d:Connector,record:Obj){
 const config=d.leadImport;if(!config)throw badRequest("lead_mapping","Configure lead intake first.");
 const result=await runModuleCode({source:config.code,inputs:{record},state:{},mode:"evaluate",now:new Date().toISOString()},{read:async()=>{throw new Error("No bindings in lead mapping.");},invoke:async()=>{throw new Error("No actions in lead mapping.");}});
 if(result.outputs.skip===true)return {skip:true as const,reason:String(result.outputs.reason||"Filtered by lead mapping.").slice(0,1000)};
 const lead=object(result.outputs.lead),external=String(at(record,config.externalIdPath)??lead.external_id??"");
 return {skip:false as const,lead:importedLeadSchema.parse({...lead,external_id:external,source_id:"preview",branch_id:config.branchId,source_kind:"connection_lead",provider:config.provider||d.name,notification_target_role_ids:config.notificationRoleIds})};
}
export async function receiveConnectionLead(ctx:PlatformAuthContext,key:string,d:Connector,record:Obj,deliveryId:string){
 const config=d.leadImport!;await authorizeLeadImport(ctx,config.branchId);
 const source=`connection:${key}:${config.mode==="resource"?config.resource:"webhook"}`;
 try{
  const mapped=await mapConnectionLead(d,record);
  if(mapped.skip)return recordLeadRejection(ctx.orgId,{source_id:source,external_id:deliveryId,branch_id:config.branchId,connection_id:key},mapped.reason);
  return await importLead(ctx.orgId,{...mapped.lead,source_id:source,connection_id:key,lead_source:{...mapped.lead.lead_source,connector_version:await (await connection(ctx,key)).activeVersion}});
 }catch(error){
  // Mapping failures occur before dispatch; the receipt for a dispatched lead is owned by importLead.
  if(error instanceof z.ZodError || (error as any)?.code==="module_execution_failed")await recordLeadRejection(ctx.orgId,{source_id:source,external_id:deliveryId,branch_id:config.branchId,connection_id:key},"Mapping failed. Review the sample and mapping before the provider redelivers.","failed");
  throw error;
 }
}
/** Work from complete immutable snapshots. Cursor commits only after each intake outcome is durable. */
export async function importConnectionResourceLeads(org:string,key:string){
 return runPlatformTask(`connection-leads:${org}:${key}`,0,async()=>{
  const c=await read(org,"connection",key);if(!c?.enabled)return;
  const ctx=await backgroundAuthContext(org,c.owner),d=await definition(org,c),config=d.leadImport;
  if(config?.mode!=="resource")return;
  await authorizeLeadImport(ctx,config.branchId);await connection(ctx,key);
  const head=await read(org,"resource",`${key}:${config.resource}`);if(!head||head.version!==c.activeVersion)return;
  const cursor=await read(org,"lead-cursor",key),after=cursor?.generation===head.generation?String(cursor?.after||""):"";
  const rows=await db().prepare("SELECT record_id,value_json FROM integration_rows WHERE organization_id=? AND connection_id=? AND resource=? AND generation=? AND record_id>? ORDER BY record_id LIMIT 50").all(org,key,config.resource!,head.generation,after);
  for(const row of rows){
   try{await receiveConnectionLead(ctx,key,d,JSON.parse(String(row.value_json)),String(row.record_id));}
   catch(error){if((error as any)?.code==="lead_processing")return;await recordLeadRejection(org,{source_id:`connection:${key}:${config.resource}`,external_id:String(row.record_id),branch_id:config.branchId,connection_id:key},"Lead mapping or intake failed. Check access, configuration and delivery history.","failed");}
   await save(org,"lead-cursor",key,{generation:head.generation,after:String(row.record_id)});
  }
 });
}
