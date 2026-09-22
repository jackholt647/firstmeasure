import { createHash, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStore } from "../../platform/sql_store.js";
import { getCommunicationsDatabase } from "../../messaging/communications_storage.js";
import { conflict, notFound } from "../../platform/errors.js";

export type Json = Record<string, unknown>;
export const text = (value: unknown) => String(value ?? "").trim();
export const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
export const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
export const now = () => new Date().toISOString();
export const id = (prefix: string, key: string = randomUUID()) => `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
export const terminal = new Set(["ended", "canceled", "failed", "busy", "no_answer", "rejected"]);
function parse(value: unknown): Json { try { return object(JSON.parse(text(value) || "{}")); } catch { return {}; } }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export interface CustomerCall extends Json {
  id: string; organization_id: string; branch_id: string; project_id: string; contact_id: string;
  owner_user_id: string; mode: string; direction: string; state: string; wrap_up_state: string;
  customer_number: string; business_number: string; customer_name: string; entry_id: string;
  created_at: string; updated_at: string; connected_at: string; ended_at: string; revision: number;
  notes: string; result: Json; metadata: Json;
}
export function database(): SqlStore { return getCommunicationsDatabase(); }
export async function initializeCustomerCallsSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS customer_calls (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, branch_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '', contact_id TEXT NOT NULL DEFAULT '', owner_user_id TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL, wrap_up_state TEXT NOT NULL DEFAULT 'draft',
      customer_number TEXT NOT NULL DEFAULT '', business_number TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '',
      entry_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      connected_at TEXT NOT NULL DEFAULT '', ended_at TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
      notes TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL DEFAULT '{}', metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS customer_calls_history ON customer_calls(organization_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS customer_calls_project ON customer_calls(organization_id,project_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS customer_calls_contact ON customer_calls(organization_id,contact_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS customer_calls_entry ON customer_calls(organization_id,entry_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS customer_calls_active ON customer_calls(organization_id,state,owner_user_id);
    CREATE TABLE IF NOT EXISTS customer_call_legs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, call_id TEXT NOT NULL REFERENCES customer_calls(id),
      role TEXT NOT NULL, control_id TEXT UNIQUE, provider_leg_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL, event_at TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS customer_call_legs_call ON customer_call_legs(organization_id,call_id);
    CREATE TABLE IF NOT EXISTS customer_call_events (
      sequence ${db.isPostgres ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"}, id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL,
      call_id TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS customer_call_events_org ON customer_call_events(organization_id,sequence);
    CREATE TABLE IF NOT EXISTS customer_call_operations (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, call_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
      response_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(organization_id,kind,id)
    );
    CREATE TABLE IF NOT EXISTS customer_call_jobs (
      id TEXT PRIMARY KEY, job_sequence ${db.isPostgres ? "BIGSERIAL UNIQUE" : "INTEGER"}, organization_id TEXT NOT NULL, call_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL, lease_owner TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '', response_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_call_jobs_pending ON customer_call_jobs(state,available_at,lease_until);
    CREATE TABLE IF NOT EXISTS customer_voice_webhooks (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, body_json TEXT NOT NULL,
      received_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS customer_voice_webhooks_pending ON customer_voice_webhooks(state,lease_until);
    CREATE TABLE IF NOT EXISTS customer_voice_resources (
      organization_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, data_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id,kind,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS customer_voice_provider_resource ON customer_voice_resources(kind,provider_id) WHERE provider_id<>'';
    CREATE TABLE IF NOT EXISTS customer_call_claims (
      organization_id TEXT NOT NULL, resource TEXT NOT NULL, owner_user_id TEXT NOT NULL, call_id TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL, PRIMARY KEY(organization_id,resource)
    );
    CREATE TABLE IF NOT EXISTS customer_call_scripts (
      organization_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, author_id TEXT NOT NULL,
      PRIMARY KEY(organization_id,id,version)
    );
    CREATE TABLE IF NOT EXISTS customer_call_artifacts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, call_id TEXT NOT NULL REFERENCES customer_calls(id),
      kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      data_json TEXT NOT NULL, UNIQUE(organization_id,call_id,kind,id)
    );
    CREATE TABLE IF NOT EXISTS customer_communication_workflow (
      organization_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, owner_user_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', snoozed_until TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL, PRIMARY KEY(organization_id,kind,source_id)
    );
    CREATE TABLE IF NOT EXISTS customer_communication_read_markers (
      organization_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, read_at TEXT NOT NULL,
      PRIMARY KEY(organization_id,user_id,kind,source_id)
    );
  `));
}

export async function transaction<T>(fn: (db: SqlStore) => T | Promise<T>): Promise<T> {
  return (await database().transaction(fn));
}
function callRow(row: unknown): CustomerCall | null {
  if (!row) return null;
  const {result_json,metadata_json,...data} = object(row);
  return {...data, result:parse(result_json), metadata:parse(metadata_json)} as CustomerCall;
}
export async function readCall(orgId: string, callId: string) {
  const call = callRow((await database().prepare("SELECT * FROM customer_calls WHERE organization_id=? AND id=?").get(orgId,callId)));
  if (!call) throw notFound("call_not_found", "This call is unavailable.");
  return call;
}
export async function insertCall(input: Partial<CustomerCall> & Pick<CustomerCall,"id"|"organization_id"|"branch_id"|"mode"|"direction">) {
  return (await database().transaction(async () => {
  const at=now();
  (await database().prepare(`INSERT INTO customer_calls (id,organization_id,branch_id,project_id,contact_id,owner_user_id,mode,direction,state,
    customer_number,business_number,customer_name,entry_id,created_at,updated_at,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.organization_id,input.branch_id,text(input.project_id),text(input.contact_id),
    text(input.owner_user_id),input.mode,input.direction,input.state||"created",text(input.customer_number),text(input.business_number),
    text(input.customer_name),text(input.entry_id),input.created_at||at,at,JSON.stringify(input.metadata||{})));
  return (await readCall(input.organization_id,input.id));

  }));
}
const patchColumns = new Set(["state","wrap_up_state","project_id","contact_id","owner_user_id","notes","connected_at","ended_at","customer_name","business_number"]);
export async function patchCall(orgId: string, callId: string, patch: Json, revision?: number) {
  return (await database().transaction(async () => {
  const values: SQLInputValue[]=[]; const fields:string[]=[];
  for (const [key,value] of Object.entries(patch)) {
    if (patchColumns.has(key)) { fields.push(`${key}=?`);values.push(text(value)); }
    if (key==="result"||key==="metadata") { fields.push(`${key}_json=?`); values.push(JSON.stringify(value)); }
  }
  fields.push("updated_at=?","revision=revision+1"); values.push(now(),orgId,callId);
  let where="organization_id=? AND id=?";
  if(revision!==undefined){where+=" AND revision=?";values.push(revision);}
  const changed=(await database().prepare(`UPDATE customer_calls SET ${fields.join(",")} WHERE ${where}`).run(...values));
  if(!changed.changes) { (await readCall(orgId,callId));throw conflict("call_revision_conflict","This call changed. Refresh before saving."); }
  return (await readCall(orgId,callId));

  }));
}
export async function listCalls(orgId: string, filter: Json = {}) {
  const values:SQLInputValue[]=[orgId]; const clauses=["organization_id=?"];
  if(filter.include_diagnostics!==true)clauses.push("mode<>'diagnostic'");
  for(const key of ["project_id","contact_id","owner_user_id","direction","entry_id","mode","wrap_up_state"]) if(text(filter[key])){clauses.push(`${key}=?`);values.push(text(filter[key]));}
  if(text(filter.branch_id)){clauses.push("branch_id=?");values.push(text(filter.branch_id));}
  if(filter.active===true)clauses.push("state NOT IN ('ended','canceled','failed','busy','no_answer','rejected') AND mode<>'external'");
  if(text(filter.query)){clauses.push("(customer_name LIKE ? ESCAPE '\\' OR customer_number LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");const q=`%${text(filter.query).replace(/[\\%_]/g,"\\$&")}%`;values.push(q,q,q);}
  const count=Number(object((await database().prepare(`SELECT count(*) AS total FROM customer_calls WHERE ${clauses.join(" AND ")}`).get(...values))).total);
  if(text(filter.before||filter.cursor)){const cursor=parse(Buffer.from(text(filter.before||filter.cursor),"base64url").toString());if(text(cursor.at)&&text(cursor.id)){clauses.push("(created_at<? OR (created_at=? AND id<?))");values.push(text(cursor.at),text(cursor.at),text(cursor.id));}}
  const limit=Math.max(1,Math.min(200,Number(filter.limit)||50));
  const rows=(await database().prepare(`SELECT * FROM customer_calls WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values,limit+1)).map(callRow) as CustomerCall[];
  const more=rows.length>limit;const calls=rows.slice(0,limit);const last=calls.at(-1);
  return {calls,total:count,next_cursor:more&&last?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString("base64url"):null};
}
export async function appendEvent(orgId:string,callId:string,type:string,data:Json={},key:string=randomUUID()) {
  return (await database().transaction(async () => {
  (await database().prepare("INSERT INTO customer_call_events(id,organization_id,call_id,type,created_at,data_json) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .run(id("ce",`${orgId}:${key}`),orgId,callId,type,now(),JSON.stringify(data)));

  }));
}
export async function callEvents(orgId:string,callId:string) {
  return (await database().prepare("SELECT * FROM customer_call_events WHERE organization_id=? AND call_id=? ORDER BY sequence").all(orgId,callId)).map(row=>({...object(row),data:parse(object(row).data_json),data_json:undefined}));
}
export async function resource(orgId:string,kind:string,key="default"): Promise<(Json & {id:string;provider_id:string;revision:number;updated_at:string}) | null> {
  const row=object((await database().prepare("SELECT * FROM customer_voice_resources WHERE organization_id=? AND kind=? AND id=?").get(orgId,kind,key)));
  return Object.keys(row).length?{...parse(row.data_json),id:text(row.id),provider_id:text(row.provider_id),revision:Number(row.revision),updated_at:text(row.updated_at)}:null;
}
export async function resources(orgId:string,kind:string) {
  return (await Promise.all((await database().prepare("SELECT id FROM customer_voice_resources WHERE organization_id=? AND kind=?").all(orgId,kind)).map(async row=>(await resource(orgId,kind,text(object(row).id)))!)));
}
export async function saveResource(orgId:string,kind:string,key:string,data:Json,providerId="",revision?:number) {
  return (await database().transaction(async () => {
  const current=(await resource(orgId,kind,key));
  if(revision!==undefined&&Number(current?.revision||0)!==revision)throw conflict("settings_revision_conflict","These settings changed. Refresh and try again.");
  (await database().prepare(`INSERT INTO customer_voice_resources(organization_id,kind,id,provider_id,data_json,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(organization_id,kind,id) DO UPDATE SET provider_id=excluded.provider_id,data_json=excluded.data_json,updated_at=excluded.updated_at,revision=customer_voice_resources.revision+1`)
    .run(orgId,kind,key,providerId||text(current?.provider_id),JSON.stringify(data),now()));
  return (await resource(orgId,kind,key))!;

  }));
}
export async function resourceByProvider(kind:string,providerId:string): Promise<(Json & {organization_id:string;id:string;provider_id:string}) | null> {
  const row=object((await database().prepare("SELECT * FROM customer_voice_resources WHERE kind=? AND provider_id=?").get(kind,providerId)));
  return Object.keys(row).length?{organization_id:text(row.organization_id),...parse(row.data_json),id:text(row.id),provider_id:text(row.provider_id)}:null;
}
export async function existingOperation(orgId:string,kind:string,key:string,callId:string,payload:Json) {
  const operationId=id("cop",`${orgId}:${kind}:${key}`);const hash=digest(payload);
  const existing=object((await database().prepare("SELECT * FROM customer_call_operations WHERE id=? AND organization_id=?").get(operationId,orgId)));
  if(Object.keys(existing).length){if(existing.payload_hash!==hash||text(existing.call_id)!==callId)throw conflict("idempotency_conflict","This operation ID was already used with different input.");return {id:operationId,existing:true,state:text(existing.state),response:parse(existing.response_json)};}
  return null;
}
export async function operation(orgId:string,kind:string,key:string,callId:string,payload:Json) {
  return (await database().transaction(async () => {
  const prior=(await existingOperation(orgId,kind,key,callId,payload));if(prior)return prior;
  const operationId=id("cop",`${orgId}:${kind}:${key}`);const hash=digest(payload);
  (await database().prepare("INSERT INTO customer_call_operations(id,organization_id,call_id,kind,payload_hash,payload_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'accepted',?,?)")
    .run(operationId,orgId,callId,kind,hash,JSON.stringify(payload.action==='dtmf'?{...payload,digits:'[redacted]'}:payload),now(),now()));
  return {id:operationId,existing:false,state:"accepted",response:{}};

  }));
}
export async function finishOperation(orgId:string,operationId:string,response:Json,state="completed") {
  (await database().prepare("UPDATE customer_call_operations SET state=?,response_json=?,updated_at=? WHERE id=? AND organization_id=?").run(state,JSON.stringify(response),now(),operationId,orgId));
}
export async function enqueue(orgId:string,callId:string,kind:string,payload:Json,key:string,delayMs=0) {
  return (await database().transaction(async () => {
  const jobId=id("cj",`${orgId}:${key}`);
  (await database().prepare("INSERT INTO customer_call_jobs(id,organization_id,call_id,kind,payload_json,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .run(jobId,orgId,callId,kind,JSON.stringify(payload),new Date(Date.now()+delayMs).toISOString(),now(),now()));
  return jobId;

  }));
}
export async function claimJob(worker:string,lane:'all'|'voice'|'background'='all',callId=''): Promise<(Json & {payload:Json;attempts:number}) | null> {
  return (await transaction(async db=>{
    // A timed-out provider POST may already have succeeded. Never replay it automatically after a worker crash.
    (await db.prepare("UPDATE customer_call_jobs SET state='uncertain',error='Worker stopped while provider command was in flight',updated_at=? WHERE state='running' AND kind='provider' AND lease_until<?").run(now(),now()));
    const row=object((await db.prepare(`SELECT j.* FROM customer_call_jobs j WHERE
      (j.state='pending' OR (j.state='running' AND j.kind<>'provider' AND j.lease_until<?)) AND j.available_at<=?
      ${lane==='voice'?"AND j.kind IN ('provider','provider_reject')":lane==='background'?"AND j.kind NOT IN ('provider','provider_reject')":''}
      AND (j.kind<>'provider' OR ${db.isPostgres ? "j.payload_json::jsonb->>'path'" : "json_extract(j.payload_json,'$.path')"}='hangup' OR NOT EXISTS
        (SELECT 1 FROM customer_call_jobs u WHERE u.organization_id=j.organization_id AND u.call_id=j.call_id AND u.kind='provider' AND u.state='uncertain'))
      AND NOT EXISTS (SELECT 1 FROM customer_call_jobs other WHERE other.organization_id=j.organization_id
        AND other.call_id=j.call_id AND other.id<>j.id AND other.state='running' AND other.lease_until>?)
      AND (?='' OR j.call_id=?) ORDER BY j.created_at,j.${db.isPostgres ? "job_sequence" : "rowid"} LIMIT 1`).get(now(),now(),now(),callId,callId)));
    if(!row.id)return null;
    (await db.prepare("UPDATE customer_call_jobs SET state='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?")
      .run(worker,new Date(Date.now()+90_000).toISOString(),now(),text(row.id)));
    return {...row,payload:parse(row.payload_json),attempts:Number(row.attempts)+1};
  }));
}
export async function finishJob(jobId:string,worker:string,state:string,response:Json={},error="",retryMs=0) {
  return (await database().transaction(async () => {
  const updated = (await database().prepare("UPDATE customer_call_jobs SET state=?,response_json=?,error=?,available_at=?,lease_owner='',lease_until='',updated_at=? WHERE id=? AND lease_owner=? AND state='running' AND lease_until>?")
    .run(state,JSON.stringify(response),error.slice(0,1000),new Date(Date.now()+retryMs).toISOString(),now(),jobId,worker,now()));
  if (!updated.changes) return false;
  if(state==='completed')(await database().prepare("UPDATE customer_call_jobs SET payload_json=json_remove(payload_json,'$.payload.digits') WHERE id=? AND json_extract(payload_json,'$.path')='send_dtmf'", "UPDATE customer_call_jobs SET payload_json=(payload_json::jsonb #- '{payload,digits}')::text WHERE id=? AND payload_json::jsonb->>'path'='send_dtmf'").run(jobId));
  return true;

  }));
}
export async function jobs(orgId:string,callId:string) {
  return (await database().prepare("SELECT id,kind,state,attempts,error,created_at,updated_at FROM customer_call_jobs WHERE organization_id=? AND call_id=? ORDER BY created_at").all(orgId,callId)).map(object);
}
export async function claimResource(orgId:string,key:string,userId:string,callId="",ttl=90_000) {
  return (await database().transaction(async () => {
  const db=database();const current=object((await db.prepare("SELECT * FROM customer_call_claims WHERE organization_id=? AND resource=?").get(orgId,key)));
  if(current.owner_user_id&&current.owner_user_id!==userId&&text(current.expires_at)>now())throw conflict("call_claimed","Someone else is already working this call.");
  if(current.call_id&&current.call_id!==callId){const active=(await readCall(orgId,text(current.call_id)));if(!terminal.has(active.state)&&(active.mode!=="external"||text(current.expires_at)>now()))throw conflict("call_in_progress","A call is already in progress for this contact.");}
  (await db.prepare("INSERT INTO customer_call_claims(organization_id,resource,owner_user_id,call_id,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(organization_id,resource) DO UPDATE SET owner_user_id=excluded.owner_user_id,call_id=excluded.call_id,expires_at=excluded.expires_at")
    .run(orgId,key,userId,callId,new Date(Date.now()+ttl).toISOString()));

  }));
}
export async function releaseClaims(orgId:string,callId:string) { (await database().prepare("DELETE FROM customer_call_claims WHERE organization_id=? AND call_id=?").run(orgId,callId)); }
export async function legs(orgId:string,callId:string): Promise<Json[]> {
  return (await database().prepare("SELECT * FROM customer_call_legs WHERE organization_id=? AND call_id=?").all(orgId,callId)).map(row=>({...object(row),data:parse(object(row).data_json)}));
}
export async function legByControl(controlId:string): Promise<Json | null> {
  const row=(await database().prepare("SELECT * FROM customer_call_legs WHERE control_id=?").get(controlId));
  return row?{...object(row),data:parse(object(row).data_json)}:null;
}
export async function saveLeg(orgId:string,callId:string,role:string,payload:Json,eventAt=now()) {
  return (await database().transaction(async () => {
  const controlId=text(payload.call_control_id);const current=(await legByControl(controlId));
  if(current&&(text(current.organization_id)!==orgId||text(current.call_id)!==callId))throw conflict("leg_ownership_conflict","Provider leg belongs to another call.");
  if(current&&(text(current.state)==="ended"||text(current.event_at)>eventAt))return current;
  (await database().prepare(`INSERT INTO customer_call_legs(id,organization_id,call_id,role,control_id,provider_leg_id,session_id,state,event_at,data_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(control_id) DO UPDATE SET state=excluded.state,event_at=excluded.event_at,data_json=excluded.data_json`)
    .run(id("cl",controlId),orgId,callId,role,controlId,text(payload.call_leg_id),text(payload.call_session_id),text(payload.state)||"initiated",eventAt,JSON.stringify({...object(current?.data),...payload})));
  return (await legByControl(controlId))!;

  }));
}
export async function artifacts(orgId:string,callId:string):Promise<Json[]> {
  return (await database().prepare("SELECT * FROM customer_call_artifacts WHERE organization_id=? AND call_id=? AND state<>'deleted' ORDER BY created_at").all(orgId,callId))
    .map(row=>({...object(row),data:parse(object(row).data_json),data_json:undefined}));
}
export async function saveArtifact(orgId:string,callId:string,kind:string,key:string,data:Json,state="ready",retentionDays=30) {
  return (await database().transaction(async () => {
  const artifactId=id("ca",`${orgId}:${kind}:${key}`);
  if(kind==='transcript'&&(await database().prepare("SELECT id FROM customer_call_artifacts WHERE organization_id=? AND id IN (?,?) AND state='deleted'")
    .get(orgId,id('ca',`${orgId}:recording:${key}`),id('ca',`${orgId}:voicemail:${key}`))))return artifactId;
  (await database().prepare(`INSERT INTO customer_call_artifacts(id,organization_id,call_id,kind,state,created_at,expires_at,data_json) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,data_json=excluded.data_json WHERE customer_call_artifacts.state<>'deleted'
      AND customer_call_artifacts.call_id=excluded.call_id AND NOT(customer_call_artifacts.state='ready' AND excluded.state='processing')`)
    .run(artifactId,orgId,callId,kind,state,now(),new Date(Date.now()+retentionDays*86400_000).toISOString(),JSON.stringify(data)));
  return artifactId;

  }));
}
