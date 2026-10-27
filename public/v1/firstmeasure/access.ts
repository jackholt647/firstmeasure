/**
 * May this caller read or change this project?
 * (docs/architecture/request-security.md#records)
 *
 * The route gate (platform/security/route-access.ts) has already said who is
 * calling. This hook, inside the FirstMeasure plugin, then:
 * - replaces `actor` in the body and query with the verified one, so every
 *   legacy handler that reads `body.actor` sees the real caller;
 * - narrows a customer to their own organization's projects, answering 404
 *   for any other project;
 * - limits a customer's list and search requests to their organization.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../src/config/env.js";
import { hasPermission } from "../platform/auth.js";
import { principalActor, requestPrincipal, type Principal } from "../platform/security/principal.js";
import { FirstMeasureError } from "./errors.js";
import { SIGNED_FILE_ACCESS } from "./route-access.js";
import { readManifest, type ProjectManifest } from "./storage.js";

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/** The organization a project belongs to (`organization_ref.id`, or the legacy `organization_id`). */
export function projectOrganizationId(manifest: ProjectManifest | Json) {
  const value = manifest as Json;
  return (String(value.organization_id ?? "").trim() || String(record(value.organization_ref).id ?? "").trim());
}

function notFound() {
  return new FirstMeasureError("project_not_found", 404, "Project not found.");
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Throws 404 unless the principal may use the project. Staff and system may use
 * every project (full-house projects keep their own gate). A customer needs
 * the project's organization to be theirs, and `view_reports` to read or
 * `order_reports` to change it.
 */
export async function authorizeProject(principal: Principal, projectId: string, mode: "read" | "write") {
  if (principal.kind === "system" || principal.kind === "staff") return null;
  if (principal.kind !== "customer") throw notFound();
  let manifest: ProjectManifest;
  try {
    manifest = await readManifest(projectId);
  } catch {
    throw notFound();
  }
  const orgId = projectOrganizationId(manifest);
  if (!orgId || orgId !== principal.auth.orgId) throw notFound();
  if (!hasPermission(principal.auth, mode === "read" ? "view_reports|order_reports" : "order_reports")) {
    throw new FirstMeasureError("permission_denied", 403, "This account cannot use this report.");
  }
  return manifest;
}

/** Route params that name a project. */
function projectIdFromRequest(request: FastifyRequest) {
  const params = record(request.params);
  const id = String(params.id ?? "").trim();
  return id || null;
}

const scopes = new WeakMap<FastifyRequest, string>();

/** The organization a customer's list or search is limited to; undefined for staff and system. */
export function organizationScope(request: FastifyRequest) {
  return scopes.get(request);
}

const CUSTOMER_LIST_FILTERS = new Set(["mine", "team", "org"]);
const LIST_ROUTES = new Set(["/v1/firstmeasure/projects/list"]);

/** What a customer may change on their own project (the Customer info card). */
export const CUSTOMER_PROJECT_PATCH_FIELDS = ["resident"] as const;

function plainObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function bindActor(request: FastifyRequest, principal: Principal) {
  const actor = principalActor(principal);
  // The system principal is our own service code; it names the actor it works for.
  if (!actor) return;
  if (plainObject(request.body)) {
    const input = request.body;
    // A tab opened as another account (before a switch in another tab) names that account; it must not list the
    // signed-in account's orders as its own (1M8-204).
    const claimed = plainObject(input.actor) ? String(input.actor.organization_id || "").trim() : "";
    if (claimed && actor.organization_id && claimed !== actor.organization_id && LIST_ROUTES.has(String(request.routeOptions.url ?? ""))) {
      throw new FirstMeasureError("organization_forbidden", 403, "This session cannot act on the requested organization.");
    }
    input.actor = { ...actor };
    for (const key of ["actor_email", "actor_name", "actor_role", "actor_org_id"]) delete input[key];
  }
  if (plainObject(request.query)) {
    for (const key of ["actor_email", "actor_name", "actor_role", "actor_org_id", "actor"]) delete request.query[key];
  }
}

function scopeCustomerRequest(request: FastifyRequest, orgId: string) {
  scopes.set(request, orgId);
  const route = request.routeOptions.url ?? "";
  if (LIST_ROUTES.has(route) && plainObject(request.body)) {
    const input = request.body;
    input.organization_id = orgId;
    const filter = String(input.filter ?? "org").toLowerCase();
    input.filter = CUSTOMER_LIST_FILTERS.has(filter) ? filter : "org";
  }
  if (request.method === "PATCH" && route === "/v1/firstmeasure/projects/:id") {
    const input = plainObject(request.body) ? request.body : {};
    request.body = Object.fromEntries(Object.entries(input).filter(([key]) => (CUSTOMER_PROJECT_PATCH_FIELDS as readonly string[]).includes(key) || key === "actor"));
  }
}

/**
 * What a project was charged or refunded is written by the domain writers
 * that move the money (ordering, expedite, cancellation, coverage refunds),
 * never by a staff edit of the record; full admins keep the ability to correct
 * a record by hand.
 */
const MONEY_FIELD = /(amount|refund|charge|credit|price|cost|payment|invoice|balance)/i;

function stripMoneyFields(request: FastifyRequest) {
  if (request.method !== "PATCH" || request.routeOptions.url !== "/v1/firstmeasure/projects/:id" || !plainObject(request.body)) return;
  for (const key of Object.keys(request.body)) {
    if (MONEY_FIELD.test(key)) delete request.body[key];
  }
}

// Signed links for customer files (thumbnails, report artifacts) that a page
// without a session shows, such as the homeowner portal.
const FILE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

function fileLinkKey() {
  return createHmac("sha256", env.platformSessionSecret).update("firstmeasure-file-link-v1").digest();
}

function fileLinkSignature(projectId: string, name: string, expires: number) {
  return createHmac("sha256", fileLinkKey()).update(`${projectId}\n${name}\n${expires}`).digest("base64url");
}

/** Query string (`exp`, `sig`) that lets anyone holding the link read one project file until it expires. */
export function signedProjectFileQuery(projectId: string, name: string, ttlSeconds = FILE_LINK_TTL_SECONDS) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `exp=${expires}&sig=${fileLinkSignature(projectId, name, expires)}`;
}

function hasValidFileLink(request: FastifyRequest) {
  const query = record(request.query);
  const params = record(request.params);
  const expires = Number(query.exp);
  const signature = String(query.sig ?? "");
  if (!Number.isInteger(expires) || expires < Date.now() / 1000 || !signature) return false;
  const name = String(params.name ?? "thumbnail");
  const expected = fileLinkSignature(String(params.id ?? ""), name, expires);
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function installFirstMeasureAccess(app: FastifyInstance) {
  app.addHook("preHandler", async (request) => {
    const access = request.routeOptions.config?.access;
    if (!access) return;
    if (typeof access === "object" && "public" in access && access.public === (SIGNED_FILE_ACCESS as { public: string }).public) {
      if (hasValidFileLink(request)) return;
      const principal = await requestPrincipal(request);
      if (principal.kind === "anonymous") throw new FirstMeasureError("authentication_required", 401, "Authentication required.");
      if (principal.kind === "customer") await authorizeProject(principal, projectIdFromRequest(request) ?? "", "read");
      return;
    }
    if (typeof access === "object" && "public" in access) return;
    const principal = await requestPrincipal(request);
    bindActor(request, principal);
    if (principal.kind === "staff" && !principal.staff.admin) stripMoneyFields(request);
    if (principal.kind !== "customer") return;
    scopeCustomerRequest(request, principal.auth.orgId);
    const projectId = projectIdFromRequest(request);
    if (projectId) await authorizeProject(principal, projectId, READ_METHODS.has(request.method) ? "read" : "write");
  });
}
