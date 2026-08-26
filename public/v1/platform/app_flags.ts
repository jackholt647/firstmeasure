import { readFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { readGlobal, type JsonObject } from "./storage.js";

export type AppFlagGroup = "platform" | "email" | "canvassing" | "calls" | "firstmeasure" | "lead_forms";
export type AppFlagValue = boolean | number | string;

export type AppFlagDefinition = {
  group: AppFlagGroup;
  flag: string;
  key: string;
  type: "boolean" | "number" | "select";
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

const APP_FLAG_REGISTRY: Record<string, Omit<AppFlagDefinition, "key">> = {
  "platform.lead_import": {
    group: "platform",
    flag: "lead_import",
    type: "boolean",
    label: "Lead Import",
    description: "Enables lead intake settings and lead import surfaces.",
    default: false,
    requires: []
  },
  "platform.website_embed_import": {
    group: "platform",
    flag: "website_embed_import",
    type: "boolean",
    label: "Website Forms",
    description: "Enables the Forms settings tab and website lead intake APIs.",
    default: false,
    requires: ["platform.lead_import"]
  },
  "platform.scheduling": {
    group: "platform",
    flag: "scheduling",
    type: "boolean",
    label: "Scheduling",
    description: "Enables the Scheduling tab, scheduling settings, and appointment-slot features.",
    default: false,
    requires: []
  },
  "platform.contacts": {
    group: "platform",
    flag: "contacts",
    type: "boolean",
    label: "My Contacts",
    description: "Enables the My Contacts tab for contact and project lookup.",
    default: false,
    requires: []
  },
  "platform.crew_management": {
    group: "platform",
    flag: "crew_management",
    type: "boolean",
    label: "Crew Management",
    description: "Enables crew setup, labor compensation plans, and crew-aware scheduling.",
    default: false,
    requires: ["platform.scheduling"]
  },
  "platform.project_photos": {
    group: "platform",
    flag: "project_photos",
    type: "boolean",
    label: "Project Photos",
    description: "Enables project photo galleries and uploads in New Project and project viewer workflows.",
    default: false,
    requires: []
  },
  "platform.photos_feed": {
    group: "platform",
    flag: "photos_feed",
    type: "boolean",
    label: "Photo Feed",
    description: "Enables the organization-wide photo feed, photo comments, and photo markup review workflows.",
    default: false,
    requires: ["platform.project_photos"]
  },
  "platform.proposals": {
    group: "platform",
    flag: "proposals",
    type: "boolean",
    label: "Proposals",
    description: "Enables proposal creation, proposal tabs, and proposal editing workflows.",
    default: false,
    requires: []
  },
  "platform.project_docs": {
    group: "platform",
    flag: "project_docs",
    type: "boolean",
    label: "Project Docs",
    description: "Enables project document storage, required documents, and document markup workflows.",
    default: false,
    requires: []
  },
  "platform.project_stages_view": {
    group: "platform",
    flag: "project_stages_view",
    type: "boolean",
    label: "Project Stages View",
    description: "Enables the Stages view mode in the Projects tab.",
    default: false,
    requires: []
  },
  "platform.proposal_agent": {
    group: "platform",
    flag: "proposal_agent",
    type: "boolean",
    label: "Proposal Agent",
    description: "Shows the AI prompt panel inside the proposal builder.",
    default: false,
    requires: ["platform.proposals"]
  },
  "platform.materials": {
    group: "platform",
    flag: "materials",
    type: "boolean",
    label: "Materials",
    description: "Enables project material lists, ordering, delivery tracking, and material amendments.",
    default: false,
    requires: ["platform.pricebook"]
  },
  "platform.money": {
    group: "platform",
    flag: "money",
    type: "boolean",
    label: "Money",
    description: "Enables project payment schedules, customer payment tracking, profitability, payables, and disbursements.",
    default: false,
    requires: []
  },
  "platform.top_bar": {
    group: "platform",
    flag: "top_bar",
    type: "boolean",
    label: "Platform Top Bar",
    description: "Enables the global search box and notifications bell in the platform header.",
    default: false,
    requires: []
  },
  "platform.left_column_todo_list": {
    group: "platform",
    flag: "left_column_todo_list",
    type: "boolean",
    label: "Left Column To Do List",
    description: "Enables the Apps/To Do switcher and today's action-item list in the portal left column.",
    default: false,
    requires: []
  },
  "platform.cobrand_sidebar_logo": {
    group: "platform",
    flag: "cobrand_sidebar_logo",
    type: "boolean",
    label: "Co-Branded Sidebar Logo",
    description: "Shows the FirstMate logo in the org primary color before the company logo in the portal sidebar.",
    default: false,
    requires: []
  },
  "platform.new_button_mode": {
    group: "platform",
    flag: "new_button_mode",
    type: "select",
    label: "New Button Mode",
    description: "Choose whether the sidebar New button opens the selector or directly starts one workflow.",
    default: "report",
    options: [
      ["selector", "Selector menu"],
      ["project", "New Project"],
      ["report", "New Report"],
      ["proposal", "New Proposal"],
      ["appointment", "New Appointment"]
    ],
    requires: []
  },
  "platform.configuration": {
    group: "platform",
    flag: "configuration",
    type: "boolean",
    label: "Configuration",
    description: "Shows the Configuration settings tab.",
    default: false,
    requires: []
  },
  "platform.pricebook": {
    group: "platform",
    flag: "pricebook",
    type: "boolean",
    label: "Pricebook",
    description: "Shows the Pricebook settings tab and editor.",
    default: false,
    requires: []
  },
  "platform.user_modals": {
    group: "platform",
    flag: "user_modals",
    type: "boolean",
    label: "User Modals",
    description: "Enables clickable user profile modals with uploaded-photo views.",
    default: false,
    requires: []
  },
  "platform.user_activity": {
    group: "platform",
    flag: "user_activity",
    type: "boolean",
    label: "User Activity",
    description: "Shows activity streams in user profile modals.",
    default: false,
    requires: ["platform.user_modals"]
  },
  "platform.storage_limits": {
    group: "platform",
    flag: "storage_limits",
    type: "boolean",
    label: "Storage Limits",
    description: "Shows storage usage and enforces media upload limits.",
    default: false,
    requires: []
  },
  "platform.free_storage_gb": {
    group: "platform",
    flag: "free_storage_gb",
    type: "number",
    label: "Free Storage GB",
    description: "Included media storage in gigabytes before upload limits apply.",
    default: 1,
    min: 0,
    step: 0.25,
    requires: ["platform.storage_limits"]
  },
  "platform.customer_portal": {
    group: "platform",
    flag: "customer_portal",
    type: "boolean",
    label: "Customer Portal",
    description: "Enables secure per-project customer portal links and portal sharing controls.",
    default: false,
    requires: []
  },
  "platform.customer_portal_media": {
    group: "platform",
    flag: "customer_portal_media",
    type: "boolean",
    label: "Customer Portal Media",
    description: "Allows project photos and videos to be shared with customer portal visitors.",
    default: false,
    requires: ["platform.customer_portal", "platform.project_photos"]
  },
  "platform.purchasable_storage": {
    group: "platform",
    flag: "purchasable_storage",
    type: "boolean",
    label: "Purchasable Storage",
    description: "Shows storage checkout entry points.",
    default: false,
    requires: ["platform.storage_limits"]
  },
  "email.inbound_lead_import": {
    group: "email",
    flag: "inbound_lead_import",
    type: "boolean",
    label: "Email Inbox Leads",
    description: "Enables inbound email lead capture.",
    default: false,
    requires: ["platform.lead_import"]
  },
  "canvassing.app": {
    group: "canvassing",
    flag: "app",
    type: "boolean",
    label: "Canvassing",
    description: "Enables canvassing settings, canvassing APIs, and the Canvassing tab.",
    default: false,
    requires: []
  },
  "calls.app": {
    group: "calls",
    flag: "app",
    type: "boolean",
    label: "Calls",
    description: "Enables the Calls tab and call workflow settings.",
    default: false,
    requires: []
  },
  "lead_forms.contact_form": {
    group: "lead_forms",
    flag: "contact_form",
    type: "boolean",
    label: "Contact Form",
    description: "Enables basic website contact forms.",
    default: false,
    requires: ["platform.website_embed_import"]
  },
  "lead_forms.appointment_form": {
    group: "lead_forms",
    flag: "appointment_form",
    type: "boolean",
    label: "Appointment Form",
    description: "Enables website appointment forms that depend on scheduling.",
    default: false,
    requires: ["platform.website_embed_import", "platform.scheduling"]
  },
  "lead_forms.instant_estimate": {
    group: "lead_forms",
    flag: "instant_estimate",
    type: "boolean",
    label: "Instant Estimate",
    description: "Enables website instant estimate forms.",
    default: false,
    requires: ["platform.website_embed_import"]
  },
  "firstmeasure.bonus_upfront_match": {
    group: "firstmeasure",
    flag: "bonus_upfront_match",
    type: "boolean",
    label: "Bonus Upfront Match",
    description: "Enables the upfront credit match offer.",
    default: false,
    requires: []
  },
  "firstmeasure.gutter_reports": {
    group: "firstmeasure",
    flag: "gutter_reports",
    type: "boolean",
    label: "Gutter Reports",
    description: "Enables roof and gutter measurement report options.",
    default: true,
    requires: ["firstmeasure.report_orders"]
  },
  "firstmeasure.weather_reports": {
    group: "firstmeasure",
    flag: "weather_reports",
    type: "boolean",
    label: "Historical Weather Reports",
    description: "Enables historical severe-weather report ordering and project report tabs.",
    default: false,
    requires: ["firstmeasure.report_orders"]
  },
  "firstmeasure.measurement_report_summary": {
    group: "firstmeasure",
    flag: "measurement_report_summary",
    type: "boolean",
    label: "Measurement Report Summary",
    description: "Enables the gated roof report summary sub-tab in project reports.",
    default: true,
    requires: ["firstmeasure.report_orders"]
  },
  "firstmeasure.report_orders": {
    group: "firstmeasure",
    flag: "report_orders",
    type: "boolean",
    label: "Report Orders",
    description: "Enables ordering FirstMeasure roof measurement reports.",
    default: true,
    requires: []
  },
  "firstmeasure.report_expedite_options": {
    group: "firstmeasure",
    flag: "report_expedite_options",
    type: "boolean",
    label: "Report Expedite Options",
    description: "Enables customer-facing turnaround choices for report orders.",
    default: true,
    requires: ["firstmeasure.report_orders"]
  },
  "firstmeasure.report_cancellations": {
    group: "firstmeasure",
    flag: "report_cancellations",
    type: "boolean",
    label: "Report Cancellations",
    description: "Enables customer cancellation of report orders during the grace period.",
    default: true,
    requires: ["firstmeasure.report_orders"]
  },
  "firstmeasure.report_followup": {
    group: "firstmeasure",
    flag: "report_followup",
    type: "boolean",
    label: "Report Follow-up",
    description: "Enables customer issue reports, correction requests, additional structure requests, and the Changes Pending tab.",
    default: false,
    requires: ["firstmeasure.report_orders"]
  },
  "firstmeasure.instant_reports": {
    group: "firstmeasure",
    flag: "instant_reports",
    type: "boolean",
    label: "Instant Reports",
    description: "Enables FirstMeasure instant report options.",
    default: false,
    requires: ["firstmeasure.report_orders"]
  },
  "firstmeasure.referral_program_banner": {
    group: "firstmeasure",
    flag: "referral_program_banner",
    type: "boolean",
    label: "Referral Program Banner",
    description: "Enables the customer referral banner.",
    default: false,
    requires: []
  }
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

const APP_FLAG_GROUPS = Array.from(new Set(Object.values(APP_FLAG_REGISTRY).map((definition) => definition.group))) as AppFlagGroup[];

const DEFAULT_APP_FLAGS = APP_FLAG_GROUPS.reduce((result, group) => {
  result[group] = {};
  return result;
}, {} as Record<AppFlagGroup, Record<string, AppFlagValue>>);

for (const [key, definition] of Object.entries(APP_FLAG_REGISTRY)) {
  DEFAULT_APP_FLAGS[definition.group][definition.flag] = definition.default;
}

const TEST_APP_FLAG_ADMIN_EMAILS = new Set(["notifications@1m8.ai"]);

const LEGACY_DEFAULT_APP_FLAGS: Record<AppFlagGroup, Record<string, AppFlagValue>> = {
  platform: {
    lead_import: false,
    website_embed_import: false,
    scheduling: false,
    contacts: false,
    crew_management: false,
    project_photos: false,
    photos_feed: false,
    proposals: false,
    project_docs: false,
    project_stages_view: false,
    proposal_agent: false,
    materials: false,
    money: false,
    top_bar: false,
    left_column_todo_list: false,
    cobrand_sidebar_logo: false,
    new_button_mode: "report",
    configuration: false,
    pricebook: false,
    user_modals: false,
    user_activity: false,
    storage_limits: false,
    free_storage_gb: 1,
    customer_portal: false,
    customer_portal_media: false,
    purchasable_storage: false
  },
  email: {
    inbound_lead_import: false
  },
  canvassing: {
    app: false
  },
  calls: {
    app: false
  },
  firstmeasure: {
    bonus_upfront_match: false,
    gutter_reports: true,
    measurement_report_summary: true,
    report_orders: true,
    report_expedite_options: true,
    report_cancellations: true,
    report_followup: false,
    instant_reports: false,
    referral_program_banner: false
  },
  lead_forms: {
    contact_form: false,
    appointment_form: false,
    instant_estimate: false
  }
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeGroup(value: string): AppFlagGroup | "" {
  const group = cleanText(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEGACY_DEFAULT_APP_FLAGS, group) ? group as AppFlagGroup : "";
}

function normalizeVariantKey(family: string, value: unknown) {
  const key = cleanText(value).toLowerCase();
  if (!family || !key) return "";
  return (APP_VARIANT_REGISTRY[family] || []).some((variant) => variant.key === key) ? key : "";
}

function normalizeFlagValue(definition: Omit<AppFlagDefinition, "key">, value: unknown): AppFlagValue {
  if (definition.type === "number") {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : definition.default;
  }
  if (definition.type === "select") {
    const selected = cleanText(value).toLowerCase();
    const options = Array.isArray(definition.options)
      ? definition.options.map((option) => Array.isArray(option) ? option[0] : option)
      : [];
    return options.includes(selected) ? selected : definition.default;
  }
  return value !== false;
}

function mergeGroup(group: AppFlagGroup, overrides: JsonObject) {
  const defaults = DEFAULT_APP_FLAGS[group];
  const result: Record<string, AppFlagValue> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const normalizedKey = cleanText(key);
    if (!normalizedKey) continue;
    const definition = APP_FLAG_REGISTRY[`${group}.${normalizedKey}`];
    if (!definition) continue;
    result[normalizedKey] = normalizeFlagValue(definition, value);
  }
  return result;
}

function normalizeOverrides(raw: JsonObject) {
  const flags = asObject(raw.app_flags || raw.feature_flags);
  const normalized: Partial<Record<AppFlagGroup, JsonObject>> = {};
  for (const group of Object.keys(DEFAULT_APP_FLAGS) as AppFlagGroup[]) {
    normalized[group] = asObject(flags[group]);
  }
  return normalized;
}

export function appFlagDefinitions() {
  return Object.entries(APP_FLAG_REGISTRY).map(([key, definition]) => ({
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
  return JSON.parse(JSON.stringify(DEFAULT_APP_FLAGS)) as Record<AppFlagGroup, Record<string, AppFlagValue>>;
}

function platformStorageRoot() {
  return path.resolve(process.cwd(), env.platformStorageRoot);
}

function appFlagDefaultsConfigPath() {
  return path.join(platformStorageRoot(), "config", "app_flag_defaults.json");
}

export function normalizeFullAppFlags(input: JsonObject = {}) {
  const source = asObject(input.app_flags || input.flags || input);
  const normalized = {} as Record<AppFlagGroup, Record<string, AppFlagValue>>;
  for (const group of APP_FLAG_GROUPS) {
    normalized[group] = mergeGroup(group, asObject(source[group]));
  }
  return normalized;
}

export async function newOrganizationAppFlagDefaults() {
  try {
    const raw = JSON.parse(await readFile(appFlagDefaultsConfigPath(), "utf8")) as JsonObject;
    const data = asObject(raw.data);
    const source = asObject(data.app_flags || data.feature_flags || raw.app_flags || raw.feature_flags);
    return normalizeFullAppFlags(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return appFlagDefaults();
  }
}

export async function rawAppFlags(orgId: string) {
  const globalDoc = await readGlobal(orgId);
  const data = asObject(globalDoc.data);
  const overrides = normalizeOverrides(data);
  const raw = {} as Record<AppFlagGroup, Record<string, AppFlagValue>>;
  for (const group of APP_FLAG_GROUPS) {
    raw[group] = mergeGroup(group, asObject(overrides[group]));
  }
  return raw;
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

function resolveFlag(
  key: string,
  raw: Record<AppFlagGroup, Record<string, AppFlagValue>>,
  resolved: Record<string, boolean>,
  reasons: Record<string, string | null>,
  stack: string[] = []
) {
  if (Object.prototype.hasOwnProperty.call(resolved, key)) return resolved[key];
  const definition = APP_FLAG_REGISTRY[key];
  if (!definition) {
    resolved[key] = false;
    reasons[key] = "unknown_flag";
    return false;
  }
  if (definition.type !== "boolean") {
    resolved[key] = false;
    reasons[key] = null;
    return false;
  }
  const rawEnabled = raw[definition.group]?.[definition.flag] !== false;
  if (!rawEnabled) {
    resolved[key] = false;
    reasons[key] = "flag_disabled";
    return false;
  }
  if (stack.includes(key)) {
    resolved[key] = false;
    reasons[key] = "dependency_cycle";
    return false;
  }
  for (const requirement of definition.requires) {
    if (!resolveFlag(requirement, raw, resolved, reasons, [...stack, key])) {
      resolved[key] = false;
      reasons[key] = `requires ${requirement}`;
      return false;
    }
  }
  resolved[key] = true;
  reasons[key] = null;
  return true;
}

export function resolveAppFlags(raw: Record<AppFlagGroup, Record<string, AppFlagValue>>) {
  const resolvedByKey: Record<string, boolean> = {};
  const disabledReasons: Record<string, string | null> = {};
  for (const key of Object.keys(APP_FLAG_REGISTRY)) {
    resolveFlag(key, raw, resolvedByKey, disabledReasons);
  }
  const resolved = appFlagDefaults();
  for (const group of APP_FLAG_GROUPS) resolved[group] = {};
  for (const [key, value] of Object.entries(resolvedByKey)) {
    const definition = APP_FLAG_REGISTRY[key];
    if (!definition || definition.type !== "boolean") continue;
    resolved[definition.group][definition.flag] = value;
  }
  for (const [key, definition] of Object.entries(APP_FLAG_REGISTRY)) {
    if (definition.type === "boolean") continue;
    resolved[definition.group][definition.flag] = raw[definition.group]?.[definition.flag] ?? definition.default;
    disabledReasons[key] = null;
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

export async function effectiveAppFlags(orgId: string) {
  return resolveAppFlags(await rawAppFlags(orgId)).resolved;
}

export async function appFlagState(orgId: string) {
  const raw = await rawAppFlags(orgId);
  const rawVariants = await rawAppVariants(orgId);
  const resolvedState = resolveAppFlags(raw);
  const variantState = resolveAppVariants(rawVariants, resolvedState.resolvedByKey);
  return {
    definitions: appFlagDefinitions(),
    variant_definitions: appVariantDefinitions(),
    raw,
    raw_variants: rawVariants,
    effective: resolvedState.resolved,
    effective_variants: variantState.resolved,
    enabled: enabledOnlyAppFlags(resolvedState.resolved),
    disabled_reasons: resolvedState.disabledReasons,
    variant_disabled_reasons: variantState.disabledReasons
  };
}

export function enabledOnlyAppFlags(flags: Record<AppFlagGroup, Record<string, AppFlagValue>>) {
  const enabled = {} as Record<AppFlagGroup, string[]>;
  for (const group of APP_FLAG_GROUPS) {
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
    || Object.prototype.hasOwnProperty.call(input, "app_flags")
    || Object.prototype.hasOwnProperty.call(input, "feature_flags")
    || Object.prototype.hasOwnProperty.call(input, "app_variants")
    || Object.prototype.hasOwnProperty.call(input, "feature_variants");
}

export function canManageTestAppFlags(input: { identity?: JsonObject; role?: string }) {
  const email = cleanText(asObject(input.identity).email).toLowerCase();
  const role = cleanText(input.role).toLowerCase();
  return TEST_APP_FLAG_ADMIN_EMAILS.has(email) && ["owner", "admin", "super_admin"].includes(role);
}

export function normalizeAppFlagInput(input: JsonObject = {}) {
  const source = asObject(input.app_flags || input.flags || input);
  const normalized = {} as Record<AppFlagGroup, Record<string, AppFlagValue>>;
  for (const group of APP_FLAG_GROUPS) {
    const groupInput = asObject(source[group]);
    normalized[group] = {};
    for (const flag of Object.keys(DEFAULT_APP_FLAGS[group] || {})) {
      if (Object.prototype.hasOwnProperty.call(groupInput, flag)) {
        const definition = APP_FLAG_REGISTRY[`${group}.${flag}`];
        if (!definition) continue;
        normalized[group][flag] = normalizeFlagValue(definition, groupInput[flag]);
      }
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
