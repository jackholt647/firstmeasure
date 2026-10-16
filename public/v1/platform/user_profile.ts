import type { JsonObject } from "./storage.js";
import { compactAppDefaults } from "../workforce/access.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
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

/** A person's own App experience settings: app id -> { visible: { device: shown }, options }. */
export function normalizeAppAccessOverrides(value: unknown) {
  return compactAppDefaults(value) as JsonObject;
}

export function organizationUserProfileFields(inputValue: unknown, options: { includeDefaults?: boolean } = {}) {
  const input = asObject(inputValue);
  const result: JsonObject = {};
  const hasAccessRoles = Object.prototype.hasOwnProperty.call(input, "access_role_ids")
    || Object.prototype.hasOwnProperty.call(input, "access_roles");
  const hasPermissionOverrides = Object.prototype.hasOwnProperty.call(input, "permission_overrides");
  const hasAppAccessOverrides = Object.prototype.hasOwnProperty.call(input, "app_access_overrides")
    || Object.prototype.hasOwnProperty.call(input, "app_entitlement_overrides");
  const hasWorkerClassification = Object.prototype.hasOwnProperty.call(input, "worker_classification");
  const hasPaymentTerms = Object.prototype.hasOwnProperty.call(input, "payment_terms");
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
    access_role_ids: normalizeAccessRoleIds(input.access_role_ids ?? input.access_roles),
    permission_overrides: normalizePermissionOverrides(input.permission_overrides),
    app_access_overrides: normalizeAppAccessOverrides(input.app_access_overrides ?? input.app_entitlement_overrides),
    worker_classification: cleanText(input.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee",
    payment_terms: asObject(input.payment_terms)
  };
}
