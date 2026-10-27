import type { PlatformAuthContext } from '../platform/auth.js';
import { badRequest, forbidden, notFound, PlatformError } from '../platform/errors.js';
import { readDocument, type JsonObject } from '../platform/storage.js';
import { canAccessDepartmentResource, hasResourcePermission } from '../workforce/department-access.js';
import { branchScope, canManageBranches, canSeeBranches } from '../workforce/branch-scope.js';
type Obj = JsonObject;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const clean = (value: unknown) => String(value ?? '').trim();

/**
 * A project this caller may see (`view_projects`) or change (`manage_projects`), with its branch and department
 * rules. A project the caller cannot see answers 404, as if it did not exist; one they see but may not change, 403.
 */
export async function readProjectForAccess(ctx: PlatformAuthContext, projectId: unknown, permission: "view_projects" | "manage_projects") {
  const id = clean(projectId);
  if (!id) throw badRequest("project_required", "Choose a project.");
  const missing = () => notFound("project_not_found", "This project is not available.");
  let document: Obj;
  try { document = obj(await readDocument(ctx.orgId, "projects", id)); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) throw missing(); throw error; }
  const data: Obj = { ...obj(document.data), id };
  if (data.deleted_at || data.trashed_at || data.in_trash) throw missing();
  const scope = branchScope(ctx), branches = [clean(data.branch_id) || "default"];
  const visible = hasResourcePermission(ctx, "view_projects|manage_projects", data)
    && canAccessDepartmentResource(ctx, data, "view_projects")
    && canSeeBranches(scope, branches);
  if (!visible) throw missing();
  if (permission === "manage_projects" && !(hasResourcePermission(ctx, "manage_projects", data) && canManageBranches(scope, branches))) {
    throw forbidden("project_manage_denied", "You cannot change this project.");
  }
  return { document, data };
}

