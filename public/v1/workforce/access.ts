import { randomBytes } from "node:crypto";

import { badRequest, conflict, notFound } from "../platform/errors.js";
import { getWorkforceDatabase } from "./storage.js";
import { resolveOrganizationStructure, type OrganizationStructure } from './organization-structure.js';
import { resolveScopedAccessGrants, type ScopedAccessGrant } from './department-access.js';
import { effectiveCapabilities } from '../platform/capabilities.js';
import { appDefinitions, canonicalAppId, type AppDefinition, type AppSurface } from "../platform/app-experience/registry.js";
import { deviceTypeIds, isDeviceTypeId, type DeviceId } from "../platform/app-experience/devices.js";
import { CREW_PERMISSION_KEYS, PAYROLL_PERMISSION_KEYS, SALES_PERMISSION_KEYS } from "./permission-keys.js";

export { CREW_PERMISSION_KEYS, PAYROLL_PERMISSION_KEYS, SALES_PERMISSION_KEYS };
export { canonicalAppId };

export type JsonObject = Record<string, unknown>;
export type PermissionMap = Record<string, boolean>;

export const ACCESS_SCHEMA_VERSION = 2;

export const DEFAULT_ACCESS_ROLE_IDS = Object.freeze({
  viewer: "viewer",
  manager: "manager",
  admin: "admin",
  super_admin: "super_admin",
  crew_member: "crew_member",
  crew_foreman: "crew_foreman",
  supervisor: "supervisor",
  repairman: "repairman",
  salesperson: "salesperson"
});

/**
 * What one layer (a role, group, department or the person) says about one app
 * (docs/architecture/app-experience.md). A device or option it leaves out
 * inherits from the layer below.
 */
export type AppSetting = {
  /** Device type -> shown. */
  visible: Record<DeviceId, boolean>;
  /** Option key -> on. */
  options: Record<string, boolean>;
  params: JsonObject;
  layout: JsonObject;
};

/** A group's or department's setting can also restrict an app: hidden everywhere and refused by the server. */
export type MembershipAppSetting = AppSetting & { restricted: boolean };

export type AccessRole = {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  is_system: boolean;
  system_key: string;
  permissions: PermissionMap;
  app_defaults: Record<string, AppSetting>;
  metadata: JsonObject;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string;
};

export type AccessRoleCreateInput = {
  id?: string;
  name: string;
  description?: string;
  permissions?: unknown;
  permission_defaults?: unknown;
  app_defaults?: unknown;
  apps?: unknown;
  metadata?: unknown;
};

export type AccessRolePatchInput = Partial<AccessRoleCreateInput> & {
  expected_revision: number;
  status?: "active" | "archived";
};

export type AppSettingSource = "app_default" | "role_default" | "department_default" | "group_default" | "user_override" | "restricted";

/** One app as one person gets it. */
export type EffectiveAppEntitlement = AppDefinition & {
  /** Device type -> shown, for every device the app exists on. */
  visible: Record<DeviceId, boolean>;
  visible_devices: DeviceId[];
  /** Shown on at least one device. Opening the app and using its API needs this. */
  allowed: boolean;
  restricted: boolean;
  option_values: Record<string, boolean>;
  sources: {
    devices: Record<DeviceId, AppSettingSource>;
    options: Record<string, AppSettingSource>;
    role_ids: string[];
  };
  params: JsonObject;
  layout: JsonObject;
  reasons: string[];
};

export type ResolvedAccessProfile = {
  schema_version: number;
  organization_id: string;
  user_id: string;
  access_role_ids: string[];
  unresolved_access_role_ids: string[];
  roles: AccessRole[];
  permissions: PermissionMap;
  effective_permissions: PermissionMap;
  app_entitlements: EffectiveAppEntitlement[];
  app_entitlements_by_id: Record<string, EffectiveAppEntitlement>;
  allowed_app_ids: string[];
  user_revision: number;
  scoped_access_grants?: ScopedAccessGrant[];
  organization_structure?: OrganizationStructure;
  app_restrictions?: string[];
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return cleanText(value) ? [value] : [];
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function nowIso() {
  return new Date().toISOString();
}

function cleanOrganizationId(value: unknown) {
  const id = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw badRequest("invalid_organization_id", "organization_id must contain at least one letter or number.");
  return id;
}

function cleanRoleId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
}

function boolValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = cleanText(value).toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "allow", "allowed"].includes(text)) return true;
  if (["0", "false", "no", "off", "disabled", "deny", "denied"].includes(text)) return false;
  return fallback;
}

export function normalizePermissionMap(value: unknown): PermissionMap {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(cleanText).filter(Boolean).map((permission) => [permission, true]));
  }
  const input = asObject(value);
  const result: PermissionMap = {};
  for (const [permissionValue, allowedValue] of Object.entries(input)) {
    const permission = cleanText(permissionValue);
    if (!permission) continue;
    result[permission] = boolValue(allowedValue, false);
  }
  return result;
}


function shownValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = cleanText(value).toLowerCase();
  if (["show", "shown", "visible", "on", "true"].includes(text)) return true;
  if (["hide", "hidden", "off", "false"].includes(text)) return false;
  return undefined;
}

function deviceVisibility(value: unknown): Record<DeviceId, boolean> {
  const every = shownValue(value);
  if (every !== undefined) return Object.fromEntries(deviceTypeIds().map((device) => [device, every]));
  const result: Record<DeviceId, boolean> = {};
  for (const [device, shown] of Object.entries(asObject(value))) {
    const state = shownValue(shown);
    if (isDeviceTypeId(device) && state !== undefined) result[device] = state;
  }
  return result;
}

function optionValues(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [key, on] of Object.entries(asObject(value))) {
    const state = shownValue(on);
    if (cleanText(key) && state !== undefined) result[cleanText(key)] = state;
  }
  return result;
}

/**
 * One layer's setting for one app. `true`/`"show"` and `false`/`"hide"` mean
 * every device; `{ visible: { desktop: true } }` sets one device. Returns null
 * when the layer says nothing, so the app inherits.
 */
export function normalizeAppSetting(value: unknown): AppSetting | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    const shown = shownValue(value);
    return shown === undefined ? null : { visible: deviceVisibility(shown), options: {}, params: {}, layout: {} };
  }
  const input = asObject(value);
  const visibleSource = input.visible ?? input.enabled ?? input.visibility;
  const setting: AppSetting = {
    visible: visibleSource === undefined || cleanText(visibleSource) === "inherit" ? {} : deviceVisibility(visibleSource),
    options: optionValues(input.options),
    params: asObject(input.params),
    layout: asObject(input.layout)
  };
  const empty = !Object.keys(setting.visible).length && !Object.keys(setting.options).length
    && !Object.keys(setting.params).length && !Object.keys(setting.layout).length;
  return empty ? null : setting;
}

export function normalizeAppDefaults(value: unknown): Record<string, AppSetting> {
  const result: Record<string, AppSetting> = {};
  for (const [appIdValue, settingValue] of Object.entries(asObject(value))) {
    const appId = canonicalAppId(appIdValue);
    const setting = normalizeAppSetting(settingValue);
    if (appId && setting) result[appId] = setting;
  }
  return result;
}

/** Settings as stored on a person: only the parts that say something. */
export function compactAppDefaults(value: unknown): Record<string, JsonObject> {
  return Object.fromEntries(Object.entries(normalizeAppDefaults(value)).map(([appId, setting]) => [appId,
    Object.fromEntries(Object.entries(setting).filter(([, part]) => Object.keys(asObject(part)).length))]));
}

/** A group's or department's settings, which may also restrict an app. */
export function normalizeMembershipAppDefaults(value: unknown): Record<string, MembershipAppSetting> {
  const result: Record<string, MembershipAppSetting> = {};
  for (const [appIdValue, settingValue] of Object.entries(asObject(value))) {
    const appId = canonicalAppId(appIdValue);
    const input = asObject(settingValue);
    const restricted = input.restricted === true;
    const setting = normalizeAppSetting(settingValue);
    if (appId && (setting || restricted)) result[appId] = { visible: {}, options: {}, params: {}, layout: {}, ...(setting || {}), restricted };
  }
  return result;
}

function mergeJson(leftValue: unknown, rightValue: unknown): JsonObject {
  const left = asObject(leftValue);
  const right = asObject(rightValue);
  const result: JsonObject = { ...left, ...right };
  for (const key of Object.keys(right)) {
    if (Object.keys(asObject(left[key])).length && Object.keys(asObject(right[key])).length) {
      result[key] = mergeJson(left[key], right[key]);
    }
  }
  return result;
}


function everyDevice(shown: boolean) {
  return Object.fromEntries(deviceTypeIds().map((device) => [device, shown]));
}

/** Show these apps, which are hidden by default, on every device they exist on. */
function showApps(ids: string[]): Record<string, AppSetting> {
  return Object.fromEntries(ids.map((id) => [id, { visible: everyDevice(true), options: {}, params: {}, layout: {} }]));
}

// Money apps are hidden by default; the roles that handle money show them.
const MANAGER_MONEY_APPS = ["portal.invoices", "portal.financials"];
const ADMIN_MONEY_APPS = [...MANAGER_MONEY_APPS, "portal.payroll"];

type PersonaApp = true | { options?: Record<string, boolean>; params?: JsonObject };

/**
 * App defaults for a role that sees exactly these apps: the listed ones are
 * shown on every device they exist on and every app shown by default is hidden.
 */
function onlyApps(shown: Record<string, PersonaApp>): Record<string, AppSetting> {
  const result: Record<string, AppSetting> = {};
  for (const app of appDefinitions()) {
    const pick = shown[app.id];
    if (pick) {
      const extra = pick === true ? {} : pick;
      result[app.id] = { visible: everyDevice(true), options: { ...(extra.options || {}) }, params: { ...(extra.params || {}) }, layout: {} };
    } else if (app.default_visible) {
      result[app.id] = { visible: everyDevice(false), options: {}, params: {}, layout: {} };
    }
  }
  return result;
}

// The apps every field persona starts from. Change orders are visible to every
// field role; write access is governed by crew.change_orders.manage so members
// get a read-only view.
function fieldPersonaApps(options: { checklists_mode: string; time_clock: boolean; extra?: Record<string, PersonaApp> }) {
  return onlyApps({
    "portal.crew_overview": { options: { time_clock: options.time_clock } },
    "portal.crew_schedule": true,
    "portal.crew_payouts": true,
    "portal.crew_receipts": true,
    "project.crew_overview": true,
    "project.field_customer": true,
    "project.crew_materials": true,
    "project.crew_payouts": true,
    "project.crew_checklists": { params: { mode: options.checklists_mode } },
    "project.crew_change_orders": true,
    ...(options.extra || {})
  });
}

export type FactoryPersonaDefinition = {
  id: string;
  name: string;
  description: string;
  level: number;
  permissions: PermissionMap;
  app_defaults: Record<string, AppSetting>;
  metadata: JsonObject;
  capability_requirements: string[];
};

// Factory persona definitions are the single source for the system access-role
// seeds AND the factory persona templates copied into each organization
// (see persona_templates.ts). Role seeding derives from this data, so a
// factory template and its seeded system role are always content-identical.
export function factoryPersonaDefinitions(): FactoryPersonaDefinition[] {
  const managerReadPermissions: PermissionMap = Object.fromEntries([
    "view_contacts", "view_schedule", "view_financials", "view_documents",
    "view_materials", "view_proposals", "view_stats", "view_websites",
    "view_pricebook", "view_feedback", "view_canvassing", "view_media",
    "view_comms", "view_customer_portals", "view_project_data", "view_feed_all_departments"
  ].map(key => [key, true]));
  const managerWritePermissions: PermissionMap = Object.fromEntries([
    "manage_project_billing", "manage_documents", "issue_documents", "sign_documents", "import_document_signatures",
    "manage_proposals", "send_proposals", "manage_stats", "manage_websites",
    "request_feedback", "manage_canvassing", "manage_media",
    "manage_customer_portals", "manage_project_data", "manage_feed"
  ].map(key => [key, true]));
  const adminPermissions: PermissionMap = {
    "*": true,
    order_reports: true,
    view_reports: true,
    view_projects: true,
    manage_projects: true,
    manage_schedule: true,
    manage_billing: true,
    manage_company_settings: true,
    manage_report_settings: true,
    manage_company_users: true,
    // Branch reach: only administrators see and manage every branch by default (docs/architecture/branches.md).
    view_all_branches: true,
    manage_all_branches: true
  };
  const crewMemberPermissions: PermissionMap = Object.fromEntries([
    CREW_PERMISSION_KEYS.dashboard_view,
    CREW_PERMISSION_KEYS.projects_view,
    CREW_PERMISSION_KEYS.schedule_view,
    CREW_PERMISSION_KEYS.receipts_upload,
    CREW_PERMISSION_KEYS.reimbursements_request,
    CREW_PERMISSION_KEYS.materials_view,
    CREW_PERMISSION_KEYS.materials_append,
    CREW_PERMISSION_KEYS.payouts_view,
    CREW_PERMISSION_KEYS.checklists_view,
    CREW_PERMISSION_KEYS.checklists_complete
  ].map((permission) => [permission, true]));
  // Crew members can review change orders (read-only) but not create or send
  // them, and never see customer payments by default.
  crewMemberPermissions[CREW_PERMISSION_KEYS.change_orders_view] = true;
  // Crew roles (member and foreman) stay production-focused: no customer
  // payments and no change-order issuing. The supervisor closes the job out.
  const crewForemanPermissions: PermissionMap = {
    ...crewMemberPermissions,
    [CREW_PERMISSION_KEYS.checklists_manage]: true
  };
  const repairmanPermissions: PermissionMap = {
    ...crewMemberPermissions,
    [CREW_PERMISSION_KEYS.checklists_manage]: true
  };
  const supervisorPermissions: PermissionMap = {
    ...crewForemanPermissions,
    [CREW_PERMISSION_KEYS.projects_view_all_production]: true,
    [CREW_PERMISSION_KEYS.payments_view]: true,
    [CREW_PERMISSION_KEYS.payments_take]: true,
    [CREW_PERMISSION_KEYS.change_orders_view]: true,
    [CREW_PERMISSION_KEYS.change_orders_manage]: true,
    [CREW_PERMISSION_KEYS.checklists_supervise]: true,
    [CREW_PERMISSION_KEYS.signatures_present]: true,
    [CREW_PERMISSION_KEYS.workflows_add]: true
  };
  const personas: FactoryPersonaDefinition[] = [
    {
      id: DEFAULT_ACCESS_ROLE_IDS.viewer,
      name: "Viewer",
      description: "Read-only access to projects, contacts, schedules and documents.",
      permissions: { view_reports: true, view_projects: true, view_contacts: true, view_schedule: true, view_documents: true, view_materials: true, view_proposals: true, view_stats: true, view_pricebook: true, view_feedback: true, view_customer_portals: true, view_project_data: true },
      app_defaults: {},
      level: 10,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.manager,
      name: "Manager",
      description: "Operational management access without company administration.",
      permissions: { order_reports: true, view_reports: true, view_projects: true, manage_projects: true, manage_schedule: true, ...managerReadPermissions, ...managerWritePermissions },
      app_defaults: showApps(MANAGER_MONEY_APPS),
      level: 20,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.admin,
      name: "Administrator",
      description: "Company administration and operational management access.",
      permissions: adminPermissions,
      app_defaults: showApps(ADMIN_MONEY_APPS),
      level: 30,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.super_admin,
      name: "Super Administrator",
      description: "Unrestricted data permission; apps for other kinds of work stay hidden unless shown.",
      permissions: { "*": true, ...adminPermissions, manage_company_user_permissions: true },
      app_defaults: showApps(ADMIN_MONEY_APPS),
      level: 40,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.crew_member,
      name: "Crew Member",
      description: "Assigned work, time, receipts, materials, earnings and checklists, with read-only change orders.",
      permissions: crewMemberPermissions,
      app_defaults: fieldPersonaApps({ checklists_mode: "complete", time_clock: true }),
      level: 10,
      metadata: { field_mode: "crew" },
      capability_requirements: ["apps.crew"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.repairman,
      name: "Repairman",
      description: "Solo technician assigned work directly: crew access plus managing their own job checklists.",
      permissions: repairmanPermissions,
      app_defaults: fieldPersonaApps({ checklists_mode: "manage", time_clock: true }),
      level: 15,
      metadata: { field_mode: "solo" },
      capability_requirements: ["apps.crew"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.crew_foreman,
      name: "Crew Foreman",
      description: "Crew Member access plus managing checklists. Payments and change orders belong to the closing-out role.",
      permissions: crewForemanPermissions,
      app_defaults: fieldPersonaApps({ checklists_mode: "manage", time_clock: true }),
      level: 20,
      metadata: { field_mode: "crew" },
      capability_requirements: ["apps.crew"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.supervisor,
      name: "Supervisor",
      description: "Sees every production project, reviews work with quality checklists, and closes out with payments and change orders.",
      permissions: supervisorPermissions,
      app_defaults: fieldPersonaApps({
        checklists_mode: "manage",
        time_clock: true,
        // Only the closing-out role sees customer payments by default;
        // companies can show the app for other roles in App experience.
        extra: {
          "project.crew_payments": true,
          "project.crew_signatures": { params: { mode: "present" } },
          "portal.crew_overview": { options: { time_clock: true }, params: { variant: "supervisor" } }
        }
      }),
      level: 30,
      metadata: { field_mode: "supervisor" },
      capability_requirements: ["apps.crew", "platform.money"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.salesperson,
      name: "Salesperson",
      description: "Phone-first sales: today's appointments, follow-ups, commission earnings, and proposal status.",
      permissions: {
        [SALES_PERMISSION_KEYS.dashboard_view]: true,
        [SALES_PERMISSION_KEYS.schedule_view]: true,
        [SALES_PERMISSION_KEYS.followups_manage]: true,
        [SALES_PERMISSION_KEYS.earnings_view]: true,
        [SALES_PERMISSION_KEYS.documents_view_status]: true,
        [SALES_PERMISSION_KEYS.money_view_status]: true,
        [SALES_PERMISSION_KEYS.stats_view_own]: true,
        // Shared project views: salespeople can collect on-the-spot payments
        // and complete sales-facing checklists on their assigned projects.
        [CREW_PERMISSION_KEYS.projects_view]: true,
        [CREW_PERMISSION_KEYS.signatures_present]: true,
        [CREW_PERMISSION_KEYS.workflows_add]: true,
        [CREW_PERMISSION_KEYS.payments_view]: true,
        [CREW_PERMISSION_KEYS.payments_take]: true,
        [CREW_PERMISSION_KEYS.checklists_view]: true,
        [CREW_PERMISSION_KEYS.checklists_complete]: true
      },
      app_defaults: onlyApps({
        "portal.sales_overview": true,
        "portal.sales_schedule": true,
        "portal.sales_earnings": true,
        "project.sales_overview": true,
        "project.field_customer": true,
        "project.crew_signatures": { params: { mode: "present" } },
        "project.crew_payments": true,
        "project.crew_checklists": { params: { mode: "complete" } }
      }),
      level: 20,
      metadata: { field_mode: "sales" },
      capability_requirements: ["apps.sales", "platform.scheduling"]
    }
  ];
  // Every seeded role may see its own projected earnings; a company that does not want them shown denies the permission.
  return personas.map(persona => ({ ...persona, permissions: { ...persona.permissions, manage_own_notifications: true, [PAYROLL_PERMISSION_KEYS.view_own_projected_earnings]: true, ...(persona.permissions.manage_company_settings === true || persona.permissions["*"] === true ? { manage_notification_defaults: true } : {}) } }));
}

type SeedRole = {
  id: string;
  name: string;
  description: string;
  permissions: PermissionMap;
  app_defaults: Record<string, AppSetting>;
  level: number;
  metadata?: JsonObject;
};

const initializedAccessDatabases = new WeakSet<object>();
const seededAccessOrganizations = new WeakMap<object, Set<string>>();

function defaultRoleSeeds(): SeedRole[] {
  return factoryPersonaDefinitions().map((definition) => ({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    permissions: definition.permissions,
    app_defaults: definition.app_defaults,
    level: definition.level,
    metadata: definition.metadata
  }));
}

export async function initializeAccessSchema(orgIdValue?: string) {
  const db = getWorkforceDatabase();
  if (!initializedAccessDatabases.has(db)) {
    initializedAccessDatabases.add(db);
  }
  if (orgIdValue) (await seedDefaultAccessRoles(cleanOrganizationId(orgIdValue)));
  return { schema_version: ACCESS_SCHEMA_VERSION, initialized: true };
}

const ACCESS_ROLE_PRESET_REVISION = 9;

// The role table keeps its older application_id and application_ids_json
// columns; nothing reads them and every write stores them empty.
async function seedDefaultAccessRoles(orgId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  const db = getWorkforceDatabase();
  let seededOrganizations = seededAccessOrganizations.get(db);
  if (!seededOrganizations) {
    seededOrganizations = new Set<string>();
    seededAccessOrganizations.set(db, seededOrganizations);
  }
  if (seededOrganizations.has(orgId)) return;
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO workforce_access_roles
    (organization_id, id, application_id, application_ids_json, name, description, status, is_system, system_key,
     permissions_json, app_defaults_json, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, '', '[]', ?, ?, 'active', 1, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`);
  const readExisting = db.prepare(`SELECT metadata_json, revision FROM workforce_access_roles
    WHERE organization_id=? AND id=? AND is_system=1`);
  const upgrade = db.prepare(`UPDATE workforce_access_roles
    SET description=?, permissions_json=?, app_defaults_json=?, metadata_json=?, revision=revision+1, updated_at=?
    WHERE organization_id=? AND id=? AND is_system=1`);
  for (const seed of defaultRoleSeeds()) {
    (await insert.run(
      orgId,
      seed.id,
      seed.name,
      seed.description,
      `role.${seed.id}`,
      json(seed.permissions),
      json(seed.app_defaults),
      json({ system_default: true, preset_revision: ACCESS_ROLE_PRESET_REVISION, level: seed.level, ...asObject(seed.metadata) }),
      now,
      now
    ));
    // Upgrade previously seeded system roles when the preset definition changes
    // (new permissions or app defaults) without touching custom roles.
    const existing = asObject((await readExisting.get(orgId, seed.id)));
    const metadata = asObject(parseJson(existing.metadata_json));
    const presetRevision = Number(metadata.preset_revision || 1);
    if (metadata.system_default === true && presetRevision < ACCESS_ROLE_PRESET_REVISION) {
      (await upgrade.run(
        seed.description,
        json(seed.permissions),
        json(seed.app_defaults),
        json({ ...metadata, preset_revision: ACCESS_ROLE_PRESET_REVISION, level: seed.level, ...asObject(seed.metadata) }),
        now,
        orgId,
        seed.id
      ));
    }
  }
  seededOrganizations.add(orgId);

  }));
}

export async function initializeAccessRoles(orgIdValue: string) {
  const orgId = cleanOrganizationId(orgIdValue);
  (await initializeAccessSchema());
  (await seedDefaultAccessRoles(orgId));
  return (await listAccessRoles(orgId, { include_archived: true }));
}

async function ensureAccessDefaults(orgIdValue: string) {
  const orgId = cleanOrganizationId(orgIdValue);
  (await initializeAccessSchema());
  (await seedDefaultAccessRoles(orgId));
  return orgId;
}

function roleView(rowValue: unknown): AccessRole {
  const row = asObject(rowValue);
  const status = cleanText(row.status) === "archived" ? "archived" : "active";
  return {
    id: cleanRoleId(row.id),
    organization_id: cleanText(row.organization_id),
    name: cleanText(row.name),
    description: cleanText(row.description),
    status,
    is_system: Number(row.is_system || 0) === 1,
    system_key: cleanText(row.system_key),
    permissions: normalizePermissionMap(parseJson(row.permissions_json)),
    app_defaults: normalizeAppDefaults(parseJson(row.app_defaults_json)),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    archived_at: cleanText(row.archived_at)
  };
}

export async function listAccessRoles(orgIdValue: string, options: boolean | { include_archived?: boolean } = {}) {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const normalizedOptions = typeof options === "boolean" ? { include_archived: options } : options;
  const clauses = ["organization_id=?"];
  if (!normalizedOptions.include_archived) clauses.push("status='active'");
  return (await getWorkforceDatabase().prepare(`SELECT * FROM workforce_access_roles
    WHERE ${clauses.join(" AND ")} ORDER BY name ASC, id ASC`)
    .all(orgId)).map(roleView);
}

export async function readAccessRole(orgIdValue: string, roleIdValue: string) {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const roleId = cleanRoleId(roleIdValue);
  const row = (await getWorkforceDatabase().prepare(`SELECT * FROM workforce_access_roles
    WHERE organization_id=? AND id=?`).get(orgId, roleId));
  if (!row) throw notFound("access_role_not_found", "Access role was not found.");
  return roleView(row);
}

async function generatedRoleId(orgId: string, name: string) {
  const base = cleanRoleId(name) || "access_role";
  const db = getWorkforceDatabase();
  if (!(await db.prepare("SELECT 1 AS found FROM workforce_access_roles WHERE organization_id=? AND id=?").get(orgId, base))) return base;
  return `${base}_${randomBytes(4).toString("hex")}`;
}

export async function createAccessRole(orgIdValue: string, inputValue: AccessRoleCreateInput | JsonObject) {
  return (await getWorkforceDatabase().transaction(async () => {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const input = asObject(inputValue);
  const name = cleanText(input.name);
  if (!name) throw badRequest("access_role_name_required", "Access role name is required.");
  const explicitId = cleanRoleId(input.id);
  const roleId = explicitId || (await generatedRoleId(orgId, name));
  if (!roleId) throw badRequest("invalid_access_role_id", "Access role id must contain at least one letter or number.");
  const db = getWorkforceDatabase();
  if ((await db.prepare("SELECT 1 AS found FROM workforce_access_roles WHERE organization_id=? AND id=?").get(orgId, roleId))) {
    throw conflict("access_role_exists", `Access role '${roleId}' already exists.`);
  }
  const now = nowIso();
  (await db.prepare(`INSERT INTO workforce_access_roles
    (organization_id, id, application_id, application_ids_json, name, description, status, is_system, system_key,
     permissions_json, app_defaults_json, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, '', '[]', ?, ?, 'active', 0, '', ?, ?, ?, 1, ?, ?)`)
    .run(
      orgId,
      roleId,
      name,
      cleanText(input.description),
      json(normalizePermissionMap(input.permissions ?? input.permission_defaults)),
      json(normalizeAppDefaults(input.app_defaults ?? input.apps)),
      json(asObject(input.metadata)),
      now,
      now
    ));
  return (await readAccessRole(orgId, roleId));

  }));
}

function requiredRevision(value: unknown) {
  const revision = Number(value || 0);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw badRequest("expected_revision_required", "A positive expected_revision is required.");
  }
  return revision;
}

export async function patchAccessRole(orgIdValue: string, roleIdValue: string, inputValue: AccessRolePatchInput | JsonObject) {
  return (await getWorkforceDatabase().transaction(async () => {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const roleId = cleanRoleId(roleIdValue);
  const input = asObject(inputValue);
  const current = (await readAccessRole(orgId, roleId));
  const expectedRevision = requiredRevision(input.expected_revision);
  if (current.revision !== expectedRevision) {
    throw conflict("access_role_revision_conflict", "Access role revision does not match.", { current_revision: current.revision });
  }
  const name = Object.prototype.hasOwnProperty.call(input, "name") ? cleanText(input.name) : current.name;
  if (!name) throw badRequest("access_role_name_required", "Access role name is required.");
  const statusValue = Object.prototype.hasOwnProperty.call(input, "status") ? cleanText(input.status).toLowerCase() : current.status;
  if (!["active", "archived"].includes(statusValue)) throw badRequest("access_role_status_invalid", "Access role status must be active or archived.");
  const status = statusValue as "active" | "archived";
  const permissions = Object.prototype.hasOwnProperty.call(input, "permissions") || Object.prototype.hasOwnProperty.call(input, "permission_defaults")
    ? normalizePermissionMap(input.permissions ?? input.permission_defaults)
    : current.permissions;
  const appDefaults = Object.prototype.hasOwnProperty.call(input, "app_defaults") || Object.prototype.hasOwnProperty.call(input, "apps")
    ? normalizeAppDefaults(input.app_defaults ?? input.apps)
    : current.app_defaults;
  const metadata = Object.prototype.hasOwnProperty.call(input, "metadata") ? asObject(input.metadata) : current.metadata;
  const now = nowIso();
  const result = (await getWorkforceDatabase().prepare(`UPDATE workforce_access_roles SET
    name=?, description=?, status=?, permissions_json=?, app_defaults_json=?, metadata_json=?,
    revision=revision+1, updated_at=?, archived_at=?
    WHERE organization_id=? AND id=? AND revision=?`)
    .run(
      name,
      Object.prototype.hasOwnProperty.call(input, "description") ? cleanText(input.description) : current.description,
      status,
      json(permissions),
      json(appDefaults),
      json(metadata),
      now,
      status === "archived" ? (current.archived_at || now) : null,
      orgId,
      roleId,
      expectedRevision
    ));
  if (Number(result.changes || 0) !== 1) {
    const latest = (await readAccessRole(orgId, roleId));
    throw conflict("access_role_revision_conflict", "Access role revision does not match.", { current_revision: latest.revision });
  }
  return (await readAccessRole(orgId, roleId));

  }));
}

export async function archiveAccessRole(
  orgIdValue: string,
  roleIdValue: string,
  expectedRevisionValue: number | { expected_revision: number } | JsonObject
) {
  return (await getWorkforceDatabase().transaction(async () => {
  const expectedRevision = typeof expectedRevisionValue === "number"
    ? expectedRevisionValue
    : Number(asObject(expectedRevisionValue).expected_revision || 0);
  return (await patchAccessRole(orgIdValue, roleIdValue, { expected_revision: requiredRevision(expectedRevision), status: "archived" }));

  }));
}

// A person saved before roles existed is read as the role their old
// permission level names.
const LEGACY_ROLE_ALIASES: Record<string, string> = {
  owner: DEFAULT_ACCESS_ROLE_IDS.super_admin,
  superadmin: DEFAULT_ACCESS_ROLE_IDS.super_admin,
  super_admin: DEFAULT_ACCESS_ROLE_IDS.super_admin,
  "super-admin": DEFAULT_ACCESS_ROLE_IDS.super_admin,
  administrator: DEFAULT_ACCESS_ROLE_IDS.admin,
  admin: DEFAULT_ACCESS_ROLE_IDS.admin,
  manager: DEFAULT_ACCESS_ROLE_IDS.manager,
  member: DEFAULT_ACCESS_ROLE_IDS.viewer,
  user: DEFAULT_ACCESS_ROLE_IDS.viewer,
  viewer: DEFAULT_ACCESS_ROLE_IDS.viewer
};

function legacyRoleId(user: JsonObject) {
  const raw = cleanText(user.org_permission_level ?? user.permission_level ?? user.role ?? asObject(user.org_permissions).level)
    .toLowerCase().replace(/\s+/g, "_");
  return LEGACY_ROLE_ALIASES[raw] || DEFAULT_ACCESS_ROLE_IDS.viewer;
}

function unwrappedUserData(value: unknown) {
  const outer = asObject(value);
  const data = asObject(outer.data);
  return Object.keys(data).length ? { ...outer, ...data } : outer;
}

function assignedRoleIds(user: JsonObject) {
  const access = asObject(user.access ?? user.access_profile);
  const hasExplicit = Object.prototype.hasOwnProperty.call(user, "access_role_ids")
    || Object.prototype.hasOwnProperty.call(access, "access_role_ids")
    || Object.prototype.hasOwnProperty.call(access, "role_ids")
    || Object.prototype.hasOwnProperty.call(access, "roles");
  const values = user.access_role_ids ?? access.access_role_ids ?? access.role_ids ?? access.roles;
  return {
    explicit: hasExplicit,
    ids: [...new Set(asArray(values).map((value) => cleanRoleId(asObject(value).id || value)).filter(Boolean))]
  };
}

/** Additive notification permissions: explicit denials override legacy defaults. */
export function notificationAccessPermissions(permissions: PermissionMap, user: JsonObject = {}, roles: Pick<AccessRole, "permissions">[] = [], legacyAdministrator = false) {
  const access = asObject(user.access ?? user.access_profile);
  const maps = [permissions, ...roles.map(role => role.permissions), asObject(user.permissions), asObject(asObject(user.org_permissions).items), asObject(access.permission_overrides), asObject(user.permission_overrides)];
  const allowed = (key: string, fallback: boolean) => {
    if (maps.some(map => map[key] === false)) return false;
    return maps.some(map => map[key] === true) || fallback;
  };
  const companySettings = permissions.manage_company_settings !== false && (permissions.manage_company_settings === true || permissions["*"] === true || legacyAdministrator);
  return { manage_own_notifications: allowed("manage_own_notifications", true), manage_notification_defaults: allowed("manage_notification_defaults", companySettings) };
}

export function feedAccessPermissions(permissions: PermissionMap) {
  const allowed = (key: string, fallback: boolean) => permissions[key] !== false && (permissions[key] === true || permissions["*"] === true || fallback);
  const companySettings = allowed("manage_company_settings", false);
  return { manage_feed: allowed("manage_feed", companySettings), view_feed_all_departments: allowed("view_feed_all_departments", companySettings), view_feed_activity: allowed("view_feed_activity", true), view_feed_posts: allowed("view_feed_posts", true) };
}

function unionRolePermissions(roles: AccessRole[]) {
  const result: PermissionMap = {};
  for (const role of roles) {
    for (const [permission, allowed] of Object.entries(role.permissions)) {
      if (allowed === true) result[permission] = true;
      else if (!Object.prototype.hasOwnProperty.call(result, permission)) result[permission] = false;
    }
  }
  return result;
}

function userPermissionOverrides(user: JsonObject) {
  const access = asObject(user.access ?? user.access_profile);
  const orgPermissions = asObject(user.org_permissions);
  return {
    ...normalizePermissionMap(user.permissions),
    ...normalizePermissionMap(orgPermissions.items),
    ...normalizePermissionMap(access.permission_overrides),
    ...normalizePermissionMap(user.permission_overrides)
  };
}

function hasPermission(permissions: PermissionMap, permission: string) {
  if (permissions[permission] === false) return false;
  return permissions[permission] === true || permissions["*"] === true;
}

/** Whether the organization has the app switched on: no switch, or any of its switches on. */
export function appEnabledForOrganization(app: Pick<AppDefinition, "capabilities">, effectiveByKey: Record<string, unknown>) {
  return app.capabilities.length === 0 || app.capabilities.some((key) => effectiveByKey[key] === true);
}

/** The apps an organization has switched on, in registry order. */
export function organizationAppCatalog(effectiveByKey: Record<string, unknown>, options: { surface?: AppSurface } = {}) {
  return appDefinitions()
    .filter((app) => appEnabledForOrganization(app, effectiveByKey))
    .filter((app) => !options.surface || app.surface === options.surface);
}

export type MembershipAppLayer = { source: "department_default" | "group_default"; defaults: Record<string, MembershipAppSetting> };

/**
 * Resolve every app the organization has on for one person, one device at a
 * time: the app's default, then their roles (any role showing it is enough),
 * then their groups and departments, then their own setting. A restricted app
 * is hidden everywhere. Options resolve through the same layers.
 */
export function resolveAppEntitlements(input: {
  effectiveByKey: Record<string, unknown>;
  roles?: AccessRole[];
  membership?: MembershipAppLayer[];
  overrides?: Record<string, AppSetting>;
  permissions?: PermissionMap;
}): EffectiveAppEntitlement[] {
  const roles = (input.roles || []).filter((role) => role.status === "active");
  const membership = input.membership || [];
  const overrides = input.overrides || {};
  const permissions = input.permissions || {};
  return organizationAppCatalog(input.effectiveByKey).map((app): EffectiveAppEntitlement => {
    const visible: Record<DeviceId, boolean> = {};
    const deviceSources: Record<DeviceId, AppSettingSource> = {};
    const roleSettings = roles.flatMap((role) => {
      const setting = role.app_defaults[app.id];
      return setting ? [{ role, setting }] : [];
    });
    const membershipSettings = membership.flatMap((layer) => {
      const setting = layer.defaults[app.id];
      return setting ? [{ source: layer.source, setting }] : [];
    });
    const override = overrides[app.id];
    const restricted = membershipSettings.some((entry) => entry.setting.restricted);
    let params = mergeJson({}, app.default_params);
    let layout = mergeJson({}, app.layout);
    for (const { setting } of [...roleSettings, ...membershipSettings, ...(override ? [{ setting: override }] : [])]) {
      params = mergeJson(params, setting.params);
      layout = mergeJson(layout, setting.layout);
    }

    for (const device of app.devices) {
      let shown = app.default_visible;
      let source: AppSettingSource = "app_default";
      // Roles add: a role that says nothing about the app contributes its default.
      if (roles.length && roleSettings.some(({ setting }) => setting.visible?.[device] !== undefined)) {
        shown = roles.some((role) => role.app_defaults[app.id]?.visible?.[device] ?? app.default_visible);
        source = "role_default";
      }
      const explicitMembership = membershipSettings.filter(({ setting }) => setting.visible?.[device] !== undefined);
      if (explicitMembership.length) {
        shown = explicitMembership.some(({ setting }) => setting.visible?.[device] === true);
        source = explicitMembership.at(-1)!.source;
      }
      if (override?.visible?.[device] !== undefined) {
        shown = override.visible?.[device] === true;
        source = "user_override";
      }
      if (restricted) {
        shown = false;
        source = "restricted";
      }
      visible[device] = shown;
      deviceSources[device] = source;
    }

    const optionValues: Record<string, boolean> = {};
    const optionSources: Record<string, AppSettingSource> = {};
    for (const option of app.options) {
      let on = option.default;
      let source: AppSettingSource = "app_default";
      if (roles.length && roleSettings.some(({ setting }) => setting.options?.[option.key] !== undefined)) {
        on = roles.some((role) => role.app_defaults[app.id]?.options?.[option.key] ?? option.default);
        source = "role_default";
      }
      const explicitMembership = membershipSettings.filter(({ setting }) => setting.options?.[option.key] !== undefined);
      if (explicitMembership.length) {
        on = explicitMembership.some(({ setting }) => setting.options?.[option.key] === true);
        source = explicitMembership.at(-1)!.source;
      }
      if (override?.options?.[option.key] !== undefined) {
        on = override.options?.[option.key] === true;
        source = "user_override";
      }
      optionValues[option.key] = on;
      optionSources[option.key] = source;
      params[option.param] = on;
    }
    for (const [param, permission] of Object.entries(app.parameter_permissions)) {
      params[param] = hasPermission(permissions, permission);
    }

    const visibleDevices = app.devices.filter((device) => visible[device]);
    const reasons: string[] = [];
    if (restricted) reasons.push("department_app_restricted");
    else if (!visibleDevices.length) reasons.push("app_not_selected");
    return {
      ...app,
      visible,
      visible_devices: visibleDevices,
      allowed: visibleDevices.length > 0,
      restricted,
      option_values: optionValues,
      sources: {
        devices: deviceSources,
        options: optionSources,
        role_ids: roleSettings.map(({ role }) => role.id)
      },
      params,
      layout,
      reasons
    };
  });
}

/**
 * Resolve the complete access facade for an organization user.
 *
 * `access_role_ids` is authoritative once present, including an empty array.
 * A person saved before roles existed is read as the role their old
 * permission level names.
 */
export async function resolveAccessProfile(
  orgIdValue: string,
  userDataValue: unknown,
  options: { effectiveByKey?: Record<string, unknown> } = {}
): Promise<ResolvedAccessProfile> {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const user = unwrappedUserData(userDataValue);
  const allRoles = (await listAccessRoles(orgId, { include_archived: true }));
  const organizationStructure = await resolveOrganizationStructure(orgId);
  const scopedGrants = resolveScopedAccessGrants(user.scoped_access_assignments, allRoles, organizationStructure);
  const scopedRoles = allRoles.filter(role => scopedGrants.some(grant => grant.role_id === role.id));
  const activeRoles = allRoles.filter((role) => role.status === "active");
  const rolesById = new Map(activeRoles.map((role) => [role.id, role]));
  const assignment = assignedRoleIds(user);
  const requestedRoleIds = assignment.explicit ? [...assignment.ids] : [legacyRoleId(user)];
  const uniqueRequestedRoleIds = [...new Set(requestedRoleIds)];
  const roles = uniqueRequestedRoleIds.map((id) => rolesById.get(id)).filter((role): role is AccessRole => Boolean(role));
  const unresolvedRoleIds = uniqueRequestedRoleIds.filter((id) => !rolesById.has(id));
  const globalPermissionOverrides = userPermissionOverrides(user);

  const effectivePermissions: PermissionMap = { ...unionRolePermissions(roles) };
  for (const [permission, allowed] of Object.entries(globalPermissionOverrides)) effectivePermissions[permission] = allowed;

  Object.assign(effectivePermissions, notificationAccessPermissions(effectivePermissions, user, roles), feedAccessPermissions(effectivePermissions));
  const member = organizationStructure.users.find(entry => entry.id === cleanText(user.id || user.user_id));
  const membership: MembershipAppLayer[] = organizationStructure.catalog.departments
    .filter(department => member?.department_ids.includes(department.id))
    .map(department => ({ source: 'department_default', defaults: normalizeMembershipAppDefaults(department.app_defaults) }));
  if (member) {
    const groups = await getWorkforceDatabase().prepare(`SELECT g.attributes_json FROM resource_groups g JOIN resource_group_memberships m ON m.organization_id = g.organization_id AND m.group_id = g.id WHERE g.organization_id = ? AND g.status = 'active' AND m.user_id = ? AND m.status = 'active' ORDER BY g.id`).all(orgId, member.id);
    for (const row of groups) {
      try { membership.push({ source: 'group_default', defaults: normalizeMembershipAppDefaults(asObject(JSON.parse(String(asObject(row).attributes_json || '{}'))).app_defaults) }); } catch { /* Invalid historical metadata conveys no defaults. */ }
    }
  }
  const effectiveByKey = options.effectiveByKey || (await effectiveCapabilities(orgId, cleanText(user.id || user.user_id) || undefined)).effectiveByKey;
  const entitlements = resolveAppEntitlements({
    effectiveByKey,
    roles: [...roles, ...scopedRoles.filter((role) => !roles.includes(role))],
    membership,
    overrides: normalizeAppDefaults(user.app_access_overrides),
    permissions: effectivePermissions
  });
  const byId = Object.fromEntries(entitlements.map((entitlement) => [entitlement.id, entitlement]));
  return {
    schema_version: ACCESS_SCHEMA_VERSION,
    organization_id: orgId,
    user_id: cleanText(user.id || user.user_id),
    access_role_ids: roles.map((role) => role.id),
    unresolved_access_role_ids: unresolvedRoleIds,
    roles,
    permissions: effectivePermissions,
    effective_permissions: effectivePermissions,
    app_entitlements: entitlements,
    app_entitlements_by_id: byId,
    allowed_app_ids: entitlements.filter((entitlement) => entitlement.allowed).map((entitlement) => entitlement.id),
    user_revision: Number(user.revision || 0),
    scoped_access_grants: scopedGrants,
    // Restrictions also name apps outside the registry, such as a capability's runtime id.
    app_restrictions: [...new Set(membership.flatMap((layer) => Object.entries(layer.defaults).filter(([, setting]) => setting.restricted).map(([id]) => id)))],
    organization_structure: organizationStructure
  };
}
