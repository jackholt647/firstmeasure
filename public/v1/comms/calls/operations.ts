import { database, object, text, now, type Json } from './storage.js';

/** Provider cost is evidence, not a customer invoice. Never manufacture missing cost. */
export async function recordVoiceCost(orgId:string,callId:string,eventId:string,payload:Json){
  const db=database();
  (await db.exec(`CREATE TABLE IF NOT EXISTS customer_voice_usage (
    organization_id TEXT NOT NULL,provider_leg_id TEXT NOT NULL,call_id TEXT NOT NULL,event_id TEXT NOT NULL,
    amount TEXT,currency TEXT NOT NULL,status TEXT NOT NULL,parts_json TEXT NOT NULL,occurred_at TEXT NOT NULL,
    PRIMARY KEY(organization_id,provider_leg_id))`));
  const parts=(Array.isArray(payload.cost_parts)?payload.cost_parts:[]).map(object), currencies=[...new Set(parts.map(p=>text(p.currency)).filter(Boolean))];
  const amount=text(payload.total_cost),valid=/^\d+(\.\d+)?$/.test(amount)&&payload.status==='success';
  const key=text(payload.call_leg_id||payload.call_control_id);if(!key)return;
  (await db.prepare(`INSERT INTO customer_voice_usage VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,provider_leg_id)
    DO UPDATE SET amount=excluded.amount,currency=excluded.currency,status=excluded.status,parts_json=excluded.parts_json,event_id=excluded.event_id,occurred_at=excluded.occurred_at
    WHERE customer_voice_usage.occurred_at<=excluded.occurred_at`).run(orgId,key,callId,eventId,valid?amount:null,currencies.length===1?currencies[0]!:'',valid?'reported':'unavailable',JSON.stringify(parts),text(payload.occurred_at)||now()));
}
export async function voiceHealth(orgId:string){
  const db=database();
  const jobs=(await db.prepare("SELECT id,call_id,kind,state,attempts,updated_at FROM customer_call_jobs WHERE organization_id=? AND state IN ('failed','uncertain') ORDER BY updated_at DESC LIMIT 100").all(orgId)).map(object);
  const pending=object((await db.prepare("SELECT count(*) AS count,min(created_at) AS oldest FROM customer_call_jobs WHERE organization_id=? AND state IN ('pending','running')").get(orgId)));
  const resources=(await db.prepare("SELECT kind,id,revision,updated_at,json_extract(data_json,'$.status') AS status FROM customer_voice_resources WHERE organization_id=? AND json_extract(data_json,'$.status') IN ('failed','uncertain','creating','sync_pending','sync_uncertain','sync_required','binding')", "SELECT kind,id,revision,updated_at,data_json::jsonb #>> '{status}' AS status FROM customer_voice_resources WHERE organization_id=? AND data_json::jsonb #>> '{status}' IN ('failed','uncertain','creating','sync_pending','sync_uncertain','sync_required','binding')").all(orgId)).map(object);
  const table=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_voice_usage'").get());
  const usage=table?(await db.prepare("SELECT currency,count(*) AS legs,sum(CAST(amount AS REAL)) AS reported_amount FROM customer_voice_usage WHERE organization_id=? AND status='reported' AND occurred_at>=? GROUP BY currency").all(orgId,new Date(Date.now()-86400000).toISOString())).map(object):[];
  return {attention:jobs,resources,pending,usage_last_24_hours:usage,healthy:!jobs.length&&!resources.length&&(!pending.oldest||Date.parse(text(pending.oldest))>Date.now()-120000)};
}
