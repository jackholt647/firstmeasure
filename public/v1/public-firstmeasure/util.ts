import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function numericValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function moneyAmount(value: unknown) {
  return Math.round(numericValue(value) * 100) / 100;
}

export function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseBoolean(value: unknown, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

export function normalizeId(value: unknown, label = "id") {
  const normalized = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function publicBaseUrl(request: { headers: Record<string, unknown>; protocol?: string }) {
  const forwardedHost = cleanText(request.headers["x-forwarded-host"]);
  const host = forwardedHost || cleanText(request.headers.host);
  const proto = cleanText(request.headers["x-forwarded-proto"]) || request.protocol || "http";
  return host ? `${proto}://${host}` : "";
}

export function maybeJson(text: string) {
  try {
    return text ? JSON.parse(text) as unknown : null;
  } catch {
    return null;
  }
}

