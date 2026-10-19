import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";

export function canManageFeed(ctx: PlatformAuthContext) {
  if (ctx.permissions.manage_feed === false) return false;
  return hasPermission(ctx, "manage_feed") || (ctx.permissions.manage_feed === undefined && hasPermission(ctx, "manage_company_settings"));
}

export function canViewAllFeedDepartments(ctx: PlatformAuthContext) {
  if (ctx.permissions.view_feed_all_departments === false) return false;
  return hasPermission(ctx, "view_feed_all_departments") || (ctx.permissions.view_feed_all_departments === undefined && hasPermission(ctx, "manage_company_settings"));
}

export function canViewFeedActivity(ctx: PlatformAuthContext) {
  return ctx.permissions.view_feed_activity !== false && (ctx.permissions.view_feed_activity === undefined || hasPermission(ctx, "view_feed_activity"));
}

export function feedDepartmentContext(ctx: PlatformAuthContext) {
  const structure = ctx.organizationStructure;
  const memberIds = structure?.users.find(user => user.id === ctx.userId)?.department_ids || [];
  const organizationWide = canViewAllFeedDepartments(ctx);
  const activeDepartments = structure?.catalog.departments.filter(entry => entry.status !== "archived") || [];
  const departments = activeDepartments.filter(entry => organizationWide || memberIds.includes(entry.id));
  return {
    department_label: structure?.catalog.terminology?.department?.singular || "Department",
    departments_label: structure?.catalog.terminology?.department?.plural || "Departments",
    departments: departments.map(({ id, label }) => ({ id, label })),
    department_ids: departments.map(entry => entry.id), member_department_ids: memberIds,
    organization_wide: organizationWide, enabled: activeDepartments.length > 0,
    show_selector: departments.length > 1
  };
}

// This restriction is additional to the source's project/domain permissions.
// Company-wide content with no department remains visible to every feed reader.
export function matchesFeedDepartment(ctx: PlatformAuthContext, resource: { department_ids: string[] }, selected?: string) {
  const context = feedDepartmentContext(ctx);
  if (selected && selected !== "all" && !context.department_ids.includes(selected)) return false;
  if (!resource.department_ids.length) return !selected || selected === "all";
  if (!context.organization_wide && !resource.department_ids.some(id => context.member_department_ids.includes(id))) return false;
  return !selected || selected === "all" || resource.department_ids.includes(selected);
}
