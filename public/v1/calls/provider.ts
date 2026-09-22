import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { TrackSource } from "@livekit/protocol";

import { env } from "../src/config/env.js";
import { PlatformError } from "../platform/errors.js";
import type { JsonObject } from "./storage.js";

export type CallsProviderName = "browser-peer" | "livekit";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function parsedIceServers() {
  try {
    const parsed = JSON.parse(env.callsIceServersJson || "[]");
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // A malformed deployment value fails below in production instead of
    // silently advertising unusable relay credentials.
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

function liveKitConfigured() {
  return Boolean(env.livekitUrl && env.livekitApiKey && env.livekitApiSecret);
}

export function callsProviderName(): CallsProviderName {
  return env.callsProvider === "livekit" ? "livekit" : "browser-peer";
}

export function callsProviderStatus() {
  const provider = callsProviderName();
  const iceServers = parsedIceServers();
  const hasTurn = iceServers.some((entry) => {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    return urls.some((url: unknown) => /^turns?:/i.test(cleanText(url)));
  });
  return {
    provider,
    configured: provider === "livekit" ? liveKitConfigured() : (!env.isProduction || hasTurn),
    production_ready: provider === "livekit" ? liveKitConfigured() : hasTurn,
    client_recording: true,
    server_recording: false,
    egress_storage_configured: provider === "livekit" && Boolean(env.callsRecordingBucket),
    turn_configured: provider === "livekit" ? liveKitConfigured() : hasTurn
  };
}

function requireLiveKit() {
  if (!liveKitConfigured()) {
    throw new PlatformError(
      "calls_provider_not_configured",
      503,
      "The production call provider is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET."
    );
  }
}

function roomService() {
  requireLiveKit();
  return new RoomServiceClient(
    env.livekitUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"),
    env.livekitApiKey,
    env.livekitApiSecret
  );
}

export async function prepareProviderRoom(room: JsonObject) {
  if (callsProviderName() !== "livekit") return;
  const service = roomService();
  try {
    await service.createRoom({
      name: cleanText(room.provider_room_name),
      emptyTimeout: env.callsRoomEmptyTimeoutSeconds,
      maxParticipants: env.callsMaxParticipants,
      metadata: JSON.stringify({
        firstmate_room_id: room.id,
        organization_id: room.organization_id,
        context_type: room.context_type,
        context_id: room.context_id,
        recording_mode: room.recording_mode
      })
    });
  } catch (error) {
    // LiveKit's create-room operation is idempotent from FirstMate's point of
    // view; an existing room with this deterministic name is safe to reuse.
    if (!/already exists|already_exist|duplicate/i.test(String((error as Error)?.message || error))) throw error;
  }
}

export async function providerJoinConfiguration(room: JsonObject, user: { id: string; name: string }) {
  const provider = callsProviderName();
  if (provider === "browser-peer") {
    const status = callsProviderStatus();
    if (env.isProduction && !status.production_ready) {
      throw new PlatformError(
        "calls_turn_not_configured",
        503,
        "Calls require a TURN relay in production. Configure CALLS_ICE_SERVERS_JSON or use the LiveKit provider."
      );
    }
    return {
      mode: "browser-peer",
      room: cleanText(room.id),
      ice_servers: parsedIceServers(),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      production_ready: status.production_ready
    };
  }

  requireLiveKit();
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: user.id,
    name: user.name,
    ttl: "10m",
    metadata: JSON.stringify({
      firstmate_room_id: room.id,
      organization_id: room.organization_id
    })
  });
  token.addGrant({
    roomJoin: true,
    room: cleanText(room.provider_room_name),
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
    canPublishSources: room.allow_video
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
      : [TrackSource.MICROPHONE]
  });
  return {
    mode: "livekit",
    room: cleanText(room.provider_room_name),
    url: env.livekitUrl,
    token: await token.toJwt(),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    production_ready: true,
    client_recording: true,
    server_recording: false,
    egress_storage_configured: Boolean(env.callsRecordingBucket)
  };
}

export async function closeProviderRoom(room: JsonObject) {
  if (callsProviderName() !== "livekit") return;
  try {
    await roomService().deleteRoom(cleanText(room.provider_room_name));
  } catch (error) {
    if (!/not found|not_found/i.test(String((error as Error)?.message || error))) throw error;
  }
}

export async function removeProviderParticipant(room: JsonObject, userId: string) {
  if (room.provider !== "livekit") return;
  try {
    await roomService().removeParticipant(cleanText(room.provider_room_name), userId);
  } catch (error) {
    if (!/not found|not_found/i.test(String((error as Error)?.message || error))) throw error;
  }
}
