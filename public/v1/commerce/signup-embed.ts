// The app's signup form embedded on the FirstMate websites (1M8-240 follow-up).
//
// The websites load https://app.1m8.ai/portal/landing/shared/signup-widget.js; it renders on the website page and
// calls the platform API cross-origin with credentials. 1m8.ai, www.1m8.ai and eu.1m8.ai are the same site as
// app.1m8.ai, so the SameSite=Lax session cookie set by signup is kept (no third-party cookie limits apply).
//
// Safety: a browser request to /v1/platform/auth/* that names another origin is answered only for the exact origins
// allowed here (the app's own origin, the configured CORS origins and SIGNUP_EMBED_ORIGINS); every other origin gets
// 403 before the route runs. CSRF for signed-in routes is unchanged: the CSRF cookie is readable only on the app
// origin. The static catalogs and phone examples a cross-origin page cannot fetch from nginx are served here, read-only.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../src/config/env.js";

const DEFAULT_EMBED_ORIGINS = ["https://1m8.ai", "https://www.1m8.ai", "https://eu.1m8.ai"];
// public/ from commerce/ (source) or dist/commerce/ (compiled), like platform/localization/server.ts.
const PUBLIC_ROOT = [new URL("../../", import.meta.url), new URL("../../../", import.meta.url)].map(url => fileURLToPath(url))
  .find(dir => existsSync(path.join(dir, "libraries/platform-language/catalogs/manifest.json"))) || fileURLToPath(new URL("../../", import.meta.url));
/** Namespaces a signup page needs; nothing else is served cross-origin. */
const CATALOG_NAMESPACES = new Set(["shared", "signup", "signup-region", "phone-input"]);

function origin(value: unknown) {
  try { const url = new URL(String(value || "")); return url.protocol === "https:" || url.protocol === "http:" ? url.origin : ""; } catch { return ""; }
}

export function signupEmbedOrigins() {
  const configured = String(process.env.SIGNUP_EMBED_ORIGINS ?? DEFAULT_EMBED_ORIGINS.join(",")).split(",").map(origin).filter(Boolean);
  return new Set([origin(env.publicBaseUrl), ...env.corsOrigins.map(origin), ...configured].filter(Boolean));
}

/** True when the request comes from the app itself, from no browser origin, or from an allowed embedding origin. */
export function signupOriginAllowed(request: Pick<FastifyRequest, "headers">) {
  const sent = request.headers.origin;
  if (!sent) return true;
  const from = origin(sent);
  if (!from) return false;
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "");
  const proto = String(request.headers["x-forwarded-proto"] || "").split(",")[0]?.trim() || "https";
  if (host && (from === `${proto}://${host}` || from === `https://${host}` || from === `http://${host}`)) return true;
  return signupEmbedOrigins().has(from);
}

export function registerSignupEmbed(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/platform/auth/") || request.method === "OPTIONS") return;
    if (signupOriginAllowed(request)) return;
    return reply.code(403).send({ ok: false, error: "origin_not_allowed", message: "Signup is not available from this website." });
  });

  // Compiled language catalogs for the signup namespaces, as the browser runtime registers them.
  app.get("/auth/signup-catalogs", async (request, reply) => {
    const query = (request.query || {}) as Record<string, unknown>;
    const wanted = String(query.namespaces || "").split(",").map(v => v.trim()).filter(Boolean);
    // English (every fallback) and the page's language only.
    const locales = new Set(["en-US", String(query.locale || "")]);
    const dir = path.join(PUBLIC_ROOT, "libraries/platform-language/catalogs");
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { namespaces: Record<string, string> };
    const bundles = [];
    for (const namespace of new Set(wanted)) {
      if (!CATALOG_NAMESPACES.has(namespace) || !manifest.namespaces[namespace]) continue;
      const file = manifest.namespaces[namespace]!;
      if (!/^[a-z0-9_-]+\.[0-9a-f]+\.json$/.test(file)) continue;
      const bundle = JSON.parse(await readFile(path.join(dir, file), "utf8")) as { namespaces: Record<string, Record<string, unknown>> };
      for (const messages of Object.values(bundle.namespaces)) for (const locale of Object.keys(messages)) if (!locales.has(locale)) delete messages[locale];
      bundles.push(bundle);
    }
    reply.header("Cache-Control", "public, max-age=300");
    return { ok: true, bundles };
  });

  // libphonenumber's example mobile numbers (the phone placeholder).
  app.get("/auth/phone-examples", async (_request, reply) => {
    const file = path.join(PUBLIC_ROOT, "libraries/vendor/libphonenumber-js-1.12.31/examples.mobile.json");
    reply.header("Cache-Control", "public, max-age=86400");
    return JSON.parse(await readFile(file, "utf8"));
  });
}
