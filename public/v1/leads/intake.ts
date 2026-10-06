import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { createPlatformLead } from "../platform/api.js";
import { readDocument } from "../platform/storage.js";

export const importedLeadSchema = z.object({
  external_id:z.string().trim().min(1).max(500), source_id:z.string().trim().min(1).max(200),
  branch_id:z.string().trim().min(1).max(120).default("default"),
  source_kind:z.enum(["email_lead","connection_lead","publication"]).default("connection_lead"),
  connection_id:z.string().max(100).default(""), provider:z.string().max(160).default(""),
  address:z.string().max(2000).default(""), title:z.string().max(1000).default(""), summary:z.string().max(10000).default(""),
  contacts:z.array(z.object({name:z.string().max(300).default(""),email:z.string().max(500).default(""),phones:z.array(z.string().max(80)).max(10).default([]),phone:z.string().max(80).optional()}).strict()).max(30).default([]),
  provider_fields:z.record(z.unknown()).default({}), lead_source:z.record(z.unknown()).default({}),
  notification_target_role_ids:z.array(z.string().max(120)).max(50).optional(),
}).strict().refine(v=>!!v.address.trim()||v.contacts.some(c=>c.name.trim()||c.email.trim()||c.phone?.trim()||c.phones.length),"A lead needs a contact or address.");
export type ImportedLead = z.input<typeof importedLeadSchema>;
let database:SqlStore|undefined;
export function leadStore(){return database??=openSqlStore({id:"lead-intake",filename:path.resolve(env.platformStorageRoot,"lead-intake.sqlite"),initialize:async db=>{
  await db.exec(`CREATE TABLE IF NOT EXISTS lead_deliveries (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,source_id TEXT NOT NULL,connection_id TEXT NOT NULL,branch_id TEXT NOT NULL,external_id TEXT NOT NULL,state TEXT NOT NULL,project_id TEXT NOT NULL DEFAULT '',input_json TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS lead_deliveries_org ON lead_deliveries(organization_id,updated_at,id);
  CREATE INDEX IF NOT EXISTS lead_deliveries_connection ON lead_deliveries(organization_id,connection_id,updated_at);`);
}});}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identity(org:string,source:string,external:string){return `lead_delivery_${hash([org,source,external])}`;}
export async function leadDeliveries(org:string,options:{branchId?:string;connectionId?:string;after?:string;limit?:number}={}){
 const limit=Math.min(100,Math.max(1,options.limit||50));
 const [afterTime="",afterId=""]=(options.after||"").split("~");
 const rows=await leadStore().prepare("SELECT id,source_id,connection_id,branch_id,external_id,state,project_id,reason,attempts,created_at,updated_at FROM lead_deliveries WHERE organization_id=? AND (?='' OR branch_id=?) AND (?='' OR connection_id=?) AND (?='' OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(org,options.branchId||"",options.branchId||"",options.connectionId||"",options.connectionId||"",afterTime,afterTime,afterTime,afterId,limit+1);
 return {items:rows.slice(0,limit).map(row=>row.state==="processing"&&Date.now()-Date.parse(String(row.updated_at))>120000?{...row,state:"uncertain",reason:"Delivery stopped during lead creation. Review before resolving."}:row),next:rows.length>limit?`${rows[limit-1]!.created_at}~${rows[limit-1]!.id}`:null};
}
/** Receive first, then dispatch once. A crashed/uncertain dispatch needs explicit review, never an automatic replay. */
export async function importLead(org:string,raw:ImportedLead){
 const input=importedLeadSchema.parse(raw);if(Buffer.byteLength(JSON.stringify(input))>1_000_000)throw badRequest("lead_payload_size","Lead data is too large.");
 const key=identity(org,input.source_id,input.external_id),time=new Date().toISOString(),db=leadStore();
 const claimed=await db.transaction(async()=>{
  const old=await db.prepare("SELECT * FROM lead_deliveries WHERE id=? AND organization_id=?").get(key,org);
  if(old){
   if(old.state==="failed"||old.state==="rejected"){
    await db.prepare("UPDATE lead_deliveries SET state='processing',project_id=?,input_json=?,reason='',attempts=attempts+1,updated_at=? WHERE id=?").run(`project_lead_${hash([org,input.source_id,input.external_id]).slice(0,32)}`,JSON.stringify(input),time,key);
    return {old:undefined};
   }
   await db.prepare("UPDATE lead_deliveries SET attempts=attempts+1 WHERE id=?").run(key);
   if(old.state==="processing"&&Date.now()-Date.parse(String(old.updated_at))>120000){await db.prepare("UPDATE lead_deliveries SET state='uncertain',reason=?,updated_at=? WHERE id=?").run("Delivery stopped during lead creation. Review the project before resolving.",time,key);old.state="uncertain";}
   return {old};
  }
  await db.prepare("INSERT INTO lead_deliveries(id,organization_id,source_id,connection_id,branch_id,external_id,state,project_id,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'processing',?,?,?,?)").run(key,org,input.source_id,input.connection_id,input.branch_id,input.external_id,`project_lead_${hash([org,input.source_id,input.external_id]).slice(0,32)}`,JSON.stringify(input),time,time);
  return {old:undefined};
 },key);
 if(claimed.old){
  const old=claimed.old;
  if(old.state==="processing")throw conflict("lead_processing","This delivery is still being processed. Retry later.");
  const project=old.state==="imported"?await readDocument(org,"projects",String(old.project_id)):null;
  return {accepted:old.state==="imported",duplicate:true,delivery_id:key,state:String(old.state),project,contacts:project?.data?.contacts||[],notification:null};
 }
 const projectId=`project_lead_${hash([org,input.source_id,input.external_id]).slice(0,32)}`;
 try{
  const result=await createPlatformLead(org,{branch_id:input.branch_id,project_id:projectId,source_kind:input.source_kind,address:input.address,title:input.title||input.address||input.summary||"New lead",summary:input.summary,contacts:input.contacts,provider:input.provider,provider_fields:input.provider_fields,
   lead_source:{...input.lead_source,external_id:input.external_id,source_id:input.source_id,connection_id:input.connection_id},
   notification:{source:input.source_kind==="email_lead"?"email_lead_import":"connection_lead_import",...(input.notification_target_role_ids?{target_role_ids:input.notification_target_role_ids}:{}),context:{connection_id:input.connection_id,delivery_id:key}}});
  await db.prepare("UPDATE lead_deliveries SET state='imported',updated_at=? WHERE id=?").run(new Date().toISOString(),key);
  return {accepted:true,duplicate:false,delivery_id:key,state:"imported",...result};
 }catch(error){
  await db.prepare("UPDATE lead_deliveries SET state='uncertain',reason=?,updated_at=? WHERE id=?").run("Lead creation did not finish cleanly. Check the project and workflow before resolving; no automatic replay.",new Date().toISOString(),key);
  throw error;
 }
}
export async function recordLeadRejection(org:string,input:{source_id:string;external_id:string;connection_id?:string;branch_id?:string},reason:string,state="rejected"){
 const key=identity(org,input.source_id,input.external_id),time=new Date().toISOString();
 await leadStore().prepare("INSERT INTO lead_deliveries(id,organization_id,source_id,connection_id,branch_id,external_id,state,input_json,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=lead_deliveries.attempts+1").run(key,org,input.source_id,input.connection_id||"",input.branch_id||"default",input.external_id,state,"{}",reason.slice(0,1000),time,time);
 return {accepted:false,delivery_id:key,state,reason};
}
export async function reviewLeadDelivery(org:string,id:string,userId:string,raw:unknown){
 const input=z.object({decision:z.enum(["imported","dismissed"]),note:z.string().trim().min(1).max(1000)}).strict().parse(raw);
 return leadStore().transaction(async db=>{
  const row=await db.prepare("SELECT * FROM lead_deliveries WHERE organization_id=? AND id=?").get(org,id);
  if(!row)throw notFound("lead_delivery_missing","Delivery not found.");
  if(row.state!=="uncertain"&&!(row.state==="processing"&&Date.now()-Date.parse(String(row.updated_at))>120000))throw conflict("lead_delivery_review","Only uncertain deliveries can be reviewed.");
  if(input.decision==="imported")await readDocument(org,"projects",String(row.project_id));
  await db.prepare("UPDATE lead_deliveries SET state=?,reason=?,updated_at=? WHERE organization_id=? AND id=?").run(input.decision,`Reviewed by ${userId}: ${input.note}`,new Date().toISOString(),org,id);
  return {id,state:input.decision};
 },id);
}
