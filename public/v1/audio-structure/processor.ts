import WebSocket from "ws";

import { env } from "../src/config/env.js";
import { PlatformError, badRequest } from "../platform/errors.js";

export type JsonSchema = Record<string, unknown>;
export type AudioStructureRequest<TContext = unknown> = {
  audio: Buffer;
  contentType?: string;
  fileName?: string;
  context: TContext;
};

export type AudioStructureProcessor<TContext = unknown, TResult = unknown> = {
  id: string;
  instructions: string;
  schema: JsonSchema;
  prompt(context: TContext): string;
  validate(value: unknown): TResult;
};

type ModelOptions = {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const processors = new Map<string, AudioStructureProcessor<unknown, unknown>>();

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export function registerAudioStructureProcessor<TContext, TResult>(
  processor: AudioStructureProcessor<TContext, TResult>
) {
  const id = clean(processor.id);
  if (!id) throw new Error("Audio structure processors require an id.");
  processors.set(id, processor as AudioStructureProcessor<unknown, unknown>);
  return processor;
}

export function audioStructureProcessor(id: string) {
  const processor = processors.get(clean(id));
  if (!processor) throw badRequest("audio_processor_unknown", "This audio processor is not registered.");
  return processor;
}

function audioFormat(contentType: string, fileName: string) {
  const type = clean(contentType).toLowerCase();
  const ext = clean(fileName).toLowerCase().split(".").pop();
  if (type.includes("wav") || ext === "wav") return "wav";
  if (type.includes("mpeg") || type.includes("mp3") || ext === "mp3") return "mp3";
  throw badRequest("audio_format_unsupported", "Structured audio currently accepts WAV or MP3 audio.");
}

function parseFunctionArguments(value: unknown) {
  try {
    const parsed = JSON.parse(clean(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new PlatformError("audio_structure_invalid", 502, "The audio model returned invalid structured data.");
  }
}

async function chatCompletion(
  processor: AudioStructureProcessor,
  request: AudioStructureRequest,
  options: Required<Pick<ModelOptions, "apiKey" | "model" | "timeoutMs">> & Pick<ModelOptions, "fetchImpl">
) {
  const format = audioFormat(clean(request.contentType), clean(request.fileName));
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        modalities: ["text"],
        messages: [{
          role: "user",
          content: [
            { type: "text", text: processor.prompt(request.context) },
            { type: "input_audio", input_audio: { data: request.audio.toString("base64"), format } }
          ]
        }],
        tools: [{
          type: "function",
          function: {
            name: "submit_structured_audio_result",
            description: processor.instructions,
            parameters: processor.schema
          }
        }],
        tool_choice: { type: "function", function: { name: "submit_structured_audio_result" } },
        temperature: 0
      })
    });
    const raw = await response.text();
    let json: any = null;
    try { json = JSON.parse(raw); } catch { /* handled below */ }
    if (!response.ok) {
      throw new PlatformError(
        "audio_structure_provider_error",
        response.status >= 500 ? 502 : response.status,
        clean(json?.error?.message) || "The audio model request failed."
      );
    }
    const call = json?.choices?.[0]?.message?.tool_calls?.find(
      (entry: any) => entry?.function?.name === "submit_structured_audio_result"
    );
    if (!call) throw new PlatformError("audio_structure_missing_result", 502, "The audio model did not return a structured result.");
    return parseFunctionArguments(call.function.arguments);
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new PlatformError("audio_structure_timeout", 504, "The audio model took too long to respond.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function wavToPcm24k(bytes: Buffer) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw badRequest("audio_format_unsupported", "Realtime structured audio requires a PCM WAV recording.");
  }
  let offset = 12;
  let formatOffset = -1;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") formatOffset = offset + 8;
    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(size, bytes.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (formatOffset < 0 || dataOffset < 0) throw badRequest("audio_wav_invalid", "The WAV recording is missing audio data.");
  const audioFormat = bytes.readUInt16LE(formatOffset);
  const channels = bytes.readUInt16LE(formatOffset + 2);
  const sampleRate = bytes.readUInt32LE(formatOffset + 4);
  const bits = bytes.readUInt16LE(formatOffset + 14);
  if (audioFormat !== 1 || bits !== 16 || !channels || !sampleRate) {
    throw badRequest("audio_wav_invalid", "The WAV recording must use 16-bit PCM audio.");
  }
  const frames = Math.floor(dataLength / (channels * 2));
  if (!frames) throw badRequest("audio_wav_invalid", "The WAV recording does not contain any audio samples.");
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += bytes.readInt16LE(dataOffset + ((frame * channels + channel) * 2));
    }
    mono[frame] = Math.round(sum / channels);
  }
  const outputFrames = Math.max(1, Math.round(frames * 24_000 / sampleRate));
  const output = Buffer.allocUnsafe(outputFrames * 2);
  for (let index = 0; index < outputFrames; index += 1) {
    const source = index * sampleRate / 24_000;
    const left = Math.min(frames - 1, Math.floor(source));
    const right = Math.min(frames - 1, left + 1);
    const leftValue = mono[left] ?? 0;
    const rightValue = mono[right] ?? leftValue;
    const value = Math.round(leftValue + ((rightValue - leftValue) * (source - left)));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2);
  }
  return output;
}

async function realtimeCompletion(
  processor: AudioStructureProcessor,
  request: AudioStructureRequest,
  options: Required<Pick<ModelOptions, "apiKey" | "model" | "timeoutMs">>
) {
  const pcm = wavToPcm24k(request.audio);
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model)}`,
      { headers: { Authorization: `Bearer ${options.apiKey}` } }
    );
    let settled = false;
    const finish = (error?: unknown, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const timer = setTimeout(
      () => finish(new PlatformError("audio_structure_timeout", 504, "The audio model took too long to respond.")),
      options.timeoutMs
    );
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["text"],
          instructions: processor.instructions,
          audio: { input: { format: { type: "audio/pcm", rate: 24_000 }, turn_detection: null } },
          tools: [{
            type: "function",
            name: "submit_structured_audio_result",
            description: processor.instructions,
            parameters: processor.schema
          }],
          tool_choice: "required"
        }
      }));
      socket.send(JSON.stringify({ type: "conversation.item.create", item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: processor.prompt(request.context) }]
      } }));
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
      socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      socket.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["text"] } }));
    });
    socket.on("message", (raw) => {
      let event: any;
      try { event = JSON.parse(String(raw)); } catch { return; }
      if (event.type === "response.function_call_arguments.done" && event.name === "submit_structured_audio_result") {
        try { finish(undefined, parseFunctionArguments(event.arguments)); } catch (error) { finish(error); }
      } else if (event.type === "error") {
        finish(new PlatformError("audio_structure_provider_error", 502, clean(event.error?.message) || "The audio model request failed."));
      } else if (event.type === "response.done" && event.response?.status === "failed") {
        finish(new PlatformError("audio_structure_provider_error", 502, clean(event.response?.status_details?.error?.message) || "The audio model request failed."));
      }
    });
    socket.on("error", (error) => finish(new PlatformError("audio_structure_provider_error", 502, error.message)));
    socket.on("close", () => {
      if (!settled) finish(new PlatformError("audio_structure_missing_result", 502, "The audio model closed without a structured result."));
    });
  });
}

export async function processStructuredAudio<TContext, TResult>(
  processorValue: AudioStructureProcessor<TContext, TResult> | string,
  request: AudioStructureRequest<TContext>,
  options: ModelOptions = {}
) {
  if (!request.audio?.length) throw badRequest("missing_audio", "An audio file is required.");
  if (request.audio.length > 20 * 1024 * 1024) throw badRequest("audio_too_large", "Structured audio recordings cannot exceed 20 MB.");
  const processor = typeof processorValue === "string"
    ? audioStructureProcessor(processorValue) as AudioStructureProcessor<TContext, TResult>
    : processorValue;
  const apiKey = clean(options.apiKey ?? env.openaiApiKey);
  const model = clean(options.model ?? env.openaiAudioStructureModel);
  const timeoutMs = options.timeoutMs ?? env.openaiAudioStructureTimeoutMs;
  if (!apiKey) throw new PlatformError("audio_structure_not_configured", 503, "Structured audio is not configured.");
  const raw = model.startsWith("gpt-realtime")
    ? await realtimeCompletion(processor, request, { apiKey, model, timeoutMs })
    : await chatCompletion(processor, request, { apiKey, model, timeoutMs, fetchImpl: options.fetchImpl });
  return processor.validate(raw);
}
