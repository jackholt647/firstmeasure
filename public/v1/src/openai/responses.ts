import { env } from "../config/env.js";

export type OpenAIJson = Record<string, unknown>;

export type OpenAIResponseResult = {
  ok: boolean;
  status: number;
  json: OpenAIJson | null;
  raw: string;
  error: string;
};

export type OpenAIResponseOptions = {
  apiKey?: string;
  timeoutMs?: number;
};

function asObject(value: unknown): OpenAIJson {
  return value && typeof value === "object" && !Array.isArray(value) ? value as OpenAIJson : {};
}

export function openAIResponseText(response: OpenAIJson | null | undefined) {
  if (!response) return "";
  if (typeof response.output_text === "string") return response.output_text.trim();
  const output = Array.isArray(response.output) ? response.output : [];
  return output.map((item) => {
    const content = Array.isArray(asObject(item).content) ? asObject(item).content as unknown[] : [];
    return content.map((part) => String(asObject(part).text ?? "").trim()).filter(Boolean).join("\n");
  }).filter(Boolean).join("\n").trim();
}

export function parseOpenAIJsonOutput(response: OpenAIJson | null | undefined) {
  const text = openAIResponseText(response);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as OpenAIJson : null;
  } catch {
    return null;
  }
}

export function openAIErrorMessage(result: Pick<OpenAIResponseResult, "json" | "error" | "status">, fallback = "OpenAI request failed.") {
  const message = String(asObject(result.json?.error).message ?? result.error ?? "").trim();
  return message || (result.status ? `${fallback} (${result.status})` : fallback);
}

export function isRetryableOpenAIStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function requestOpenAIResponse(payload: OpenAIJson, options: OpenAIResponseOptions = {}): Promise<OpenAIResponseResult> {
  const apiKey = String(options.apiKey ?? env.openaiApiKey ?? "").trim();
  if (!apiKey) return { ok: false, status: 0, json: null, raw: "", error: "OPENAI_API_KEY is not configured." };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(options.timeoutMs ?? 90_000)));
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const raw = await response.text();
    let json: OpenAIJson | null = null;
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as OpenAIJson : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok && Boolean(json),
      status: response.status,
      json,
      raw,
      error: response.ok ? (json ? "" : "OpenAI returned a non-JSON response.") : response.statusText
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      raw: "",
      error: error instanceof Error ? error.message : "OpenAI request failed."
    };
  } finally {
    clearTimeout(timeout);
  }
}
