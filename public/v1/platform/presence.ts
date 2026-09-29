import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { openSqlStore, type SqlStore } from "./sql_store.js";
import { env } from "../src/config/env.js";

// Ephemeral sessions live in shared SQL so separate API replicas see one roster.
const TTL = 30_000;
let store: SqlStore | undefined;
const streams = new Set<() => void>();
export function closePresenceStreams() { for (const close of streams) close(); }
function database() {
  return store ||= openSqlStore({ id: "platform-presence", filename: path.resolve(process.env.PLATFORM_STORAGE_ROOT || "./storage/platform", "presence.sqlite"), initialize: async db => {
    await db.exec(`CREATE TABLE IF NOT EXISTS platform_view_presence (
      session_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, scope TEXT NOT NULL,
      user_id TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_view_presence_scope ON platform_view_presence(organization_id, scope, expires_at);`);
  }});
}
export async function presenceRoster(orgId: string, scope: string) {
  if (scope === "online") return database().prepare(`SELECT user_id, MAX(name) AS name FROM platform_view_presence
    WHERE organization_id=? AND expires_at>? GROUP BY user_id ORDER BY user_id`).all(orgId, Date.now());
  return database().prepare(`SELECT user_id, MAX(name) AS name FROM platform_view_presence
    WHERE organization_id=? AND scope=? AND expires_at>? GROUP BY user_id ORDER BY user_id`).all(orgId, scope, Date.now());
}
export async function attachPresence(request: FastifyRequest, reply: FastifyReply, input: {
  orgId: string; scope: string; userId: string; name: string; authorize: () => Promise<unknown>;
}) {
  const db = database();
  const session = randomUUID();
  await db.prepare("DELETE FROM platform_view_presence WHERE expires_at<=?").run(Date.now());
  await db.prepare("INSERT INTO platform_view_presence(session_id,organization_id,scope,user_id,name,expires_at) VALUES(?,?,?,?,?,?)")
    .run(session, input.orgId, input.scope, input.userId, input.name, Date.now() + TTL);
  const origin = String(request.headers.origin || "");
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive",
    ...(origin && env.corsOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" } : {}) });
  request.raw.socket.setTimeout(0);
  request.raw.socket.setNoDelay(true);
  let closed = false, signature = "", refreshed = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    streams.delete(close);
    clearTimeout(timer);
    void db.prepare("DELETE FROM platform_view_presence WHERE session_id=?").run(session).catch(() => {});
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
