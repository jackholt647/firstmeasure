import type { PlatformAuthContext } from "../platform/auth.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { badRequest, forbidden } from "../platform/errors.js";
import {
  callsProviderName,
  callsProviderStatus,
  closeProviderRoom,
  prepareProviderRoom,
  providerJoinConfiguration
} from "./provider.js";
import { removeProviderParticipant } from "./provider.js";
import * as storage from "./storage.js";
import type { CallRecordingMode, JsonObject } from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function userDisplayName(ctx: PlatformAuthContext) {
  const user = asObject(ctx.user);
  const document = asObject(ctx.userDocument);
  const data = asObject(document.data);
  const identity = asObject(ctx.identity);
  return cleanText(user.name || data.name || identity.name || user.email || data.email || identity.email || ctx.userId);
}

async function recordingModeFor(
  orgId: string,
  requested: CallRecordingMode,
  capabilityGroup: "calls" | "channels"
): Promise<CallRecordingMode> {
  if (requested === "off") return "off";
  if (!(await isCapabilityEnabled(orgId, `${capabilityGroup}.recording`))) return "off";
  if (requested === "video" && await isCapabilityEnabled(orgId, `${capabilityGroup}.record_video`)) return "video";
  return "audio";
}

function withProvider(room: JsonObject): JsonObject {
  return { ...room, provider_status: callsProviderStatus() };
}

export async function createRoom(
  ctx: PlatformAuthContext,
  input: {
    context_type: string;
    context_id: string;
    thread_id?: string;
    title?: string;
    allow_video?: boolean;
    recording_mode?: CallRecordingMode;
    settings?: JsonObject;
  },
  options: { capabilityGroup?: "calls" | "channels" } = {}
) {
  const contextType = cleanText(input.context_type);
  const contextId = cleanText(input.context_id);
  if (!contextType || !contextId) throw badRequest("call_context_required", "A call must be attached to an application context.");
  const capabilityGroup = options.capabilityGroup || "calls";
  const recordingMode = await recordingModeFor(ctx.orgId, input.recording_mode || "off", capabilityGroup);
  const room = (await storage.createRoomRecord({
    organization_id: ctx.orgId,
    context_type: contextType,
    context_id: contextId,
    thread_id: input.thread_id,
    title: input.title,
    provider: callsProviderName(),
    started_by: ctx.userId,
    recording_mode: recordingMode,
    allow_video: input.allow_video !== false,
    settings: {
      ...(input.settings || {}),
      recording_requested: input.recording_mode || "off",
      recording_policy_group: capabilityGroup
    }
  }));
  await prepareProviderRoom(room);
  return withProvider(room);
}

export async function getRoom(ctx: PlatformAuthContext, roomId: string) {
  return withProvider((await storage.roomRecord(ctx.orgId, roomId)));
}

export async function joinRoom(ctx: PlatformAuthContext, roomId: string) {
  const room = (await storage.joinRoomRecord(ctx.orgId, roomId, ctx.userId, userDisplayName(ctx)));
  const connection = await providerJoinConfiguration(room, { id: ctx.userId, name: userDisplayName(ctx) });
  return { ...withProvider(room), connection };
}

export async function updateMediaState(
  ctx: PlatformAuthContext,
  roomId: string,
  state: { microphone_enabled?: boolean; camera_enabled?: boolean; screen_enabled?: boolean }
) {
  const room = (await storage.roomRecord(ctx.orgId, roomId));
  if (!room.allow_video && (state.camera_enabled || state.screen_enabled)) {
    throw badRequest("call_video_disabled", "Video is disabled for this call.");
  }
  return withProvider((await storage.updateParticipantMediaRecord(ctx.orgId, roomId, ctx.userId, state)));
}

export async function leaveRoom(ctx: PlatformAuthContext, roomId: string) {
  return withProvider((await storage.leaveRoomRecord(ctx.orgId, roomId, ctx.userId)));
}

export async function endRoom(ctx: PlatformAuthContext, roomId: string) {
  const room = (await storage.endRoomRecord(ctx.orgId, roomId, ctx.userId));
  await closeProviderRoom(room);
  return withProvider(room);
}

export async function removeParticipant(ctx: PlatformAuthContext, roomId: string, userId: string) {
  const room = (await storage.roomRecord(ctx.orgId, roomId));
  if (room.started_by !== ctx.userId) throw forbidden("call_host_required", "Only the host can remove participants.");
  if (userId === ctx.userId) throw badRequest("call_remove_self", "Use Leave to leave your call.");
  await removeProviderParticipant(room, userId);
  return withProvider((await storage.removeParticipantRecord(ctx.orgId, roomId, ctx.userId, userId)));
}

export async function postSignal(
  ctx: PlatformAuthContext,
  roomId: string,
  input: { sender_peer_id: string; target_peer_id?: string; kind: string; payload: JsonObject }
) {
  const room = (await storage.roomRecord(ctx.orgId, roomId));
  if (cleanText(room.provider) !== "browser-peer") {
    throw badRequest("call_signaling_managed", "This call provider manages signaling directly.");
  }
  const participant = (room.participants as JsonObject[]).find((item) => cleanText(item.user_id) === ctx.userId && !item.left_at);
  if (!participant) throw forbidden("call_join_required", "Join this call before sending signaling data.");
  return (await storage.createSignalRecord(
    ctx.orgId,
    roomId,
    input.sender_peer_id,
    input.kind,
    input.payload,
    input.target_peer_id
  ));
}

export async function listSignals(ctx: PlatformAuthContext, roomId: string, afterSeq: number, peerId: string) {
  const room = (await storage.roomRecord(ctx.orgId, roomId));
  if (!(room.participants as JsonObject[]).some(item => item.user_id === ctx.userId && !item.left_at)) throw forbidden("call_join_required", "Join this call before reading signaling data.");
  if (cleanText(room.provider) !== "browser-peer") return [];
  if (!cleanText(peerId)) throw badRequest("peer_id_required", "A call peer ID is required.");
  return (await storage.listSignalRecords(ctx.orgId, roomId, afterSeq, peerId));
}

export async function saveArtifact(
  ctx: PlatformAuthContext,
  roomId: string,
  input: {
    kind: "audio_recording" | "video_recording" | "transcript" | "notes";
    media_id?: string;
    attachment_id?: string;
    provider_asset_id?: string;
    content_type?: string;
    duration_ms?: number;
    metadata?: JsonObject;
  }
) {
  const room = (await storage.roomRecord(ctx.orgId, roomId));
  if (cleanText(room.started_by) !== ctx.userId) {
    throw forbidden("call_artifact_owner_required", "Only the call host can save a call recording.");
  }
  const mode = cleanText(room.recording_mode);
  if (input.kind === "video_recording" && mode !== "video") {
    throw forbidden("call_video_recording_disabled", "Video recording is disabled for this call.");
  }
  if (input.kind === "audio_recording" && !["audio", "video"].includes(mode)) {
    throw forbidden("call_recording_disabled", "Recording is disabled for this call.");
  }
  return (await storage.createArtifactRecord({
    organization_id: ctx.orgId,
    room_id: roomId,
    ...input
  }));
}

export async function listArtifacts(ctx: PlatformAuthContext, roomId: string) {
  return (await storage.listArtifacts(ctx.orgId, roomId));
}

export async function listEvents(ctx: PlatformAuthContext, options: { roomId?: string; limit?: number } = {}) {
  return (await storage.listEvents(ctx.orgId, options));
}

export async function setRoomThread(ctx: PlatformAuthContext, roomId: string, threadId: string) {
  return (await storage.updateRoomThread(ctx.orgId, roomId, threadId));
}
