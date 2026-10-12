import type {SqlStore} from '../../platform/sql_store.js';

export async function initializePhoneMarketingSchema(db:SqlStore){
 await db.exec(`
 CREATE TABLE IF NOT EXISTS phone_tracking_sessions (
  organization_id TEXT NOT NULL,pool_id TEXT NOT NULL,id TEXT NOT NULL,visitor_hash TEXT NOT NULL,
  phone_number TEXT NOT NULL,lease_until TEXT NOT NULL,reuse_after TEXT NOT NULL,
  attribution_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,pool_id,id),UNIQUE(organization_id,pool_id,visitor_hash)
 );
 CREATE INDEX IF NOT EXISTS phone_tracking_sessions_number ON phone_tracking_sessions(organization_id,phone_number,reuse_after);
 CREATE INDEX IF NOT EXISTS phone_tracking_sessions_pool ON phone_tracking_sessions(organization_id,pool_id,created_at,id);
 CREATE TABLE IF NOT EXISTS phone_tracking_call_index (
  organization_id TEXT NOT NULL,call_id TEXT NOT NULL,phone_number TEXT NOT NULL,
  lead_source_id TEXT NOT NULL,marketing_campaign_id TEXT NOT NULL,pool_id TEXT NOT NULL,visit_id TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,call_id)
 );
 CREATE INDEX IF NOT EXISTS phone_tracking_call_sources ON phone_tracking_call_index(organization_id,lead_source_id,marketing_campaign_id,created_at,call_id);
 CREATE INDEX IF NOT EXISTS phone_tracking_call_number ON phone_tracking_call_index(organization_id,phone_number,created_at,call_id);
 CREATE TABLE IF NOT EXISTS phone_broadcast_recipients (
  organization_id TEXT NOT NULL,campaign_id TEXT NOT NULL,id TEXT NOT NULL,address TEXT NOT NULL,
  recipient_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',message_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',replied_at TEXT NOT NULL DEFAULT '',opted_out_at TEXT NOT NULL DEFAULT '',lease_until TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,campaign_id,id),UNIQUE(organization_id,campaign_id,address)
 );
 CREATE INDEX IF NOT EXISTS phone_broadcast_pending ON phone_broadcast_recipients(organization_id,campaign_id,state,lease_until,id);
 CREATE TABLE IF NOT EXISTS phone_tracking_scan (id TEXT PRIMARY KEY,last_created_at TEXT NOT NULL,last_call_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS phone_sms_throttle (id TEXT PRIMARY KEY,next_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS phone_tracking_rate (id TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at TEXT NOT NULL);
 `);
}
