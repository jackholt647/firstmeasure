import type { PlatformAuthContext } from '../platform/auth.js';
import { hasPermission } from '../platform/auth.js';
import { badRequest, forbidden } from '../platform/errors.js';
import type { AccessRole } from './access.js';

export type ScopedAccessAssignment = { role_id?: string; permissions?: Record<string, boolean>; scope: { kind: 'department' | 'division'; id: string } };
export type ScopedAccessGrant = ScopedAccessAssignment & { permissions: Record<string, boolean> };
export type DepartmentResource = { organization_id?: unknown; department_ids?: unknown; department_id?: unknown; division_id?: unknown; branch_id?: unknown; department_access?: unknown };
export type OrganizationStructureAccess = {
  catalog: { terminology?: {department?: {singular?:string;plural?:string}}; departments: Array<{ id: string; label: string; status?: string; division_id?: string; app_defaults?: Record<string, unknown> }>; divisions?: Array<{ id: string; parent_id?: string; branch_id?: string; status?: string }> };
  users: Array<{ id: string; department_ids: string[]; division_ids?: string[] }>;
};
const ids = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.map(String).map(id => id.trim()).filter(Boolean))] : [];
const active = (entry: { status?: string }) => entry.status !== 'archived';

/** These capabilities operate on the organization itself; a department cannot confer them. */
export function isDepartmentScopeablePermission(permission: string) {
  return !!permission && !permission.includes('|') && permission !== '*' && ![
    'manage_billing', 'manage_company_settings', 'manage_company_users', 'manage_company_user_permissions',
    'manage_report_settings', 'manage_notification_defaults', 'manage_integrations', 'manage_security',
    'manage_roles', 'manage_organization', 'manage_capabilities', 'manage_feed', 'view_feed_all_departments'
  ].includes(permission);
}

function scopeExists(structure: OrganizationStructureAccess | undefined, scope: ScopedAccessAssignment['scope']) {
  if (!structure) return false;
  if (scope.kind === 'division') return ancestors(structure, scope.id).length > 0;
  return structure.catalog.departments.some(entry => entry.id === scope.id && active(entry) && (!entry.division_id || ancestors(structure, entry.division_id).length > 0));
}

function ancestors(structure: OrganizationStructureAccess, id: string) {
  const result: string[] = [];
  const nodes = structure.catalog.divisions || [];
  while (id && !result.includes(id)) {
    const node = nodes.find(entry => entry.id === id && active(entry));
    if (!node) return [];
    result.push(id); id = node.parent_id || '';
  }
  return result;
}

export function resourceDepartmentIds(resource: DepartmentResource) {
  return [...new Set([...ids(resource.department_ids), ...ids(resource.department_id ? [resource.department_id] : [])])];
}

function scopeMatches(structure: OrganizationStructureAccess, scope: ScopedAccessAssignment['scope'], resource: DepartmentResource) {
  if (!scopeExists(structure, scope)) return false;
  const departments = structure.catalog.departments.filter(entry => active(entry) && resourceDepartmentIds(resource).includes(entry.id));
  if (scope.kind === 'department') return departments.some(entry => entry.id === scope.id);
  const divisions = [String(resource.division_id || ''), ...departments.map(entry => entry.division_id || '')];
  // Existing branch affiliations participate only through explicitly mapped division nodes.
  if (resource.branch_id) divisions.push(...(structure.catalog.divisions || []).filter(entry => active(entry) && entry.branch_id === resource.branch_id).map(entry => entry.id));
  return divisions.some(id => ancestors(structure, id).includes(scope.id));
}

export function resolveScopedAccessGrants(assignments: unknown, roles: AccessRole[], structure: OrganizationStructureAccess): ScopedAccessGrant[] {
  if (!Array.isArray(assignments)) return [];
  return assignments.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const assignment = value as ScopedAccessAssignment;
    if (!assignment.scope || !['department', 'division'].includes(assignment.scope.kind) || !scopeExists(structure, assignment.scope)) return [];
    const role = assignment.role_id ? roles.find(entry => entry.id === assignment.role_id && entry.status === 'active') : undefined;
    if (assignment.role_id && !role) return [];
    const permissions = Object.fromEntries(Object.entries({ ...role?.permissions, ...assignment.permissions }).filter(([key, allowed]) => isDepartmentScopeablePermission(key) && typeof allowed === 'boolean'));
    return [{ ...assignment, permissions }];
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

/** Explicit division grants mapped to existing branch IDs; does not widen ordinary global role branch defaults. */
export function scopedPermissionBranchIds(ctx: PlatformAuthContext, permission: string) {
  const structure=ctx.organizationStructure;
  if(!structure)return [];
  return [...new Set((structure.catalog.divisions||[]).filter(active).map(division=>division.branch_id||'').filter(Boolean))].filter(branch_id=>permission.split('|').some(value=>{
    const name=value.trim();
    return (ctx.scopedAccessGrants||[]).some(grant=>grant.scope.kind==='division'&&grant.permissions[name]===true&&scopeMatches(structure,grant.scope,{branch_id}))&&hasResourcePermission(ctx,name,{branch_id});
  }));
}

/** SQL consumers OR these rules, applying each rule's denials to its whole positive clause. */
export function resourcePermissionRules(ctx: PlatformAuthContext, permission: string) {
  const structure=ctx.organizationStructure;
  const departments=structure?.catalog.departments.filter(entry=>scopeExists(structure,{kind:'department',id:entry.id})).map(entry=>entry.id)||[];
  const branches=[...new Set((structure?.catalog.divisions||[]).filter(active).map(entry=>entry.branch_id||'').filter(Boolean))];
  return [...new Set(permission.split('|').map(name=>name.trim()).filter(Boolean))].flatMap(name=>{
    if(ctx.permissions?.[name]===false)return [];
    const grants=(ctx.scopedAccessGrants||[]).filter(grant=>scopeExists(structure,grant.scope));
    const matches=(value:boolean,resource:DepartmentResource)=>!!structure&&grants.some(grant=>grant.permissions[name]===value&&scopeMatches(structure,grant.scope,resource));
    return [{global:hasPermission(ctx,name),department_ids:departments.filter(department_id=>matches(true,{department_id})),branch_ids:branches.filter(branch_id=>matches(true,{branch_id})),denied_department_ids:departments.filter(department_id=>matches(false,{department_id})),denied_branch_ids:branches.filter(branch_id=>matches(false,{branch_id}))}];
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
    division_ids: member?.division_ids || [], organization_wide: organizationWide,
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
  return value.map(raw => {
    const entry = raw as ScopedAccessAssignment;
    if (!entry?.scope || !['department', 'division'].includes(entry.scope.kind) || !scopeExists(structure, entry.scope)) throw badRequest('scoped_access_scope_invalid', 'Select an active department or division in this organization.');
    const role = entry.role_id ? roles.find(role => role.id === entry.role_id && role.status === 'active') : undefined;
    if (entry.role_id && !role) throw badRequest('scoped_access_role_invalid', 'Select an active role in this organization.');
    if (!entry.role_id && !Object.keys(entry.permissions || {}).length) throw badRequest('scoped_access_empty', 'Choose a role or permissions.');
    if (Object.entries(entry.permissions || {}).some(([key, value]) => !isDepartmentScopeablePermission(key) || typeof value !== 'boolean')) throw badRequest('scoped_access_permission_invalid', 'This permission cannot be assigned at department or division scope.');
    if (role && Object.entries(role.permissions).some(([key, value]) => value && !isDepartmentScopeablePermission(key))) throw badRequest('scoped_access_role_not_scopeable', 'This role includes organization-wide powers. Use a role containing only department-scoped capabilities.');
    return { ...(entry.role_id ? { role_id: entry.role_id } : {}), ...(entry.permissions ? { permissions: { ...entry.permissions } } : {}), scope: { ...entry.scope } };
  });
}
