import { env } from "../src/config/env.js";
import { PlatformError, badRequest } from "../platform/errors.js";

export const AUDIO_NOTE_MAX_BYTES = 25 * 1024 * 1024;
export const AUDIO_NOTE_MIME_TYPES = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/mpeg",
  "video/webm"
]);

export type TranscriptionInput = {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  language?: string;
  prompt?: string;
};

export type TranscriptionResult = {
  text: string;
  model: string;
  usage: unknown;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedFileName(value: unknown, contentType: string) {
  const name = clean(value).replace(/[\r\n"\\/]+/g, "_");
  if (name.includes(".")) return name;
  if (contentType.includes("webm")) return `${name || "audio-note"}.webm`;
  if (contentType.includes("ogg")) return `${name || "audio-note"}.ogg`;
  if (contentType.includes("wav")) return `${name || "audio-note"}.wav`;
  if (contentType.includes("mp4") || contentType.includes("m4a")) return `${name || "audio-note"}.m4a`;
  return `${name || "audio-note"}.mp3`;
}

export function validateAudio(input: TranscriptionInput) {
  if (!input.bytes.length) throw badRequest("missing_audio", "An audio file is required.");
  if (input.bytes.length > AUDIO_NOTE_MAX_BYTES) {
    throw new PlatformError("audio_too_large", 413, "Audio notes must be 25 MB or smaller.");
  }
  const contentType = clean(input.contentType).toLowerCase().split(";")[0] || "application/octet-stream";
  if (!AUDIO_NOTE_MIME_TYPES.has(contentType)) {
    throw badRequest("unsupported_audio_type", "Use an FLAC, MP3, MP4, M4A, OGG, WAV, MPEG, or WebM audio file.");
  }
  return {
    ...input,
    contentType,
    fileName: normalizedFileName(input.fileName, contentType)
  };
}

export async function transcribeAudio(
  rawInput: TranscriptionInput,
  options: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<TranscriptionResult> {
  const input = validateAudio(rawInput);
  const apiKey = clean(options.apiKey ?? env.openaiApiKey);
  if (!apiKey) throw new PlatformError("transcription_not_configured", 503, "Audio transcription is not configured.");

  const model = clean(options.model ?? env.openaiTranscriptionModel) || "gpt-4o-transcribe";
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(input.bytes)], { type: input.contentType }), input.fileName);
  form.append("model", model);
  form.append("response_format", "json");
  if (clean(input.language)) form.append("language", clean(input.language));
  if (clean(input.prompt)) form.append("prompt", clean(input.prompt).slice(0, 1000));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? env.openaiTranscriptionTimeoutMs);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new PlatformError("transcription_timeout", 504, "Audio transcription timed out.");
    }
    throw new PlatformError("transcription_unavailable", 502, "Audio transcription is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const providerError = payload.error && typeof payload.error === "object"
      ? clean((payload.error as Record<string, unknown>).message)
      : "";
    throw new PlatformError(
      "transcription_failed",
      response.status >= 500 ? 502 : 400,
      providerError || "OpenAI could not transcribe this audio."
    );
  }

  const text = clean(payload.text);
  if (!text) throw new PlatformError("empty_transcription", 422, "No speech was detected in this audio note.");
  return { text, model, usage: payload.usage ?? null };
}
