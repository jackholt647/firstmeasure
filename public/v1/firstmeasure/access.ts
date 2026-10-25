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
import type { FastifyInstance, FastifyRequest } from "fastify";
import { hasPermission } from "../platform/auth.js";
import { principalActor, requestPrincipal, type Principal } from "../platform/security/principal.js";
import { FirstMeasureError } from "./errors.js";
import { readManifest, type ProjectManifest } from "./storage.js";

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/** The organization a project belongs to (`organization_ref.id`, or the legacy `organization_id`). */
export function projectOrganizationId(manifest: ProjectManifest | Json) {
  const value = manifest as Json;
  return String(value.organization_id ?? record(value.organization_ref).id ?? "").trim();
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

function bindActor(request: FastifyRequest, principal: Principal) {
  const actor = principalActor(principal);
  // The system principal is our own service code; it names the actor it works for.
  if (!actor) return;
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)) {
    const input = body as Json;
    input.actor = { ...actor };
    for (const key of ["actor_email", "actor_name", "actor_role", "actor_org_id"]) delete input[key];
    if (principal.kind === "customer") {
      input.organization_id = principal.auth.orgId;
      if (input.filter !== undefined && !CUSTOMER_LIST_FILTERS.has(String(input.filter).toLowerCase())) input.filter = "org";
    }
  }
  const query = request.query;
  if (query && typeof query === "object") {
    const input = query as Json;
    for (const key of ["actor_email", "actor_name", "actor_role", "actor_org_id", "actor"]) delete input[key];
    if (principal.kind === "customer") {
      input.organization_id = principal.auth.orgId;
      delete input.owner_email;
    }
  }
}

export function installFirstMeasureAccess(app: FastifyInstance) {
  app.addHook("preHandler", async (request) => {
    const access = request.routeOptions.config?.access;
    if (!access || (typeof access === "object" && "public" in access)) return;
    const principal = await requestPrincipal(request);
    bindActor(request, principal);
    if (principal.kind !== "customer") return;
    scopes.set(request, principal.auth.orgId);
    const projectId = projectIdFromRequest(request);
    if (projectId) await authorizeProject(principal, projectId, READ_METHODS.has(request.method) ? "read" : "write");
  });
}
