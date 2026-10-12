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
 *
 * This is the ONE long-lived connection a browser page holds to the platform.
 * Anything else that needs to push to a page (who is viewing, live document
 * editing, ...) rides on it as a channel: a kind registered here with
 * registerRealtimeChannelKind and asked for by the page with `watch=<kind>:<id>`
 * on the stream URL. Do not add another streaming endpoint for browsers; see
 * docs/architecture/realtime.md.
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
  /** false for a connection that carries channels only (a user without an app that receives platform events). */
  events: boolean;
  write: (chunk: string) => void;
  close: () => void;
};

/** Sends one frame of a channel to the page: an event name and its data. */
export type RealtimeChannelSend = (event: string, data: unknown) => void;
/**
 * Starts a channel on a connection that is already authorized for it and
 * returns how to stop it. `ended` tells the page the channel stopped on its
 * own (its data source failed, access was withdrawn) so it can ask again.
 */
export type RealtimeChannelOpen = (send: RealtimeChannelSend, ended: (code?: string) => void) => Promise<() => void> | (() => void);
/** Authorizes one `watch` entry for this request and returns how to open it. Throws to refuse. */
export type RealtimeChannelKind = (request: FastifyRequest, input: { orgId: string; id: string; query: Record<string, unknown> }) => Promise<RealtimeChannelOpen>;
export type ResolvedRealtimeChannel = { name: string; open?: RealtimeChannelOpen; error?: string };

export const MAX_REALTIME_CHANNELS = 12;
const channelKinds = new Map<string, RealtimeChannelKind>();

/** Registers what `watch=<kind>:<id>` means on the platform stream. One owner per kind. */
export function registerRealtimeChannelKind(kind: string, factory: RealtimeChannelKind) {
  channelKinds.set(kind, factory);
}

/** `watch` as it arrives on the query string: repeated, or comma separated. */
export function realtimeWatchList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return [...new Set(raw.flatMap(entry => String(entry).split(",")).map(entry => entry.trim()).filter(Boolean))].slice(0, MAX_REALTIME_CHANNELS);
}

/**
 * Authorizes each watched channel before the response starts. One that is
 * refused or unknown is reported to the page on the stream as its own error;
 * the connection and its other channels carry on.
 */
export async function resolveRealtimeChannels(request: FastifyRequest, orgId: string, names: string[], query: Record<string, unknown>): Promise<ResolvedRealtimeChannel[]> {
  return Promise.all(names.map(async name => {
    const at = name.indexOf(":");
    const kind = at < 0 ? name : name.slice(0, at);
    const factory = channelKinds.get(kind);
    if (!factory) return { name, error: "unknown_channel" };
    try { return { name, open: await factory(request, { orgId, id: at < 0 ? "" : name.slice(at + 1), query }) }; }
    catch (error) { return { name, error: String((error as { code?: unknown })?.code || "channel_refused") }; }
  }));
}

function encodeChannel(name: string, event: string, data: unknown) {
  return `event: channel\ndata: ${JSON.stringify({ channel: name, event, data: data ?? null })}\n\n`;
}

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
function delivers(connection: Connection, event: RealtimeEvent) {
  return connection.events && eventVisibleTo(event, connection.userId);
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
    if (delivers(connection, event)) connection.write(encodeSse(event));
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
  options: { orgId: string; userId: string; after: number; channels?: ResolvedRealtimeChannel[]; events?: boolean }
) {
  const { orgId, userId, after } = options;
  const events = options.events !== false;
  // Fetch before sending headers so database failures remain normal API errors.
  const catchUp = events ? await pollRealtimeEvents(orgId, userId, after) : { events: [] as RealtimeEvent[], next: orgStream(orgId).seq, resync: false };
  const stream = orgStream(orgId);
  if (events && ![...stream.connections.values()].some(connection => connection.events)) stream.seq = catchUp.next;

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
  let closed = false;
  const stops: Array<() => void> = [];
  const connection: Connection = {
    id: connectionCounter,
    orgId,
    userId,
    events,
    write: (chunk) => {
      if (closed) return;
      // A page that stopped reading must not grow this process without bound.
      if (reply.raw.writableLength > 4 * 1024 * 1024) { connection.close(); return; }
      try {
        reply.raw.write(chunk);
      } catch {
        connection.close();
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      stream.connections.delete(connection.id);
      for (const stop of stops.splice(0)) { try { stop(); } catch { /* a channel's own cleanup */ } }
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
  if (events) for (const event of stream.buffer) {
    if (event.seq > catchUp.next && eventVisibleTo(event, userId)) connection.write(encodeSse(event));
  }
  request.raw.on("close", () => connection.close());
  // Channels start once the page is listening. Each is independent: one that
  // cannot start says so on the stream and the others carry on.
  for (const channel of options.channels || []) {
    const send: RealtimeChannelSend = (event, data) => connection.write(encodeChannel(channel.name, event, data));
    if (!channel.open) { send("error", { code: channel.error || "channel_refused" }); continue; }
    try {
      const stop = await channel.open(send, code => send("error", { code: code || "channel_ended" }));
      if (closed) stop(); else stops.push(stop);
    } catch (error) {
      send("error", { code: String((error as { code?: unknown })?.code || "channel_failed") });
    }
  }
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
  replicaPollTimer = setInterval(() => { void syncReplicaRealtime().catch(() => undefined); }, 250);
  replicaPollTimer.unref?.();
}

export async function syncReplicaRealtime() {
  if (replicaPollRunning) return;
  const cursors = [...streams.entries()].filter(([, stream]) => [...stream.connections.values()].some(connection => connection.events))
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
        for (const connection of stream.connections.values()) if (connection.events) connection.write(`id: ${page.next}\nevent: platform\ndata: ${JSON.stringify({ topic: "sys.resync", payload: {}, ts: new Date().toISOString() })}\n\n`);
      } else {
        for (const event of page.events) {
          if (event.seq <= stream.seq) continue;
          for (const connection of stream.connections.values()) if (delivers(connection, event)) connection.write(encodeSse(event));
        }
      }
      stream.seq = page.next;
      stream.buffer = [...stream.buffer, ...page.events].slice(-RING_BUFFER_SIZE);
    }
  } finally { replicaPollRunning = false; }
}
