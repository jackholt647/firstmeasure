import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { appendRealtimeEvent, readRealtimeStreams } from "./realtime_postgres.js";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "../src/config/env.js";

/**
 * Platform realtime hub.
 *
 * First real-time surface in the backend: an in-process pub/sub bus fanned out
 * to browsers over Server-Sent Events, with a cursor-polling fallback served
 * from the same per-org ring buffer. Single-host deployment (SQLite storage)
 * makes in-process fan-out the correct scope — no external broker.
 *
 * Events are org-scoped and optionally targeted to a set of user ids so
 * private-channel/DM traffic is filtered server-side before it ever reaches a
 * connection.
 */

export type RealtimeEvent = {
  seq: number;
  organization_id: string;
  topic: string;
  /** null = every user in the org may receive it; otherwise only these ids. */
  user_ids: string[] | null;
  payload: Record<string, unknown>;
  ts: string;
};

type PublishInput = {
  organization_id: string;
  topic: string;
  user_ids?: string[] | null;
  payload?: Record<string, unknown>;
};

type Connection = {
  id: number;
  orgId: string;
  userId: string;
  write: (chunk: string) => void;
  close: () => void;
};

const RING_BUFFER_SIZE = 1000;
const HEARTBEAT_MS = 25_000;

type OrgStream = {
  seq: number;
  buffer: RealtimeEvent[];
  connections: Map<number, Connection>;
};

const streams = new Map<string, OrgStream>();
let connectionCounter = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
let replicaPollTimer: NodeJS.Timeout | null = null;
let replicaPollRunning = false;

function orgStream(orgId: string): OrgStream {
  let stream = streams.get(orgId);
  if (!stream) {
    stream = { seq: 0, buffer: [], connections: new Map() };
    streams.set(orgId, stream);
  }
  return stream;
}

function eventVisibleTo(event: RealtimeEvent, userId: string) {
  return event.user_ids === null || event.user_ids.includes(userId);
}

function encodeSse(event: RealtimeEvent) {
  const data = JSON.stringify({ topic: event.topic, payload: event.payload, ts: event.ts });
  return `id: ${event.seq}\nevent: platform\ndata: ${data}\n\n`;
}

function ensureHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    let live = 0;
    for (const stream of streams.values()) {
      for (const connection of stream.connections.values()) {
        connection.write(": ping\n\n");
        live += 1;
      }
    }
    if (!live && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

export async function publishRealtimeEvent(input: PublishInput) {
  const orgId = String(input.organization_id || "").trim();
  if (!orgId) return null;
  if (isFirstMeasurePostgresEnabled()) {
    return appendRealtimeEvent({ organization_id: orgId, topic: String(input.topic || "").trim(), user_ids: Array.isArray(input.user_ids) ? [...new Set(input.user_ids.map(String))] : null, payload: input.payload || {} });
  }
  const stream = orgStream(orgId);
  stream.seq += 1;
  const event: RealtimeEvent = {
    seq: stream.seq,
    organization_id: orgId,
    topic: String(input.topic || "").trim(),
    user_ids: Array.isArray(input.user_ids) ? [...new Set(input.user_ids.map((id) => String(id)))] : null,
    payload: input.payload && typeof input.payload === "object" ? input.payload : {},
    ts: new Date().toISOString()
  };
  stream.buffer.push(event);
  if (stream.buffer.length > RING_BUFFER_SIZE) stream.buffer.splice(0, stream.buffer.length - RING_BUFFER_SIZE);
  for (const connection of stream.connections.values()) {
    if (eventVisibleTo(event, connection.userId)) connection.write(encodeSse(event));
  }
  return event;
}

/**
 * Events with seq > after that the user may see. `resync: true` means the
 * cursor has fallen out of the ring buffer and the client must refetch state.
 */
export async function pollRealtimeEvents(orgId: string, userId: string, after: number) {
  if (isFirstMeasurePostgresEnabled()) {
    const [page] = await readRealtimeStreams([{ organization_id: orgId, after }]);
    return { events: page!.events.filter(event => eventVisibleTo(event, userId)), next: page!.next, resync: page!.resync };
  }
  const stream = streams.get(orgId);
  if (!stream) return { events: [] as RealtimeEvent[], next: 0, resync: false };
  const oldestBuffered = stream.buffer.length ? stream.buffer[0]!.seq : stream.seq + 1;
  const resync = after > 0 && after < oldestBuffered - 1;
  const events = stream.buffer.filter((event) => event.seq > after && eventVisibleTo(event, userId));
  return { events, next: stream.seq, resync };
}

export async function attachRealtimeConnection(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { orgId: string; userId: string; after: number }
) {
  const { orgId, userId, after } = options;
  // Fetch before sending headers so database failures remain normal API errors.
  const catchUp = await pollRealtimeEvents(orgId, userId, after);
  const stream = orgStream(orgId);
  if (!stream.connections.size) stream.seq = catchUp.next;

  // The response is hijacked from Fastify, which means the CORS plugin's
  // headers never reach it — restate them here or cross-origin dev setups
  // (portal on :8011, API on :3101) silently lose EventSource to the browser.
  const origin = String(request.headers.origin ?? "");
  const corsHeaders: Record<string, string> = origin && env.corsOrigins.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
    : {};

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx buffers /v1/ proxy responses by default; this disables it per-response.
    "X-Accel-Buffering": "no",
    ...corsHeaders
  });
  request.raw.socket.setTimeout(0);
  request.raw.socket.setNoDelay(true);
  reply.raw.write(`retry: 3000\n\n`);

  connectionCounter += 1;
  const connection: Connection = {
    id: connectionCounter,
    orgId,
    userId,
    write: (chunk) => {
      try {
        reply.raw.write(chunk);
      } catch {
        connection.close();
      }
    },
    close: () => {
      stream.connections.delete(connection.id);
      try {
        reply.raw.end();
      } catch {
        /* already closed */
      }
    }
  };
  stream.connections.set(connection.id, connection);
  ensureHeartbeat();
  ensureReplicaPoller();

  if (after > 0) {
    if (catchUp.resync) {
      connection.write(`event: platform\ndata: ${JSON.stringify({ topic: "sys.resync", payload: {}, ts: new Date().toISOString() })}\n\n`);
    } else {
      for (const event of catchUp.events) connection.write(encodeSse(event));
    }
  }

  // A shared poll may have completed while the initial replay query was pending.
  for (const event of stream.buffer) {
    if (event.seq > catchUp.next && eventVisibleTo(event, userId)) connection.write(encodeSse(event));
  }
  request.raw.on("close", () => connection.close());
  return connection;
}

export function realtimeDiagnostics() {
  return [...streams.entries()].map(([orgId, stream]) => ({
    organization_id: orgId,
    seq: stream.seq,
    buffered: stream.buffer.length,
    connections: stream.connections.size
  }));
}

export function resetRealtimeForTests() {
  for (const stream of streams.values()) {
    for (const connection of stream.connections.values()) connection.close();
  }
  streams.clear();
  if (replicaPollTimer) clearInterval(replicaPollTimer);
  replicaPollTimer = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function ensureReplicaPoller() {
  if (!isFirstMeasurePostgresEnabled() || replicaPollTimer) return;
  replicaPollTimer = setInterval(() => { void syncReplicaRealtime().catch(() => undefined); }, 1000);
  replicaPollTimer.unref?.();
}

export async function syncReplicaRealtime() {
  if (replicaPollRunning) return;
  const cursors = [...streams.entries()].filter(([, stream]) => stream.connections.size)
    .map(([organization_id, stream]) => ({ organization_id, after: stream.seq }));
  if (!cursors.length) {
    if (replicaPollTimer) clearInterval(replicaPollTimer);
    replicaPollTimer = null;
    return;
  }
  replicaPollRunning = true;
  try {
    for (const page of await readRealtimeStreams(cursors)) {
      const stream = streams.get(page.organization_id);
      if (!stream) continue;
      if (page.resync) {
        for (const connection of stream.connections.values()) connection.write(`id: ${page.next}\nevent: platform\ndata: ${JSON.stringify({ topic: "sys.resync", payload: {}, ts: new Date().toISOString() })}\n\n`);
      } else {
        for (const event of page.events) {
          if (event.seq <= stream.seq) continue;
          for (const connection of stream.connections.values()) if (eventVisibleTo(event, connection.userId)) connection.write(encodeSse(event));
        }
      }
      stream.seq = page.next;
      stream.buffer = [...stream.buffer, ...page.events].slice(-RING_BUFFER_SIZE);
    }
  } finally { replicaPollRunning = false; }
}
