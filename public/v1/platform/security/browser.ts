/**
 * Browser-facing protections (docs/architecture/request-security.md#browser-protections):
 * credentialed CORS only for our own origins, a cross-site write check for
 * every cookie-authenticated request, and headers that stop content sniffing.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../../src/config/env.js";
import { signupEmbedOrigins } from "../../commerce/signup-embed.js";
import { forbidden } from "../errors.js";

function originOf(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return "";
  }
}

/** Origins that may make credentialed requests: CORS_ALLOWED_ORIGINS plus PUBLIC_BASE_URL. */
export function allowedOrigins() {
  const origins = new Set<string>();
  for (const value of [...env.corsOrigins, env.publicBaseUrl]) {
    const origin = originOf(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function isAllowedOrigin(origin: string) {
  return allowedOrigins().has(originOf(origin));
}

/**
 * The routes the signup form embedded on the websites (1m8.ai, www, eu;
 * commerce/signup-embed.ts) calls with credentials: signup and login set the
 * session cookie, and the widget's funnel beacon is always credentialed.
 */
function isSignupEmbedRoute(url: string) {
  const path = url.split("?", 1)[0] ?? "";
  return path.startsWith("/v1/platform/auth/") || path === "/v1/platform/acquisition/event";
}

/** Our origins anywhere, plus the signup embed origins on the signup embed's own routes only. */
export function isCredentialedOrigin(request: Pick<FastifyRequest, "url">, origin: string) {
  if (isAllowedOrigin(origin)) return true;
  return isSignupEmbedRoute(request.url) && signupEmbedOrigins().has(originOf(origin));
}

/**
 * @fastify/cors per-request options: our origins get credentials; any other
 * origin may still read public, cookie-free answers (embedded forms, the
 * public API), but the browser never shares a signed-in response with it.
 */
export function corsDelegator(request: FastifyRequest, callback: (error: Error | null, options?: Record<string, unknown>) => void) {
  const origin = String(request.headers.origin ?? "");
  callback(null, { origin: origin ? true : false, credentials: origin ? isCredentialedOrigin(request, origin) : false });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function carriesSessionCookie(request: FastifyRequest) {
  const cookie = String(request.headers.cookie ?? "");
  return cookie.split(";").some((part) => part.trim().startsWith(`${env.platformSessionCookieName}=`));
}

/**
 * A browser sends Origin on every cross-origin request and on same-origin
 * writes, so a cookie-carrying write from another site (including a sibling
 * subdomain, which SameSite=Lax lets through) is refused here.
 */
export function assertSameOriginWrite(request: FastifyRequest) {
  if (SAFE_METHODS.has(request.method)) return;
  if (!carriesSessionCookie(request)) return;
  const origin = String(request.headers.origin ?? "").trim();
  if (origin) {
    if (origin === "null" || !isCredentialedOrigin(request, origin)) throw forbidden("cross_site_request", "This request came from another site.");
    return;
  }
  const referer = String(request.headers.referer ?? "").trim();
  if (referer && !isCredentialedOrigin(request, referer)) throw forbidden("cross_site_request", "This request came from another site.");
}

export function installBrowserProtections(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    assertSameOriginWrite(request);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    if (!reply.hasHeader("X-Content-Type-Options")) reply.header("X-Content-Type-Options", "nosniff");
    if (!reply.hasHeader("Referrer-Policy")) reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    return payload;
  });
}
