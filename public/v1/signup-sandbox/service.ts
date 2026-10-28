import { env } from '../src/config/env.js';
import { gatedAccounts } from "./admin.js";
import { randomBytes } from "node:crypto";

import { newOrganizationAppFlagDefaults } from "../platform/app_flags.js";
import { NEW_ORGANIZATION_APP_OFFERS, offeredAppIds } from '../platform/app-experience/offers.js';
import { valueCapabilities } from "../platform/capabilities.js";
import { libraryEntries, libraryStamp } from "../config-library/library.js";
import type { LibraryEntry } from "../config-library/contracts.js";
import { contentHash } from "../config-library/canonical.js";
import type { SandboxConfigurationData } from "../config-library/kinds/sandbox_configuration.js";
import {
  hashPassword,
  loginPlatformIdentity,
  loginPlatformVerifiedIdentity,
  type PlatformAuthContext
} from "../platform/auth.js";
import {
  addIdentityMembership,
  createIdentity,
  createOrganization,
  deleteIdentity,
  deleteIdentitySessions,
  listDocuments,
  listIdentityMemberships,
  readDocument,
  readIdentity,
  readGlobal,
  saveGlobal,
  upsertDocument
} from "../platform/storage.js";
import { organizationUserProfileFields } from "../platform/user_profile.js";
import { DEFAULT_ACCESS_ROLE_IDS, listAccessRoles, patchAccessRole } from "../workforce/access.js";
import { patchScopeFlags, readScopeFlagState } from "../scopes/storage.js";
import {
  generateSandboxId,
  nowIso,
  removePlatformOrgData,
  sandboxError,
  sandboxStore,
  sanitizeSandboxId,
  type JsonObject
} from "./storage.js";

export const SANDBOX_TEST_PASSWORD = "test1234";

const PAGE_ROLES = ["landing", "signup", "setup"] as const;
const PAGE_STATUSES = ["placeholder", "implemented", "builtin"] as const;
const ENTRY_MODES = ["landing_first", "signup_first"] as const;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const normalized = cleanText(value).toLowerCase();
  return allowed.includes(normalized as T) ? (normalized as T) : fallback;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

// ---- Settings model --------------------------------------------------------
// A workflow's `defaults` and a page's `effects` hold three maps:
//   app_flags: { "group.flag": boolean|number|string|"$user" }  (legacy app-flag keys)
//   settings:  { "dot.path.into.org.global.data": value|"$user" }
//   scope_flags: { "scope_template_id": boolean|"$user" }
// "$user" marks a value the signing-up user picks on that page; it documents
// the choice in projections and is never auto-applied.

export const USER_CHOICE = "$user";

/**
 * Where a workflow's app flags start before its own are laid over (config-library kind sandbox_configuration,
 * `app_flags_base`), computed from the running registry so a capability added later is covered too.
 */
const APP_FLAG_BASES = ["new_organization", "all_off", "all_on", "expanded_access_off"] as const;
function appFlagBaseOverrides(base: unknown): JsonObject {
  const overrides: JsonObject = {};
  for (const capability of valueCapabilities()) {
    if (capability.type !== "boolean") continue;
    if (base === "all_off") overrides[capability.key] = false;
    if (base === "all_on") overrides[capability.key] = true;
    if (base === "expanded_access_off" && capability.requires.includes("platform.expanded_access")) overrides[capability.key] = false;
  }
  return overrides;
}

function normalizeEffectMap(value: unknown): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(asObject(value))) {
    const path = cleanText(key);
    if (!path || entry === undefined || entry === null) continue;
    result[path] = entry as unknown;
  }
  return result;
}

function normalizeEffects(value: unknown): JsonObject {
  const input = asObject(value);
  return {
    app_flags: normalizeEffectMap(input.app_flags),
    settings: normalizeEffectMap(input.settings),
    scope_flags: normalizeEffectMap(input.scope_flags)
  };
}

function deepMerge(base: JsonObject, patch: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(asObject(result[key]), value as JsonObject);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function setDeepPath(target: JsonObject, dotPath: string, value: unknown) {
  const segments = dotPath.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return;
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    if (!node[segment] || typeof node[segment] !== "object" || Array.isArray(node[segment])) node[segment] = {};
    node = node[segment] as JsonObject;
  }
  node[segments[segments.length - 1] as string] = value;
}

// "group.flag" keys -> the grouped app_flags document shape ({group: {flag: value}}).
function groupedFlagOverrides(flagMap: JsonObject, options: { includeUserChoices?: boolean } = {}): JsonObject {
  const grouped: JsonObject = {};
  for (const [key, value] of Object.entries(flagMap)) {
    if (value === USER_CHOICE && !options.includeUserChoices) continue;
    const dot = key.indexOf(".");
    const group = dot > 0 ? key.slice(0, dot) : key;
    const flag = dot > 0 ? key.slice(dot + 1) : key;
    const bucket = asObject(grouped[group]);
    bucket[flag] = value;
    grouped[group] = bucket;
  }
  return grouped;
}

// ---- Pages -----------------------------------------------------------------

function normalizePage(input: JsonObject, existing: JsonObject | null = null): JsonObject {
  const now = nowIso();
  const id = existing ? String(existing.id) : input.id ? sanitizeSandboxId(input.id, "page id") : generateSandboxId("spg");
  const implementationInput = (input.implementation ?? existing?.implementation ?? {}) as JsonObject;
  const status = choice(input.status ?? existing?.status, PAGE_STATUSES, "placeholder");
  return {
    schema_version: sandboxStore.schemaVersion,
    kind: "signup_page",
    id,
    title: cleanText(input.title ?? existing?.title) || "Untitled page",
    role: choice(input.role ?? existing?.role, PAGE_ROLES, "setup"),
    status,
    variant_of: cleanText(input.variant_of ?? existing?.variant_of) || null,
    implementation: {
      type: cleanText(implementationInput.type) || (status === "builtin" ? "builtin_wizard" : status === "implemented" ? "bundle" : "placeholder"),
      bundle: cleanText(implementationInput.bundle) || null,
      builtin_ref: cleanText(implementationInput.builtin_ref) || null
    },
    brief: String(input.brief ?? existing?.brief ?? ""),
    effects: normalizeEffects(input.effects ?? existing?.effects),
    tags: Array.isArray(input.tags ?? existing?.tags) ? ((input.tags ?? existing?.tags) as unknown[]).map(cleanText).filter(Boolean) : [],
    created_at: existing ? String(existing.created_at) : now,
    updated_at: now
  };
}

export async function createPage(input: JsonObject) {
  const page = normalizePage(input);
  if (await sandboxStore.readPage(String(page.id))) {
    throw sandboxError(409, "page_exists", `Page '${page.id}' already exists.`);
  }
  return sandboxStore.savePage(page);
}

export async function createPageVariant(sourcePageId: string, input: JsonObject) {
  const source = await sandboxStore.readPage(sourcePageId);
  if (!source) throw sandboxError(404, "page_not_found", `Page '${sourcePageId}' was not found.`);
  return sandboxStore.savePage(normalizePage({
    ...source,
    ...input,
    id: input.id ?? undefined,
    title: cleanText(input.title) || `${source.title} (variant)`,
    variant_of: source.id,
    // A variant starts as a placeholder until an agent builds its bundle.
    status: input.status ?? "placeholder",
    implementation: input.implementation ?? { type: "placeholder" }
  }));
}

export async function updatePage(pageId: string, patch: JsonObject) {
  const existing = await sandboxStore.readPage(pageId);
  if (!existing) throw sandboxError(404, "page_not_found", `Page '${pageId}' was not found.`);
  return sandboxStore.savePage(normalizePage(patch, existing));
}

export async function deletePage(pageId: string, options: { force?: boolean } = {}) {
  const existing = await sandboxStore.readPage(pageId);
  if (!existing) throw sandboxError(404, "page_not_found", `Page '${pageId}' was not found.`);
  const workflows = await sandboxStore.listWorkflows();
  const referencedBy = workflows.filter((workflow) =>
    (Array.isArray(workflow.stages) ? workflow.stages : []).some((stage) => (stage as JsonObject).page_id === pageId));
  if (referencedBy.length && !options.force) {
    throw sandboxError(409, "page_in_use", `Page '${pageId}' is used by: ${referencedBy.map((w) => w.title).join(", ")}. Pass force=true to delete anyway.`);
  }
  await sandboxStore.deletePage(pageId);
  return { deleted: pageId, referenced_by: referencedBy.map((w) => w.id) };
}

// ---- Workflows -------------------------------------------------------------

function normalizeStage(input: JsonObject): JsonObject {
  return {
    id: input.id ? sanitizeSandboxId(input.id, "stage id") : generateSandboxId("stg"),
    page_id: sanitizeSandboxId(input.page_id, "stage page id"),
    notes: String(input.notes ?? "")
  };
}

// What the sandbox's "Add sample data" can add (development/fixtures.ts addTestOrgSampleData).
const SAMPLE_DATA_KINDS = ["equipment", "channels", "projects", "customers"];

function normalizeWorkflow(input: JsonObject, existing: JsonObject | null = null): JsonObject {
  const now = nowIso();
  const id = existing ? String(existing.id) : input.id ? sanitizeSandboxId(input.id, "workflow id") : generateSandboxId("swf");
  const stagesInput = Array.isArray(input.stages) ? input.stages : Array.isArray(existing?.stages) ? existing.stages : [];
  return {
    schema_version: sandboxStore.schemaVersion,
    kind: "signup_workflow",
    id,
    title: cleanText(input.title ?? existing?.title) || "Untitled workflow",
    description: String(input.description ?? existing?.description ?? ""),
    entry_mode: choice(input.entry_mode ?? existing?.entry_mode, ENTRY_MODES, "signup_first"),
    defaults: normalizeEffects(input.defaults ?? existing?.defaults),
    stages: (stagesInput as JsonObject[]).map(normalizeStage),
    variant_of: cleanText(input.variant_of ?? existing?.variant_of) || null,
    tags: Array.isArray(input.tags ?? existing?.tags) ? ((input.tags ?? existing?.tags) as unknown[]).map(cleanText).filter(Boolean) : [],
    // Test orgs from this workflow can take development sample data.
    sample_data: (input.sample_data ?? existing?.sample_data) === true,
    // The sample data a new test org gets when it is launched (a workflow that offers sample data only).
    launch_sample_data: (input.sample_data ?? existing?.sample_data) === true && Array.isArray(input.launch_sample_data ?? existing?.launch_sample_data)
      ? [...new Set(((input.launch_sample_data ?? existing?.launch_sample_data) as unknown[]).map(cleanText).filter((kind) => SAMPLE_DATA_KINDS.includes(kind)))]
      : [],
    // The test-run bar shows inside its test orgs unless the workflow turns it off.
    dev_bar: (input.dev_bar ?? existing?.dev_bar) !== false,
    // The onboarding wizard's product mode for builtin wizard stages (empty: the standard one).
    onboarding_mode: /^[a-z_]{0,40}$/.test(cleanText(input.onboarding_mode ?? existing?.onboarding_mode)) ? cleanText(input.onboarding_mode ?? existing?.onboarding_mode) : "",
    // Where the workflow's app flags start before its own are laid over (appFlagBaseOverrides).
    app_flags_base: choice(input.app_flags_base ?? existing?.app_flags_base, APP_FLAG_BASES, "new_organization"),
    // Terminology labels and role app options written at creation where the organization has none.
    terminology: asObject(input.terminology ?? existing?.terminology),
    role_app_options: asObject(input.role_app_options ?? existing?.role_app_options),
    // Ordered setup steps, each a published action run as the new organization's owner (runSetupSteps).
    setup: (Array.isArray(input.setup ?? existing?.setup) ? (input.setup ?? existing?.setup) as unknown[] : []).map(asObject).filter((step) => cleanText(step.action)),
    // The config library entry this copy was made from (never taken from input): see ensureSeedData.
    library: existing?.library ?? null,
    created_at: existing ? String(existing.created_at) : now,
    updated_at: now
  };
}

export async function createWorkflow(input: JsonObject) {
  const workflow = normalizeWorkflow(input);
  if (await sandboxStore.readWorkflow(String(workflow.id))) {
    throw sandboxError(409, "workflow_exists", `Workflow '${workflow.id}' already exists.`);
  }
  return sandboxStore.saveWorkflow(workflow);
}

export async function updateWorkflow(workflowId: string, patch: JsonObject) {
  const existing = await sandboxStore.readWorkflow(workflowId);
  if (!existing) throw sandboxError(404, "workflow_not_found", `Workflow '${workflowId}' was not found.`);
  return sandboxStore.saveWorkflow(normalizeWorkflow(patch, existing));
}

export async function duplicateWorkflow(workflowId: string, input: JsonObject = {}) {
  const source = await sandboxStore.readWorkflow(workflowId);
  if (!source) throw sandboxError(404, "workflow_not_found", `Workflow '${workflowId}' was not found.`);
  return sandboxStore.saveWorkflow(normalizeWorkflow({
    ...source,
    library: null,
    id: undefined,
    title: cleanText(input.title) || `${source.title} (variant)`,
    variant_of: source.id,
    stages: (Array.isArray(source.stages) ? source.stages : []).map((stage) => ({ ...(stage as JsonObject), id: undefined }))
  }));
}

export async function deleteWorkflow(workflowId: string) {
  const existing = await sandboxStore.readWorkflow(workflowId);
  if (!existing) throw sandboxError(404, "workflow_not_found", `Workflow '${workflowId}' was not found.`);
  await sandboxStore.deleteWorkflow(workflowId);
  return { deleted: workflowId };
}

// ---- Run context -----------------------------------------------------------

export async function resolveWorkflowRunContext(workflowId: string) {
  const workflow = await sandboxStore.readWorkflow(workflowId);
  if (!workflow) throw sandboxError(404, "workflow_not_found", `Workflow '${workflowId}' was not found.`);
  const stages = Array.isArray(workflow.stages) ? (workflow.stages as JsonObject[]) : [];
  const resolvedStages: JsonObject[] = [];
  for (const stage of stages) {
    const page = await sandboxStore.readPage(String(stage.page_id));
    resolvedStages.push({ ...stage, page: page ?? { id: stage.page_id, title: "Missing page", status: "placeholder", role: "setup", implementation: { type: "placeholder" } } });
  }
  // A test instance skips the landing/signup entry pages: it starts at the
  // first stage a freshly-created, already-authenticated org would see.
  let startStage = resolvedStages.findIndex((stage) => {
    const role = String((stage.page as JsonObject).role ?? "setup");
    return role !== "landing" && role !== "signup";
  });
  if (startStage < 0) startStage = 0;
  return { workflow, stages: resolvedStages, start_stage: startStage };
}

// ---- Settings projection ---------------------------------------------------
// Answers "what state is the org in at each point of this workflow?":
// platform flag defaults -> workflow defaults (baseline) -> each stage's page
// effects layered in order. "$user" entries are listed but not folded into
// state (they depend on what the signing-up user picks).

export async function computeSettingsProjection(workflowId: string) {
  const runContext = await resolveWorkflowRunContext(workflowId);
  const workflow = runContext.workflow;
  const defaults = normalizeEffects(workflow.defaults);
  const platformFlagDefaults = (await newOrganizationAppFlagDefaults()) as JsonObject;

  let flags = deepMerge(deepMerge(platformFlagDefaults, groupedFlagOverrides(appFlagBaseOverrides(workflow.app_flags_base))), groupedFlagOverrides(asObject(defaults.app_flags)));
  let scopeFlags = normalizeEffectMap(defaults.scope_flags);
  const settings: JsonObject = {};
  for (const [path, value] of Object.entries(asObject(defaults.settings))) {
    if (value !== USER_CHOICE) setDeepPath(settings, path, value);
  }

  const baseline = {
    workflow_defaults: defaults,
    app_flags: flags,
    scope_flags: JSON.parse(JSON.stringify(scopeFlags)) as JsonObject,
    settings: JSON.parse(JSON.stringify(settings)) as JsonObject
  };

  const stages = [];
  for (const stage of runContext.stages) {
    const page = asObject(stage.page);
    const effects = normalizeEffects(page.effects);
    const userChoices: JsonObject = {};
    for (const [key, value] of Object.entries(asObject(effects.app_flags))) {
      if (value === USER_CHOICE) userChoices[`app_flags.${key}`] = USER_CHOICE;
    }
    for (const [key, value] of Object.entries(asObject(effects.settings))) {
      if (value === USER_CHOICE) userChoices[`settings.${key}`] = USER_CHOICE;
    }
    for (const [key, value] of Object.entries(asObject(effects.scope_flags))) {
      if (value === USER_CHOICE) userChoices[`scope_flags.${key}`] = USER_CHOICE;
    }
    flags = deepMerge(flags, groupedFlagOverrides(asObject(effects.app_flags)));
    scopeFlags = { ...scopeFlags, ...normalizeEffectMap(effects.scope_flags) };
    for (const [path, value] of Object.entries(asObject(effects.settings))) {
      if (value !== USER_CHOICE) setDeepPath(settings, path, value);
    }
    stages.push({
      stage_id: stage.id,
      page_id: page.id,
      page_title: page.title,
      effects,
      user_choices: userChoices,
      state_after: {
        app_flags: JSON.parse(JSON.stringify(flags)) as JsonObject,
        scope_flags: JSON.parse(JSON.stringify(scopeFlags)) as JsonObject,
        settings: JSON.parse(JSON.stringify(settings)) as JsonObject
      }
    });
  }

  return {
    workflow_id: workflow.id,
    workflow_title: workflow.title,
    platform_flag_defaults: platformFlagDefaults,
    baseline,
    stages,
    final_state: { app_flags: flags, scope_flags: scopeFlags, settings }
  };
}

// ---- Test instances --------------------------------------------------------

const TEST_ORG_ADJECTIVES = ["Copper", "Harbor", "Summit", "Cedar", "Granite", "Willow", "Beacon", "Anchor", "Compass", "Lantern", "Meridian", "Pioneer"];
const TEST_ORG_NOUNS = ["Falcon", "Otter", "Heron", "Badger", "Osprey", "Marlin", "Cormorant", "Lynx", "Petrel", "Kestrel", "Walrus", "Puffin"];

function randomFrom<T>(values: readonly T[]): T {
  return values[randomBytes(1).readUInt8(0) % values.length] as T;
}

/** A workflow's terminology labels (`{namespace: {key: label}}`), keeping any label the organization already has. */
async function applyWorkflowTerminology(orgId: string, terminology: JsonObject, branchId = "default") {
  if (!Object.keys(terminology).length) return;
  const { readBranchModule, saveBranchModule } = await import("../platform/storage.js");
  const current = await readBranchModule(orgId, branchId, "variable_mappings").catch(() => null);
  const data = asObject(current?.data);
  const labels = asObject(data.labels) as Record<string, Record<string, string>>;
  const next: Record<string, Record<string, string>> = { ...labels };
  let changed = false;
  for (const [namespace, terms] of Object.entries(terminology)) {
    for (const [key, label] of Object.entries(asObject(terms))) {
      if (next[namespace]?.[key] || !cleanText(label)) continue;
      next[namespace] = { ...(next[namespace] || {}), [key]: cleanText(label) };
      changed = true;
    }
  }
  if (changed) await saveBranchModule(orgId, branchId, "variable_mappings", { data: { ...data, labels: next } }, { replace: false });
}

/** A workflow's app options (`{app id: {option: value}}`) on every active role, keeping anything a role already sets. */
async function applyWorkflowRoleAppOptions(orgId: string, roleAppOptions: JsonObject) {
  if (!Object.keys(roleAppOptions).length) return;
  for (const role of await listAccessRoles(orgId)) {
    if ((role as JsonObject).status === "archived") continue;
    const current = asObject((role as JsonObject).app_defaults) as Record<string, JsonObject>;
    const next: Record<string, JsonObject> = { ...current };
    let changed = false;
    for (const [appId, options] of Object.entries(roleAppOptions)) {
      const setting = asObject(next[appId]);
      const existing = asObject(setting.options);
      const missing = Object.entries(asObject(options)).filter(([key]) => !(key in existing));
      if (!missing.length) continue;
      next[appId] = { ...setting, options: { ...existing, ...Object.fromEntries(missing) } };
      changed = true;
    }
    if (changed) await patchAccessRole(orgId, String((role as JsonObject).id), { expected_revision: (role as JsonObject).revision, app_defaults: next });
  }
}

/**
 * A workflow's setup steps, in order: each names a published action and its input, and runs as the new
 * organization's owner (the person the sandbox made). A step limited to other data environments is skipped; one that
 * fails stops creation unless it says `on_error: "continue"`.
 */
async function runSetupSteps(workflow: JsonObject, orgId: string, instanceId: string, owner: PlatformAuthContext) {
  const steps = (Array.isArray(workflow.setup) ? workflow.setup : []).map(asObject);
  if (!steps.length) return;
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  const { invokeAction } = await import("../platform/publication/actions.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  initializePublication();
  for (const [index, step] of steps.entries()) {
    const action = cleanText(step.action);
    const environments = Array.isArray(step.data_environments) ? step.data_environments.map(String) : null;
    if (!action || (environments && !environments.includes(env.dataEnvironment))) continue;
    try {
      await invokeAction(userPublicationContext(owner, { mode: "command" }), { action, ...(cleanText(step.version) ? { version: cleanText(step.version) } : {}), target: { scope: "organization", organizationId: orgId } }, asObject(step.input), { idempotencyKey: `signup-sandbox:${instanceId}:${index}:${action}` });
    } catch (error) {
      if (step.on_error !== "continue") throw error;
      console.error(`Sandbox setup step ${action} did not finish:`, error instanceof Error ? error.message : error);
    }
  }
}

export async function createTestInstance(workflowId: string, input: JsonObject = {}) {
  const password = gatedAccounts() ? randomBytes(24).toString("base64url") : SANDBOX_TEST_PASSWORD;
  const runContext = await resolveWorkflowRunContext(workflowId);
  const instanceId = generateSandboxId("sbi");
  const suffix = randomBytes(3).toString("hex");
  const orgName = cleanText(input.label) || `${randomFrom(TEST_ORG_ADJECTIVES)} ${randomFrom(TEST_ORG_NOUNS)} Test Co ${suffix}`;
  const email = `sandbox-${suffix}-${randomBytes(3).toString("hex")}@signup-sandbox.test`;

  // Start from the same defaults as real registration, then the workflow's flag base, then overlay the
  // workflow's declared default state (flags + settings). Nothing here depends on which workflow it is.
  const workflowDefaults = normalizeEffects(runContext.workflow.defaults);
  const defaultAppFlags = (await newOrganizationAppFlagDefaults()) as JsonObject;
  const baseFlags = deepMerge(defaultAppFlags, groupedFlagOverrides(appFlagBaseOverrides(runContext.workflow.app_flags_base)));
  const globalData: JsonObject = {
    app_flags: deepMerge(baseFlags, groupedFlagOverrides(asObject(workflowDefaults.app_flags))),
    ...(env.dataEnvironment==='development'?{communications_development:{enabled:true,onboarding:'pending'},app_groups:{communications:{default:'inbox',members:{center:'standalone'}}}}:{}),
    credits_balance: 0,
    credits_ledger: [],
    billing: {
      auto_topup: { enabled: false, threshold_dollars: 50, topup_dollars: 100, status: "idle" },
      stripe: { has_payment_method: false },
      events: []
    },
    branding: { colors: { primary: "#d93025", secondary: "#202124", accent: "#1a73e8" } },
    report_settings: {}
  };
  for (const [path, value] of Object.entries(asObject(workflowDefaults.settings))) {
    if (value !== USER_CHOICE) setDeepPath(globalData, path, value);
  }
  // A workflow may name the apps it offers (settings.app_offers); they are written after the demo content is seeded.
  const workflowOffers = Array.isArray(globalData.app_offers) ? offeredAppIds(globalData.app_offers) : null;
  delete globalData.app_offers;
  const organization = await createOrganization({
    name: orgName,
    metadata: {
      sandbox_test_org: true,
      sandbox_instance_id: instanceId,
      sandbox_workflow_id: workflowId
    },
    global: globalData
  });
  const literalScopeFlags = Object.fromEntries(Object.entries(asObject(workflowDefaults.scope_flags))
    .filter(([, value]) => typeof value === "boolean"));
  if (Object.keys(literalScopeFlags).length) {
    const scopeState = (await readScopeFlagState(String(organization.id)));
    (await patchScopeFlags(String(organization.id), {
      expected_revision: scopeState.revision,
      flags: literalScopeFlags
    }));
  }
  const identity = await createIdentity({
    email,
    password_hash: await hashPassword(password),
    password_algo: "bcrypt",
    name: "Sandbox Tester",
    metadata: {
      email_verified: true,
      sandbox_test_org: true,
      sandbox_instance_id: instanceId
    }
  });
  const userId = `user_${String(identity.id).replace(/^identity_/, "")}`;
  const user = await upsertDocument(String(organization.id), "users", {
    id: userId,
    data: {
      identity_id: identity.id,
      email,
      name: "Sandbox Tester",
      phone: "",
      role: "owner",
      roles: ["sales_appointments", "inside_sales"],
      status: "active",
      permissions: { "*": true },
      ...organizationUserProfileFields({}, { includeDefaults: true }),
      // The owner has the Super admin role, as a real signup's owner does (by its "owner" role); an empty role list
      // would leave them out of every role's app options, such as My Projects opening on the map.
      access_role_ids: [DEFAULT_ACCESS_ROLE_IDS.super_admin],
      profile: {},
      stats: { projects_ordered: 0, commissions_earned: 0 },
      metadata: {}
    },
    metadata: { kind: "organization_user", identity_id: identity.id }
  }, { replace: true });
  await addIdentityMembership(String(identity.id), String(organization.id), String(user.id), "owner");

  const ctx = await loginPlatformIdentity({
    email,
    password,
    organizationId: String(organization.id),
    metadata: { source: "signup_sandbox_instance", sandbox_instance_id: instanceId }
  });

  // The workflow's terminology and role app options (never over what is already set), then its setup steps.
  await applyWorkflowTerminology(String(organization.id), asObject(runContext.workflow.terminology));
  await applyWorkflowRoleAppOptions(String(organization.id), asObject(runContext.workflow.role_app_options));
  await runSetupSteps(runContext.workflow, String(organization.id), instanceId, ctx);

  const testOrg = await sandboxStore.saveTestOrg({
    schema_version: sandboxStore.schemaVersion,
    kind: "signup_sandbox_test_org",
    id: instanceId,
    org_id: organization.id,
    org_name: orgName,
    identity_id: identity.id,
    email,
    password,
    workflow_id: workflowId,
    workflow_title: runContext.workflow.title,
    created_at: nowIso()
  });
  // The workflow's launch sample data, the same as "Add sample data" afterwards (development data only).
  const launchSamples = (Array.isArray(runContext.workflow.launch_sample_data) ? runContext.workflow.launch_sample_data : []).map(String).filter((kind) => SAMPLE_DATA_KINDS.includes(kind));
  if (!env.isProduction && runContext.workflow.sample_data === true && launchSamples.length) {
    try {
      await (await import("./sample-data.js")).addTestOrgSampleData(instanceId, Object.fromEntries(launchSamples.map((kind) => [kind, true])));
    } catch (error) {
      console.error("Test org launch sample data was not added:", error instanceof Error ? error.message : error);
    }
  }

  // Land directly on the real surface of the first actionable stage (the
  // actual portal wizard for builtin steps); the injected dev bar takes over
  // navigation from there. A workflow whose only stages are entry pages
  // (landing/signup) is "instant": the created org IS the finished signup,
  // so land straight in the portal.
  const startStage = runContext.stages[runContext.start_stage] as JsonObject | undefined;
  const startRole = String(asObject(asObject(startStage).page).role ?? "setup");
  const redirect = !startStage
    ? "/portal/?onboarding=1"
    : (startRole === "landing" || startRole === "signup")
      ? "/portal/"
      : stageSurfaceUrl(cleanText(runContext.workflow.onboarding_mode), startStage, runContext.start_stage);
  // Seed demo content before offers mask the operational apps; viewing a tab never consumes an offer.
  await saveGlobal(String(organization.id), { data: { app_offers: [...(workflowOffers ?? NEW_ORGANIZATION_APP_OFFERS)] } });
  // The dev console restores this starting state in one click (docs/architecture/config-library.md, "Test organizations").
  await (await import("../config-library/initial-state.js")).captureInitialState(String(organization.id), "created");
  const { buildAuthContext } = await import('../platform/auth.js');
  return { testOrg, authContext: await buildAuthContext(ctx.sessionId, ctx.session), redirect };
}

// Applies a stage's declared literal effects to a test org's global doc, so a
// run through placeholder pages still leaves the org in the intended state.
// "$user" entries are skipped (no page UI exists yet to collect them).
export async function applyStageEffects(instanceId: string, stageId: string) {
  const record = await sandboxStore.readTestOrg(instanceId);
  if (!record) throw sandboxError(404, "test_org_not_found", `Test org '${instanceId}' was not found.`);
  const runContext = await resolveWorkflowRunContext(String(record.workflow_id));
  const stage = runContext.stages.find((entry) => String(entry.id) === stageId);
  if (!stage) throw sandboxError(404, "stage_not_found", `Stage '${stageId}' was not found in workflow '${record.workflow_id}'.`);
  const effects = normalizeEffects(asObject(stage.page).effects);
  const flagOverrides = groupedFlagOverrides(asObject(effects.app_flags));
  const settingEntries = Object.entries(asObject(effects.settings)).filter(([, value]) => value !== USER_CHOICE);
  const scopeFlagEntries = Object.entries(asObject(effects.scope_flags)).filter(([, value]) => typeof value === "boolean");
  if (!Object.keys(flagOverrides).length && !settingEntries.length && !scopeFlagEntries.length) {
    return { applied: false, app_flags: {}, settings: {}, scope_flags: {} };
  }

  const orgId = String(record.org_id);
  const current = await readGlobal(orgId);
  const data = asObject(current.data);
  const patch: JsonObject = {};
  if (Object.keys(flagOverrides).length) {
    patch.app_flags = deepMerge(asObject(data.app_flags), flagOverrides);
  }
  for (const [path, value] of settingEntries) {
    // saveGlobal merges shallowly at the top level, so carry the full current
    // top-level object for any path we touch before deep-setting into it.
    const topKey = path.split(".")[0] as string;
    if (patch[topKey] === undefined) {
      const existingValue = data[topKey];
      patch[topKey] = existingValue && typeof existingValue === "object" && !Array.isArray(existingValue)
        ? JSON.parse(JSON.stringify(existingValue))
        : existingValue;
    }
    setDeepPath(patch, path, value);
  }
  await saveGlobal(orgId, { data: patch });
  if (scopeFlagEntries.length) {
    const scopeState = (await readScopeFlagState(orgId));
    (await patchScopeFlags(orgId, {
      expected_revision: scopeState.revision,
      flags: Object.fromEntries(scopeFlagEntries)
    }));
  }
  return {
    applied: true,
    app_flags: flagOverrides,
    settings: Object.fromEntries(settingEntries),
    scope_flags: Object.fromEntries(scopeFlagEntries)
  };
}

// The surface a stage lives on. Every stage runs in the real app: builtin
// wizard steps in the portal wizard, landing/signup on their real pages, and
// placeholder/bundle pages as a dev-bar overlay inside the portal
// (?sbx_stage=<index>) — there is no separate runner surface.
function stageSurfaceUrl(onboardingMode: string, stage: JsonObject, index: number) {
  const page = asObject(stage.page);
  const implementation = asObject(page.implementation);
  const implType = String(implementation.type);
  const role = String(page.role ?? "setup");
  if (implType === "builtin_wizard" && role === "setup") {
    // sbx_step lets the dev bar jump the wizard to this step after a
    // cross-surface navigation; same-page clicks call goToPage directly.
    const ref = cleanText(implementation.builtin_ref) || "branding";
    const productMode = onboardingMode ? `&onboardingMode=${encodeURIComponent(onboardingMode)}` : "";
    return `/portal/?onboarding=1&sbx_step=${encodeURIComponent(ref)}${productMode}`;
  }
  if (implType === "landing_embed") {
    const variant = cleanText(implementation.builtin_ref) || "measurements";
    return `/portal/landing/?variant=${encodeURIComponent(variant)}`;
  }
  if (role === "signup") {
    return "/portal/login.php";
  }
  return `/portal/?sbx_stage=${index}`;
}

// Full state for the injected dev bar: the workflow, per-stage jump targets,
// what's completed, and whether the real wizard has finished.
export async function instanceRunState(instanceId: string) {
  const record = await sandboxStore.readTestOrg(instanceId);
  if (!record) throw sandboxError(404, "test_org_not_found", `Test org '${instanceId}' was not found.`);
  const workflowId = String(record.workflow_id);
  const runContext = await resolveWorkflowRunContext(workflowId);
  let onboardingCompleted = false;
  try {
    const global = await readGlobal(String(record.org_id));
    onboardingCompleted = Boolean(asObject(global.data).onboarding_completed);
  } catch {
    // Org may have been deleted out from under the registry; the bar just
    // shows nothing as completed.
  }
  const stages = runContext.stages.map((stage, index) => ({
    ...stage,
    target: stageSurfaceUrl(cleanText(runContext.workflow.onboarding_mode), stage as JsonObject, index)
  }));
  return {
    test_org: record,
    workflow: runContext.workflow,
    stages,
    start_stage: runContext.start_stage,
    completed_stage_ids: Array.isArray(record.completed_stage_ids) ? record.completed_stage_ids : [],
    onboarding_completed: onboardingCompleted
  };
}

export async function findInstanceByOrg(orgId: string) {
  const records = await sandboxStore.listTestOrgs();
  return records.find((record) => String(record.org_id) === orgId) ?? null;
}

// Marks a stage done on the instance record and, for placeholder pages,
// applies its declared literal effects to the test org.
export async function completeStage(instanceId: string, stageId: string, input: JsonObject = {}) {
  const record = await sandboxStore.readTestOrg(instanceId);
  if (!record) throw sandboxError(404, "test_org_not_found", `Test org '${instanceId}' was not found.`);
  const runContext = await resolveWorkflowRunContext(String(record.workflow_id));
  const stage = runContext.stages.find((entry) => String(entry.id) === stageId);
  if (!stage) throw sandboxError(404, "stage_not_found", `Stage '${stageId}' was not found in workflow '${record.workflow_id}'.`);
  const completed = new Set((Array.isArray(record.completed_stage_ids) ? record.completed_stage_ids : []).map(String));
  completed.add(stageId);
  const stageInputs = asObject(record.stage_inputs);
  if (Object.keys(input).length) stageInputs[stageId] = input;
  await sandboxStore.saveTestOrg({ ...record, completed_stage_ids: [...completed], stage_inputs: stageInputs });
  const page = asObject((stage as JsonObject).page);
  let applied: JsonObject = { applied: false };
  if (String(asObject(page.implementation).type) === "placeholder") {
    applied = await applyStageEffects(instanceId, stageId) as JsonObject;
  }
  const declared = normalizeEffects(page.effects);
  const requestedFlags = asObject(input.app_flags);
  const requestedSettings = asObject(input.settings);
  const chosenFlags: JsonObject = {};
  const chosenSettings: JsonObject = {};
  for (const [key, value] of Object.entries(requestedFlags)) {
    if (asObject(declared.app_flags)[key] === USER_CHOICE) chosenFlags[key] = value;
  }
  for (const [key, value] of Object.entries(requestedSettings)) {
    if (asObject(declared.settings)[key] === USER_CHOICE) chosenSettings[key] = value;
  }
  if (Object.keys(chosenFlags).length || Object.keys(chosenSettings).length) {
    const orgId = String(record.org_id);
    const current = await readGlobal(orgId);
    const data = asObject(current.data);
    const patch: JsonObject = {};
    if (Object.keys(chosenFlags).length) {
      patch.app_flags = deepMerge(asObject(data.app_flags), groupedFlagOverrides(chosenFlags));
    }
    for (const [settingPath, value] of Object.entries(chosenSettings)) {
      const topKey = settingPath.split(".")[0] as string;
      if (patch[topKey] === undefined) {
        const existingValue = data[topKey];
        patch[topKey] = existingValue && typeof existingValue === "object" && !Array.isArray(existingValue)
          ? JSON.parse(JSON.stringify(existingValue))
          : existingValue;
      }
      setDeepPath(patch, settingPath, value);
    }
    await saveGlobal(orgId, { data: patch });
    applied = { applied: true, app_flags: groupedFlagOverrides(chosenFlags), settings: chosenSettings };
  }
  return { completed_stage_ids: [...completed], effects: applied, stage_input: input };
}

export async function deleteTestOrg(instanceId: string) {
  const record = await sandboxStore.readTestOrg(instanceId);
  if (!record) throw sandboxError(404, "test_org_not_found", `Test org '${instanceId}' was not found.`);
  const users = await listDocuments(String(record.org_id), "users");
  const sandboxIdentityIds: string[] = [];
  for (const user of users) {
    const identityId = cleanText(asObject(user.data).identity_id);
    if (!identityId || identityId === String(record.identity_id)) continue;
    const identity = await readIdentity(identityId).catch(() => null);
    if (identity && asObject(identity.metadata).sandbox_instance_id === instanceId) sandboxIdentityIds.push(identityId);
  }
  await removePlatformOrgData({
    orgId: String(record.org_id),
    identityId: String(record.identity_id),
    email: String(record.email)
  });
  for (const identityId of sandboxIdentityIds) {
    await deleteIdentitySessions(identityId);
    await deleteIdentity(identityId);
  }
  await sandboxStore.deleteTestOrg(instanceId);
  return { deleted: instanceId, org_id: record.org_id };
}

async function testOrgRecord(instanceId: string) {
  const record = await sandboxStore.readTestOrg(instanceId);
  if (!record) throw sandboxError(404, "test_org_not_found", "Test organization not found.");
  return record;
}

export async function listTestOrgUsers(instanceId: string) {
  const record = await testOrgRecord(instanceId);
  const documents = await listDocuments(String(record.org_id), "users");
  return documents.map((document) => {
    const data = asObject(document.data);
    return {
      id: document.id,
      name: data.name,
      email: data.email,
      role: data.role,
      status: data.status,
      permissions: asObject(data.permissions)
    };
  });
}

export async function addTestOrgUser(instanceId: string, input: JsonObject) {
  const record = await testOrgRecord(instanceId);
  const name = cleanText(input.name);
  const email = cleanText(input.email).toLowerCase();
  const role = cleanText(input.role || "custom").toLowerCase();
  if (!name || name.length > 120) throw sandboxError(400, "invalid_name", "Enter a name of up to 120 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw sandboxError(400, "invalid_email", "Enter a valid email address.");
  if (!["viewer", "manager", "admin", "custom"].includes(role)) throw sandboxError(400, "invalid_role", "Choose a valid role.");
  const permissions = asObject(input.permissions);
  if (Object.keys(permissions).length > 100 || Object.entries(permissions).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_.:-]{0,100}$/.test(key) || typeof value !== "boolean")) {
    throw sandboxError(400, "invalid_permissions", "Permissions must be a map of permission names to booleans.");
  }
  const identity = await createIdentity({
    email,
    name,
    password_hash: await hashPassword(randomBytes(24).toString("base64url")),
    password_algo: "bcrypt",
    metadata: { email_verified: true, sandbox_test_org: true, sandbox_instance_id: instanceId }
  });
  const userId = `user_${String(identity.id).replace(/^identity_/, "")}`;
  const orgId = String(record.org_id);
  const user = await upsertDocument(orgId, "users", {
    id: userId,
    data: {
      identity_id: identity.id, email, name, phone: "", role,
      org_permissions: { level: role, items: permissions },
      org_permission_level: role, permissions, status: "active",
      roles: [], account_type: "customer", team_id: "default", branch_id: "default",
      ...organizationUserProfileFields({}, { includeDefaults: true }),
      profile: {}, stats: {}, metadata: { sandbox_test_org: true }
    },
    metadata: { kind: "organization_user", identity_id: identity.id, source: "signup_sandbox" }
  }, { replace: true });
  await addIdentityMembership(String(identity.id), orgId, String(user.id), role);
  return { id: user.id, name, email, role, status: "active", permissions };
}

export async function loginAsTestOrgUser(instanceId: string, userId: string) {
  const record = await testOrgRecord(instanceId);
  const orgId = String(record.org_id);
  const document = await readDocument(orgId, "users", sanitizeSandboxId(userId, "user id"));
  const identityId = cleanText(asObject(document.data).identity_id);
  if (!identityId) throw sandboxError(400, "user_identity_missing", "This user has no login identity.");
  const identity = await readIdentity(identityId);
  const memberships = await listIdentityMemberships(identityId);
  if (!memberships.some((entry) => String(asObject(entry.organization).id) === orgId && String(asObject(entry.user).id) === userId)) {
    throw sandboxError(403, "user_membership_missing", "This user does not belong to this test organization.");
  }
  return loginPlatformVerifiedIdentity({ identity, organizationId: orgId, metadata: { source: "signup_sandbox_admin_jump", sandbox_instance_id: instanceId } });
}

// ---- Export / import -------------------------------------------------------

export async function exportWorkflowBundle(workflowId: string) {
  const workflow = await sandboxStore.readWorkflow(workflowId);
  if (!workflow) throw sandboxError(404, "workflow_not_found", `Workflow '${workflowId}' was not found.`);
  const pageIds = [...new Set((Array.isArray(workflow.stages) ? (workflow.stages as JsonObject[]) : []).map((stage) => String(stage.page_id)))];
  const pages = [];
  for (const pageId of pageIds) {
    const page = await sandboxStore.readPage(pageId);
    if (page) pages.push(page);
  }
  return {
    schema_version: sandboxStore.schemaVersion,
    kind: "signup_sandbox_bundle",
    exported_at: nowIso(),
    workflows: [workflow],
    pages
  };
}

export async function exportLibraryBundle() {
  return {
    schema_version: sandboxStore.schemaVersion,
    kind: "signup_sandbox_bundle",
    exported_at: nowIso(),
    workflows: await sandboxStore.listWorkflows(),
    pages: await sandboxStore.listPages()
  };
}

export async function importBundle(bundle: JsonObject, options: { overwrite?: boolean } = {}) {
  if (bundle.kind !== "signup_sandbox_bundle") {
    throw sandboxError(400, "invalid_bundle", "Expected a signup_sandbox_bundle document.");
  }
  const summary = { pages_imported: 0, pages_skipped: 0, workflows_imported: 0, workflows_skipped: 0 };
  for (const pageInput of Array.isArray(bundle.pages) ? (bundle.pages as JsonObject[]) : []) {
    const existing = await sandboxStore.readPage(sanitizeSandboxId(pageInput.id, "page id"));
    if (existing && !options.overwrite) {
      summary.pages_skipped += 1;
      continue;
    }
    await sandboxStore.savePage(normalizePage(pageInput, existing));
    summary.pages_imported += 1;
  }
  for (const workflowInput of Array.isArray(bundle.workflows) ? (bundle.workflows as JsonObject[]) : []) {
    const existing = await sandboxStore.readWorkflow(sanitizeSandboxId(workflowInput.id, "workflow id"));
    if (existing && !options.overwrite) {
      summary.workflows_skipped += 1;
      continue;
    }
    await sandboxStore.saveWorkflow(normalizeWorkflow(workflowInput, existing));
    summary.workflows_imported += 1;
  }
  return summary;
}

// ---- Seed pages: the signup pages workflows name --------------------------
// Stable ids so the same seed on two machines produces identical, syncable docs.

const SEED_PAGES: JsonObject[] = [
  {
    id: "spg_firstmate_landing",
    title: "FirstMate marketing landing",
    role: "landing",
    status: "builtin",
    implementation: { type: "landing_embed", builtin_ref: "measurements" },
    brief: "Existing landing-page system (public/portal/landing) with the embedded signup widget. Optional front step; test instances skip it."
  },
  {
    id: "spg_firstmate_signup",
    title: "Account signup (email + password + company)",
    role: "signup",
    status: "builtin",
    implementation: { type: "builtin_wizard", builtin_ref: "register" },
    brief: "The existing register step (login.php / signup-widget.js -> auth/legacy-action register). Test instances skip it: the sandbox creates the org and session for you."
  },
  {
    id: "spg_firstmate_branding",
    title: "Branding: website, logo, colors",
    role: "setup",
    status: "builtin",
    implementation: { type: "builtin_wizard", builtin_ref: "branding" },
    brief: "Existing onboarding wizard page 'branding' (public/libraries/apps/onboarding/wizard.js).",
    effects: {
      settings: {
        "branding.colors.primary": "$user",
        "branding.colors.secondary": "$user",
        "branding.colors.accent": "$user",
        "branding.logo": "$user",
        "website_url": "$user"
      }
    }
  },
  {
    id: "spg_firstmate_users",
    title: "Team members & permissions",
    role: "setup",
    status: "builtin",
    implementation: { type: "builtin_wizard", builtin_ref: "users" },
    brief: "Existing onboarding wizard page 'users'."
  },
  {
    id: "spg_firstmate_account_load",
    title: "Credits top-up + bonus offer + checkout",
    role: "setup",
    status: "builtin",
    implementation: { type: "builtin_wizard", builtin_ref: "account_load" },
    brief: "Existing onboarding wizard page 'account_load' (bonus offer depends on acquisition attribution).",
    effects: {
      settings: {
        "credits_balance": "$user",
        "billing.auto_topup.enabled": "$user",
        "billing.stripe.has_payment_method": "$user"
      }
    }
  },
  {
    id: "spg_channels_team",
    title: "Bring your team",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_channels_team/page.js" },
    brief: "Collect teammate invitations and a simple workspace role for each person.",
    effects: { settings: { "channels_onboarding.invites": "$user" } },
    tags: ["channels", "channels-only"]
  },
  {
    id: "spg_channels_structure",
    title: "Create your first channels",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_channels_structure/page.js" },
    brief: "Suggest a small starter channel set and let the owner add, rename, and choose public/private channels.",
    effects: { settings: { "channels_onboarding.starter_channels": "$user" } },
    tags: ["channels", "channels-only"]
  },
  {
    id: "spg_channels_preferences",
    title: "Set collaboration defaults",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_channels_preferences/page.js" },
    brief: "Choose notification, AI, huddle recording, and external guest policies with plain-language explanations.",
    effects: {
      app_flags: {
        "channels.ai": "$user",
        "channels.recording": "$user",
        "channels.record_video": "$user",
        "channels.external": "$user"
      },
      settings: {
        "channels_onboarding.default_notify_level": "$user",
        "channels_onboarding.send_mode": "$user"
      }
    },
    tags: ["channels", "channels-only"]
  },
  {
    id: "spg_channels_launch",
    title: "Your workspace is ready",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_channels_launch/page.js" },
    brief: "A concise completion page that reinforces the Channels-only product and launches into the app.",
    effects: { settings: { "channels_onboarding.completed": "$user" } },
    tags: ["channels", "channels-only"]
  },
  {
    id: "spg_home_improvement_services",
    title: "Choose your services",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_home_improvement_services/page.js" },
    brief: "Let a home improvement company select every service it provides. Show common exterior services first and offer a searchable, much larger catalog for other specialties. Every choice is a toggle button, never a checkbox.",
    effects: { settings: { "home_improvement_setup.services": "$user" } },
    tags: ["home-improvement", "company-profile"]
  },
  {
    id: "spg_home_improvement_work_types",
    title: "Choose the work you do",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_home_improvement_work_types/page.js" },
    brief: "Ask whether the company primarily performs full replacements, repairs, and/or ongoing maintenance. Allow any combination using large toggle buttons, never checkboxes.",
    effects: { settings: { "home_improvement_setup.work_types": "$user" } },
    tags: ["home-improvement", "company-profile"]
  },
  {
    id: "spg_roofing_profile",
    title: "Company profile & job types",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_profile/page.js" },
    brief: "Roofing company profile: exterior services offered (roofing preselected), the job types the company runs (retail replacement, insurance restoration, repairs, maintenance plans — these drive the per-job-type setup tabs later), and team size excluding crews.",
    effects: {
      settings: {
        "roofing_setup.services": "$user",
        "roofing_setup.job_types": "$user",
        "roofing_setup.team_size": "$user"
      }
    },
    tags: ["roofing", "company-profile"]
  },
  {
    id: "spg_roofing_lead_intake",
    title: "Lead sources & first contact",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_lead_intake/page.js" },
    brief: "Where leads come from, how the company first reaches out (phone/text/email — text discloses the SMS add-on), and optional lead-import inbox + website lead form. The inbox is set up automatically; the web form can't be (it must be embedded on their site), so enabling it adds a post-setup step with the embed code.",
    effects: { settings: { "roofing_setup.lead_intake": "$user" } },
    tags: ["roofing", "sales"]
  },
  {
    id: "spg_roofing_sales_workflows",
    title: "Sales workflow by job type",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_sales_workflows/page.js" },
    brief: "One guided workflow per selected job type. Each workflow covers new-lead handling, follow-up, bid timing, the appointment checklist, payment terms, and a job-specific contract/proposal choice. Recommended documents adapt to replacements, insurance restoration, repairs, or maintenance; users can upload their own or explicitly use no contract. Includes the 'describe it instead' AI setup-agent entry point (stub).",
    effects: { settings: { "roofing_setup.sales_workflows": "$user" } },
    tags: ["roofing", "sales"]
  },
  {
    id: "spg_roofing_proposal_doc",
    title: "Proposal & contract documents",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_proposal_doc/page.js" },
    brief: "Upload the company's current proposal for the AI agent to rebuild, or pick a FirstMate template (classic, good-better-best, insurance packet) from a list with a visual preview panel on the right. Contract terms are optional and accept any file format or typed-in text.",
    effects: { settings: { "roofing_setup.proposal_document": "$user" } },
    tags: ["roofing", "documents"]
  },
  {
    id: "spg_roofing_schedules_commissions",
    title: "Sales appointments",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_schedules_commissions/page.js" },
    brief: "Sales-appointment availability and duration. The page is skipped automatically when the configured sales workflows do not use sales appointments. Advanced availability supports different hours per day and recurring blocked times.",
    effects: { settings: { "roofing_setup.schedules": "$user" } },
    tags: ["roofing", "sales"]
  },
  {
    id: "spg_roofing_commissions",
    title: "Commissions by job type",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_commissions/page.js" },
    brief: "A separate commission plan for each selected job type, with same-as shortcuts. Supports percentage of contract, percentage of gross profit, flat per-job amounts, custom commission line items, and optional self-generated lead overrides. Per-square commission is intentionally excluded.",
    effects: { settings: { "roofing_setup.commissions": "$user" } },
    tags: ["roofing", "sales", "payroll"]
  },
  {
    id: "spg_roofing_production",
    title: "Production lifecycle & crews",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_production/page.js" },
    brief: "Per-job-type production to-do templates (prefilled from FirstMate's roofing presets, editable) plus the crew model: employees vs subs and how crews are paid.",
    effects: { settings: { "roofing_setup.production": "$user" } },
    tags: ["roofing", "production"]
  },
  {
    id: "spg_roofing_team",
    title: "Build your team",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_team/page.js" },
    brief: "Office users, salespeople (with the 'what do you call them' terminology pick), field staff, and crews. Solo-friendly: a 'just me for now' path skips everything. Invites send at finish.",
    effects: { settings: { "roofing_setup.team": "$user" } },
    tags: ["roofing", "team"]
  },
  {
    id: "spg_roofing_summary",
    title: "Review your setup",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_summary/page.js" },
    brief: "Read-back of everything configured (from stage inputs), the automatic sending identity (company@firstmatemail.com), and the SMS add-on recap (counts SMS steps configured; they send by email until the add-on is enabled).",
    effects: { settings: { "roofing_setup.completed": "$user" } },
    tags: ["roofing", "summary"]
  },
  {
    id: "spg_roofing_import",
    title: "Bring your data",
    role: "setup",
    status: "implemented",
    implementation: { type: "bundle", bundle: "pages/spg_roofing_import/page.js" },
    brief: "The 'one more thing' finale: import contacts from a CSV (client-side header parse + count preview) and optionally list active jobs to recreate. Skippable.",
    effects: { settings: { "roofing_setup.import": "$user" } },
    tags: ["roofing", "import"]
  }
];

// ---- Seed: workflows from the config library -------------------------------
// Every signup sandbox configuration is a config library entry (kind sandbox_configuration,
// docs/architecture/config-library.md). Its saved workflow is a copy that records the entry it came from
// (`library`: kind, id, revision, sha256 and the hash of what was written). A newer library revision replaces a copy
// nobody edited; a copy edited in the sandbox stays as it is until it is reset to the library.

const SANDBOX_CONFIGURATION_KIND = "sandbox_configuration";
/** The fields of a saved workflow that come from its library entry. */
const CONFIGURATION_FIELDS = ["title", "description", "entry_mode", "onboarding_mode", "stages", "tags", "sample_data", "launch_sample_data", "dev_bar", "app_flags_base", "defaults", "terminology", "role_app_options", "setup"] as const;

function configurationContent(workflow: JsonObject) {
  return contentHash(Object.fromEntries(CONFIGURATION_FIELDS.map((field) => [field, workflow[field] ?? null])) as never);
}

function workflowFromEntry(entry: LibraryEntry<SandboxConfigurationData>, existing: JsonObject | null) {
  // Every configuration field is in the parsed entry, so it replaces the saved one; id and created_at are kept.
  const workflow = normalizeWorkflow({ ...structuredClone(entry.data), id: entry.id }, existing);
  workflow.library = { ...libraryStamp(entry as unknown as LibraryEntry), copy_sha256: configurationContent(workflow) };
  return workflow;
}

/** How a saved workflow stands against its library entry: missing, library, behind (untouched, older) or changed. */
export function workflowLibraryState(workflow: JsonObject | null, entry: LibraryEntry<SandboxConfigurationData>) {
  if (!workflow) return "missing" as const;
  const library = asObject(workflow.library);
  if (!library.copy_sha256 || library.copy_sha256 !== configurationContent(workflow)) return "changed" as const;
  return Number(library.revision) === entry.revision && library.sha256 === entry.sha256 ? "library" as const : "behind" as const;
}

/** Every library configuration's saved workflow and how it stands. */
export async function libraryWorkflowStatus() {
  const rows = [];
  for (const entry of libraryEntries<SandboxConfigurationData>(SANDBOX_CONFIGURATION_KIND)) {
    const workflow = await sandboxStore.readWorkflow(entry.id);
    rows.push({ id: entry.id, state: workflowLibraryState(workflow, entry), library_revision: entry.revision, copy_revision: Number(asObject(workflow?.library).revision) || undefined });
  }
  return rows;
}

/** Puts a saved workflow back to its library entry, discarding edits made in the sandbox. */
export async function resetWorkflowToLibrary(workflowId: string) {
  const entry = libraryEntries<SandboxConfigurationData>(SANDBOX_CONFIGURATION_KIND).find((item) => item.id === workflowId);
  if (!entry) throw sandboxError(404, "workflow_not_in_library", `Workflow '${workflowId}' is not a library configuration.`);
  return sandboxStore.saveWorkflow(workflowFromEntry(entry, await sandboxStore.readWorkflow(workflowId)));
}

export async function ensureSeedData() {
  for (const page of SEED_PAGES) {
    if (!(await sandboxStore.readPage(String(page.id)))) {
      await sandboxStore.savePage(normalizePage(page));
    }
  }
  for (const entry of libraryEntries<SandboxConfigurationData>(SANDBOX_CONFIGURATION_KIND)) {
    const current = await sandboxStore.readWorkflow(entry.id);
    // A copy saved before configurations were library entries (no stamp) is replaced once; one edited since it was
    // made from the library is left as it is.
    const state = current && !current.library ? "behind" : workflowLibraryState(current, entry);
    if (state === "missing" || state === "behind") await sandboxStore.saveWorkflow(workflowFromEntry(entry, current));
  }
  const workflows = await sandboxStore.listWorkflows();
  const legacyBrandingReferenced = workflows.some((workflow) =>
    (Array.isArray(workflow.stages) ? workflow.stages : []).some((stage) => String((stage as JsonObject).page_id) === "spg_channels_brand"));
  if (!legacyBrandingReferenced && await sandboxStore.readPage("spg_channels_brand")) {
    await sandboxStore.deletePage("spg_channels_brand");
  }
}
