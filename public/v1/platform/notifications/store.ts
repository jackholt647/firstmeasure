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
  if(Number(row?.revision||0)!==rule.revision)throw conflict('notification_rule_revision','Notification rule revision conflict');
  const next={...rule,revision:rule.revision+1};
  await db.prepare('INSERT INTO notification_rules(organization_id,user_id,id,revision,data_json) VALUES(?,?,?,?,?) ON CONFLICT(organization_id,user_id,id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json').run(org,user,rule.id,next.revision,JSON.stringify(next));
  await db.prepare('INSERT INTO notification_rule_history(id,organization_id,user_id,rule_id,revision,data_json,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),org,user,rule.id,next.revision,JSON.stringify(next),reason,new Date().toISOString());
  return next;
 },identity(org,user,rule.id));
}
export async function ruleHistory(org:string,user:string){return (await notificationStore().prepare('SELECT rule_id,revision,reason,created_at,data_json FROM notification_rule_history WHERE organization_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100').all(org,user)).map(r=>({...r,rule:JSON.parse(String(r.data_json)),data_json:undefined}));}
