/**
 * Staff authority checks for the staff console
 * (docs/architecture/request-security.md#principals). The route gate admits
 * staff; these decide what a given staff member may do inside a route.
 */
import type { FastifyRequest } from "fastify";
import { forbidden, unauthorized } from "../platform/errors.js";
import { knownPrincipal } from "../platform/security/principal.js";
import { staffAuthority, staffMeets, type StaffAuthority, type StaffLevel } from "../platform/security/staff.js";

type Json = Record<string, unknown>;

/** The verified staff member, or the system principal (null). Anyone else is refused. */
export function staffOrSystem(request: FastifyRequest): StaffAuthority | null {
  const principal = knownPrincipal(request);
  if (principal.kind === "system") return null;
  if (principal.kind === "staff") return principal.staff;
  if (principal.kind === "anonymous") throw unauthorized("authentication_required", "Authentication required.");
  throw forbidden("staff_required", "Internal staff access is required.");
}

export function requireStaffLevel(request: FastifyRequest, level: StaffLevel, what = "this action") {
  const staff = staffOrSystem(request);
  if (staff && !staffMeets(staff, level)) throw forbidden("staff_level_required", `Internal ${level} access is required for ${what}.`);
  return staff;
}

/** Fields of an internal user that only a full admin may set or change. */
const ADMIN_ONLY_ROLES = new Set(["admin", "system_admin"]);
const ADMIN_ONLY_PERMISSIONS = ["is_admin_legacy", "platform_admin", "manage_users", "manage_sales_users", "firstmeasure_debugger", "manage_qa_queue"];

function text(value: unknown) {
  return String(value ?? "").trim();
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/** Whether this staff member manages internal users at all. */
export function managesInternalUsers(staff: StaffAuthority) {
  return staff.admin || staff.permissions.manage_users === true || staff.permissions.manage_sales_users === true;
}

/**
 * May `staff` create or change `existing` (null for a new user) into `input`?
 * Only a full admin may create or edit an admin, grant admin-level roles or
 * permission flags, or set a raw password hash. A sales-user manager manages
 * sales staff only. Nobody but an admin changes another person's password.
 */
export function assertMayManageInternalUser(staff: StaffAuthority | null, existing: Json | null, input: Json) {
  if (!staff) return; // system principal: our own service code
  if (!managesInternalUsers(staff)) throw forbidden("user_manager_required", "Only user managers can change internal users.");
  if (staff.admin) return;
  const target = { ...(existing ?? {}), ...input };
  if (existing && staffAuthority({ ...existing, status: "active" })?.admin) throw forbidden("admin_required", "Only a full admin can change an admin.");
  if (ADMIN_ONLY_ROLES.has(text(target.role).toLowerCase()) || target.is_admin === true) {
    throw forbidden("admin_required", "Only a full admin can grant admin access.");
  }
  const before = record(existing?.permissions);
  const after = record(input.permissions);
  for (const key of ADMIN_ONLY_PERMISSIONS) {
    if (key in after && Boolean(after[key]) !== Boolean(before[key])) throw forbidden("admin_required", `Only a full admin can change the ${key} permission.`);
  }
  if (input.password_hash !== undefined || input.password_algo !== undefined) throw forbidden("admin_required", "Only a full admin can set a password hash.");
  if (existing && text(input.password) && text(existing.email).toLowerCase() !== staff.email) {
    throw forbidden("admin_required", "Only a full admin can set another person's password.");
  }
  if (existing && input.email !== undefined && text(input.email).toLowerCase() !== text(existing.email).toLowerCase()) {
    throw forbidden("admin_required", "Only a full admin can change a staff member's email.");
  }
  if (!staff.permissions.manage_users && staff.permissions.manage_sales_users) {
    const department = text(target.department).toLowerCase();
    const role = text(target.role).toLowerCase();
    if (department !== "sales" && !["salesperson", "sales_manager"].includes(role)) {
      throw forbidden("user_manager_required", "Sales user managers can manage sales staff only.");
    }
  }
}

/**
 * The staff level each staff console action (`POST /v1/internal/legacy-action`)
 * needs. Actions not listed need any staff member; their handlers keep their
 * own checks (shift manager, manager review, tutorial manager, call scripts).
 */
export const LEGACY_ACTION_LEVELS: Record<string, StaffLevel> = {
  save_user: "manager",
  delete_user: "manager",
  set_user_queue_mode: "manager",
  debug_organization_summaries: "admin",
  stats_credit_revenue: "admin",
  customer_users_export_page: "admin",
  customer_credit_export_page: "admin",
  org_assign_sales_owner: "manager",
  org_set_test_flag: "admin",
  admin_adjust_org_credits: "admin",
  admin_adjust_org_free_expedites: "admin",
  customer_apply_pairs: "manager",
  admin_impersonate_user: "admin",
  stats_data: "admin",
  fetch_all_users_with_orders: "manager",
  // Shift edits: requireShiftScheduleManager decides (it also admits manage_queue).
  shift_save_schedule: "any",
  shift_save_day_override: "any",
  shift_remove_day_override: "any",
  rush_mode_start: "admin",
  rush_mode_automation_set: "admin",
  pj_rebuild: "admin",
  server_config_list: "admin",
  server_config_set: "admin",
  get_apple_key_info: "admin",
  set_apple_key: "admin",
  coupon_admin_create: "manager",
  coupon_admin_update: "manager",
  coupon_admin_delete: "manager",
  commission_save_user_settings: "admin",
  commission_mark_payroll_completed: "admin",
  commission_export_report: "admin",
  lead_assign_org_credits: "admin",
  mock_comms_settings_save: "admin",
  mock_comms_reset: "admin",
  mock_comms_inject_gmail: "admin",
  mock_comms_inject_calendar: "admin",
  gmail_debug_snapshot: "admin",
  data_agent_save_settings: "admin",
  set_tutorial_assignment: "manager",
  save_curriculum: "manager",
  set_tutorial_exam_reviewed: "manager",
  qa_queue_move_to_top: "manager",
  qa_queue_clear_priority: "manager",
  manager_complexity_override: "manager",
  reject_no_coverage: "qa",
  cancel_project: "manager",
  reopen_completed_project: "manager",
  manager_review_settings_save: "manager",
  manager_review_override: "manager"
};

export function requireLegacyActionLevel(request: FastifyRequest, action: string) {
  return requireStaffLevel(request, LEGACY_ACTION_LEVELS[action] ?? "any", `the ${action} action`);
}
