import { randomUUID } from "node:crypto";
import path from "node:path";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";

import { env } from "../src/config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";

export type JsonObject = Record<string, unknown>;
export type CallRecordingMode = "off" | "audio" | "video";

let database: SqlStore | null = null;
let databasePath = "";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function parseJson(value: unknown, fallback: unknown) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function rowObject(row: JsonObject): JsonObject {
  const result = { ...row };
  for (const [source, target, fallback] of [
    ["settings_json", "settings", {}],
    ["metadata_json", "metadata", {}]
  ] as const) {
    if (source in result) {
      result[target] = parseJson(result[source], fallback);
      delete result[source];
    }
  }
  return result;
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.callsStorageRoot, "calls.sqlite");
}

export async function closeCallsDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}
export function getCallsDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeCallsDatabase();
  database = openSqlStore({ id: "calls", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}
async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS call_rooms (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      thread_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      provider TEXT NOT NULL,
      provider_room_name TEXT NOT NULL,
      started_by TEXT NOT NULL,
      recording_mode TEXT NOT NULL DEFAULT 'off',
      allow_video INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS call_rooms_active_context_uq
      ON call_rooms(organization_id, context_type, context_id)
      WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS call_rooms_org_started_idx
      ON call_rooms(organization_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS call_participants (
      room_id TEXT NOT NULL REFERENCES call_rooms(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'participant',
      microphone_enabled INTEGER NOT NULL DEFAULT 1,
      camera_enabled INTEGER NOT NULL DEFAULT 0,
      screen_enabled INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS call_participants_org_user_idx
      ON call_participants(organization_id, user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS call_signals (
      ${db.isPostgres ? "seq BIGSERIAL PRIMARY KEY" : "seq INTEGER PRIMARY KEY AUTOINCREMENT"},
      id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL REFERENCES call_rooms(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      sender_peer_id TEXT NOT NULL,
      target_peer_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS call_signals_poll_idx ON call_signals(room_id, seq);

    CREATE TABLE IF NOT EXISTS call_artifacts (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES call_rooms(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      media_id TEXT,
      attachment_id TEXT,
      provider_asset_id TEXT,
      content_type TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS call_artifacts_room_idx ON call_artifacts(room_id, created_at);

    CREATE TABLE IF NOT EXISTS call_events (
      ${db.isPostgres ? "seq BIGSERIAL PRIMARY KEY" : "seq INTEGER PRIMARY KEY AUTOINCREMENT"},
      id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL REFERENCES call_rooms(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS call_events_org_idx ON call_events(organization_id, created_at DESC);
  `));

}


async function participants(roomId: string) {
  return ((await getCallsDatabase().prepare(`
    SELECT * FROM call_participants WHERE room_id = ? ORDER BY joined_at
  `).all(roomId)) as JsonObject[]).map((row) => ({
    ...row,
    microphone_enabled: Boolean(row.microphone_enabled),
    camera_enabled: Boolean(row.camera_enabled),
    screen_enabled: Boolean(row.screen_enabled)
  }));
}

export async function roomRecord(orgId: string, roomId: string): Promise<JsonObject> {
  const row = (await getCallsDatabase().prepare(`
    SELECT * FROM call_rooms WHERE id = ? AND organization_id = ?
  `).get(roomId, orgId)) as JsonObject | undefined;
  if (!row) throw notFound("call_room_not_found", "This call does not exist.");
  return {
    ...rowObject(row),
    allow_video: Boolean(row.allow_video),
    participants: (await participants(roomId))
  };
}

export async function activeRoomForContext(orgId: string, contextType: string, contextId: string): Promise<JsonObject | null> {
  const row = (await getCallsDatabase().prepare(`
    SELECT id FROM call_rooms
    WHERE organization_id = ? AND context_type = ? AND context_id = ? AND state = 'active'
    ORDER BY started_at DESC LIMIT 1
  `).get(orgId, cleanText(contextType), cleanText(contextId))) as JsonObject | undefined;
  return row?.id ? (await roomRecord(orgId, cleanText(row.id))) : null;
}

export async function createRoomRecord(input: {
  organization_id: string;
  context_type: string;
  context_id: string;
  thread_id?: string;
  title?: string;
  provider: string;
  started_by: string;
  recording_mode: CallRecordingMode;
  allow_video: boolean;
  settings?: JsonObject;
}) {
  return (await getCallsDatabase().transaction(async () => {
  const existing = (await activeRoomForContext(input.organization_id, input.context_type, input.context_id));
  if (existing) return existing;
  const id = `call_${randomUUID()}`;
  const now = nowIso();
  const providerRoomName = `fm_${input.organization_id}_${id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  (await getCallsDatabase().prepare(`
    INSERT INTO call_rooms
      (id, organization_id, context_type, context_id, thread_id, title, state, provider,
       provider_room_name, started_by, recording_mode, allow_video, started_at,
       settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.organization_id,
    cleanText(input.context_type),
    cleanText(input.context_id),
    cleanText(input.thread_id) || null,
    cleanText(input.title),
    cleanText(input.provider),
    providerRoomName,
    input.started_by,
    input.recording_mode,
    input.allow_video ? 1 : 0,
    now,
    json(input.settings),
    now,
    now
  ));
  (await appendEventRecord(input.organization_id, id, "call_started", input.started_by, {
    context_type: input.context_type,
    context_id: input.context_id,
    recording_mode: input.recording_mode
  }));
  return (await roomRecord(input.organization_id, id));

  }));
}

export async function updateRoomThread(orgId: string, roomId: string, threadId: string) {
  return (await getCallsDatabase().transaction(async () => {
  (await getCallsDatabase().prepare(`
    UPDATE call_rooms SET thread_id = ?, updated_at = ? WHERE id = ? AND organization_id = ?
  `).run(cleanText(threadId) || null, nowIso(), roomId, orgId));
  return (await roomRecord(orgId, roomId));

  }));
}

export async function joinRoomRecord(orgId: string, roomId: string, userId: string, displayName = "") {
  return (await getCallsDatabase().transaction(async () => {
  const room = (await roomRecord(orgId, roomId));
  if (room.state !== "active") throw badRequest("call_not_active", "This call has ended.");
  if ((room.participants as JsonObject[]).some(item => item.user_id === userId && item.role === "removed")) {
    throw forbidden("call_removed", "The host removed you from this call.");
  }
  const now = nowIso();
  (await getCallsDatabase().prepare(`
    INSERT INTO call_participants
      (room_id, organization_id, user_id, display_name, role, joined_at, left_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT (room_id, user_id) DO UPDATE SET
      display_name = excluded.display_name,
      left_at = NULL,
      updated_at = excluded.updated_at
  `).run(roomId, orgId, userId, cleanText(displayName), room.started_by === userId ? "host" : "participant", now, now));
  (await appendEventRecord(orgId, roomId, "participant_joined", userId));
  return (await roomRecord(orgId, roomId));

  }));
}

export async function updateParticipantMediaRecord(
  orgId: string,
  roomId: string,
  userId: string,
  state: { microphone_enabled?: boolean; camera_enabled?: boolean; screen_enabled?: boolean }
) {
  return (await getCallsDatabase().transaction(async () => {
  (await roomRecord(orgId, roomId));
  const current = (await getCallsDatabase().prepare(`
    SELECT * FROM call_participants WHERE room_id = ? AND organization_id = ? AND user_id = ?
  `).get(roomId, orgId, userId)) as JsonObject | undefined;
  if (!current || current.left_at) throw notFound("call_participant_not_found", "Join the call before changing media state.");
  (await getCallsDatabase().prepare(`
    UPDATE call_participants
    SET microphone_enabled = ?, camera_enabled = ?, screen_enabled = ?, updated_at = ?
    WHERE room_id = ? AND organization_id = ? AND user_id = ?
  `).run(
    (state.microphone_enabled ?? Boolean(current.microphone_enabled)) ? 1 : 0,
    (state.camera_enabled ?? Boolean(current.camera_enabled)) ? 1 : 0,
    (state.screen_enabled ?? Boolean(current.screen_enabled)) ? 1 : 0,
    nowIso(),
    roomId,
    orgId,
    userId
  ));
  return (await roomRecord(orgId, roomId));

  }));
}

export async function leaveRoomRecord(orgId: string, roomId: string, userId: string) {
  return (await getCallsDatabase().transaction(async () => {
  (await roomRecord(orgId, roomId));
  const now = nowIso();
  (await getCallsDatabase().prepare(`
    UPDATE call_participants SET left_at = ?, updated_at = ?
    WHERE room_id = ? AND organization_id = ? AND user_id = ?
  `).run(now, now, roomId, orgId, userId));
  (await appendEventRecord(orgId, roomId, "participant_left", userId));
  return (await roomRecord(orgId, roomId));

  }));
}

export async function removeParticipantRecord(orgId: string, roomId: string, hostId: string, userId: string) {
  return (await getCallsDatabase().transaction(async () => {
  const room = (await roomRecord(orgId, roomId));
  if (room.started_by !== hostId) throw forbidden("call_host_required", "Only the host can remove participants.");
  if (userId === hostId) throw badRequest("call_remove_self", "Use Leave to leave your call.");
  if (room.state !== "active") throw badRequest("call_not_active", "This call has ended.");
  const now = nowIso();
  (await getCallsDatabase().prepare(`UPDATE call_participants SET role = 'removed', left_at = ?, updated_at = ?, microphone_enabled = 0, camera_enabled = 0, screen_enabled = 0 WHERE room_id = ? AND organization_id = ? AND user_id = ?`).run(now, now, roomId, orgId, userId));
  (await appendEventRecord(orgId, roomId, "participant_removed", hostId, { user_id:userId }));
  return (await roomRecord(orgId, roomId));

  }));
}

export async function endRoomRecord(orgId: string, roomId: string, userId: string) {
  return (await getCallsDatabase().transaction(async () => {
  const room = (await roomRecord(orgId, roomId));
  if (cleanText(room.started_by) !== userId) {
    throw badRequest("call_owner_required", "Only the person who started this call can end it for everyone.");
  }
  if (room.state === "ended") return room;
  const now = nowIso();
  const db = getCallsDatabase();
  (await db.prepare(`
    UPDATE call_rooms SET state = 'ended', ended_at = ?, updated_at = ?
    WHERE id = ? AND organization_id = ?
  `).run(now, now, roomId, orgId));
  (await db.prepare(`
    UPDATE call_participants SET left_at = COALESCE(left_at, ?), updated_at = ?
    WHERE room_id = ? AND organization_id = ?
  `).run(now, now, roomId, orgId));
  (await appendEventRecord(orgId, roomId, "call_ended", userId));
  return (await roomRecord(orgId, roomId));

  }));
}

export async function createSignalRecord(
  orgId: string,
  roomId: string,
  senderPeerId: string,
  kind: string,
  payload: JsonObject,
  targetPeerId?: string
) {
  return (await getCallsDatabase().transaction(async () => {
  const room = (await roomRecord(orgId, roomId));
  if (room.state !== "active") throw badRequest("call_not_active", "This call has ended.");
  const id = `signal_${randomUUID()}`;
  const now = nowIso();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  const db = getCallsDatabase();
  (await db.prepare(`
    INSERT INTO call_signals
      (id, room_id, organization_id, sender_peer_id, target_peer_id, kind, payload_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, roomId, orgId, cleanText(senderPeerId), cleanText(targetPeerId) || null, cleanText(kind), json(payload), now, expires));
  (await db.prepare("DELETE FROM call_signals WHERE expires_at < ?").run(now));
  return { id, room_id: roomId, sender_peer_id: senderPeerId, target_peer_id: cleanText(targetPeerId) || null, kind, payload, created_at: now };

  }));
}

export async function listSignalRecords(orgId: string, roomId: string, afterSeq: number, peerId: string): Promise<JsonObject[]> {
  (await roomRecord(orgId, roomId));
  const rows = (await getCallsDatabase().prepare(`
    SELECT * FROM call_signals
    WHERE organization_id = ? AND room_id = ? AND seq > ?
      AND sender_peer_id <> ?
      AND (target_peer_id IS NULL OR target_peer_id = ?)
      AND expires_at >= ?
    ORDER BY seq ASC LIMIT 200
  `).all(orgId, roomId, Math.max(0, afterSeq), peerId, peerId, nowIso())) as JsonObject[];
  return rows.map((row) => ({ ...row, seq: Number(row.seq), payload: parseJson(row.payload_json, {}) }));
}

export async function createArtifactRecord(input: {
  organization_id: string;
  room_id: string;
  kind: "audio_recording" | "video_recording" | "transcript" | "notes";
  media_id?: string;
  attachment_id?: string;
  provider_asset_id?: string;
  content_type?: string;
  duration_ms?: number;
  metadata?: JsonObject;
}) {
  return (await getCallsDatabase().transaction(async () => {
  (await roomRecord(input.organization_id, input.room_id));
  const db = getCallsDatabase();
  if (input.attachment_id) {
    const existing = (await db.prepare(`
      SELECT id FROM call_artifacts WHERE room_id = ? AND attachment_id = ? LIMIT 1
    `).get(input.room_id, input.attachment_id)) as JsonObject | undefined;
    if (existing?.id) return (await artifactRecord(input.organization_id, cleanText(existing.id)));
  }
  const id = `call_artifact_${randomUUID()}`;
  const now = nowIso();
  (await db.prepare(`
    INSERT INTO call_artifacts
      (id, room_id, organization_id, kind, status, media_id, attachment_id,
       provider_asset_id, content_type, duration_ms, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.room_id,
    input.organization_id,
    input.kind,
    cleanText(input.media_id) || null,
    cleanText(input.attachment_id) || null,
    cleanText(input.provider_asset_id) || null,
    cleanText(input.content_type),
    Number.isFinite(input.duration_ms) ? Math.max(0, Number(input.duration_ms)) : null,
    json(input.metadata),
    now,
    now
  ));
  (await appendEventRecord(input.organization_id, input.room_id, "recording_ready", null, {
    artifact_id: id,
    kind: input.kind
  }));
  return (await artifactRecord(input.organization_id, id));

  }));
}

export async function artifactRecord(orgId: string, artifactId: string) {
  const row = (await getCallsDatabase().prepare(`
    SELECT * FROM call_artifacts WHERE id = ? AND organization_id = ?
  `).get(artifactId, orgId)) as JsonObject | undefined;
  if (!row) throw notFound("call_artifact_not_found", "This call artifact does not exist.");
  return rowObject(row);
}

export async function listArtifacts(orgId: string, roomId: string) {
  (await roomRecord(orgId, roomId));
  return ((await getCallsDatabase().prepare(`
    SELECT * FROM call_artifacts WHERE organization_id = ? AND room_id = ? ORDER BY created_at
  `).all(orgId, roomId)) as JsonObject[]).map(rowObject);
}

export async function appendEventRecord(orgId: string, roomId: string, kind: string, actorId: string | null, metadata: JsonObject = {}) {
  return (await getCallsDatabase().transaction(async () => {
  const id = `call_event_${randomUUID()}`;
  const now = nowIso();
  (await getCallsDatabase().prepare(`
    INSERT INTO call_events (id, room_id, organization_id, kind, actor_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, roomId, orgId, cleanText(kind), cleanText(actorId) || null, json(metadata), now));
  return { id, room_id: roomId, organization_id: orgId, kind, actor_id: cleanText(actorId) || null, metadata, created_at: now };

  }));
}

export async function listEvents(orgId: string, options: { roomId?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
  const rows = options.roomId
    ? (await getCallsDatabase().prepare(`
        SELECT * FROM call_events WHERE organization_id = ? AND room_id = ? ORDER BY created_at DESC LIMIT ?
      `).all(orgId, options.roomId, limit)) as JsonObject[]
    : (await getCallsDatabase().prepare(`
        SELECT * FROM call_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?
      `).all(orgId, limit)) as JsonObject[];
  return rows.map(rowObject);
}

export function assertRoomContext(room: JsonObject, contextType: string, contextId: string) {
  if (cleanText(room.context_type) !== cleanText(contextType) || cleanText(room.context_id) !== cleanText(contextId)) {
    throw conflict("call_context_mismatch", "This call belongs to a different application context.");
  }
}
