import { createHash } from "node:crypto";

import { badRequest, notFound } from "./errors.js";
import { OTHER_PERMISSION_CATEGORY, PERMISSION_CATEGORIES, WILDCARD_PERMISSION, permissionSubcategory } from "./permission_categories.js";
import { readGlobal, mutateGlobal, readPlatformConfiguration, mutatePlatformConfiguration, type JsonObject } from "./storage.js";
import { APP_OFFERS, maskOfferedCapabilities, offeredAppIds, offersWithPrerequisitesMet } from "./app-experience/offers.js";
import { libraryData, libraryEntries, libraryEntry, libraryVersion } from "../config-library/library.js";
import type { LibraryEntry } from "../config-library/contracts.js";
import type { Author } from "../config-library/contracts.js";
// Types only: the kind files import the capability declarations, which import this module.
import type { CapabilityPresetData, PresetBase } from "../config-library/kinds/capability_preset.js";
import type { CapabilitySignupPresetData } from "../config-library/kinds/capability_signup_preset.js";
import type { CapabilityDefaultsData } from "../config-library/kinds/capability_defaults.js";
import { importPlatformConfigurationOnce, saveLibraryEntry, deleteLibraryEntry } from "./capability-library.js";

/**
 * Central capability registry.
 *
 * Every org-level app, feature flag, setting, and user-grantable permission is
 * declared here as one node in a single dependency graph. The legacy app-flags
 * API (`app_flags.ts`) is derived from the value-bearing nodes of this
 * registry, so the stored `data.app_flags` document shape and every existing
 * `isAppFlagEnabled(orgId, group, flag)` call keeps working unchanged.
 *
 * Node kinds:
 * - "app": a top-level product surface that can be switched on/off per org.
 * - "feature": an org-level boolean nested under an app or another feature.
 * - "setting": an org-level value (boolean/number/select) that tunes behavior.
 * - "permission": a user-grantable action. Not stored per org; permission
 *   nodes document which permission keys exist, which app they belong to, and
 *   whether they grant read or write access. They power the permission-set UI
 *   and `can()`.
 *
 * Edges:
 * - `parent`: child relationship. The child is meaningless while the parent is
 *   off; the settings UI nests it and the solver disables it automatically.
 * - `requires`: cross-cutting dependency on a non-ancestor node.
 * Both edge kinds resolve identically ("requires <key>" reasons); they differ
 * only in how the UI presents them.
 */

export type CapabilityKind = "app" | "feature" | "setting" | "permission";
/** multi_select stores a comma-separated string of option values. */
export type CapabilityValueType = "boolean" | "number" | "select" | "multi_select";
export type CapabilityValue = boolean | number | string;

export type CapabilityDefinition = {
  key: string;
  kind: CapabilityKind;
  label: string;
  description: string;
  /** Value nodes only. Defaults to "boolean". Permission nodes carry none. What a value is when nothing sets it is
   * library data (config-library kind `capability_defaults`), never declared here. */
  type?: CapabilityValueType;
  parent?: string;
  requires?: string[];
  options?: Array<string | [string, string]>;
  min?: number;
  step?: number;
  /** Named relevance predicate. Informational. */
  relevance?: string;
  /** Permission nodes: the permission key checked by hasPermission(). */
  permission_key?: string;
  /** Permission nodes: read (view) or write (mutate). */
  access?: "read" | "write";
  /**
   * Permission nodes: the subcategory id (see permission_categories.ts) the
   * permission is listed under when people grant it. Presentation only.
   */
  permission_group?: string;
  /** App nodes: the embeddable-app runtime id this node gates. */
  runtime_app_id?: string;
  /** Optional UI grouping label for top-level setting nodes. */
  category?: string;
  /** App nodes: compact copy for small add-app catalog tiles. */
  catalog_stub?: string;
  /**
   * App nodes: whether the app is offered in the org-facing add-apps catalog
   * (the More Apps menu and Manage My Apps). Defaults to true. Set false for
   * deprecated or unreleased/beta apps that should stay reachable through
   * capability values but never be advertised for self-serve enablement.
   */
  discoverable?: boolean;
  /**
   * App nodes: FontAwesome icon class (e.g. "fa-calendar-days") shown in the
   * add-apps catalog. Disabled apps often have no registered runtime surface
   * to borrow an icon from, so the registry carries one.
   */
  icon?: string;
};

export type NormalizedCapability = Required<Pick<CapabilityDefinition, "key" | "kind" | "label" | "description">> & {
  type: CapabilityValueType | null;
  default: CapabilityValue | null;
  parent: string;
  requires: string[];
  options: Array<[string, string]>;
  min?: number;
  step?: number;
  relevance: string;
  permission_key: string;
  access: "read" | "write" | "";
  /** Permission nodes: subcategory id ("" when undeclared). */
  permission_group: string;
  /** Derived: the subcategory's top-level category id ("" when undeclared). */
  permission_category: string;
  runtime_app_id: string;
  category: string;
  /** Compact copy for small add-app catalog tiles. */
  catalog_stub: string;
  /** Whether the org-facing add-apps catalog may offer this app. */
  discoverable: boolean;
  /** FontAwesome icon class for the add-apps catalog ("" when undeclared). */
  icon: string;
  /** Derived: legacy storage group (first key segment) for value nodes. */
  group: string;
  /** Derived: legacy storage flag (rest of key) for value nodes. */
  flag: string;
  /** Derived: child keys in registration order. */
  children: string[];
  /** Derived: registration order for stable UI sorting. */
  order: number;
  /** Derived: parents-first chain (nearest parent last). */
  ancestors: string[];
  /** True for nodes that carry an org-stored value. */
  stores_value: boolean;
};

export type CapabilityResolution = {
  /** For value nodes: dependency-resolved on/off (booleans) or availability. */
  effectiveByKey: Record<string, boolean>;
  /** Effective value per value node (booleans resolved, others raw/default). */
  values: Record<string, CapabilityValue>;
  /** Why a node is off/unavailable; null when active. */
  reasons: Record<string, string | null>;
};

export type ValueSetViolation = {
  key: string;
  message: string;
  missing?: string;
  code: "unknown_key" | "not_settable" | "dependency_unsatisfied" | "invalid_value";
};

export type CapabilityPreset = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /** Where values the preset does not name start (presetBaseValues). */
  base: PresetBase;
  values: Record<string, CapabilityValue>;
  /** The library entry's revision and last save. */
  revision?: number;
  updated_at?: string;
};

const firstMeasureCapabilities = new Set([
  "mobile.app_download", "mobile.developer_downloads",
  "platform.expanded_access", "apps.projects", "apps.project_map", "apps.firstmeasure", "apps.billing", "apps.referrals",
  "platform.left_column_settings",
  "platform.sidebar_footer_layout", "platform.cobrand_sidebar_logo",
  "platform.new_button_mode", "platform.new_button_items",
  "platform.storage_limits", "platform.free_storage_gb", "platform.purchasable_storage",
  "permission.view_projects", "permission.manage_projects", "permission.view_reports",
  "permission.order_reports", "permission.manage_report_settings", "permission.manage_billing",
  "permission.manage_company_settings", "permission.manage_company_users", "permission.manage_company_user_permissions"
]);

const registry = new Map<string, NormalizedCapability>();
let registryValidated = false;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

const KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export function registerCapabilities(definitions: CapabilityDefinition[]) {
  for (const supplied of definitions) {
    // Apply the rollout ceiling to module-registered capabilities as well as the core catalog.
    const definition = firstMeasureCapabilities.has(supplied.key) || supplied.key.startsWith("firstmeasure.")
      ? supplied : { ...supplied, requires: [...new Set([...(supplied.requires || []), "platform.expanded_access"])] };
    const key = cleanText(definition.key);
    if (!key || !KEY_PATTERN.test(key)) {
      throw new Error(`Capability key "${definition.key}" is invalid. Keys are lowercase dot-separated segments.`);
    }
    if (registry.has(key)) {
      throw new Error(`Capability "${key}" is registered twice.`);
    }
    const kind = definition.kind;
    if (!["app", "feature", "setting", "permission"].includes(kind)) {
      throw new Error(`Capability "${key}" has unknown kind "${String(kind)}".`);
    }
    const storesValue = kind !== "permission";
    const type: CapabilityValueType | null = storesValue ? (definition.type || "boolean") : null;
    if (storesValue) {
      const segments = key.split(".");
      if (segments.length !== 2) {
        throw new Error(`Capability "${key}" stores a value and must use a two-segment "group.flag" key for app-flag storage compatibility.`);
      }
      if ((type === "select" || type === "multi_select") && !(definition.options || []).length) {
        throw new Error(`Capability "${key}" is a ${type} but declares no options.`);
      }
    } else {
      if (!cleanText(definition.permission_key)) {
        throw new Error(`Permission capability "${key}" must declare permission_key.`);
      }
      if (!["read", "write"].includes(String(definition.access))) {
        throw new Error(`Permission capability "${key}" must declare access: "read" | "write".`);
      }
    }
    const segments = key.split(".");
    registry.set(key, {
      key,
      kind,
      label: cleanText(definition.label) || key,
      description: cleanText(definition.description),
      type,
      // Laid over from the library whenever the registry is read (applyLibraryDefaults).
      default: null,
      parent: cleanText(definition.parent),
      requires: (definition.requires || []).map(cleanText).filter(Boolean),
      options: (definition.options || []).map((option) => Array.isArray(option) ? [cleanText(option[0]), cleanText(option[1])] as [string, string] : [cleanText(option), cleanText(option)] as [string, string]),
      ...(definition.min !== undefined ? { min: definition.min } : {}),
      ...(definition.step !== undefined ? { step: definition.step } : {}),
      relevance: cleanText(definition.relevance),
      permission_key: cleanText(definition.permission_key),
      access: definition.access || "",
      permission_group: kind === "permission" ? cleanText(definition.permission_group) : "",
      permission_category: "",
      runtime_app_id: cleanText(definition.runtime_app_id),
      category: cleanText(definition.category),
      catalog_stub: cleanText(definition.catalog_stub),
      discoverable: definition.discoverable !== false,
      icon: cleanText(definition.icon),
      group: storesValue ? (segments[0] ?? "") : "",
      flag: storesValue ? segments.slice(1).join(".") : "",
      children: [],
      order: registry.size,
      ancestors: [],
      stores_value: storesValue
    });
    registryValidated = false;
    defaultsVersion = -1;
  }
}

/** A value capability the library names no default for: off, its minimum (or 0), or its first option. */
function unsetDefault(node: NormalizedCapability): CapabilityValue {
  if (node.type === "number") return node.min ?? 0;
  if (node.type === "select") return node.options[0]?.[0] ?? "";
  if (node.type === "multi_select") return "";
  return false;
}

let defaultsVersion = -1;
/**
 * Every value capability's default is library data (config-library kind `capability_defaults`, entry `platform`),
 * laid over the code declarations. Re-applied whenever the library changes, so an edit on dev reaches every process
 * on its next read. A value that no longer fits its declaration is treated as unset.
 */
function applyLibraryDefaults() {
  const version = libraryVersion();
  if (version === defaultsVersion) return;
  defaultsVersion = version;
  const values = libraryData<CapabilityDefaultsData>("capability_defaults", "platform")?.values || {};
  for (const node of registry.values()) {
    if (!node.stores_value) continue;
    node.default = unsetDefault(node);
    const value = values[node.key];
    if (value === undefined || typeof value !== (node.type === "boolean" ? "boolean" : node.type === "number" ? "number" : "string")) continue;
    node.default = normalizeCapabilityValue(node, value);
  }
}

/**
 * Validates the whole graph. Throws on structural problems so a bad registry
 * fails at server boot (and in tests) instead of resolving inconsistently.
 */
export function validateCapabilityRegistry() {
  if (registryValidated) { applyLibraryDefaults(); return; }
  for (const node of registry.values()) {
    node.children = [];
    node.ancestors = [];
  }
  for (const node of registry.values()) {
    if (node.permission_group) {
      const placement = permissionSubcategory(node.permission_group);
      if (!placement) throw new Error(`Permission capability "${node.key}" names unknown permission group "${node.permission_group}".`);
      node.permission_category = placement.category.id;
    }
    if (node.parent) {
      const parent = registry.get(node.parent);
      if (!parent) throw new Error(`Capability "${node.key}" declares unknown parent "${node.parent}".`);
      if (!parent.stores_value) throw new Error(`Capability "${node.key}" cannot have permission node "${node.parent}" as parent.`);
      parent.children.push(node.key);
    }
    for (const requirement of node.requires) {
      const target = registry.get(requirement);
      if (!target) throw new Error(`Capability "${node.key}" requires unknown capability "${requirement}".`);
      if (!target.stores_value) throw new Error(`Capability "${node.key}" cannot require permission node "${requirement}".`);
    }
  }
  // Cycle detection across parent + requires edges.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string, trail: string[]) => {
    if (done.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`Capability dependency cycle: ${[...trail, key].join(" -> ")}`);
    }
    visiting.add(key);
    const node = registry.get(key)!;
    for (const edge of [...(node.parent ? [node.parent] : []), ...node.requires]) {
      visit(edge, [...trail, key]);
    }
    visiting.delete(key);
    done.add(key);
  };
  for (const key of registry.keys()) visit(key, []);
  // Ancestor chains (parents only).
  for (const node of registry.values()) {
    const chain: string[] = [];
    let cursor = node.parent;
    while (cursor) {
      chain.unshift(cursor);
      cursor = registry.get(cursor)!.parent;
    }
    node.ancestors = chain;
  }
  registryValidated = true;
  applyLibraryDefaults();
}

export function capabilityRegistry(): ReadonlyMap<string, NormalizedCapability> {
  validateCapabilityRegistry();
  return registry;
}

export function capabilityDefinition(key: string) {
  validateCapabilityRegistry();
  return registry.get(cleanText(key)) || null;
}

export function capabilityDefinitions() {
  validateCapabilityRegistry();
  return Array.from(registry.values()).map((node) => ({
    ...node,
    requires: [...node.requires],
    options: node.options.map((option) => [...option] as [string, string]),
    children: [...node.children],
    ancestors: [...node.ancestors]
  }));
}

export function valueCapabilities() {
  validateCapabilityRegistry();
  return Array.from(registry.values()).filter((node) => node.stores_value);
}

export function permissionCapabilities() {
  validateCapabilityRegistry();
  return Array.from(registry.values()).filter((node) => node.kind === "permission");
}

export type PermissionCatalogEntry = {
  key: string;
  label: string;
  description: string;
  access: "read" | "write" | "";
  /** False when the permission's app or feature is off for the organization; omitted when not resolved. */
  available?: boolean;
};

export type PermissionCatalog = {
  categories: Array<{
    id: string;
    label: string;
    description: string;
    icon: string;
    subcategories: Array<{ id: string; label: string; description: string; capability: string; collapsed: boolean; permissions: PermissionCatalogEntry[] }>;
  }>;
  /** Where a key the catalog does not describe is listed. */
  other: { id: string; label: string; description: string; icon: string };
};

/**
 * The permission catalog people grant from: category, then subcategory, then
 * permission. Built from the permission nodes; a node without a group is
 * listed under `other` by the reader. Reads come before writes within a
 * subcategory, otherwise registration order. Pass an organization's resolved
 * capabilities to mark permissions whose app or feature is off.
 */
export function permissionCatalog(effectiveByKey?: Record<string, boolean>): PermissionCatalog {
  const byGroup = new Map<string, NormalizedCapability[]>();
  for (const node of permissionCapabilities()) {
    if (!node.permission_group) continue;
    if (!byGroup.has(node.permission_group)) byGroup.set(node.permission_group, []);
    byGroup.get(node.permission_group)!.push(node);
  }
  const rank = (node: NormalizedCapability) => (node.access === "read" ? 0 : 1);
  const entry = (node: NormalizedCapability): PermissionCatalogEntry => ({
    key: node.permission_key,
    label: node.label,
    description: node.description,
    access: node.access,
    ...(effectiveByKey ? { available: effectiveByKey[node.key] === true } : {})
  });
  return {
    categories: PERMISSION_CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      icon: category.icon,
      subcategories: category.subcategories.map((subcategory) => ({
        id: subcategory.id,
        label: subcategory.label,
        description: subcategory.description,
        capability: subcategory.capability || "",
        collapsed: subcategory.collapsed === true,
        permissions: [
          ...(subcategory.id === WILDCARD_PERMISSION.group
            ? [{ key: WILDCARD_PERMISSION.key, label: WILDCARD_PERMISSION.label, description: WILDCARD_PERMISSION.description, access: "write" as const, ...(effectiveByKey ? { available: true } : {}) }]
            : []),
          ...(byGroup.get(subcategory.id) || []).slice().sort((left, right) => rank(left) - rank(right) || left.order - right.order).map(entry)
        ]
      })).filter((subcategory) => subcategory.permissions.length)
    })).filter((category) => category.subcategories.length),
    other: { ...OTHER_PERMISSION_CATEGORY }
  };
}

/** Registry defaults as a flat key -> value map. */
export function capabilityDefaultValues() {
  const defaults: Record<string, CapabilityValue> = {};
  for (const node of valueCapabilities()) {
    defaults[node.key] = node.default as CapabilityValue;
  }
  return defaults;
}

/** The Equipment app currently exposes one fixed, practical feature set. */
export const EQUIPMENT_SIMPLE_CAPABILITIES: Record<string, boolean> = {
  "equipment.scheduling": true,
  "equipment.requirements": false,
  "equipment.maintenance": true,
  "equipment.meters": false,
  "equipment.operators": true,
  "equipment.costing": false,
  "equipment.custody": false
};

function withEquipmentSimpleCapabilities<T extends Record<string, CapabilityValue>>(values: T): T {
  return { ...values, ...EQUIPMENT_SIMPLE_CAPABILITIES };
}

export function normalizeCapabilityValue(node: NormalizedCapability, value: unknown): CapabilityValue {
  if (["platform.expanded_access", "platform.more_apps"].includes(node.key)) return value === true;
  if (node.type === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : (node.default as number);
  }
  if (node.type === "select") {
    const selected = cleanText(value).toLowerCase();
    return node.options.some(([optionValue]) => optionValue === selected) ? selected : (node.default as string);
  }
  if (node.type === "multi_select") {
    const allowed = new Set(node.options.map(([optionValue]) => optionValue));
    const parts = (Array.isArray(value) ? value : cleanText(value).split(","))
      .map((part) => cleanText(part).toLowerCase())
      .filter((part) => part && allowed.has(part));
    return [...new Set(parts)].join(",");
  }
  return value !== false;
}

/**
 * Resolves a raw flat value map into effective values with reasons.
 * A boolean node is effective only when its raw value is not false AND its
 * parent chain and every `requires` target resolve effective. Number/select
 * nodes carry their raw value; their on/off state reflects dependency health
 * so the UI can gray them out. Permission nodes resolve to org-level
 * availability (their parent app/feature chain).
 */
export function resolveCapabilities(rawValues: Record<string, CapabilityValue>): CapabilityResolution {
  validateCapabilityRegistry();
  rawValues = withEquipmentSimpleCapabilities(rawValues);
  const effectiveByKey: Record<string, boolean> = {};
  const reasons: Record<string, string | null> = {};
  const values: Record<string, CapabilityValue> = {};

  const resolve = (key: string, stack: string[]): boolean => {
    if (Object.prototype.hasOwnProperty.call(effectiveByKey, key)) return effectiveByKey[key] === true;
    const node = registry.get(key);
    if (!node) {
      effectiveByKey[key] = false;
      reasons[key] = "unknown_flag";
      return false;
    }
    if (stack.includes(key)) {
      effectiveByKey[key] = false;
      reasons[key] = "dependency_cycle";
      return false;
    }
    const dependencies = [...(node.parent ? [node.parent] : []), ...node.requires];
    for (const dependency of dependencies) {
      if (!resolve(dependency, [...stack, key])) {
        effectiveByKey[key] = false;
        reasons[key] = `requires ${dependency}`;
        return false;
      }
    }
    if (node.stores_value && node.type === "boolean") {
      const raw = Object.prototype.hasOwnProperty.call(rawValues, key) ? rawValues[key] : node.default;
      if (raw === false) {
        effectiveByKey[key] = false;
        reasons[key] = "flag_disabled";
        return false;
      }
    }
    effectiveByKey[key] = true;
    reasons[key] = null;
    return true;
  };

  for (const key of registry.keys()) resolve(key, []);

  for (const node of valueCapabilities()) {
    if (node.type === "boolean") {
      values[node.key] = effectiveByKey[node.key] === true;
    } else {
      const raw = Object.prototype.hasOwnProperty.call(rawValues, node.key) ? rawValues[node.key] : (node.default as CapabilityValue);
      values[node.key] = normalizeCapabilityValue(node, raw);
    }
  }
  if (effectiveByKey["platform.expanded_access"] !== true) {
    values["platform.new_button_mode"] = "report";
    values["platform.new_button_items"] = "report";
  }
  return { effectiveByKey, values, reasons };
}

/**
 * Validates a candidate value set. Returns normalized values plus violations.
 * Dependency violations are reported (so preset editors can surface them) but
 * the set is still storable: the solver keeps unsatisfied nodes off at
 * resolution time.
 */
export function validateValueSet(input: Record<string, unknown>) {
  validateCapabilityRegistry();
  const normalized: Record<string, CapabilityValue> = {};
  const violations: ValueSetViolation[] = [];
  for (const [rawKey, rawValue] of Object.entries(asObject(input))) {
    const key = cleanText(rawKey);
    const node = registry.get(key);
    if (!node) {
      violations.push({ key, code: "unknown_key", message: `Unknown capability "${key}".` });
      continue;
    }
    if (!node.stores_value) {
      violations.push({ key, code: "not_settable", message: `"${key}" is a permission and cannot be stored as an org value.` });
      continue;
    }
    normalized[key] = normalizeCapabilityValue(node, rawValue);
  }
  const resolution = resolveCapabilities({ ...capabilityDefaultValues(), ...normalized });
  for (const [key, value] of Object.entries(normalized)) {
    const node = registry.get(key)!;
    if (node.type === "boolean" && value === true && resolution.effectiveByKey[key] !== true) {
      const reason = resolution.reasons[key] || "";
      const missing = reason.startsWith("requires ") ? reason.slice("requires ".length) : "";
      violations.push({
        key,
        code: "dependency_unsatisfied",
        ...(missing ? { missing } : {}),
        message: missing
          ? `"${key}" is on but its dependency "${missing}" is off; it will stay disabled until "${missing}" is enabled.`
          : `"${key}" is on but cannot activate (${reason || "unresolved dependency"}).`
      });
    }
  }
  return { values: normalized, violations, resolution };
}

// ---------------------------------------------------------------------------
// Org value storage (legacy-compatible: global.json data.app_flags, grouped)
// ---------------------------------------------------------------------------

export function groupCapabilityValues(flat: Record<string, CapabilityValue>) {
  const grouped: Record<string, Record<string, CapabilityValue>> = {};
  for (const [key, value] of Object.entries(flat)) {
    const node = registry.get(key);
    if (!node?.stores_value) continue;
    const groupValues = grouped[node.group] ?? (grouped[node.group] = {});
    groupValues[node.flag] = value;
  }
  return grouped;
}

export function flattenGroupedValues(grouped: JsonObject) {
  validateCapabilityRegistry();
  const flat: Record<string, CapabilityValue> = {};
  for (const [group, flags] of Object.entries(asObject(grouped))) {
    for (const [flag, value] of Object.entries(asObject(flags))) {
      const key = `${cleanText(group)}.${cleanText(flag)}`;
      const node = registry.get(key);
      if (!node?.stores_value) continue;
      flat[key] = normalizeCapabilityValue(node, value);
    }
  }
  return flat;
}

/** Raw stored org overrides (normalized, defaults filled in), flat keyed. */
export async function rawCapabilityValues(orgId: string) {
  const globalDoc = await readGlobal(orgId);
  return capabilityValuesFromGlobal(globalDoc);
}

function capabilityValuesFromGlobal(globalDoc: JsonObject) {
  const data = asObject(globalDoc.data);
  const stored = flattenGroupedValues(asObject(data.app_flags || data.feature_flags));
  return withEquipmentSimpleCapabilities({ ...capabilityDefaultValues(), ...stored });
}

/** Persists a full flat value map (merged over current stored overrides). */
export async function saveCapabilityValues(orgId: string, partial: Record<string, unknown>) {
  const { values, violations } = validateValueSet(partial);
  const fatal = violations.filter((violation) => violation.code === "unknown_key" || violation.code === "not_settable");
  if (fatal.length) {
    throw badRequest("invalid_capability_values", fatal.map((violation) => violation.message).join(" "));
  }
  const saved = await mutateGlobal(orgId, global => {
    const data = asObject(global.data);
    const current = { ...capabilityDefaultValues(), ...flattenGroupedValues(asObject(data.app_flags || data.feature_flags)) };
    return { data: { app_flags: groupCapabilityValues({ ...current, ...values }) } };
  });
  return { values: flattenGroupedValues(asObject(asObject(saved.data).app_flags)), violations };
}

export function platformRolloutConfigurationKey(orgId: string) {
  return `platform_rollout_${createHash("sha256").update(orgId).digest("hex").slice(0,40)}`;
}

export async function readPlatformRollout(orgId: string) {
  const stored = await readPlatformConfiguration(platformRolloutConfigurationKey(orgId));
  return { mode: stored?.mode === "selected" ? "selected" as const : "all" as const,
    user_ids: Array.isArray(stored?.user_ids) ? stored.user_ids.map(cleanText).filter(Boolean) : [] };
}

/** An organization is the feature ceiling. An operator can restrict its audience. */
// ---------------------------------------------------------------------------
// Country rules (1M8-228)
// ---------------------------------------------------------------------------

/**
 * Operator rules that set capability values for organizations in given countries (their country of record,
 * platform/organization_country.ts). A rule wins over the organization's stored value; later rules win over
 * earlier ones. Stored as the platform configuration "capability_country_rules".
 */
export type CapabilityCountryRule = { countries: string[]; values: Record<string, CapabilityValue>; note?: string };
const COUNTRY_RULES_TTL_MS = 15_000;
let countryRulesCache: { at: number; rules: CapabilityCountryRule[] } | null = null;

export function normalizeCapabilityCountryRules(input: unknown): CapabilityCountryRule[] {
  const rules = Array.isArray(asObject(input).rules) ? asObject(input).rules as unknown[] : Array.isArray(input) ? input : [];
  if (rules.length > 100) throw badRequest("invalid_country_rules", "At most 100 country rules.");
  return rules.map((raw, index) => {
    const rule = asObject(raw);
    const countries = (Array.isArray(rule.countries) ? rule.countries : []).map(value => cleanText(value).toUpperCase());
    if (!countries.length || countries.some(code => !/^[A-Z]{2}$/.test(code))) throw badRequest("invalid_country_rules", `Rule ${index + 1} needs one or more two-letter country codes.`);
    const { values, violations } = validateValueSet(asObject(rule.values));
    if (violations.length) throw badRequest("invalid_country_rules", `Rule ${index + 1}: ${violations.map(violation => violation.message).join(" ")}`);
    if (!Object.keys(values).length) throw badRequest("invalid_country_rules", `Rule ${index + 1} sets no capability values.`);
    const note = cleanText(rule.note).slice(0, 200);
    return { countries: [...new Set(countries)], values, ...(note ? { note } : {}) };
  });
}

export async function readCapabilityCountryRules(fresh = false) {
  if (!fresh && countryRulesCache && Date.now() - countryRulesCache.at < COUNTRY_RULES_TTL_MS) return countryRulesCache.rules;
  const raw = await readPlatformConfiguration("capability_country_rules");
  // A saved rule that no longer validates (say, a removed capability) is skipped, never fatal to flag checks.
  const saved = raw ? asObject(raw.data ?? raw).rules : [];
  const rules = (Array.isArray(saved) ? saved : []).flatMap(rule => { try { return normalizeCapabilityCountryRules([rule]); } catch { return []; } });
  countryRulesCache = { at: Date.now(), rules };
  return rules;
}

export async function saveCapabilityCountryRules(input: unknown, actorEmail: string) {
  const rules = normalizeCapabilityCountryRules(input);
  await mutatePlatformConfiguration("capability_country_rules", () => ({ data: { rules }, updated_by: actorEmail, updated_at: new Date().toISOString() }));
  countryRulesCache = { at: Date.now(), rules };
  return rules;
}

export function applyCapabilityCountryRules(values: Record<string, CapabilityValue>, country: string, rules: CapabilityCountryRule[]) {
  const matching = rules.filter(rule => rule.countries.includes(country));
  return matching.length ? Object.assign({ ...values }, ...matching.map(rule => rule.values)) as Record<string, CapabilityValue> : values;
}

async function withCountryRules(orgId: string, values: Record<string, CapabilityValue>) {
  const rules = await readCapabilityCountryRules();
  if (!rules.length) return values;
  const { organizationCountryCode } = await import("./organization_country.js");
  return applyCapabilityCountryRules(values, await organizationCountryCode(orgId), rules);
}

export async function capabilityValuesForUser(orgId: string, userId?: string, raw?: Record<string, CapabilityValue>, includeOffered = false) {
  const global = includeOffered && raw ? null : await readGlobal(orgId);
  let values = await withCountryRules(orgId, raw || capabilityValuesFromGlobal(global!));
  if (values["platform.expanded_access"] === true) {
    values = await (await import("../platform-billing/service.js")).applyEntitlements(orgId, values);
  }
  if (userId && values["platform.expanded_access"] === true) {
    const rollout = await readPlatformRollout(orgId);
    if (rollout.mode === "selected" && !rollout.user_ids.includes(userId)) values = { ...values, "platform.expanded_access": false };
  }
  if (includeOffered) return values;
  return maskOfferedCapabilities(values, asObject(global?.data).app_offers);
}

/** Resolve visibility and operational features from the same organization snapshot. */
export async function capabilityAccessState(orgId: string, userId?: string) {
  const global = await readGlobal(orgId);
  const values = await capabilityValuesForUser(orgId, userId, capabilityValuesFromGlobal(global), true);
  const pending = offeredAppIds(asObject(global.data).app_offers);
  const ceiling = pending.length ? resolveCapabilities(values).effectiveByKey : {};
  // A pending offer stays masked either way; one whose prerequisite setup is not reached is just not advertised yet.
  const advertised = await offersWithPrerequisitesMet(orgId, pending.filter(id => APP_OFFERS[id].some(key => ceiling[key] === true)));
  return { capabilities: resolveCapabilities(maskOfferedCapabilities(values, pending)), offeredAppIds: advertised };
}

/** Only configured and commercially available offers may be shown. */
export async function availableOfferedApps(orgId: string, userId?: string) {
  return (await capabilityAccessState(orgId, userId)).offeredAppIds;
}

export async function effectiveCapabilities(orgId: string, userId?: string) {
  return resolveCapabilities(await capabilityValuesForUser(orgId, userId));
}

/** Org-level gate: is this capability active for the organization? */
export async function isCapabilityEnabled(orgId: string, key: string) {
  const node = capabilityDefinition(key);
  if (!node) return false;
  const resolution = await effectiveCapabilities(orgId);
  return resolution.effectiveByKey[node.key] === true;
}

// ---------------------------------------------------------------------------
// Presets: config-library kind capability_preset, one entry per preset
// ---------------------------------------------------------------------------

const PRESET_KIND = "capability_preset";

/**
 * Where a preset's unnamed values start, computed from the running registry so a capability added later is covered:
 * `off` (on/off capabilities off), `defaults`, or `all_on` (on/off capabilities on). Other values keep their defaults.
 */
export function presetBaseValues(base: PresetBase) {
  const values: Record<string, CapabilityValue> = {};
  for (const node of valueCapabilities()) {
    values[node.key] = node.type === "boolean" && base !== "defaults" ? base === "all_on" : node.default as CapabilityValue;
  }
  return values;
}

/** Values of declared value capabilities only, normalized (a saved key whose capability was removed is dropped). */
function knownValues(input: Record<string, unknown>) {
  validateCapabilityRegistry();
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
    const node = registry.get(cleanText(key));
    return node?.stores_value ? [[node.key, normalizeCapabilityValue(node, value)]] : [];
  })) as Record<string, CapabilityValue>;
}

function presetFromEntry(entry: LibraryEntry<CapabilityPresetData>): CapabilityPreset {
  const data = entry.data;
  const own = knownValues(data.values || {});
  return {
    id: entry.id,
    name: data.name,
    description: data.description || "",
    builtin: data.builtin === true,
    base: data.base || "off",
    // A built-in preset shows its whole configuration; one an operator made shows what they set.
    values: data.builtin ? { ...presetBaseValues(data.base || "off"), ...own } : own,
    revision: entry.revision,
    updated_at: entry.updated_at
  };
}

/** Presets operators saved in the platform configuration before presets were library entries come across once. */
function importLegacyPresets() {
  return importPlatformConfigurationOnce("capability_presets", (document) => (Array.isArray(document.presets) ? document.presets : []).flatMap((raw) => {
    const preset = asObject(raw);
    const id = cleanText(preset.id), name = cleanText(preset.name);
    if (!id || !name || libraryEntry(PRESET_KIND, id)) return [];
    return [{ kind: PRESET_KIND, id, data: { name, description: cleanText(preset.description), builtin: false, base: "off", values: knownValues(asObject(preset.values)) } }];
  }));
}

export async function listCapabilityPresets(): Promise<CapabilityPreset[]> {
  validateCapabilityRegistry();
  await importLegacyPresets();
  const presets = libraryEntries<CapabilityPresetData>(PRESET_KIND).map(presetFromEntry);
  return [...presets.filter((preset) => preset.builtin), ...presets.filter((preset) => !preset.builtin)];
}

export async function readCapabilityPreset(presetId: string) {
  const id = cleanText(presetId);
  const preset = (await listCapabilityPresets()).find((entry) => entry.id === id);
  if (!preset) throw notFound("preset_not_found", `Capability preset "${id}" was not found.`);
  return preset;
}

function slugifyPresetId(name: string) {
  const slug = cleanText(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 70);
  return slug || `preset_${Date.now().toString(36)}`;
}

function requireEditablePreset(presetId: string, verb: string) {
  const entry = libraryEntry<CapabilityPresetData>(PRESET_KIND, cleanText(presetId));
  if (!entry) throw notFound("preset_not_found", `Capability preset "${cleanText(presetId)}" was not found.`);
  if (entry.data.builtin) throw badRequest("preset_builtin", verb === "edit" ? "Built-in presets are edited in the config library. Save a copy under a new name instead." : "Built-in presets cannot be deleted.");
  return entry;
}

export async function createCapabilityPreset(input: { id?: string; name: string; description?: string; values: Record<string, unknown> }, author: Author) {
  validateCapabilityRegistry();
  const name = cleanText(input.name);
  if (!name) throw badRequest("preset_name_required", "A preset name is required.");
  const { values, violations } = validateValueSet(input.values || {});
  const used = new Set((await listCapabilityPresets()).map((preset) => preset.id));
  const baseId = cleanText(input.id) || slugifyPresetId(name);
  let id = baseId;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${baseId}_${suffix}`;
  const saved = await saveLibraryEntry(PRESET_KIND, id, { name, description: cleanText(input.description), builtin: false, base: "off", values }, author);
  return { preset: presetFromEntry(saved.entry as unknown as LibraryEntry<CapabilityPresetData>), violations };
}

export async function updateCapabilityPreset(presetId: string, input: { name?: string; description?: string; values?: Record<string, unknown> }, author: Author) {
  await importLegacyPresets();
  const entry = requireEditablePreset(presetId, "edit");
  let violations: ValueSetViolation[] = [];
  let values = knownValues(entry.data.values || {});
  if (input.values !== undefined) {
    const validated = validateValueSet(input.values || {});
    values = validated.values;
    violations = validated.violations;
  }
  const data: CapabilityPresetData = {
    name: input.name !== undefined ? (cleanText(input.name) || entry.data.name) : entry.data.name,
    description: input.description !== undefined ? cleanText(input.description) : entry.data.description,
    builtin: false,
    base: entry.data.base || "off",
    values
  };
  // Another save since this process read the preset is a conflict (409): reload before saving.
  const saved = await saveLibraryEntry(PRESET_KIND, entry.id, data, author, { expected_revision: entry.revision });
  return { preset: presetFromEntry(saved.entry as unknown as LibraryEntry<CapabilityPresetData>), violations };
}

export async function deleteCapabilityPreset(presetId: string, author: Author) {
  await importLegacyPresets();
  const entry = requireEditablePreset(presetId, "delete");
  await deleteLibraryEntry(PRESET_KIND, entry.id, author, { expected_revision: entry.revision });
  return { deleted: true };
}

/**
 * Applies a preset to an organization. Presets are complete configurations: values the preset does not name start
 * from its base (on/off capabilities off for most presets), settings at their defaults.
 */
export async function applyCapabilityPreset(orgId: string, presetId: string) {
  const preset = await readCapabilityPreset(presetId);
  const full = { ...presetBaseValues(preset.base), ...preset.values };
  // App presets never opt customers into a rollout or change its audience.
  delete full["platform.expanded_access"];
  delete full["platform.more_apps"];
  const saved = await saveCapabilityValues(orgId, full);
  return { preset, ...saved };
}

// ---------------------------------------------------------------------------
// Signup defaults: config-library kind capability_signup_preset, entry new_organization
// ---------------------------------------------------------------------------

const SIGNUP_KIND = "capability_signup_preset";
const SIGNUP_ID = "new_organization";

function signupPreset(): CapabilitySignupPresetData {
  return libraryData<CapabilitySignupPresetData>(SIGNUP_KIND, SIGNUP_ID) || { preset_id: "", values: {} };
}

/** A signup preset an operator chose in the platform configuration before it was a library entry comes across once. */
async function importLegacySignupPreset() {
  await importLegacyPresets();
  await importPlatformConfigurationOnce("capability_signup_preset", (document) => {
    const presetId = cleanText(document.preset_id);
    return presetId && libraryEntry(PRESET_KIND, presetId) ? [{ kind: SIGNUP_KIND, id: SIGNUP_ID, data: { ...structuredClone(signupPreset()), preset_id: presetId } }] : [];
  });
}

/** Public signup's fixed start (library data: the signup preset entry's `values`), over whatever else it is given. */
export function firstMeasureSignupValues(values: Record<string, CapabilityValue>): Record<string, CapabilityValue> {
  return { ...values, ...knownValues(signupPreset().values || {}) };
}

/**
 * The flat value map applied to newly registered organizations: the configured
 * signup preset when one is set, otherwise registry defaults.
 */
export async function newOrganizationCapabilityValues() {
  await importLegacySignupPreset();
  const presetId = cleanText(signupPreset().preset_id);
  if (presetId) {
    const preset = await readCapabilityPreset(presetId).catch(() => null);
    if (preset) {
      const defaults = capabilityDefaultValues();
      const values = { ...presetBaseValues(preset.base), ...preset.values };
      // Signup remains FirstMeasure even when a historical platform preset is configured.
      for (const key of Object.keys(defaults)) {
        if (firstMeasureCapabilities.has(key) || key.startsWith("firstmeasure.")) values[key] = defaults[key]!;
      }
      return firstMeasureSignupValues(values);
    }
  }
  return firstMeasureSignupValues(capabilityDefaultValues());
}

export async function setSignupCapabilityPreset(presetId: string, author: Author) {
  const id = cleanText(presetId);
  if (id) await readCapabilityPreset(id);
  else await importLegacySignupPreset();
  await saveLibraryEntry(SIGNUP_KIND, SIGNUP_ID, { ...structuredClone(signupPreset()), preset_id: id }, author);
  return { preset_id: id };
}

export async function readSignupCapabilityPresetId() {
  await importLegacySignupPreset();
  return cleanText(signupPreset().preset_id);
}

// ---------------------------------------------------------------------------
// Full API state payload
// ---------------------------------------------------------------------------

export async function capabilityState(orgId: string, userId?: string) {
  validateCapabilityRegistry();
  const raw = await rawCapabilityValues(orgId);
  const resolution = resolveCapabilities(await capabilityValuesForUser(orgId, userId, raw));
  return {
    definitions: capabilityDefinitions(),
    raw,
    effective: resolution.values,
    effective_by_key: resolution.effectiveByKey,
    reasons: resolution.reasons,
    presets: await listCapabilityPresets(),
    signup_preset_id: await readSignupCapabilityPresetId()
  };
}

/** Indexed in PostgreSQL so platform workers do not scan FirstMeasure tenants. */
export async function listExpandedPlatformOrgIds(): Promise<string[]> {
  const { isFirstMeasurePostgresEnabled, queryPostgres } = await import("../src/database/postgres.js");
  if (isFirstMeasurePostgresEnabled()) {
    const { ensurePostgresPlatformStorage } = await import("./storage_postgres.js");
    await ensurePostgresPlatformStorage();
    const result = await queryPostgres<{ organization_id: string }>(`SELECT organization_id FROM platform_documents
      WHERE collection='global' AND id='global' AND document #> '{data,app_flags,platform,expanded_access}' = 'true'::jsonb
      ORDER BY organization_id`);
    return result.rows.map(row => row.organization_id);
  }
  const { listOrganizations } = await import("./storage.js");
  const ids: string[] = [];
  for (const org of await listOrganizations()) if (await isCapabilityEnabled(cleanText(org.id), "platform.expanded_access")) ids.push(cleanText(org.id));
  return ids;
}
