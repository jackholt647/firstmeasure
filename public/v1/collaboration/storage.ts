import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { conflict, notFound } from "../platform/errors.js";

export type RecordValue = Record<string, any> & {id:string; revision:number};
let store:SqlStore|undefined;
export function collaborationStore() {
  return store ||= openSqlStore({id:"collaboration",filename:path.resolve(env.platformStorageRoot,"collaboration.sqlite"),schemaVersion:2,initialize:async db=>{
    await db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_records (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_org_id TEXT NOT NULL,
        recipient_org_id TEXT NOT NULL DEFAULT '', resource_key TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, revision INTEGER NOT NULL, value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS collaboration_outbound ON collaboration_records(owner_org_id,kind,status,id);
      CREATE INDEX IF NOT EXISTS collaboration_inbound ON collaboration_records(recipient_org_id,kind,status,id);
      CREATE INDEX IF NOT EXISTS collaboration_resource ON collaboration_records(resource_key,recipient_org_id,kind,status);
      CREATE INDEX IF NOT EXISTS collaboration_pending_kind ON collaboration_records(kind,status,revision,id);
      CREATE TABLE IF NOT EXISTS collaboration_tokens(token_hash TEXT PRIMARY KEY, invitation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_audit (
        id TEXT PRIMARY KEY, owner_org_id TEXT NOT NULL, recipient_org_id TEXT NOT NULL,
        resource_id TEXT NOT NULL, event_type TEXT NOT NULL, actor_json TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS collaboration_audit_owner ON collaboration_audit(owner_org_id,id);
      CREATE TABLE IF NOT EXISTS collaboration_outbox (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS collaboration_outbox_pending ON collaboration_outbox(delivered,id);
    `);
  }});
}
export const newId=(prefix:string)=>`${prefix}_${randomUUID().replaceAll("-","")}`;
export const now=()=>new Date().toISOString();
/** Sorted organization locks serialize policy changes with effects without a fleet-wide lock. */
export async function withOrganizationLocks<T>(orgs:string[],operation:()=>Promise<T>):Promise<T>{
  const ids=[...new Set(orgs.filter(Boolean))].sort();
  const next=(index:number):Promise<T>=>index===ids.length?operation():collaborationStore().transaction(()=>next(index+1),`organization:${ids[index]}`);
  return next(0);
}
export const resourceKey=(r:{owner_org_id:string;type:string;id:string;project_id?:string})=>[r.owner_org_id,r.type,r.project_id||"",r.id].join(":");
export async function getRecord(id:string,kind?:string):Promise<RecordValue> {
  const row=await collaborationStore().prepare("SELECT value_json,kind FROM collaboration_records WHERE id=?").get(id);
  if(!row || kind && row.kind!==kind)throw notFound("collaboration_unavailable","This item is unavailable.");
  return JSON.parse(String(row.value_json));
}
export async function findRecord(id:string,kind?:string):Promise<RecordValue|null>{
  try{return await getRecord(id,kind);}catch(e:any){if(e.code==="collaboration_unavailable")return null;throw e;}
}
export async function insertRecord(kind:string,value:RecordValue){
  await collaborationStore().prepare("INSERT INTO collaboration_records(id,kind,owner_org_id,recipient_org_id,resource_key,status,revision,value_json) VALUES(?,?,?,?,?,?,?,?)")
    .run(value.id,kind,value.owner_org_id,value.recipient_org_id||"",value.resource?resourceKey(value.resource):"",value.status||"active",value.revision,JSON.stringify(value));
  return value;
}
export async function updateRecord(current:RecordValue,patch:Record<string,unknown>,expected:number){
  if(current.revision!==expected)throw conflict("collaboration_revision_conflict","This item changed. Reload before saving.");
  const next:RecordValue={...current,...patch,id:current.id,revision:current.revision+1,updated_at:now()};
  const result=await collaborationStore().prepare("UPDATE collaboration_records SET recipient_org_id=?,status=?,revision=?,value_json=? WHERE id=? AND revision=?")
    .run(next.recipient_org_id||"",next.status||"active",next.revision,JSON.stringify(next),current.id,expected);
  if(result.changes!==1)throw conflict("collaboration_revision_conflict","This item changed. Reload before saving.");
  return next;
}
export async function listRecords(kind:string,orgId:string,direction:"inbound"|"outbound"|"both"="both",after="",limit=50){
  const where=direction==="both"?"(owner_org_id=? OR recipient_org_id=?)":`${direction==="inbound"?"recipient_org_id":"owner_org_id"}=?`;
  const params=direction==="both"?[orgId,orgId]:[orgId];
  const rows=await collaborationStore().prepare(`SELECT value_json FROM collaboration_records WHERE kind=? AND ${where} AND id>? ORDER BY id LIMIT ?`).all(kind,...params,after,limit+1);
  const items=rows.slice(0,limit).map(r=>JSON.parse(String(r.value_json)) as RecordValue);
  return {items,next_cursor:rows.length>limit?items.at(-1)!.id:null};
}
export async function listGrants(orgId:string,direction:"inbound"|"outbound",after="",limit=50,type="",other=""){
  const column=direction==="inbound"?"recipient_org_id":"owner_org_id",counterpart=direction==="inbound"?"owner_org_id":"recipient_org_id";
  const conditions=["kind='grant'",`${column}=?`,"id>?"],values:(string|number)[]=[orgId,after];
  if(type){conditions.push("resource_key LIKE ?");values.push(`%:${type}:%`);}
  if(other){conditions.push(`${counterpart}=?`);values.push(other);}
  const rows=await collaborationStore().prepare(`SELECT value_json FROM collaboration_records WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT ?`).all(...values,limit+1);
  const items=rows.slice(0,limit).map(row=>JSON.parse(String(row.value_json)) as RecordValue);
  return {items,next_cursor:rows.length>limit?items.at(-1)!.id:null};
}
export async function audit(value:RecordValue,event:string,actor:Record<string,unknown>,payload:Record<string,unknown>={}){
  const id=newId("audit");
  await collaborationStore().prepare("INSERT INTO collaboration_audit(id,owner_org_id,recipient_org_id,resource_id,event_type,actor_json,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id,value.owner_org_id,value.recipient_org_id||"",value.id,event,JSON.stringify(actor),JSON.stringify(payload),now());
  const privateEvent=event==="collaboration.relationship.updated"||event==="collaboration.privacy.changed"||event==="collaboration.invitation.created";
  for(const org of new Set([value.owner_org_id,...(privateEvent?[]:[value.recipient_org_id])].filter(Boolean))){
    await collaborationStore().prepare("INSERT INTO collaboration_outbox(id,organization_id,event_type,payload_json) VALUES(?,?,?,?)")
      .run(`${id}:${org}`,org,event,JSON.stringify({record_id:value.id,revision:value.revision,...payload}));
  }
}
export async function closeCollaborationStore(){await store?.close();store=undefined;}
