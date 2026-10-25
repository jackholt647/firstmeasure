/**
 * Route access declarations (docs/architecture/request-security.md#route-access-declarations).
 *
 * Every route under a covered prefix declares who may call it, either in its
 * route options (`config: { access }`) or in its plugin's access table
 * (`registerRouteAccessTable`). Registering a covered route without one throws
 * at startup, and the root preHandler refuses callers the declaration excludes
 * before any plugin hook or handler runs.
 */
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import { forbidden, unauthorized } from "../errors.js";
import { requestPrincipal, type Principal } from "./principal.js";
import { capturesRawBody, rememberRawBody } from "./service.js";
import { staffMeets, STAFF_LEVELS, type StaffLevel } from "./staff.js";

export type RouteAccess =
  | { public: string }
  | "service"
  | { staff: StaffLevel }
  | "customer_or_staff"
  | "customer";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

export const COVERED_PREFIXES = [
  "/v1/firstmeasure",
  "/v1/firstmeasure-remote",
  "/v1/internal",
  "/v1/communications",
  "/v1/public/firstmeasure"
] as const;

const tables = new Map<string, RouteAccess>();
const declared = new Map<string, RouteAccess>();

function key(method: string, url: string) {
  return `${method.toUpperCase()} ${url.replace(/\/+$/, "") || "/"}`;
}

/**
 * Declarations for a plugin's routes, keyed `"METHOD /full/url/:param"`
 * (`"* /url"` for every method). Call before the plugin registers.
 */
export function registerRouteAccessTable(entries: Record<string, RouteAccess>) {
  for (const [entry, access] of Object.entries(entries)) {
    const [method, url] = entry.split(" ");
    if (!method || !url) throw new Error(`Route access entry "${entry}" must be "METHOD /url".`);
    assertValidAccess(entry, access);
    tables.set(key(method, url), access);
  }
}

export function isCoveredUrl(url: string) {
  const path = url.split("?")[0] ?? "";
  return COVERED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function assertValidAccess(route: string, access: unknown): asserts access is RouteAccess {
  if (access === "service" || access === "customer_or_staff" || access === "customer") return;
  if (access && typeof access === "object") {
    const value = access as Record<string, unknown>;
    if (typeof value.public === "string" && value.public.trim().length >= 8) return;
    if (typeof value.staff === "string" && (STAFF_LEVELS as readonly string[]).includes(value.staff)) return;
  }
  throw new Error(`Route ${route} has no valid access declaration (docs/architecture/request-security.md).`);
}

/** The declaration for a registered route (tests and the access-gates snapshot read this). */
export function declaredRouteAccess(method: string, url: string) {
  return declared.get(key(method, url)) ?? null;
}

export function declaredRoutes() {
  return [...declared.entries()].map(([route, access]) => ({ route, access }));
}

/** Whether the principal passes the route's declaration. */
export function principalMeets(principal: Principal, access: RouteAccess) {
  if (typeof access === "object" && "public" in access) return true;
  if (principal.kind === "system") return true;
  if (access === "service") return false;
  if (typeof access === "object" && "staff" in access) return principal.kind === "staff" && staffMeets(principal.staff, access.staff);
  if (access === "customer_or_staff") return principal.kind === "customer" || principal.kind === "staff";
  if (access === "customer") return principal.kind === "customer" || (principal.kind === "staff" && principal.auth !== null);
  return false;
}

function routeAccess(request: FastifyRequest) {
  const config = (request.routeOptions.config ?? {}) as { access?: RouteAccess };
  return config.access ?? null;
}

const MAX_SIGNED_BODY_BYTES = 32 * 1024 * 1024;

export function installRouteAccess(app: FastifyInstance) {
  app.addHook("onRoute", (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!isCoveredUrl(route.url)) return;
    for (const method of methods) {
      if (method === "HEAD" && !(route.config as Record<string, unknown> | undefined)?.access) {
        // Fastify adds HEAD for every GET; it inherits the GET's declaration.
        const get = tables.get(key("GET", route.url));
        if (get) { route.config = { ...(route.config ?? {}), access: get }; declared.set(key("HEAD", route.url), get); continue; }
      }
      const access = (route.config as { access?: unknown } | undefined)?.access
        ?? tables.get(key(method, route.url)) ?? tables.get(key("*", route.url));
      assertValidAccess(key(method, route.url), access);
      route.config = { ...(route.config ?? {}), access };
      declared.set(key(method, route.url), access);
    }
  });

  // Signed PHP requests sign their body; keep the raw bytes to check it.
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!capturesRawBody(request)) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_SIGNED_BODY_BYTES) throw forbidden("signed_body_too_large", "A signed service request body is too large.");
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks);
    rememberRawBody(request, raw);
    return Readable.from(raw);
  });

  app.addHook("preHandler", async (request) => {
    const url = request.routeOptions.url;
    if (!url || !isCoveredUrl(url)) return;
    const access = routeAccess(request);
    if (!access) throw forbidden("route_access_undeclared", "This route has no access declaration.");
    if (typeof access === "object" && "public" in access) return;
    const principal = await requestPrincipal(request);
    if (principalMeets(principal, access)) return;
    if (principal.kind === "anonymous") throw unauthorized("authentication_required", "Authentication required.");
    throw forbidden("access_denied", "This account cannot use this route.");
  });
}
