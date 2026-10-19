import type { PlatformAuthContext } from '../platform/auth.js';
import { hasPermission } from '../platform/auth.js';
import { badRequest, forbidden } from '../platform/errors.js';
import type { AccessRole } from './access.js';

/**
 * A role or permissions given in part of the organization: one department, one branch (its departments and its
 * records), or one region (its branches). See docs/architecture/branches.md. `division` is the older unit scope; a
 * saved one is read through the catalog's `unit_migration` (or a region of the same id) and is never written again.
 */
export type ScopeKind = 'department' | 'branch' | 'region';
export type ScopedAccessAssignment = { role_id?: string; permissions?: Record<string, boolean>; scope: { kind: ScopeKind; id: string } };
export type ScopedAccessGrant = ScopedAccessAssignment & { permissions: Record<string, boolean> };
export type DepartmentResource = { organization_id?: unknown; department_ids?: unknown; department_id?: unknown; region_id?: unknown; branch_id?: unknown; branch_ids?: unknown; department_access?: unknown };
export type OrganizationStructureAccess = {
  catalog: { terminology?: {department?: {singular?:string;plural?:string}}; departments: Array<{ id: string; label: string; status?: string; branch_id?: string; app_defaults?: Record<string, unknown> }>; regions?: Array<{ id: string; label?: string; status?: string; branch_ids?: string[] }>; unit_migration?: { scopes?: Record<string, Array<{ kind: 'branch' | 'region'; id: string }>> } };
  branches?: Array<{ id: string; status?: string }>;
  users: Array<{ id: string; department_ids: string[]; branch_ids?: string[]; region_ids?: string[]; resource_group_ids?: string[] }>;
  groups?: Array<{ id: string; label?: string; kind_id?: string; department_ids: string[] }>;
};
const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.map(String).map(id => id.trim()).filter(Boolean))] : [];
const active = (entry: { status?: string }) => entry.status !== 'archived';

/** These capabilities operate on the organization itself; a department cannot confer them. */
export function isDepartmentScopeablePermission(permission: string) {
  return !!permission && !permission.includes('|') && permission !== '*' && ![
    'manage_billing', 'manage_company_settings', 'manage_company_users', 'manage_company_user_permissions',
    'manage_report_settings', 'manage_notification_defaults', 'manage_integrations', 'manage_security',
    'manage_roles', 'manage_organization', 'manage_capabilities', 'manage_feed', 'view_feed_all_departments',
    // Branch reach is about the organization's structure; a department, branch or region cannot confer it.
    'view_region_branches', 'manage_region_branches', 'view_all_branches', 'manage_all_branches'
  ].includes(permission);
}

const branchKnown = (structure: OrganizationStructureAccess, id: string) => id === 'default' || !structure.branches || structure.branches.some(entry => entry.id === id);
const branchActive = (structure: OrganizationStructureAccess, id: string) => !!id && branchKnown(structure, id) && !(structure.branches || []).some(entry => entry.id === id && entry.status === 'archived');
const activeRegion = (structure: OrganizationStructureAccess, id: string) => (structure.catalog.regions || []).find(entry => entry.id === id && active(entry));

function scopeExists(structure: OrganizationStructureAccess | undefined, scope: ScopedAccessAssignment['scope']) {
  if (!structure) return false;
  if (scope.kind === 'region') return !!activeRegion(structure, scope.id);
  if (scope.kind === 'branch') return branchActive(structure, scope.id);
  return structure.catalog.departments.some(entry => entry.id === scope.id && active(entry) && branchActive(structure, entry.branch_id || 'default'));
}

/** The scopes an older unit grant now covers: the catalog's migration record, else a region of the same id. */
export function migratedUnitScopes(structure: OrganizationStructureAccess | undefined, unitId: string): Array<ScopedAccessAssignment['scope']> {
  if (!structure) return [];
  const recorded = structure.catalog.unit_migration?.scopes?.[unitId];
  if (recorded) return recorded.map(scope => ({ kind: scope.kind, id: scope.id }));
  return activeRegion(structure, unitId) ? [{ kind: 'region', id: unitId }] : [];
}
/** A saved assignment in today's scope kinds. An older unit scope becomes the branch or region scopes it now covers. */
function currentScopes(structure: OrganizationStructureAccess | undefined, scope: { kind?: unknown; id?: unknown } | undefined): Array<ScopedAccessAssignment['scope']> {
  const kind = String(scope?.kind || ''), id = String(scope?.id || '');
  if (!id) return [];
  if (kind === 'division') return migratedUnitScopes(structure, id);
  return ['department', 'branch', 'region'].includes(kind) ? [{ kind: kind as ScopeKind, id }] : [];
}

export function resourceDepartmentIds(resource: DepartmentResource) {
  return [...new Set([...ids(resource.department_ids), ...ids(resource.department_id ? [resource.department_id] : [])])];
}

/** The branches a resource is in: its own `branch_id` / `branch_ids` and the branches of its departments. */
function resourceBranchIds(structure: OrganizationStructureAccess, resource: DepartmentResource) {
  const departments = structure.catalog.departments.filter(entry => active(entry) && resourceDepartmentIds(resource).includes(entry.id));
  return [...new Set([...ids(resource.branch_id ? [resource.branch_id] : []), ...ids(resource.branch_ids), ...departments.map(entry => entry.branch_id || 'default')])];
}

function scopeMatches(structure: OrganizationStructureAccess, scope: ScopedAccessAssignment['scope'], resource: DepartmentResource) {
  if (!scopeExists(structure, scope)) return false;
  if (scope.kind === 'department') return structure.catalog.departments.some(entry => active(entry) && entry.id === scope.id && resourceDepartmentIds(resource).includes(entry.id));
  const branches = resourceBranchIds(structure, resource);
  if (scope.kind === 'branch') return branches.includes(scope.id);
  const region = activeRegion(structure, scope.id);
  return String(resource.region_id || '') === scope.id || branches.some(id => (region?.branch_ids || []).includes(id));
}

export function resolveScopedAccessGrants(assignments: unknown, roles: AccessRole[], structure: OrganizationStructureAccess): ScopedAccessGrant[] {
  if (!Array.isArray(assignments)) return [];
  return assignments.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const assignment = value as ScopedAccessAssignment;
    const scopes = currentScopes(structure, assignment.scope).filter(scope => scopeExists(structure, scope));
    if (!scopes.length) return [];
    const role = assignment.role_id ? roles.find(entry => entry.id === assignment.role_id && entry.status === 'active') : undefined;
    if (assignment.role_id && !role) return [];
    const permissions = Object.fromEntries(Object.entries({ ...role?.permissions, ...assignment.permissions }).filter(([key, allowed]) => isDepartmentScopeablePermission(key) && typeof allowed === 'boolean'));
    return scopes.map(scope => ({ ...assignment, scope, permissions }));
  });
}

/** True only for a known, server-loaded target. Never pass request filter values as its classification. */
export function hasResourcePermission(ctx: PlatformAuthContext, permission: string | undefined, resource: DepartmentResource) {
  if (resource.organization_id && resource.organization_id !== ctx.orgId) return false;
  if (!permission) return true;
  return permission.split('|').some(nameValue => {
    const name = nameValue.trim();
    if (ctx.permissions?.[name] === false) return false;
    const matching = ctx.organizationStructure ? (ctx.scopedAccessGrants || []).filter(grant => scopeMatches(ctx.organizationStructure!, grant.scope, resource)) : [];
    if (matching.some(grant => grant.permissions[name] === false)) return false;
    return hasPermission(ctx, name) || matching.some(grant => grant.permissions[name] === true);
  });
}

export function assertResourcePermission(ctx: PlatformAuthContext, permission: string, resource: DepartmentResource) {
  if (!hasResourcePermission(ctx, permission, resource)) throw forbidden('department_permission_denied', 'This operation is not permitted for this resource.');
}

/** Discovery/route entrance only. The domain must subsequently authorize every actual resource. */
export function canUseScopedPermission(ctx: PlatformAuthContext, permission?: string) {
  if (!permission) return true;
  return permission.split('|').some(value => {
    const name = value.trim();
    if (ctx.permissions?.[name] === false) return false;
    return hasPermission(ctx, name) || (ctx.scopedAccessGrants || []).some(grant => grant.permissions[name] === true && scopeExists(ctx.organizationStructure, grant.scope));
  });
}

/** The branches a branch or region grant of this permission covers. Ordinary organization-wide grants are not counted here. */
export function scopedPermissionBranchIds(ctx: PlatformAuthContext, permission: string) {
  const structure=ctx.organizationStructure;
  if(!structure)return [];
  return structureBranchIds(structure).filter(branch_id=>permission.split('|').some(value=>{
    const name=value.trim();
    return (ctx.scopedAccessGrants||[]).some(grant=>grant.scope.kind!=='department'&&grant.permissions[name]===true&&scopeMatches(structure,grant.scope,{branch_id}))&&hasResourcePermission(ctx,name,{branch_id});
  }));
}

function structureBranchIds(structure: OrganizationStructureAccess) {
  return [...new Set(['default', ...(structure.branches || []).map(entry => entry.id), ...structure.catalog.departments.map(entry => entry.branch_id || 'default')])].filter(id => branchActive(structure, id));
}

/** SQL consumers OR these rules, applying each rule's denials to its whole positive clause. */
export function resourcePermissionRules(ctx: PlatformAuthContext, permission: string) {
  const structure=ctx.organizationStructure;
  const departments=structure?.catalog.departments.filter(entry=>scopeExists(structure,{kind:'department',id:entry.id})).map(entry=>entry.id)||[];
  const branches=structure?structureBranchIds(structure):[];
  return [...new Set(permission.split('|').map(name=>name.trim()).filter(Boolean))].flatMap(name=>{
    if(ctx.permissions?.[name]===false)return [];
    const grants=(ctx.scopedAccessGrants||[]).filter(grant=>scopeExists(structure,grant.scope));
    const matches=(value:boolean,resource:DepartmentResource)=>!!structure&&grants.some(grant=>grant.permissions[name]===value&&scopeMatches(structure,grant.scope,resource));
    // A branch or region rule covers records tagged with the branch; department rules cover records tagged with a department.
    const branchMatches=(value:boolean,branch_id:string)=>!!structure&&grants.some(grant=>grant.scope.kind!=='department'&&grant.permissions[name]===value&&scopeMatches(structure,grant.scope,{branch_id}));
    return [{global:hasPermission(ctx,name),department_ids:departments.filter(department_id=>matches(true,{department_id})),branch_ids:branches.filter(branch_id=>branchMatches(true,branch_id)),denied_department_ids:departments.filter(department_id=>matches(false,{department_id})),denied_branch_ids:branches.filter(branch_id=>branchMatches(false,branch_id))}];
  });
}

export function relevantDepartmentContext(ctx: PlatformAuthContext) {
  const structure = ctx.organizationStructure;
  const member = structure?.users.find(user => user.id === ctx.userId);
  const memberIds = member?.department_ids || [];
  const organizationWide = hasPermission(ctx, 'manage_company_settings') || hasPermission(ctx, 'manage_company_user_permissions') || ctx.permissions?.['*'] === true;
  const activeDepartments = structure?.catalog.departments.filter(entry => scopeExists(structure, {kind:'department',id:entry.id})) || [];
  const departments = activeDepartments.filter(department => organizationWide || memberIds.includes(department.id)
    || (ctx.scopedAccessGrants || []).some(grant => Object.values(grant.permissions).some(Boolean) && scopeMatches(structure!, grant.scope, { department_id: department.id })));
  return {
    department_label: structure?.catalog.terminology?.department?.singular || 'Department',
    departments_label: structure?.catalog.terminology?.department?.plural || 'Departments',
    departments: departments.map(({ id, label }) => ({ id, label })),
    department_ids: departments.map(department => department.id), member_department_ids: memberIds,
    branch_ids: member?.branch_ids || [], region_ids: member?.region_ids || [], organization_wide: organizationWide,
    show_selector: activeDepartments.length > 1 && departments.length > 1,
    enabled: activeDepartments.length > 1
  };
}

/** Relevance is a presentation filter, not a permission. Shared resources remain discoverable. */
export function matchesDepartmentFilter(ctx: PlatformAuthContext, resource: DepartmentResource, selected?: string) {
  const context = relevantDepartmentContext(ctx);
  const resourceIds = resourceDepartmentIds(resource);
  if (selected && selected !== 'all' && !context.department_ids.includes(selected)) return false;
  if (!resourceIds.length) return true;
  if (selected && selected !== 'all') return resourceIds.includes(selected);
  if (!context.enabled || context.organization_wide) return true;
  return resourceIds.some(id => context.department_ids.includes(id));
}

/** Only explicit department-restricted content uses membership as a visibility boundary. */
export function canAccessDepartmentResource(ctx: PlatformAuthContext, resource: DepartmentResource, scopedReadPermission?: string) {
  if (resource.organization_id && resource.organization_id !== ctx.orgId) return false;
  if (resource.department_access !== 'restricted') return true;
  const context = relevantDepartmentContext(ctx);
  if (context.organization_wide || resourceDepartmentIds(resource).some(id => context.member_department_ids.includes(id))) return true;
  // An unrelated scoped capability never enrolls someone in a private audience.
  return !!scopedReadPermission && scopedReadPermission.split('|').some(permission => {
    const name=permission.trim();
    return ctx.permissions?.[name] !== false && (ctx.scopedAccessGrants||[]).some(grant=>grant.permissions[name]===true&&ctx.organizationStructure&&scopeMatches(ctx.organizationStructure,grant.scope,resource))
      && hasResourcePermission(ctx,name,resource);
  });
}

export function validateScopedAccessAssignments(value: unknown, roles: AccessRole[], structure: OrganizationStructureAccess): ScopedAccessAssignment[] {
  if (!Array.isArray(value) || value.length > 200) throw badRequest('scoped_access_invalid', 'Provide at most 200 scoped role assignments.');
  return value.flatMap(raw => {
    const entry = raw as ScopedAccessAssignment;
    // An older unit scope is saved as the branch or region scopes it now covers.
    const scopes = currentScopes(structure, entry?.scope);
    if (!scopes.length || scopes.some(scope => !scopeExists(structure, scope))) throw badRequest('scoped_access_scope_invalid', 'Select an active department, branch or region in this organization.');
    const role = entry.role_id ? roles.find(role => role.id === entry.role_id && role.status === 'active') : undefined;
    if (entry.role_id && !role) throw badRequest('scoped_access_role_invalid', 'Select an active role in this organization.');
    if (!entry.role_id && !Object.keys(entry.permissions || {}).length) throw badRequest('scoped_access_empty', 'Choose a role or permissions.');
    if (Object.entries(entry.permissions || {}).some(([key, value]) => !isDepartmentScopeablePermission(key) || typeof value !== 'boolean')) throw badRequest('scoped_access_permission_invalid', 'This permission cannot be assigned at department, branch or region scope.');
    if (role && Object.entries(role.permissions).some(([key, value]) => value && !isDepartmentScopeablePermission(key))) throw badRequest('scoped_access_role_not_scopeable', 'This role includes organization-wide powers. Use a role containing only department-scoped capabilities.');
    return scopes.map(scope => ({ ...(entry.role_id ? { role_id: entry.role_id } : {}), ...(entry.permissions ? { permissions: { ...entry.permissions } } : {}), scope }));
  });
}
