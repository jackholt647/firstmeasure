import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

const API_KEY_HASH_ENV = "FIRSTMEASURE_REMOTE_API_KEY_SHA256";
const ALLOWED_ORIGINS_ENV = "FIRSTMEASURE_REMOTE_ALLOWED_ORIGINS";
const ALLOWED_IPS_ENV = "FIRSTMEASURE_REMOTE_ALLOWED_IPS";

type RateEntry = { windowStartedAt: number; count: number };

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function csvSet(value: unknown) {
  return new Set(clean(value).split(",").map((item) => item.trim()).filter(Boolean));
}

function normalizedIp(value: unknown) {
  const ip = clean(value);
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function isLoopback(ip: string) {
  return ip === "127.0.0.1" || ip === "::1";
}

function requestClientIp(request: FastifyRequest) {
  const socketIp = normalizedIp(request.socket.remoteAddress || request.ip);
  // NGINX appends the actual peer to X-Forwarded-For. Use the last value so a
  // client-supplied leading entry cannot bypass the IP allowlist/rate limit.
  const forwardedValues = clean(request.headers["x-forwarded-for"]).split(",").map((value) => value.trim()).filter(Boolean);
  const forwarded = forwardedValues.at(-1) || "";
  return isLoopback(socketIp) && forwarded ? normalizedIp(forwarded) : socketIp;
}

function requestIsSecure(request: FastifyRequest) {
  const forwardedFor = clean(request.headers["x-forwarded-for"]);
  const forwardedProto = clean(request.headers["x-forwarded-proto"]).toLowerCase();
  if (forwardedFor) return forwardedProto === "https";
  return forwardedProto === "https" || (request.socket as { encrypted?: boolean }).encrypted === true || isLoopback(normalizedIp(request.socket.remoteAddress));
}

function configuredHash() {
  const value = clean(process.env[API_KEY_HASH_ENV]).toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : "";
}

function bearerToken(request: FastifyRequest) {
  const value = clean(request.headers.authorization);
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
}

function secureTokenMatches(token: string, expectedHex: string) {
  if (!token || token.length > 512 || !expectedHex) return false;
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reject(reply: FastifyReply, statusCode: number, error: string, message: string) {
  return reply.code(statusCode).send({ ok: false, error, message });
}

export function createRemoteRequestGuard() {
  const rate = new Map<string, RateEntry>();
  const failures = new Map<string, RateEntry>();

  function consume(map: Map<string, RateEntry>, key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const current = map.get(key);
    const next = !current || now - current.windowStartedAt >= windowMs
      ? { windowStartedAt: now, count: 1 }
      : { ...current, count: current.count + 1 };
    map.set(key, next);
    if (map.size > 5_000) {
      for (const [entryKey, entry] of map) {
        if (now - entry.windowStartedAt >= windowMs) map.delete(entryKey);
      }
    }
    return next.count <= limit;
  }

  return async function remoteRequestGuard(request: FastifyRequest, reply: FastifyReply) {
    const clientIp = requestClientIp(request) || "unknown";

    if (process.env.FIRSTMEASURE_REMOTE_REQUIRE_HTTPS !== "false" && !requestIsSecure(request)) {
      return reject(reply, 426, "https_required", "HTTPS is required.");
    }

    const origin = clean(request.headers.origin);
    const allowedOrigins = csvSet(process.env[ALLOWED_ORIGINS_ENV]);
    if (origin && !allowedOrigins.has(origin)) {
      return reject(reply, 403, "origin_forbidden", "Browser-origin requests are not allowed.");
    }

    const allowedIps = csvSet(process.env[ALLOWED_IPS_ENV]);
    if (allowedIps.size > 0 && !allowedIps.has(clientIp)) {
      return reject(reply, 403, "access_forbidden", "Access is not allowed.");
    }

    if (!consume(rate, clientIp, 120, 60_000)) {
      reply.header("Retry-After", "60");
      return reject(reply, 429, "rate_limited", "Too many requests.");
    }

    const expectedHash = configuredHash();
    if (!expectedHash) {
      request.log.error(`${API_KEY_HASH_ENV} is missing or invalid; FirstMeasure Remote is locked.`);
      return reject(reply, 503, "service_locked", "The remote metrics API is not configured.");
    }

    if (!secureTokenMatches(bearerToken(request), expectedHash)) {
      if (!consume(failures, clientIp, 10, 15 * 60_000)) {
        reply.header("Retry-After", "900");
        return reject(reply, 429, "rate_limited", "Too many failed authentication attempts.");
      }
      return reject(reply, 401, "unauthorized", "A valid Bearer API key is required.");
    }
  };
}

export function applyRemoteSecurityHeaders(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header("Expires", "0");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
}
