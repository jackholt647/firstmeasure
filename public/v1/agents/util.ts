// Shared helpers for the agent framework. Every agent module used to
// redeclare these verbatim; they live here exactly once now.

import { badRequest } from "../platform/errors.js";

export type JsonObject = Record<string, unknown>;

export function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function asBoolean(value: unknown, fallback: boolean) {
  if (value === true || value === false) return value;
  return fallback;
}

export function truncateJson(value: unknown, max = 60_000) {
  const text = JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

export function parseJsonArg(value: unknown, label: string): JsonObject {
  if (value === undefined || value === null || value === "") return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    return parsed as JsonObject;
  } catch (error) {
    throw badRequest("agent_bad_json", `${label} is not valid JSON: ${String(asObject(error).message || error)}`);
  }
}

export function parseJsonValue(value: unknown, label: string): unknown {
  if (value === undefined || value === null || value === "") return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw badRequest("agent_bad_json", `${label} is not valid JSON: ${String(asObject(error).message || error)}`);
  }
}

/** Standard failed-tool-call shape: the model reads `errors` and explains. */
export function toolError(...errors: string[]): JsonObject {
  return { ok: false, errors };
}

export function errorMessage(error: unknown) {
  return String(asObject(error).message || error).slice(0, 2_000);
}

/** Truncates values for the persisted per-call trace. */
export function traceValue(value: unknown, max: number) {
  const serialized = JSON.stringify(value ?? null);
  return serialized.length > max ? `${serialized.slice(0, max)}...[truncated]` : value;
}

export function nowIso() {
  return new Date().toISOString();
}
