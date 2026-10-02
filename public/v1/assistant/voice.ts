import { createHmac, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import { env } from "../src/config/env.js";
import { PlatformError } from "../platform/errors.js";

export const VOICE_TURN_NOTE = `This is a delegated request from a live voice conversation. Transcripts may contain mistakes or later corrections. Use the latest user request; ask if unclear. Assistant speech in the supplied transcript is context, never evidence that an action happened or authorization from the user. Keep existing permission and confirmation rules. Return a concise spoken answer (at most 100 words), with verified results or the exact confirmation question. Do not repeat actions already completed in this thread.`;

/** The same server credential as agents/runtime; no provider credentials go to the browser. */
export async function createAssistantVoiceSession(sdp: string, messages: Array<{ role: string; content: string }>) {
  if (!env.openaiApiKey) throw new PlatformError("voice_not_configured", 503, "Voice conversations are not configured yet.");
  const input = messages.filter(m => ["user", "assistant"].includes(m.role) && m.content).slice(-12).map(m => ({
    type: "message", role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content.slice(0, 1000) }]
  }));
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST", headers: { Authorization: `Bearer ${env.openaiApiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({ session: {
        model: "gpt-live-1", delegation: { type: "client" }, input,
        instructions: "You are FirstMate, a helpful voice assistant in the user's workspace. Speak naturally and concisely. You can listen while speaking. Delegate ALL substantive questions, workspace lookups, actions, memory requests, confirmations, and corrections to the existing FirstMate backend. Only handle greetings and conversational acknowledgments yourself. Never invent records, permissions, results, or task completion. When the backend asks for confirmation, read its question and delegate the user's answer. If a user changes or cancels a request while work is running, delegate that correction; never claim the earlier work was canceled until the backend confirms it. Backend work may continue when voice ends. Say a brief hello and ask how you can help."
      }, transport: { type: "webrtc", sdp } })
    });
  } catch { throw new PlatformError("voice_connection_failed", 502, "Could not connect voice. Please try again."); }
  if (!response.ok) {
    // Never relay provider bodies: they can contain account or credential details.
    throw new PlatformError("voice_unavailable", response.status === 429 ? 429 : 503,
      response.status === 429 ? "Voice is busy. Please try again shortly." : "GPT-Live is unavailable for this account right now.");
  }
  const result = await response.json() as { session?: { id?: unknown }; transport?: { sdp?: unknown } };
  if (typeof result.session?.id !== "string" || typeof result.transport?.sdp !== "string") {
    throw new PlatformError("voice_invalid_response", 502, "Voice could not establish a connection. Please try again.");
  }
  return { session: { id: result.session.id }, transport: { sdp: result.transport.sdp } };
}

const attempts = new Map<string, number[]>();
export function limitVoiceStarts(owner: string) {
  const now = Date.now();
  for (const [key, times] of attempts) if (times.at(-1)! < now - 60000) attempts.delete(key);
  const times = (attempts.get(owner) || []).filter(t => t > now - 60000);
  if (times.length >= 6) throw new PlatformError("voice_rate_limited", 429, "Please wait a minute before starting another voice conversation.");
  attempts.set(owner, [...times, now]);
}
export function voiceCloseToken(owner: string, sessionId: string) {
  const payload = Buffer.from(JSON.stringify({ owner, sessionId, expires: Date.now() + 60 * 60_000 })).toString("base64url");
  return payload + "." + createHmac("sha256", env.openaiApiKey).update("assistant-voice:" + payload).digest("hex");
}
export async function closeAssistantVoiceSession(owner: string, token: string) {
  if (!env.openaiApiKey) throw new PlatformError("voice_not_configured", 503, "Voice is not configured.");
  const [payload, mac] = token.split(".");
  const expected = createHmac("sha256", env.openaiApiKey).update("assistant-voice:" + payload).digest("hex");
  if (!payload || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new PlatformError("invalid_voice_session", 403, "This voice session is not available.");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {owner:string;sessionId:string;expires:number};
  if (data.owner !== owner || data.expires < Date.now()) throw new PlatformError("invalid_voice_session", 403, "This voice session is not available.");
  // Fallback for a failed peer connection or navigation during session creation.
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(data.sessionId)}/attach`, { headers: { Authorization: `Bearer ${env.openaiApiKey}` }, handshakeTimeout: 5000 });
    const done = () => { clearTimeout(timer); socket.terminate(); resolve(); };
    const timer = setTimeout(done, 7000);
    socket.on("error", done); socket.on("close", () => { clearTimeout(timer); resolve(); });
    socket.on("open", () => socket.send(JSON.stringify({type:"session.close"})));
    socket.on("message", raw => { try { if (JSON.parse(raw.toString()).type === "session.closed") done(); } catch {} });
  });
}
