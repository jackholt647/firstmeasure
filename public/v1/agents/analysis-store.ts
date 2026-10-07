import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../src/config/env.js';
import { openSqlStore, type SqlStore } from '../platform/sql_store.js';
import { conflict } from '../platform/errors.js';
import { contentHash } from '../platform/publication/validation.js';

export type AnalysisCitation = { id:string; label:string };
export type AnalysisRecord = {
  id:string; organization_id:string; user_id:string; provider:string; source_id:string;
  source_revision:string; citations:AnalysisCitation[]; expires_at:string;
  kind:'summary'|'answer'; question:string; system_prompt:string;
  state:'pending'|'running'|'ready'|'failed'; text:string; error:string;
  model:string; created_at:string; updated_at:string;
};
let db:SqlStore|null=null, filename='';
export async function closeAnalysisStore(){const old=db;db=null;filename='';await old?.close();}
function database(){
  const next=path.resolve(process.cwd(),env.platformStorageRoot,'agent-analysis.sqlite');
  if(db&&filename===next)return db;
  void closeAnalysisStore();filename=next;
  db=openSqlStore({id:'agent_analysis',filename:next,schemaVersion:1,initialize:async store=>{
    await store.exec(`CREATE TABLE IF NOT EXISTS agent_source_analyses (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
      provider TEXT NOT NULL, source_id TEXT NOT NULL, operation_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, state TEXT NOT NULL, data_json TEXT NOT NULL, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(organization_id,user_id,operation_key));
      CREATE INDEX IF NOT EXISTS agent_source_analyses_source ON agent_source_analyses(organization_id,provider,source_id,created_at)`);
  }});return db;
}
function record(row:Record<string,unknown>|undefined):AnalysisRecord|null {
  if(!row)return null;
  return {...JSON.parse(String(row.data_json)),state:row.state,updated_at:row.updated_at} as AnalysisRecord;
}
export async function reserveAnalysis(input:Omit<AnalysisRecord,'id'|'created_at'|'updated_at'|'state'|'text'|'error'|'model'>,operationKey:string){
  const store=database(),at=new Date().toISOString();
  // Retention timestamps can change without changing source content; use stable request identity.
  const hash=contentHash({provider:input.provider,source:input.source_id,revision:input.source_revision,question:input.question,prompt:input.system_prompt});
  const value:AnalysisRecord={...input,id:`analysis_${randomUUID()}`,state:'pending',text:'',error:'',model:'',created_at:at,updated_at:at};
  const inserted=await store.prepare(`INSERT INTO agent_source_analyses(id,organization_id,user_id,provider,source_id,operation_key,request_hash,state,data_json,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?) ON CONFLICT(organization_id,user_id,operation_key) DO NOTHING`)
    .run(value.id,input.organization_id,input.user_id,input.provider,input.source_id,operationKey,hash,JSON.stringify(value),input.expires_at,at,at);
  const row=await store.prepare('SELECT * FROM agent_source_analyses WHERE organization_id=? AND user_id=? AND operation_key=?').get(input.organization_id,input.user_id,operationKey);
  if(!row||row.request_hash!==hash)throw conflict('analysis_operation_conflict','This operation ID belongs to a different analysis request.');
  return {record:record(row)!,created:!!inserted.changes};
}
export async function readAnalysis(org:string,id:string){return record(await database().prepare('SELECT * FROM agent_source_analyses WHERE organization_id=? AND id=?').get(org,id));}
export async function listAnalyses(org:string,provider:string,sourceId:string){return (await database().prepare('SELECT * FROM agent_source_analyses WHERE organization_id=? AND provider=? AND source_id=? ORDER BY created_at DESC LIMIT 50').all(org,provider,sourceId)).map(row=>record(row)!);}
export async function claimAnalysis(org:string,id:string){return !!(await database().prepare("UPDATE agent_source_analyses SET state='running',updated_at=? WHERE organization_id=? AND id=? AND state='pending'").run(new Date().toISOString(),org,id)).changes;}
export async function finishAnalysis(value:AnalysisRecord){
  await database().prepare("UPDATE agent_source_analyses SET state=?,data_json=?,updated_at=? WHERE organization_id=? AND id=? AND state='running'")
    .run(value.state,JSON.stringify(value),new Date().toISOString(),value.organization_id,value.id);
}
export async function expireAnalyses(){await database().prepare('DELETE FROM agent_source_analyses WHERE expires_at<=?').run(new Date().toISOString());}
export async function revokeSourceAnalyses(org:string,provider:string,sourceId:string){await database().prepare('DELETE FROM agent_source_analyses WHERE organization_id=? AND provider=? AND source_id=?').run(org,provider,sourceId);}
