import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { openSqlStore, type SqlStore } from "./sql_store.js";
import { env } from "../src/config/env.js";

// Ephemeral sessions live in shared SQL so separate API replicas see one roster.
const TTL = 30_000;
export const PRESENCE_IDLE_MS = Math.max(1_000, Number(process.env.PLATFORM_PRESENCE_IDLE_MS) || 5 * 60_000);
let store: SqlStore | undefined;
const streams = new Set<() => void>();
export function closePresenceStreams() { for (const close of streams) close(); }
function database() {
  return store ||= openSqlStore({ id: "platform-presence", schemaVersion: 2, filename: path.resolve(process.env.PLATFORM_STORAGE_ROOT || "./storage/platform", "presence.sqlite"), initialize: async db => {
    await db.exec(`CREATE TABLE IF NOT EXISTS platform_view_presence (
      session_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, scope TEXT NOT NULL,
      user_id TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_view_presence_scope ON platform_view_presence(organization_id, scope, expires_at);
      CREATE TABLE IF NOT EXISTS platform_presence_activity (session_id TEXT PRIMARY KEY, last_active_at BIGINT NOT NULL);`);
  }});
}
export async function presenceRoster(orgId: string, scope: string) {
  if (scope === "online") return database().prepare(`SELECT p.user_id, MAX(p.name) AS name,
    CASE WHEN MAX(a.last_active_at)>? THEN 'active' ELSE 'away' END AS status,
    MAX(a.last_active_at) AS last_active_at
    FROM platform_view_presence p LEFT JOIN platform_presence_activity a ON a.session_id=p.session_id
    WHERE p.organization_id=? AND p.scope='online' AND p.expires_at>? GROUP BY p.user_id ORDER BY p.user_id`).all(Date.now() - PRESENCE_IDLE_MS, orgId, Date.now());
  return database().prepare(`SELECT user_id, MAX(name) AS name FROM platform_view_presence
    WHERE organization_id=? AND scope=? AND expires_at>? GROUP BY user_id ORDER BY user_id`).all(orgId, scope, Date.now());
}
export async function recordPresenceActivity(orgId: string, userId: string, sessionId: string) {
  const result = await database().prepare(`UPDATE platform_presence_activity SET last_active_at=? WHERE session_id=? AND EXISTS
    (SELECT 1 FROM platform_view_presence p WHERE p.session_id=? AND p.organization_id=? AND p.user_id=? AND p.scope='online' AND p.expires_at>?)`)
    .run(Date.now(), sessionId, sessionId, orgId, userId, Date.now());
  return result.changes > 0;
}
export async function attachPresence(request: FastifyRequest, reply: FastifyReply, input: {
  orgId: string; scope: string; userId: string; name: string; activityAgeMs?: number; authorize: () => Promise<unknown>;
}) {
  const db = database();
  const session = randomUUID();
  await db.prepare("DELETE FROM platform_view_presence WHERE expires_at<=?").run(Date.now());
  await db.exec("DELETE FROM platform_presence_activity WHERE session_id NOT IN (SELECT session_id FROM platform_view_presence)");
  await db.prepare("INSERT INTO platform_view_presence(session_id,organization_id,scope,user_id,name,expires_at) VALUES(?,?,?,?,?,?)")
    .run(session, input.orgId, input.scope, input.userId, input.name, Date.now() + TTL);
  if (input.scope === "online") await db.prepare("INSERT INTO platform_presence_activity(session_id,last_active_at) VALUES(?,?)").run(session, Date.now() - (input.activityAgeMs || 0));
  const origin = String(request.headers.origin || "");
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive",
    ...(origin && env.corsOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {}) });
  request.raw.socket.setTimeout(0);
  request.raw.socket.setNoDelay(true);
  if (input.scope === "online") reply.raw.write(`event: session\ndata: ${JSON.stringify({session_id:session})}\n\n`);
  let closed = false, signature = "", refreshed = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    streams.delete(close);
    clearTimeout(timer);
    void db.prepare("DELETE FROM platform_view_presence WHERE session_id=?").run(session).catch(() => {});
    void db.prepare("DELETE FROM platform_presence_activity WHERE session_id=?").run(session).catch(() => {});
    reply.raw.end();
  };
  streams.add(close);
  reply.raw.on("close", close);
  if (reply.raw.destroyed || request.raw.aborted) { close(); return; }
  const tick = async () => {
    try {
      if (closed) return;
      if (Date.now() - refreshed >= 10_000) {
        await input.authorize();
        if (closed) return;
        await db.prepare("UPDATE platform_view_presence SET expires_at=? WHERE session_id=?").run(Date.now() + TTL, session);
        refreshed = Date.now();
        reply.raw.write(": heartbeat\n\n");
      }
      const next = JSON.stringify(await presenceRoster(input.orgId, input.scope));
      if (!closed && next !== signature) {
        signature = next;
        reply.raw.write(`event: presence\ndata: ${next}\n\n`);
      }
    } catch { close(); }
    if (!closed) { timer = setTimeout(tick, 750); timer.unref(); }
  };
  await tick();
}
