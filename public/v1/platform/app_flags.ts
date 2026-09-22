import { readFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import "./capability_defs.js";
import {
  capabilityValuesForUser,
  capabilityDefinition,
  flattenGroupedValues,
  groupCapabilityValues,
  newOrganizationCapabilityValues,
  normalizeCapabilityValue,
  resolveCapabilities,
  valueCapabilities,
  type CapabilityValue,
  type NormalizedCapability
} from "./capabilities.js";
import { readGlobal, readPlatformConfiguration, type JsonObject } from "./storage.js";

/**
 * Legacy app-flags compatibility layer.
 *
 * The capability registry (`capabilities.ts` + `capability_defs.ts`) is the
 * single source of truth. This module derives the historical
 * `group.flag`-shaped registry, defaults, resolution, and API payloads from
 * it so every existing `isAppFlagEnabled(orgId, group, flag)` call site,
 * the stored `data.app_flags` document shape, the internal operator console,
 * and the legacy client module keep working unchanged.
 */

export type AppFlagGroup = string;
export type AppFlagValue = boolean | number | string;
export type AppPlacement = "sidebar" | "more" | "settings" | "hidden";

const APP_PLACEMENTS = new Set<AppPlacement>(["sidebar", "more", "settings", "hidden"]);

export type AppFlagDefinition = {
  group: AppFlagGroup;
  flag: string;
  key: string;
  type: "boolean" | "number" | "select" | "multi_select";
  label: string;
  description: string;
  default: AppFlagValue;
  requires: string[];
  options?: Array<string | [string, string]>;
  min?: number;
  step?: number;
};

export type AppVariantDefinition = {
  family: string;
  key: string;
  label: string;
  description: string;
  requires: string[];
};

const APP_VARIANT_REGISTRY: Record<string, AppVariantDefinition[]> = {
  "firstmeasure.referral_offer": [
    {
      family: "firstmeasure.referral_offer",
      key: "gift_card_50",
      label: "$50 Gift Card",
      description: "Referrer receives a $50 gift card for each qualified signup.",
      requires: ["firstmeasure.referral_program_banner"]
    },
    {
      family: "firstmeasure.referral_offer",
      key: "credits_50",
      label: "$50 Free Credits",
      description: "Referrer receives $50 in FirstMate credits for each qualified signup.",
      requires: ["firstmeasure.referral_program_banner"]
    }
  ]
};

const TEST_APP_FLAG_ADMIN_EMAILS = new Set(["notifications@1m8.ai"]);

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function legacyDefinition(node: NormalizedCapability): Omit<AppFlagDefinition, "key"> {
  return {
    group: node.group,
    flag: node.flag,
    type: node.type || "boolean",
    label: node.label,
    description: node.description,
    default: node.default as AppFlagValue,
    requires: [...(node.parent ? [node.parent] : []), ...node.requires],
    ...(node.options.length ? { options: node.options.map((option) => [...option] as [string, string]) } : {}),
    ...(node.min !== undefined ? { min: node.min } : {}),
    ...(node.step !== undefined ? { step: node.step } : {})
  };
}

function flagRegistry() {
  const entries: Record<string, Omit<AppFlagDefinition, "key">> = {};
  for (const node of valueCapabilities()) entries[node.key] = legacyDefinition(node);
  return entries;
}

function flagGroups(): AppFlagGroup[] {
  return Array.from(new Set(valueCapabilities().map((node) => node.group)));
}

function defaultsByGroup() {
  const defaults: Record<AppFlagGroup, Record<string, AppFlagValue>> = {};
  for (const node of valueCapabilities()) {
    const groupDefaults = defaults[node.group] ?? (defaults[node.group] = {});
    groupDefaults[node.flag] = node.default as AppFlagValue;
  }
  return defaults;
}

function normalizeGroup(value: string): AppFlagGroup | "" {
  const group = cleanText(value).toLowerCase();
  return flagGroups().includes(group) ? group : "";
}

function normalizeVariantKey(family: string, value: unknown) {
  const key = cleanText(value).toLowerCase();
  if (!family || !key) return "";
  return (APP_VARIANT_REGISTRY[family] || []).some((variant) => variant.key === key) ? key : "";
}

export function appFlagDefinitions() {
  return Object.entries(flagRegistry()).map(([key, definition]) => ({
    key,
    ...definition,
    defaultValue: definition.default,
    requires: [...definition.requires],
    options: definition.options ? [...definition.options] : undefined
  })) as AppFlagDefinition[];
}

export function appVariantDefinitions() {
  return Object.values(APP_VARIANT_REGISTRY).flatMap((variants) => variants.map((variant) => ({
    ...variant,
    requires: [...variant.requires]
  }))) as AppVariantDefinition[];
}

export function appFlagDefaults() {
  return JSON.parse(JSON.stringify(defaultsByGroup())) as Record<AppFlagGroup, Record<string, AppFlagValue>> & { firstmeasure: Record<string, AppFlagValue> };
}

function platformStorageRoot() {
  return path.resolve(process.cwd(), env.platformStorageRoot);
}

function appFlagDefaultsConfigPath() {
  return path.join(platformStorageRoot(), "config", "app_flag_defaults.json");
}

export function normalizeFullAppFlags(input: JsonObject = {}) {
  const source = asObject(input.app_flags || input.flags || input);
  const flat = { ...Object.fromEntries(valueCapabilities().map((node) => [node.key, node.default as CapabilityValue])), ...flattenGroupedValues(source) };
  return groupCapabilityValues(flat) as Record<AppFlagGroup, Record<string, AppFlagValue>>;
}

export async function newOrganizationAppFlagDefaults() {
  const raw = await readPlatformConfiguration("app_flag_defaults");
  if (raw) {
    const data = asObject(raw.data);
    const defaults = normalizeFullAppFlags(asObject(data.app_flags || data.feature_flags || raw.app_flags || raw.feature_flags));
    defaults.platform = { ...defaults.platform, expanded_access: false, more_apps: false };
    return defaults;
  }
  return groupCapabilityValues(await newOrganizationCapabilityValues()) as Record<AppFlagGroup, Record<string, AppFlagValue>>;
}

export async function rawAppFlags(orgId: string) {
  const globalDoc = await readGlobal(orgId);
  const data = asObject(globalDoc.data);
  const flat = {
    ...Object.fromEntries(valueCapabilities().map((node) => [node.key, node.default as CapabilityValue])),
    ...flattenGroupedValues(asObject(data.app_flags || data.feature_flags))
  };
  return groupCapabilityValues(flat) as Record<AppFlagGroup, Record<string, AppFlagValue>>;
}

export async function rawAppVariants(orgId: string) {
  const globalDoc = await readGlobal(orgId);
  const data = asObject(globalDoc.data);
  const source = asObject(data.app_variants || data.feature_variants);
  const normalized: Record<string, string | null> = {};
  for (const family of Object.keys(APP_VARIANT_REGISTRY)) {
    const key = normalizeVariantKey(family, source[family]);
    normalized[family] = key || null;
  }
  return normalized;
}

export async function rawAppPlacements(orgId: string) {
  const globalDoc = await readGlobal(orgId);
  const data = asObject(globalDoc.data);
  return normalizeAppPlacementInput(data.app_placements);
}

/**
 * Normalizes the operator-managed app launcher projection. App ids deliberately
 * remain manifest ids (for example `portal.equipment`) so adding a new app does
 * not require a backend registry change.
 */
export function normalizeAppPlacementInput(input: unknown) {
  const source = asObject(input);
  const normalized: Record<string, AppPlacement> = {};
  for (const [rawId, rawPlacement] of Object.entries(source)) {
    const id = cleanText(rawId).toLowerCase();
    const placement = cleanText(rawPlacement).toLowerCase() as AppPlacement;
    if (!/^[a-z0-9][a-z0-9._-]{1,119}$/.test(id) || !APP_PLACEMENTS.has(placement)) continue;
    normalized[id] = placement;
  }
  return normalized;
}

export function resolveAppFlags(raw: Record<AppFlagGroup, Record<string, AppFlagValue>>) {
  const flat = flattenGroupedValues(raw as JsonObject);
  const resolution = resolveCapabilities(flat);
  const resolvedByKey: Record<string, boolean> = {};
  const disabledReasons: Record<string, string | null> = {};
  const resolved: Record<AppFlagGroup, Record<string, AppFlagValue>> = {};
  for (const group of flagGroups()) resolved[group] = {};
  for (const node of valueCapabilities()) {
    const groupValues = resolved[node.group] ?? (resolved[node.group] = {});
    if (node.type === "boolean") {
      resolvedByKey[node.key] = resolution.effectiveByKey[node.key] === true;
      disabledReasons[node.key] = resolution.reasons[node.key] ?? null;
      groupValues[node.flag] = resolution.effectiveByKey[node.key] === true;
    } else {
      // Legacy behavior: non-boolean flags never appear "resolved" and carry
      // their raw (or default) value through.
      resolvedByKey[node.key] = false;
      disabledReasons[node.key] = null;
      groupValues[node.flag] = resolution.values[node.key] as AppFlagValue;
    }
  }
  return { resolved, resolvedByKey, disabledReasons };
}

export function resolveAppVariants(
  rawVariants: Record<string, string | null>,
  resolvedFlagsByKey: Record<string, boolean>
) {
  const resolved: Record<string, string | null> = {};
  const disabledReasons: Record<string, string | null> = {};
  for (const family of Object.keys(APP_VARIANT_REGISTRY)) {
    const key = normalizeVariantKey(family, rawVariants[family]);
    const variant = (APP_VARIANT_REGISTRY[family] || []).find((entry) => entry.key === key);
    if (!variant) {
      resolved[family] = null;
      disabledReasons[family] = key ? "unknown_variant" : "no_variant";
      continue;
    }
    const missing = variant.requires.find((requirement) => resolvedFlagsByKey[requirement] !== true);
    if (missing) {
      resolved[family] = null;
      disabledReasons[family] = `requires ${missing}`;
      continue;
    }
    resolved[family] = key;
    disabledReasons[family] = null;
  }
  return { resolved, disabledReasons };
}

export async function effectiveAppFlags(orgId: string, userId?: string) {
  const raw = flattenGroupedValues(await rawAppFlags(orgId));
  return resolveAppFlags(groupCapabilityValues(await capabilityValuesForUser(orgId, userId, raw))).resolved;
}

export async function appFlagState(orgId: string, userId?: string) {
  const [raw, rawVariants, appPlacements] = await Promise.all([
    rawAppFlags(orgId),
    rawAppVariants(orgId),
    rawAppPlacements(orgId)
  ]);
  const resolvedState = resolveAppFlags(groupCapabilityValues(await capabilityValuesForUser(orgId, userId, flattenGroupedValues(raw))));
  const variantState = resolveAppVariants(rawVariants, resolvedState.resolvedByKey);
  return {
    definitions: appFlagDefinitions(),
    variant_definitions: appVariantDefinitions(),
    raw,
    raw_variants: rawVariants,
    effective: resolvedState.resolved,
    effective_variants: variantState.resolved,
    app_placements: appPlacements,
    enabled: enabledOnlyAppFlags(resolvedState.resolved),
    disabled_reasons: resolvedState.disabledReasons,
    variant_disabled_reasons: variantState.disabledReasons
  };
}

export function enabledOnlyAppFlags(flags: Record<AppFlagGroup, Record<string, AppFlagValue>>) {
  const enabled: Record<AppFlagGroup, string[]> = {};
  for (const group of flagGroups()) {
    enabled[group] = Object.entries(flags[group] || {})
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .sort();
  }
  return enabled;
}

export async function isAppFlagEnabled(orgId: string, groupValue: string, flagValue: string) {
  const group = normalizeGroup(groupValue);
  const flag = cleanText(flagValue);
  if (!group || !flag) return false;
  const flags = await effectiveAppFlags(orgId);
  return flags[group]?.[flag] === true;
}

export function containsAppFlagMutation(input: JsonObject = {}) {
  const data = asObject(input.data);
  return Object.prototype.hasOwnProperty.call(data, "app_flags")
    || Object.prototype.hasOwnProperty.call(data, "feature_flags")
    || Object.prototype.hasOwnProperty.call(data, "app_variants")
    || Object.prototype.hasOwnProperty.call(data, "feature_variants")
    || Object.prototype.hasOwnProperty.call(data, "app_placements")
    || Object.prototype.hasOwnProperty.call(input, "app_flags")
    || Object.prototype.hasOwnProperty.call(input, "feature_flags")
    || Object.prototype.hasOwnProperty.call(input, "app_variants")
    || Object.prototype.hasOwnProperty.call(input, "feature_variants")
    || Object.prototype.hasOwnProperty.call(input, "app_placements");
}

export function canManageTestAppFlags(input: { identity?: JsonObject; role?: string; orgId?: string }) {
  const email = cleanText(asObject(input.identity).email).toLowerCase();
  const role = cleanText(input.role).toLowerCase();
  // Deployment-owned allowlist: organization/profile writes and signup presets
  // cannot turn an ordinary customer organization into a test organization.
  const testOrganizations = new Set((process.env.PLATFORM_TEST_ORG_IDS || "").split(",").map(value => value.trim()).filter(Boolean));
  return testOrganizations.has(cleanText(input.orgId))
    && TEST_APP_FLAG_ADMIN_EMAILS.has(email) && ["owner", "admin", "super_admin"].includes(role);
}

export function normalizeAppFlagInput(input: JsonObject = {}) {
  const source = asObject(input.app_flags || input.flags || input);
  const normalized: Record<AppFlagGroup, Record<string, AppFlagValue>> = {};
  for (const group of flagGroups()) {
    const groupInput = asObject(source[group]);
    normalized[group] = {};
    for (const [flag, value] of Object.entries(groupInput)) {
      const node = capabilityDefinition(`${group}.${cleanText(flag)}`);
      if (!node?.stores_value) continue;
      normalized[group][node.flag] = normalizeCapabilityValue(node, value);
    }
  }
  return normalized;
}

export function normalizeAppVariantInput(input: JsonObject = {}) {
  const source = asObject(input.app_variants || input.variants || input);
  const normalized: Record<string, string | null> = {};
  for (const family of Object.keys(APP_VARIANT_REGISTRY)) {
    const key = normalizeVariantKey(family, source[family]);
    normalized[family] = key || null;
  }
  return normalized;
}
