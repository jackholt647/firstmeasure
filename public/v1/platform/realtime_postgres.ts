import { ensurePostgresPlatformStorage } from "./storage_postgres.js";
import { queryPostgres, withPostgresTransaction } from "../src/database/postgres.js";
import type { RealtimeEvent } from "./realtime.js";

let schema: Promise<void> | undefined;
export const RETAINED_REALTIME_EVENTS = 1000;
async function ensureSchema() {
  schema ??= (async () => {
    await ensurePostgresPlatformStorage();
    await withPostgresTransaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-realtime-schema-v1'))");
      await client.query(`
        CREATE TABLE IF NOT EXISTS platform_realtime_heads (
          organization_id TEXT PRIMARY KEY, latest_seq BIGINT NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS platform_realtime_events (
          organization_id TEXT NOT NULL, seq BIGINT NOT NULL, topic TEXT NOT NULL,
          user_ids TEXT[], payload JSONB NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (organization_id, seq)
        );
      `);
    });
  })().catch(error => { schema = undefined; throw error; });
  await schema;
}

/** A per-organization row lock makes cursor order identical to commit order. */
export async function appendRealtimeEvent(input: Omit<RealtimeEvent, "seq" | "ts">): Promise<RealtimeEvent> {
  await ensureSchema();
  return withPostgresTransaction(async client => {
    const head = await client.query<{ latest_seq: string }>(`
      INSERT INTO platform_realtime_heads (organization_id, latest_seq) VALUES ($1, 1)
      ON CONFLICT (organization_id) DO UPDATE SET latest_seq = platform_realtime_heads.latest_seq + 1
      RETURNING latest_seq`, [input.organization_id]);
    const seq = Number(head.rows[0]!.latest_seq);
    const event: RealtimeEvent = { ...input, seq, ts: new Date().toISOString() };
    await client.query(`INSERT INTO platform_realtime_events (organization_id, seq, topic, user_ids, payload, ts)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [event.organization_id, seq, event.topic, event.user_ids, JSON.stringify(event.payload), event.ts]);
    await client.query("DELETE FROM platform_realtime_events WHERE organization_id = $1 AND seq <= $2", [event.organization_id, seq - RETAINED_REALTIME_EVENTS]);
    return event;
  });
}

export type RealtimeStreamPage = { organization_id: string; events: RealtimeEvent[]; next: number; resync: boolean };
/** One statement gives a consistent snapshot and batches all connected orgs per replica. */
export async function readRealtimeStreams(cursors: Array<{ organization_id: string; after: number }>): Promise<RealtimeStreamPage[]> {
  if (!cursors.length) return [];
  await ensureSchema();
  const result = await queryPostgres<{ organization_id: string; latest_seq: string; after: string; events: RealtimeEvent[] }>(`
    WITH cursors AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(organization_id text, after bigint))
    SELECT c.organization_id, COALESCE(h.latest_seq, 0) AS latest_seq, c.after,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('organization_id', e.organization_id, 'seq', e.seq,
        'topic', e.topic, 'user_ids', e.user_ids, 'payload', e.payload, 'ts', e.ts) ORDER BY e.seq)
        FROM platform_realtime_events e WHERE e.organization_id = c.organization_id AND e.seq > c.after), '[]'::jsonb) AS events
    FROM cursors c LEFT JOIN platform_realtime_heads h ON h.organization_id = c.organization_id`, [JSON.stringify(cursors)]);
  return result.rows.map(row => {
    const next = Number(row.latest_seq);
    const after = Number(row.after);
    return { organization_id: row.organization_id, events: row.events, next,
      resync: after > next || (after > 0 && after < Math.max(0, next - RETAINED_REALTIME_EVENTS)) };
  });
}
