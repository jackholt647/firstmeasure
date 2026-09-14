import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { isFirstMeasurePostgresEnabled, queryPostgres } from '../src/database/postgres.js';
import { RETENTION_DAYS, type TrackingEvent } from './core.js';

const schema = `
CREATE TABLE IF NOT EXISTS staff_tracking_events (id TEXT PRIMARY KEY,email TEXT NOT NULL,at TEXT NOT NULL,ip TEXT,kind TEXT NOT NULL,attempt TEXT NOT NULL,course TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS staff_tracking_user_time ON staff_tracking_events(email,at);
CREATE INDEX IF NOT EXISTS staff_tracking_ip_time ON staff_tracking_events(ip,at);
CREATE INDEX IF NOT EXISTS staff_tracking_time ON staff_tracking_events(at);
CREATE INDEX IF NOT EXISTS staff_tracking_attempt ON staff_tracking_events(email,course,attempt,at);
CREATE TABLE IF NOT EXISTS staff_tracking_grants (email TEXT PRIMARY KEY,granted_by TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff_tracking_reviews (event_id TEXT PRIMARY KEY,status TEXT NOT NULL,note TEXT NOT NULL,reviewer TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff_tracking_audit (id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,at TEXT NOT NULL);
`;
let db: DatabaseSync | undefined;
function sqlite() {
  if (!db) {
    if (env.dataEnvironment === 'production') throw new Error('Tracking requires shared PostgreSQL in production');
    const root = path.resolve(process.env.INTERNAL_STORAGE_ROOT || 'storage/internal'); mkdirSync(root,{recursive:true});
    db = new DatabaseSync(path.join(root,'staff-tracking.sqlite')); db.exec(schema);
  }
  return db;
}
export async function trackingQuery(sql: string, args: (string|number|null)[] = []): Promise<any[]> {
  if (isFirstMeasurePostgresEnabled()) return (await queryPostgres(sql,args)).rows;
  const order: (string|number|null)[] = [];
  const converted = sql.replace(/\$(\d+)/g,(_m,n)=>{order.push(args[Number(n)-1]!);return '?';});
  return sqlite().prepare(converted).all(...order);
}
// Explicit deployment/test step; never auto-migrate the live database on request.
export async function initializeTrackingSchema() {
  if (isFirstMeasurePostgresEnabled()) await queryPostgres(schema);
  else sqlite();
}
export async function insertEvent(e: TrackingEvent) {
  await trackingQuery('INSERT INTO staff_tracking_events(id,email,at,ip,kind,attempt,course,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',[e.id,e.email,e.at,e.ip,e.kind,e.attempt,e.course,JSON.stringify(e)]);
}
export async function priorEvents(e: TrackingEvent) {
  const cutoff=new Date(Date.parse(e.at)-RETENTION_DAYS*86400000).toISOString();
  // Bound indexed input as well as output: a large shared office must not cause
  // a full 90-day scan for every row on the page. Retain attempt/status boundaries.
  const rows=await trackingQuery(`WITH own AS (
    SELECT * FROM staff_tracking_events WHERE email=$3 AND at<$1 AND at>=$2 ORDER BY at DESC LIMIT 10001
  ), shared AS (
    SELECT * FROM staff_tracking_events WHERE ip=$4 AND at<$1 AND at>=$2 ORDER BY at DESC LIMIT 10001
  ), bounded AS (SELECT * FROM own UNION SELECT * FROM shared), ranked AS (
    SELECT data,at,ROW_NUMBER() OVER(PARTITION BY email,ip,course,attempt,CASE WHEN data LIKE '%"established":true%' THEN 1 ELSE 0 END ORDER BY at DESC,id DESC) AS rn FROM bounded
  ) SELECT data,CASE WHEN (SELECT COUNT(*) FROM own)>=10001 OR (SELECT COUNT(*) FROM shared)>=10001 THEN 1 ELSE 0 END AS source_limited
  FROM ranked WHERE rn=1 ORDER BY at DESC LIMIT 2000`,[e.at,cutoff,e.email,e.ip]);
  const result=rows.map(r=>JSON.parse(r.data) as TrackingEvent) as TrackingEvent[] & {limited:boolean};
  result.limited=rows.length>=2000||rows.some(r=>Number(r.source_limited)===1);
  return result;
}
export async function expireTracking() {
  const cutoff=new Date(Date.now()-RETENTION_DAYS*86400000).toISOString();
  await trackingQuery('DELETE FROM staff_tracking_reviews WHERE event_id IN (SELECT id FROM staff_tracking_events WHERE at<$1 ORDER BY at LIMIT 5000)',[cutoff]);
  await trackingQuery('DELETE FROM staff_tracking_events WHERE id IN (SELECT id FROM staff_tracking_events WHERE at<$1 ORDER BY at LIMIT 5000)',[cutoff]);
  await trackingQuery('DELETE FROM staff_tracking_reviews WHERE event_id IN (SELECT r.event_id FROM staff_tracking_reviews r LEFT JOIN staff_tracking_events e ON e.id=r.event_id WHERE e.id IS NULL LIMIT 5000)');
  await trackingQuery('DELETE FROM staff_tracking_audit WHERE id IN (SELECT id FROM staff_tracking_audit WHERE at<$1 ORDER BY at LIMIT 5000)',[cutoff]);
}
export function closeTrackingSqlite() { db?.close();db=undefined; }
