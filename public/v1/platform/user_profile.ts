import type { JsonObject } from "./storage.js";

export const MANAGEMENT_APPLICATION_ID = "management";
export const FIELD_APPLICATION_ID = "field";

export type ApplicationAccessEntry = {
  enabled: boolean;
  role_id: string;
  permissions: JsonObject;
};

export type ApplicationAccess = Record<string, ApplicationAccessEntry>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function boolValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = cleanText(value).toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(text)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(text)) return false;
  return fallback;
}

function applicationEntry(value: unknown, fallbackEnabled: boolean): ApplicationAccessEntry {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return { enabled: boolValue(value, fallbackEnabled), role_id: "", permissions: {} };
  }
  const input = asObject(value);
  return {
    enabled: boolValue(input.enabled ?? input.access ?? input.allowed, fallbackEnabled),
    role_id: cleanText(input.role_id || input.roleId || input.role),
    permissions: asObject(input.permissions || input.permission_items || input.items)
  };
}

/**
 * Application access is intentionally independent from organization permissions.
 * Existing user documents predate this field, so absence means management access
 * remains enabled while the future field application remains opt-in.
 */
export function normalizeApplicationAccess(value: unknown, options: { managementDefault?: boolean } = {}): ApplicationAccess {
  const input = asObject(value);
  const managementDefault = options.managementDefault !== false;
  const managementValue = input.management ?? input.main ?? input.portal;
  const fieldValue = input.field ?? input.crew ?? input.workforce;
  const result: ApplicationAccess = {
    [MANAGEMENT_APPLICATION_ID]: applicationEntry(managementValue, managementDefault),
    [FIELD_APPLICATION_ID]: applicationEntry(fieldValue, false)
  };
  for (const [key, entry] of Object.entries(input)) {
    const id = cleanText(key).toLowerCase();
    if (!id || ["management", "main", "portal", "field", "crew", "workforce"].includes(id)) continue;
    result[id] = applicationEntry(entry, false);
  }
  return result;
}

export function normalizeAccessRoleIds(value: unknown) {
  const values = Array.isArray(value) ? value : cleanText(value) ? [value] : [];
  return [...new Set(values.map((item) => cleanText(item).toLowerCase().replace(/[^a-z0-9_-]+/g, "-")).filter(Boolean))];
}

export function normalizePermissionOverrides(value: unknown) {
  const input = asObject(value);
  return Object.fromEntries(Object.entries(input).map(([key, enabled]) => [cleanText(key), enabled === true])
    .filter(([key]) => !!key));
}

export function normalizeAppAccessOverrides(value: unknown) {
  const input = asObject(value);
  const result: JsonObject = {};
  for (const [appIdValue, stateValue] of Object.entries(input)) {
    const appId = cleanText(appIdValue);
    if (!appId) continue;
    if (stateValue === true) result[appId] = "show";
    else if (stateValue === false) result[appId] = "hide";
    else {
      const state = cleanText(stateValue).toLowerCase();
      result[appId] = ["show", "hide"].includes(state) ? state : "inherit";
    }
  }
  return result;
}

export function organizationUserProfileFields(inputValue: unknown, options: { includeDefaults?: boolean } = {}) {
  const input = asObject(inputValue);
  const result: JsonObject = {};
  const hasApplicationAccess = Object.prototype.hasOwnProperty.call(input, "application_access")
    || Object.prototype.hasOwnProperty.call(input, "app_access");
  const hasAccessRoles = Object.prototype.hasOwnProperty.call(input, "access_role_ids")
    || Object.prototype.hasOwnProperty.call(input, "access_roles");
  const hasPermissionOverrides = Object.prototype.hasOwnProperty.call(input, "permission_overrides");
  const hasAppAccessOverrides = Object.prototype.hasOwnProperty.call(input, "app_access_overrides")
    || Object.prototype.hasOwnProperty.call(input, "app_entitlement_overrides");
  const hasWorkerClassification = Object.prototype.hasOwnProperty.call(input, "worker_classification");
  const hasPaymentTerms = Object.prototype.hasOwnProperty.call(input, "payment_terms");
  if (hasApplicationAccess || options.includeDefaults) {
    result.application_access = normalizeApplicationAccess(input.application_access ?? input.app_access);
  }
  if (hasAccessRoles || options.includeDefaults) {
    result.access_role_ids = normalizeAccessRoleIds(input.access_role_ids ?? input.access_roles);
  }
  if (hasPermissionOverrides || options.includeDefaults) {
    result.permission_overrides = normalizePermissionOverrides(input.permission_overrides);
  }
  if (hasAppAccessOverrides || options.includeDefaults) {
    result.app_access_overrides = normalizeAppAccessOverrides(input.app_access_overrides ?? input.app_entitlement_overrides);
  }
  if (hasWorkerClassification || options.includeDefaults) {
    result.worker_classification = cleanText(input.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee";
  }
  if (hasPaymentTerms || options.includeDefaults) {
    const terms = asObject(input.payment_terms);
    result.payment_terms = {
      basis: cleanText(terms.basis) === "net_days" ? "net_days" : "payroll_schedule",
      net_days: Math.max(0, Math.min(365, Math.floor(Number(terms.net_days || 0))))
    };
  }
  return result;
}

export function organizationUserProfileView(inputValue: unknown) {
  const input = asObject(inputValue);
  return {
    application_access: normalizeApplicationAccess(input.application_access ?? input.app_access),
    access_role_ids: normalizeAccessRoleIds(input.access_role_ids ?? input.access_roles),
    permission_overrides: normalizePermissionOverrides(input.permission_overrides),
    app_access_overrides: normalizeAppAccessOverrides(input.app_access_overrides ?? input.app_entitlement_overrides),
    worker_classification: cleanText(input.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee",
    payment_terms: asObject(input.payment_terms)
  };
}

export function applicationAccessForUser(inputValue: unknown) {
  const input = asObject(inputValue);
  return normalizeApplicationAccess(input.application_access ?? input.app_access);
}

export function userHasApplicationAccess(inputValue: unknown, applicationId: string) {
  const access = applicationAccessForUser(inputValue);
  const normalized = cleanText(applicationId).toLowerCase();
  const canonical = ["main", "portal"].includes(normalized)
    ? MANAGEMENT_APPLICATION_ID
    : ["crew", "workforce"].includes(normalized)
      ? FIELD_APPLICATION_ID
      : normalized;
  return access[canonical]?.enabled === true;
}

export function userHasApplicationPermission(inputValue: unknown, applicationId: string, permission?: string) {
  if (!permission) return userHasApplicationAccess(inputValue, applicationId);
  const access = applicationAccessForUser(inputValue);
  const normalized = cleanText(applicationId).toLowerCase();
  const canonical = ["main", "portal"].includes(normalized)
    ? MANAGEMENT_APPLICATION_ID
    : ["crew", "workforce"].includes(normalized)
      ? FIELD_APPLICATION_ID
      : normalized;
  const entry = access[canonical];
  if (!entry?.enabled) return false;
  if (entry.permissions["*"] === true) return true;
  return cleanText(permission).split("|").some((key) => entry.permissions[key.trim()] === true);
}
