import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { badRequest, notFound } from "./errors.js";
import { readGlobal, mutateGlobal, readPlatformConfiguration, mutatePlatformConfiguration, type JsonObject } from "./storage.js";

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
export type CapabilityAudience = "management" | "field";
export type CapabilityDevice = "desktop" | "mobile";

export type CapabilityDefinition = {
  key: string;
  kind: CapabilityKind;
  label: string;
  description: string;
  /** Value nodes only. Defaults to "boolean". Permission nodes carry none. */
  type?: CapabilityValueType;
  default?: CapabilityValue;
  parent?: string;
  requires?: string[];
  options?: Array<string | [string, string]>;
  min?: number;
  step?: number;
  /** Which applications surface this capability. Informational. */
  audience?: CapabilityAudience[];
  /** Device visibility. Informational; enforced by the entitlement layer. */
  devices?: CapabilityDevice[];
  /** Named relevance predicate (e.g. "hourly_compensation"). Informational. */
  relevance?: string;
  /** Permission nodes: the permission key checked by hasPermission(). */
  permission_key?: string;
  /** Permission nodes: read (view) or write (mutate). */
  access?: "read" | "write";
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
  audience: CapabilityAudience[];
  devices: CapabilityDevice[];
  relevance: string;
  permission_key: string;
  access: "read" | "write" | "";
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
  values: Record<string, CapabilityValue>;
  created_at?: string;
  updated_at?: string;
};

const firstMeasureCapabilities = new Set([
  "mobile.app_download", "mobile.developer_downloads",
  "platform.expanded_access", "apps.projects", "apps.project_map", "apps.firstmeasure", "apps.notifications", "apps.billing", "apps.referrals",
  "platform.left_column_apps", "platform.separate_user_section", "platform.cobrand_sidebar_logo",
  "platform.left_column_expansion_mode", "platform.always_collapsible_left_column",
  "platform.new_button_mode", "platform.new_button_items", "platform.left_column_default_mode",
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
      if (type === "number" && typeof definition.default !== "number") {
        throw new Error(`Capability "${key}" is a number but its default is not numeric.`);
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
      default: storesValue ? (definition.default ?? (type === "boolean" ? false : null)) : null,
      parent: cleanText(definition.parent),
      requires: (definition.requires || []).map(cleanText).filter(Boolean),
      options: (definition.options || []).map((option) => Array.isArray(option) ? [cleanText(option[0]), cleanText(option[1])] as [string, string] : [cleanText(option), cleanText(option)] as [string, string]),
      ...(definition.min !== undefined ? { min: definition.min } : {}),
      ...(definition.step !== undefined ? { step: definition.step } : {}),
      audience: definition.audience || ["management"],
      devices: definition.devices || ["desktop", "mobile"],
      relevance: cleanText(definition.relevance),
      permission_key: cleanText(definition.permission_key),
      access: definition.access || "",
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
  }
}

/**
 * Validates the whole graph. Throws on structural problems so a bad registry
 * fails at server boot (and in tests) instead of resolving inconsistently.
 */
export function validateCapabilityRegistry() {
  if (registryValidated) return;
  for (const node of registry.values()) {
    node.children = [];
    node.ancestors = [];
  }
  for (const node of registry.values()) {
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
    audience: [...node.audience],
    devices: [...node.devices],
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

/** Registry defaults as a flat key -> value map. */
export function capabilityDefaultValues() {
  const defaults: Record<string, CapabilityValue> = {};
  for (const node of valueCapabilities()) {
    defaults[node.key] = node.default as CapabilityValue;
  }
  return defaults;
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
    values["platform.left_column_default_mode"] = "apps";
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
  const data = asObject(globalDoc.data);
  const stored = flattenGroupedValues(asObject(data.app_flags || data.feature_flags));
  return { ...capabilityDefaultValues(), ...stored };
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
export async function capabilityValuesForUser(orgId: string, userId?: string, raw?: Record<string, CapabilityValue>) {
  let values = raw || await rawCapabilityValues(orgId);
  if (values["platform.expanded_access"] === true) {
    values = await (await import("../platform-billing/service.js")).applyEntitlements(orgId, values);
  }
  if (!userId || values["platform.expanded_access"] !== true) return values;
  const rollout = await readPlatformRollout(orgId);
  return rollout.mode === "selected" && !rollout.user_ids.includes(userId)
    ? { ...values, "platform.expanded_access": false } : values;
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
// Presets
// ---------------------------------------------------------------------------

function platformStorageRoot() {
  return path.resolve(process.cwd(), env.platformStorageRoot);
}

function capabilityPresetsPath() {
  return path.join(platformStorageRoot(), "config", "capability_presets.json");
}

/** All boolean value nodes off, non-boolean nodes at their defaults. */
function baselineOffValues() {
  const values: Record<string, CapabilityValue> = {};
  for (const node of valueCapabilities()) {
    values[node.key] = node.type === "boolean" ? false : (node.default as CapabilityValue);
  }
  return values;
}

function presetValues(overrides: Record<string, CapabilityValue>) {
  return { ...baselineOffValues(), ...overrides };
}

function everythingOnValues() {
  const values: Record<string, CapabilityValue> = {};
  for (const node of valueCapabilities()) {
    values[node.key] = node.type === "boolean" ? true : (node.default as CapabilityValue);
  }
  return values;
}

export function builtinCapabilityPresets(): CapabilityPreset[] {
  validateCapabilityRegistry();
  return [
    {
      id: "platform_defaults",
      name: "Platform Defaults",
      description: "The registry defaults applied to new organizations when no signup preset is configured.",
      builtin: true,
      values: capabilityDefaultValues()
    },
    {
      id: "proposals_only",
      name: "Proposals Only",
      description: "A focused proposal workflow on the document engine: create and send proposals, collect signatures and payment through the customer portal. Everything else off.",
      builtin: true,
      values: presetValues({
        "apps.projects": true,
        "platform.contacts": true,
        "platform.documents": true,
        "documents.templates_studio": true,
        "documents.esign": true,
        "documents.payments": true,
        "platform.customer_portal": true,
        "customer_portal.payments": true,
        "platform.money": true,
        "money.take_payment": true,
        "money.payment_schedules": true,
        "apps.billing": true,
        "platform.pricebook": true,
        "platform.new_button_mode": "doc:proposal"
      })
    },
    {
      id: "sales_crm",
      name: "Sales & CRM",
      description: "Lead intake, CRM pipeline, scheduling, proposals, and communications for sales-driven teams.",
      builtin: true,
      values: presetValues({
        "apps.projects": true,
        "apps.crm": true,
        "crm.pipeline": true,
        "crm.automations": true,
        "crm.call_lists": true,
        "platform.contacts": true,
        "platform.lead_import": true,
        "platform.website_embed_import": true,
        "email.inbound_lead_import": true,
        "lead_forms.contact_form": true,
        "lead_forms.appointment_form": true,
        "lead_forms.instant_estimate": true,
        "platform.scheduling": true,
        "scheduling.appointment_slots": true,
        "platform.documents": true,
        "documents.templates_studio": true,
        "documents.esign": true,
        "platform.customer_portal": true,
        "customer_portal.payments": true,
        "platform.money": true,
        "money.take_payment": true,
        "money.payment_schedules": true,
        "apps.billing": true,
        "apps.messaging": true,
        "platform.sms_settings": true,
        "apps.channels": true,
        "channels.threads": true,
        "channels.reactions": true,
        "channels.dms": true,
        "channels.attachments": true,
        "channels.pins": true,
        "channels.search": true,
        "channels.project_notes": true,
        "canvassing.app": true,
        "calls.app": true,
        "platform.pricebook": true,
        "platform.top_bar": true,
        "topbar.global_search": true,
        "topbar.notifications": true,
        "platform.new_button_mode": "selector"
      })
    },
    {
      id: "field_operations",
      name: "Field Operations",
      description: "Crew scheduling, checklists, time tracking, materials, and payroll for production-heavy teams.",
      builtin: true,
      values: presetValues({
        "apps.projects": true,
        "apps.crew": true,
        "crew.time_clock": true,
        "crew.receipts": true,
        "crew.change_orders": true,
        "crew.field_payments": true,
        "apps.checklists": true,
        "checklists.templates": true,
        "checklists.supervision": true,
        "apps.payroll": true,
        "payroll.pay_runs": true,
        "payroll.compensation_profiles": true,
        "payroll.commissions": true,
        "payroll.self_service_earnings": true,
        "apps.training": true,
        "training.studio": true,
        "training.assignments": true,
        "training.quizzes": true,
        "apps.equipment": true,
        "equipment.scheduling": true,
        "platform.scheduling": true,
        "scheduling.crew_dispatch": true,
        "platform.project_photos": true,
        "photos.markup": true,
        "platform.photos_feed": true,
        "platform.project_docs": true,
        "docs.markup": true,
        "platform.pricebook": true,
        "platform.materials": true,
        "materials.ordering": true,
        "platform.money": true,
        "money.take_payment": true,
        "money.expenses": true,
        "money.profitability": true,
        "apps.billing": true,
        "apps.channels": true,
        "channels.threads": true,
        "channels.reactions": true,
        "channels.project_notes": true,
        "platform.user_modals": true,
        "platform.new_button_mode": "project"
      })
    },
    {
      id: "full_platform",
      name: "Full Platform",
      description: "Everything on. Number and select settings keep their defaults.",
      builtin: true,
      values: everythingOnValues()
    }
  ];
}

type PresetFileShape = { presets?: CapabilityPreset[] };

async function readCustomPresets(): Promise<CapabilityPreset[]> {
  try {
    const raw = (await readPlatformConfiguration("capability_presets") || {}) as PresetFileShape;
    return (Array.isArray(raw.presets) ? raw.presets : [])
      .map((preset) => ({
        id: cleanText(preset.id),
        name: cleanText(preset.name),
        description: cleanText(preset.description),
        builtin: false,
        values: Object.fromEntries(
          Object.entries(asObject(preset.values)).flatMap(([key, value]) => {
            const node = registry.get(cleanText(key));
            return node?.stores_value ? [[node.key, normalizeCapabilityValue(node, value)]] : [];
          })
        ),
        created_at: cleanText(preset.created_at),
        updated_at: cleanText(preset.updated_at)
      }))
      .filter((preset) => preset.id && preset.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function writeCustomPresets(presets: CapabilityPreset[]) {
  await mutatePlatformConfiguration("capability_presets", () => ({ presets }));
}

export async function listCapabilityPresets(): Promise<CapabilityPreset[]> {
  validateCapabilityRegistry();
  return [...builtinCapabilityPresets(), ...(await readCustomPresets())];
}

export async function readCapabilityPreset(presetId: string) {
  const id = cleanText(presetId);
  const preset = (await listCapabilityPresets()).find((entry) => entry.id === id);
  if (!preset) throw notFound("preset_not_found", `Capability preset "${id}" was not found.`);
  return preset;
}

function slugifyPresetId(name: string) {
  const slug = cleanText(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || `preset_${Date.now().toString(36)}`;
}

export async function createCapabilityPreset(input: { id?: string; name: string; description?: string; values: Record<string, unknown> }) {
  validateCapabilityRegistry();
  const name = cleanText(input.name);
  if (!name) throw badRequest("preset_name_required", "A preset name is required.");
  const { values, violations } = validateValueSet(input.values || {});
  const existing = await listCapabilityPresets();
  let id = cleanText(input.id) || slugifyPresetId(name);
  if (existing.some((preset) => preset.id === id)) {
    let suffix = 2;
    while (existing.some((preset) => preset.id === `${id}_${suffix}`)) suffix += 1;
    id = `${id}_${suffix}`;
  }
  const now = new Date().toISOString();
  const preset: CapabilityPreset = {
    id,
    name,
    description: cleanText(input.description),
    builtin: false,
    values,
    created_at: now,
    updated_at: now
  };
  await mutatePlatformConfiguration("capability_presets", current => {
    const presets = Array.isArray(current?.presets) ? current.presets as CapabilityPreset[] : [];
    const used = new Set([...builtinCapabilityPresets(), ...presets].map(item => item.id));
    const baseId = preset.id;
    let suffix = 2;
    while (used.has(preset.id)) preset.id = `${baseId}_${suffix++}`;
    return { presets: [...presets, preset] };
  });
  return { preset, violations };
}

export async function updateCapabilityPreset(presetId: string, input: { name?: string; description?: string; values?: Record<string, unknown> }) {
  const id = cleanText(presetId);
  if (builtinCapabilityPresets().some((preset) => preset.id === id)) {
    throw badRequest("preset_builtin", "Built-in presets cannot be edited. Save a copy under a new name instead.");
  }
  const custom = await readCustomPresets();
  const index = custom.findIndex((preset) => preset.id === id);
  const current = index >= 0 ? custom[index] : undefined;
  if (!current) throw notFound("preset_not_found", `Capability preset "${id}" was not found.`);
  let violations: ValueSetViolation[] = [];
  let values = current.values;
  if (input.values !== undefined) {
    const validated = validateValueSet(input.values || {});
    values = validated.values;
    violations = validated.violations;
  }
  const next: CapabilityPreset = {
    ...current,
    name: input.name !== undefined ? (cleanText(input.name) || current.name) : current.name,
    description: input.description !== undefined ? cleanText(input.description) : current.description,
    values,
    updated_at: new Date().toISOString()
  };
  await mutatePlatformConfiguration("capability_presets", currentConfig => {
    const presets = Array.isArray(currentConfig?.presets) ? currentConfig.presets as CapabilityPreset[] : [];
    const latest = presets.find(item => item.id === id);
    if (!latest) throw notFound("preset_not_found", `Capability preset "${id}" was not found.`);
    if (latest.updated_at !== current.updated_at) throw badRequest("preset_changed", "The preset changed. Reload before saving.");
    return { presets: presets.map(item => item.id === id ? next : item) };
  });
  return { preset: next, violations };
}

export async function deleteCapabilityPreset(presetId: string) {
  const id = cleanText(presetId);
  if (builtinCapabilityPresets().some((preset) => preset.id === id)) {
    throw badRequest("preset_builtin", "Built-in presets cannot be deleted.");
  }
  const custom = await readCustomPresets();
  const next = custom.filter((preset) => preset.id !== id);
  if (next.length === custom.length) throw notFound("preset_not_found", `Capability preset "${id}" was not found.`);
  await mutatePlatformConfiguration("capability_presets", current => {
    const presets = Array.isArray(current?.presets) ? current.presets as CapabilityPreset[] : [];
    if (!presets.some(item => item.id === id)) throw notFound("preset_not_found", `Capability preset "${id}" was not found.`);
    return { presets: presets.filter(item => item.id !== id) };
  });
  return { deleted: true };
}

/**
 * Applies a preset to an organization. Presets are complete configurations:
 * boolean nodes missing from the preset are turned off; number/select nodes
 * missing keep their registry defaults.
 */
export async function applyCapabilityPreset(orgId: string, presetId: string) {
  const preset = await readCapabilityPreset(presetId);
  const full = { ...baselineOffValues(), ...preset.values };
  // App presets never opt customers into a rollout or change its audience.
  delete full["platform.expanded_access"];
  delete full["platform.more_apps"];
  const saved = await saveCapabilityValues(orgId, full);
  return { preset, ...saved };
}

// ---------------------------------------------------------------------------
// Signup defaults
// ---------------------------------------------------------------------------

function signupPresetConfigPath() {
  return path.join(platformStorageRoot(), "config", "capability_signup_preset.json");
}

/**
 * The flat value map applied to newly registered organizations: the configured
 * signup preset when one is set, otherwise registry defaults.
 */
export async function newOrganizationCapabilityValues() {
  try {
    const raw = await readPlatformConfiguration("capability_signup_preset") || {};
    const presetId = cleanText(raw.preset_id);
    if (presetId) {
      const preset = await readCapabilityPreset(presetId).catch(() => null);
      if (preset) {
        const defaults = capabilityDefaultValues();
        const values = { ...baselineOffValues(), ...preset.values };
        // Signup remains FirstMeasure even when a historical platform preset is configured.
        for (const key of Object.keys(defaults)) {
          if (firstMeasureCapabilities.has(key) || key.startsWith("firstmeasure.")) values[key] = defaults[key]!;
        }
        values["platform.expanded_access"] = false;
        values["platform.more_apps"] = false;
        return values;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return capabilityDefaultValues();
}

export async function setSignupCapabilityPreset(presetId: string) {
  const id = cleanText(presetId);
  if (id) await readCapabilityPreset(id);
  await mutatePlatformConfiguration("capability_signup_preset", () => ({ preset_id: id, updated_at: new Date().toISOString() }));
  return { preset_id: id };
}

export async function readSignupCapabilityPresetId() {
  try {
    const raw = await readPlatformConfiguration("capability_signup_preset") || {};
    return cleanText(raw.preset_id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
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
