/**
 * The one answer to "what may this internal staff member do"
 * (docs/architecture/request-security.md#principals). Every staff check reads
 * the internal user record through here, never a role sent by the caller.
 */
type Json = Record<string, unknown>;

export const STAFF_LEVELS = ["any", "technician", "qa", "manager", "admin"] as const;
export type StaffLevel = typeof STAFF_LEVELS[number];

export type StaffAuthority = {
  email: string;
  name: string;
  role: string;
  /** Highest level this person holds; each level includes the ones below it. */
  level: StaffLevel;
  admin: boolean;
  manager: boolean;
  qa: boolean;
  technician: boolean;
  /** May use FirstMeasure debug tools (traces, index status). */
  debugger: boolean;
  team_id: string;
  department: string;
  /** The record's permission flags (manage_users, manage_sales_users, ...). */
  permissions: Record<string, boolean>;
};

const PRODUCTION_ROLES = ["admin", "system_admin", "manager", "qa", "technician", "sales_manager", "salesperson", "trainee"];
const STAFF_PERMISSION_FLAGS = ["is_admin_legacy", "view_all_projects", "manage_queue", "manage_users", "manage_qa", "manage_sales_users", "platform_admin"];

function text(value: unknown) {
  return String(value ?? "").trim();
}

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/** Whether the internal user record is an active staff member at all. */
export function isActiveStaffUser(user: Json | null | undefined) {
  if (!user || user.disabled === true) return false;
  const status = text(user.status || "active").toLowerCase();
  if (!["active", "enabled"].includes(status)) return false;
  const permissions = record(user.permissions);
  if (text(user.account_type) === "employee") return true;
  if (PRODUCTION_ROLES.includes(text(user.role).toLowerCase())) return true;
  if (user.is_admin === true) return true;
  return STAFF_PERMISSION_FLAGS.some((key) => permissions[key] === true);
}

/** Null when the record is not an active staff member. */
export function staffAuthority(user: Json | null | undefined): StaffAuthority | null {
  if (!user || !isActiveStaffUser(user)) return null;
  const role = text(user.role).toLowerCase();
  const permissions = record(user.permissions);
  const admin = ["admin", "system_admin"].includes(role) || user.is_admin === true
    || permissions.is_admin_legacy === true || permissions.platform_admin === true;
  const manager = admin || ["manager", "sales_manager"].includes(role) || permissions.manage_qa_queue === true;
  const qa = manager || role === "qa" || permissions.manage_qa === true || user.is_qa_trainee === true;
  const technician = qa || ["technician", "trainee"].includes(role);
  const level: StaffLevel = admin ? "admin" : manager ? "manager" : qa ? "qa" : technician ? "technician" : "any";
  return {
    email: text(user.email).toLowerCase(),
    name: text(user.name) || text(user.email),
    role,
    level,
    admin,
    manager,
    qa,
    technician,
    debugger: admin || permissions.firstmeasure_debugger === true,
    team_id: text(user.team_id),
    department: text(user.department),
    permissions: Object.fromEntries(Object.entries(permissions).map(([key, value]) => [key, value === true]))
  };
}

export function staffMeets(authority: StaffAuthority | null | undefined, level: StaffLevel) {
  if (!authority) return false;
  return STAFF_LEVELS.indexOf(authority.level) >= STAFF_LEVELS.indexOf(level);
}

/** The legacy `roles` list FirstMeasure handlers read from an actor. */
export function staffActorRoles(authority: StaffAuthority) {
  const roles = new Set<string>();
  if (authority.role) roles.add(authority.role);
  if (authority.admin) roles.add("admin");
  if (authority.manager) roles.add("manager");
  if (authority.qa) roles.add("qa");
  if (authority.technician) roles.add("technician");
  if (authority.debugger) roles.add("firstmeasure_debugger");
  return [...roles];
}

export function internalStaffOrgId() {
  return text(process.env.INTERNAL_PLATFORM_ORG_ID || process.env.STAFF_PLATFORM_ORG_ID || "legacy_internal").toLowerCase();
}

/** Whether a platform identity has an active membership in the internal staff organization. */
export function identityIsStaffMember(identity: Json | null | undefined) {
  const staffOrg = internalStaffOrgId();
  const memberships = Array.isArray(identity?.memberships) ? identity!.memberships as unknown[] : [];
  return memberships.some((value) => {
    const membership = record(value);
    const orgId = text(membership.organization_id || record(membership.organization).id).toLowerCase();
    return orgId === staffOrg && !["disabled", "removed", "inactive", "invited"].includes(text(membership.status).toLowerCase());
  });
}
