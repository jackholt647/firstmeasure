import { conflict } from "../errors.js";
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openSqlStore, type SqlStore } from '../sql_store.js';
import { env } from '../../src/config/env.js';
import { ruleSchema, type NotificationRule } from './contracts.js';
let db:SqlStore|undefined;
export const identity=(...parts:unknown[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function notificationStore(){return db??=openSqlStore({id:'notification-delivery',filename:path.resolve(env.platformStorageRoot,'notification-delivery.sqlite'),initialize:async db=>{await db.exec(`
 CREATE TABLE IF NOT EXISTS notification_rule_outputs (organization_id TEXT NOT NULL,user_id TEXT NOT NULL,rule_id TEXT NOT NULL,revision INTEGER NOT NULL,values_json TEXT NOT NULL,dependencies_json TEXT NOT NULL,PRIMARY KEY(organization_id,user_id,rule_id));
 CREATE TABLE IF NOT EXISTS notification_rule_samples (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,rule_id TEXT NOT NULL,input_json TEXT NOT NULL,reads_json TEXT NOT NULL,output_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_occurrences (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,note_json TEXT NOT NULL,event_json TEXT NOT NULL,audience_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
 CREATE TABLE IF NOT EXISTS notification_rules (organization_id TEXT NOT NULL,user_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(organization_id,user_id,id));
 CREATE TABLE IF NOT EXISTS notification_rule_tombstones (organization_id TEXT NOT NULL,user_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(organization_id,user_id,id));
 CREATE TABLE IF NOT EXISTS notification_personal_configurations (organization_id TEXT NOT NULL,user_id TEXT NOT NULL,branch_id TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(organization_id,user_id,branch_id));
 CREATE TABLE IF NOT EXISTS notification_organization_defaults (organization_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_organization_locks (organization_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_configuration_history (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,branch_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_rule_history (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,rule_id TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS notification_recipients (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,notification_id TEXT NOT NULL,user_id TEXT NOT NULL,note_json TEXT NOT NULL,event_json TEXT NOT NULL,baseline_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',deadline_at TEXT NOT NULL,lease_until TEXT NOT NULL DEFAULT '',token TEXT NOT NULL DEFAULT '',audit_json TEXT NOT NULL DEFAULT '[]');
 CREATE INDEX IF NOT EXISTS notification_recipients_due ON notification_recipients(state,deadline_at);
 CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY,recipient_id TEXT NOT NULL,method TEXT NOT NULL,decision_json TEXT NOT NULL,state TEXT NOT NULL,due_at TEXT NOT NULL,token TEXT NOT NULL DEFAULT '',lease_until TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,result_json TEXT NOT NULL DEFAULT '{}');
 CREATE INDEX IF NOT EXISTS notification_deliveries_due ON notification_deliveries(state,due_at);
 CREATE TABLE IF NOT EXISTS notification_group_members (group_id TEXT NOT NULL,recipient_id TEXT NOT NULL,PRIMARY KEY(group_id,recipient_id));
 CREATE TABLE IF NOT EXISTS notification_groups (id TEXT PRIMARY KEY,first_at TEXT NOT NULL,last_at TEXT NOT NULL,count INTEGER NOT NULL);
 `);}});}
export async function listRules(org:string,user:string){return (await notificationStore().prepare('SELECT data_json FROM notification_rules WHERE organization_id=? AND user_id=? ORDER BY id').all(org,user)).map(r=>ruleSchema.parse(JSON.parse(String(r.data_json)))).sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));}
export async function saveRule(org:string,user:string,raw:unknown,reason='User configuration'):Promise<NotificationRule>{
 const rule=ruleSchema.parse(raw),db=notificationStore();
 return db.transaction(async()=>{
  const row=await db.prepare('SELECT revision FROM notification_rules WHERE organization_id=? AND user_id=? AND id=?').get(org,user,rule.id);
  const tombstone=await db.prepare('SELECT revision FROM notification_rule_tombstones WHERE organization_id=? AND user_id=? AND id=?').get(org,user,rule.id);
  if(tombstone&&(!row||Number(tombstone.revision)>=Number(row.revision)))throw conflict('notification_rule_deleted','This notification rule was deleted.');
  if(Number(row?.revision||0)!==rule.revision)throw conflict('notification_rule_revision','Notification rule revision conflict');
  const next={...rule,revision:rule.revision+1};
  await db.prepare('INSERT INTO notification_rules(organization_id,user_id,id,revision,data_json) VALUES(?,?,?,?,?) ON CONFLICT(organization_id,user_id,id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json').run(org,user,rule.id,next.revision,JSON.stringify(next));
  await db.prepare('INSERT INTO notification_rule_history(id,organization_id,user_id,rule_id,revision,data_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,rule.id,next.revision,JSON.stringify(next),reason,new Date().toISOString());
  return next;
 },identity(org,user,rule.id));
}
export async function deleteRule(org:string,user:string,id:string,revision:number){
 const db=notificationStore();
 return db.transaction(async()=>{
  const row=await db.prepare('SELECT revision,data_json FROM notification_rules WHERE organization_id=? AND user_id=? AND id=?').get(org,user,id);
  if(!row||Number(row.revision)!==revision)throw conflict('notification_rule_revision','Notification rule revision conflict');
  await db.prepare('INSERT INTO notification_rule_tombstones(organization_id,user_id,id,revision) VALUES(?,?,?,?) ON CONFLICT(organization_id,user_id,id) DO UPDATE SET revision=excluded.revision').run(org,user,id,revision+1);
  await db.prepare('INSERT INTO notification_rule_history(id,organization_id,user_id,rule_id,revision,data_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,id,revision+1,String(row.data_json),'Deleted by user',new Date().toISOString());
  await db.prepare('DELETE FROM notification_rules WHERE organization_id=? AND user_id=? AND id=?').run(org,user,id);
  await db.prepare('DELETE FROM notification_rule_outputs WHERE organization_id=? AND user_id=? AND rule_id=?').run(org,user,id);
  for(const recipient of await db.prepare('SELECT id,note_json FROM notification_recipients WHERE organization_id=? AND user_id=?').all(org,user)){
   const note=JSON.parse(String(recipient.note_json));if(note.context?.rule_id!==id)continue;
   await db.prepare("UPDATE notification_recipients SET state='cancelled',token='' WHERE id=?").run(String(recipient.id));
   await db.prepare("UPDATE notification_deliveries SET state='cancelled',token='' WHERE recipient_id=? AND state IN ('pending','available')").run(String(recipient.id));
  }
  return {deleted:true};
 },identity(org,user,id));
}
/** Explicit user edit of a currently mandatory virtual rule; never used by repairs. */
export async function savePersonalRemovalLockRule(org:string,user:string,raw:unknown,policyRevision:number):Promise<NotificationRule>{
 const rule=ruleSchema.parse(raw),db=notificationStore();
 return db.transaction(async()=>{
  const sql='SELECT revision,data_json FROM notification_organization_locks WHERE organization_id=?';
  const policyRow=await db.prepare(sql,sql+' FOR UPDATE').get(org);
  const policy=policyRow?JSON.parse(String(policyRow.data_json)):null,lock=policy?.locks?.['rule:'+rule.id];
  if(!policy||Number(policyRow!.revision)!==policyRevision||lock?.mode!=='removal'||!lock.rule||lock.rule.id!==rule.id||Number(lock.rule.revision)!==rule.revision||!rule.enabled)throw conflict('notification_lock_changed','The required notification changed. Reload it before editing.');
  const existing=await db.prepare('SELECT revision FROM notification_rules WHERE organization_id=? AND user_id=? AND id=?').get(org,user,rule.id);
  if(existing)throw conflict('notification_rule_revision','Notification rule revision conflict');
  const tombstone=await db.prepare('SELECT revision FROM notification_rule_tombstones WHERE organization_id=? AND user_id=? AND id=?').get(org,user,rule.id);
  const next={...rule,revision:Math.max(rule.revision,Number(tombstone?.revision||0))+1};
  await db.prepare('INSERT INTO notification_rules(organization_id,user_id,id,revision,data_json) VALUES(?,?,?,?,?)').run(org,user,rule.id,next.revision,JSON.stringify(next));
  await db.prepare('INSERT INTO notification_rule_history(id,organization_id,user_id,rule_id,revision,data_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,rule.id,next.revision,JSON.stringify(next),`Personal edit of required notification under organization policy revision ${policyRevision}`,new Date().toISOString());
  return next;
 },identity(org,user,rule.id));
}
export async function ruleHistory(org:string,user:string){return (await notificationStore().prepare('SELECT rule_id,revision,reason,created_at,data_json FROM notification_rule_history WHERE organization_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100').all(org,user)).map(r=>({...r,rule:JSON.parse(String(r.data_json)),data_json:undefined}));}
