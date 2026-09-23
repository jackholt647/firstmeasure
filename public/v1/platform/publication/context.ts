import { can, hasPermission, type PlatformAuthContext } from "../auth.js";
import { isCapabilityEnabled } from "../capabilities.js";
import { forbidden, badRequest } from "../errors.js";
import type { AccessPolicy, ExecutionKind, PublicationContext, SystemGrant, TargetRef } from "./contracts.js";

const issuedGrants = new WeakSet<object>();

export function userPublicationContext(auth: PlatformAuthContext, options: Partial<Pick<PublicationContext, "projectId" | "executionKind" | "mode" | "invocationId">> = {}): PublicationContext {
  return { auth, organizationId: auth.orgId, branchId: auth.branchId, executionKind: "api", mode: "evaluate", ...options };
}

/** Server-only capability issuance. Grants cannot be reconstructed by JSON or supplied by tenant code. */
export function systemPublicationContext(input: { kind: ExecutionKind; organizationId: string; projectId?: string; branchId?: string; operations: string[]; mode?: "evaluate" | "command"; invocationId?: string }): PublicationContext {
  if (!input.organizationId || !input.operations.length || input.operations.some(id => !id || id.includes("*"))) throw badRequest("publication_grant_invalid", "System grants require explicit operations and an organization.");
  const grant: SystemGrant = Object.freeze({ kind: input.kind, organizationId: input.organizationId, ...(input.projectId ? { projectId: input.projectId } : {}), operations: Object.freeze([...input.operations]) });
  issuedGrants.add(grant);
  return { auth: null, organizationId: input.organizationId, branchId: input.branchId, projectId: input.projectId, executionKind: input.kind, mode: input.mode || "evaluate", invocationId: input.invocationId, system: grant };
}

export async function authorizePublication(ctx: PublicationContext, target: TargetRef, policy: AccessPolicy, operation: string): Promise<void> {
  if (!policy.scopes.includes(target.scope)) throw forbidden("publication_scope_denied", "This operation does not support the requested scope.");
  if (target.scope !== "global" && (!target.organizationId || target.organizationId !== ctx.organizationId)) throw forbidden("publication_tenant_denied", "The source belongs to another organization.");
  if (target.scope === "project" && !target.projectId) throw badRequest("publication_project_required", "A project target is required.");
  if (ctx.projectId && target.projectId && ctx.projectId !== target.projectId) throw forbidden("publication_project_denied", "The requested project is outside this execution context.");
  if (ctx.auth) {
    if (ctx.auth.orgId !== ctx.organizationId) throw forbidden("publication_tenant_denied", "The principal does not belong to this organization.");
    const applications = policy.applications === false ? [] : policy.applications || ["management"];
    if (applications.length && !applications.some(name => {
      const entry = ctx.auth!.applicationAccess?.[name];
      if (!entry?.enabled) return false;
      return !policy.applicationPermission || policy.applicationPermission.split("|").some(permission =>
        entry.permissions[permission.trim()] === true || (entry.permissions[permission.trim()] !== false && entry.permissions["*"] === true));
    })) throw forbidden("publication_application_denied", "This user does not have access to the required application.");
    for (const permission of policy.permissions) if (!hasPermission(ctx.auth, permission)) throw forbidden("publication_permission_denied", "This operation is not permitted for this user.");
    for (const capability of policy.capabilities || []) if (!(await can(ctx.auth, capability))) throw forbidden("publication_capability_denied", "This feature is not available.");
  } else {
    const grant = ctx.system;
    if (!grant || !issuedGrants.has(grant) || grant.organizationId !== ctx.organizationId || grant.kind !== ctx.executionKind || !grant.operations.includes(operation) || !policy.systemKinds?.includes(grant.kind)) throw forbidden("publication_system_denied", "A trusted grant for this operation is required.");
    if (grant.projectId && target.scope === "project" && target.projectId !== grant.projectId) throw forbidden("publication_project_denied", "The requested project is outside the system grant.");
    for (const capability of policy.capabilities || []) if (!(await isCapabilityEnabled(ctx.organizationId, capability))) throw forbidden("publication_capability_denied", "This feature is not available.");
  }
  await policy.authorize?.(ctx, target);
}
