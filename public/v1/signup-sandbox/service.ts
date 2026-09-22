import { gatedAccounts } from "./admin.js";
import { randomBytes } from "node:crypto";

import { newOrganizationAppFlagDefaults } from "../platform/app_flags.js";
import { valueCapabilities } from "../platform/capabilities.js";
import {
  hashPassword,
  loginPlatformIdentity
} from "../platform/auth.js";
import {
  addIdentityMembership,
  createIdentity,
  createOrganization,
  readGlobal,
  saveGlobal,
  upsertDocument
} from "../platform/storage.js";
import { organizationUserProfileFields } from "../platform/user_profile.js";
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

function channelsOnlyAppFlags(): JsonObject {
  const enabled = new Set([
    "apps.assistant",
    "apps.channels",
    "channels.threads",
    "channels.reactions",
    "channels.dms",
    "channels.attachments",
    "channels.pins",
    "channels.search",
    "channels.attention_v2",
    "channels.rich_messages",
    "channels.resources",
    "channels.clips",
    "channels.workflows",
    "channels.ai",
    "calls.rooms",
    "channels.huddles",
    "platform.top_bar",
    "platform.cobrand_sidebar_logo",
    "topbar.notifications"
  ]);
  const overrides: JsonObject = {};
  for (const capability of valueCapabilities()) {
    if (capability.type === "boolean") overrides[capability.key] = enabled.has(capability.key);
  }
  overrides["platform.new_button_mode"] = "off";
  overrides["platform.new_button_items"] = "";
  overrides["platform.left_column_apps"] = false;
  overrides["platform.left_column_todo_list"] = false;
  overrides["platform.left_column_default_mode"] = "channels";
  // Channels-only workspaces use the integrated global-sidebar rail. With the
  // Apps and To Do panes disabled above, Channels becomes the left column
  // instead of appearing as a separate full-page app.
  overrides["channels.sidebar_tab"] = true;
  overrides["topbar.global_search"] = false;
  return overrides;
}

// Mirrors the "Full Platform" capability preset: every boolean capability on
// (Money + merchant processing included), selects/numbers at their defaults.
function instantFullOrgAppFlags(): JsonObject {
  const overrides: JsonObject = {};
  for (const capability of valueCapabilities()) {
    if (capability.type === "boolean") overrides[capability.key] = true;
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

  let flags = deepMerge(platformFlagDefaults, groupedFlagOverrides(asObject(defaults.app_flags)));
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

export async function createTestInstance(workflowId: string, input: JsonObject = {}) {
  const password = gatedAccounts() ? randomBytes(24).toString("base64url") : SANDBOX_TEST_PASSWORD;
  const runContext = await resolveWorkflowRunContext(workflowId);
  const instanceId = generateSandboxId("sbi");
  const suffix = randomBytes(3).toString("hex");
  const orgName = cleanText(input.label) || `${randomFrom(TEST_ORG_ADJECTIVES)} ${randomFrom(TEST_ORG_NOUNS)} Test Co ${suffix}`;
  const email = `sandbox-${suffix}-${randomBytes(3).toString("hex")}@signup-sandbox.test`;

  // Start from the same defaults as real registration, then overlay the
  // workflow's declared default state (flags + settings).
  const workflowDefaults = normalizeEffects(runContext.workflow.defaults);
  const defaultAppFlags = (await newOrganizationAppFlagDefaults()) as JsonObject;
  const globalData: JsonObject = {
    app_flags: deepMerge(defaultAppFlags, groupedFlagOverrides(asObject(workflowDefaults.app_flags))),
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
    metadata: { source: "signup_sandbox_instance" }
  });

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
      : stageSurfaceUrl(workflowId, instanceId, startStage, runContext.start_stage);
  return { testOrg, authContext: ctx, redirect };
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
function stageSurfaceUrl(_workflowId: string, _instanceId: string, stage: JsonObject, index: number) {
  const page = asObject(stage.page);
  const implementation = asObject(page.implementation);
  const implType = String(implementation.type);
  const role = String(page.role ?? "setup");
  if (implType === "builtin_wizard" && role === "setup") {
    // sbx_step lets the dev bar jump the wizard to this step after a
    // cross-surface navigation; same-page clicks call goToPage directly.
    const ref = cleanText(implementation.builtin_ref) || "branding";
    const productMode = _workflowId === "swf_channels_only"
      ? "&onboardingMode=channels"
      : _workflowId === "swf_home_improvement"
        ? "&onboardingMode=home_improvement"
        : "";
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
    target: stageSurfaceUrl(workflowId, instanceId, stage as JsonObject, index)
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
  await removePlatformOrgData({
    orgId: String(record.org_id),
    identityId: String(record.identity_id),
    email: String(record.email)
  });
  await sandboxStore.deleteTestOrg(instanceId);
  return { deleted: instanceId, org_id: record.org_id };
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

// ---- Seed: the FirstMate default workflow as a rebuildable template --------
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

const SEED_WORKFLOW: JsonObject = {
  id: "swf_firstmate_default",
  title: "FirstMate default signup",
  description: "The current production FirstMate flow rebuilt as a sandbox workflow: landing -> signup -> branding -> users -> credits/checkout -> enter app.",
  entry_mode: "landing_first",
  stages: [
    { id: "stg_fm_landing", page_id: "spg_firstmate_landing", notes: "Optional marketing front door." },
    { id: "stg_fm_signup", page_id: "spg_firstmate_signup", notes: "Skipped by sandbox test instances." },
    { id: "stg_fm_branding", page_id: "spg_firstmate_branding", notes: "" },
    { id: "stg_fm_users", page_id: "spg_firstmate_users", notes: "Skipped on mobile in the real wizard." },
    { id: "stg_fm_account_load", page_id: "spg_firstmate_account_load", notes: "" }
  ],
  tags: ["template", "firstmate"]
};

const CHANNELS_ONLY_WORKFLOW: JsonObject = {
  id: "swf_channels_only",
  title: "FirstMate Channels-only signup",
  description: "A focused signup for a company buying FirstMate Channels as its complete team workspace. No CRM, projects, app picker, to-do rail, credit purchase, or product-suite language.",
  entry_mode: "signup_first",
  stages: [
    { id: "stg_channels_signup", page_id: "spg_firstmate_signup", notes: "Standard identity and company creation; skipped by sandbox instances." },
    { id: "stg_channels_brand", page_id: "spg_firstmate_branding", notes: "Use the shared production branding experience: website discovery, logo preview/upload, palette extraction, color editing, and live branded previews." },
    { id: "stg_channels_team", page_id: "spg_channels_team", notes: "Invite the first teammates and assign simple workspace roles." },
    { id: "stg_channels_structure", page_id: "spg_channels_structure", notes: "Create a useful starter channel structure." },
    { id: "stg_channels_preferences", page_id: "spg_channels_preferences", notes: "Set company-wide collaboration defaults." },
    { id: "stg_channels_launch", page_id: "spg_channels_launch", notes: "Review and enter Channels." }
  ],
  tags: ["template", "channels", "channels-only"]
};

const HOME_IMPROVEMENT_WORKFLOW: JsonObject = {
  id: "swf_home_improvement",
  title: "Generic home improvement company setup",
  description: "The foundation for a full home improvement company setup: account creation, generic workspace branding, services, and the kinds of work the company performs. Additional setup pages will follow.",
  entry_mode: "signup_first",
  defaults: {
    settings: {
      "home_improvement_setup.template": "generic",
      "home_improvement_setup.completed": false
    }
  },
  stages: [
    { id: "stg_home_improvement_signup", page_id: "spg_firstmate_signup", notes: "Standard identity and company creation; skipped by sandbox instances." },
    { id: "stg_home_improvement_brand", page_id: "spg_firstmate_branding", notes: "Use the shared production branding flow with a lightweight generic workspace preview: branded left rail, general interface styling, and a sample modal." },
    { id: "stg_home_improvement_services", page_id: "spg_home_improvement_services", notes: "Select common services or search a broader home improvement catalog." },
    { id: "stg_home_improvement_work_types", page_id: "spg_home_improvement_work_types", notes: "Select any combination of replacement, repair, and ongoing maintenance work." }
  ],
  tags: ["template", "home-improvement", "full-company"]
};

const ROOFING_WORKFLOW: JsonObject = {
  id: "swf_roofing_company",
  title: "Roofing company setup",
  description: "Full setup draft for a roofing/exteriors company that sells retail replacements, works insurance claims, and runs repairs and maintenance: profile, lead intake, per-job-type sales workflows with job-specific contracts and payment terms, schedules & commissions, production templates, team, summary, and a data-import finale.",
  entry_mode: "signup_first",
  defaults: {
    settings: {
      "roofing_setup.template": "roofing",
      "roofing_setup.completed": false
    }
  },
  stages: [
    { id: "stg_roofing_signup", page_id: "spg_firstmate_signup", notes: "Standard identity and company creation; skipped by sandbox instances." },
    { id: "stg_roofing_brand", page_id: "spg_firstmate_branding", notes: "Shared production branding flow: website discovery, logo, palette, live previews." },
    { id: "stg_roofing_profile", page_id: "spg_roofing_profile", notes: "Services, job types (drives the sales-workflow tabs), team size." },
    { id: "stg_roofing_lead_intake", page_id: "spg_roofing_lead_intake", notes: "Lead sources, first-contact method, optional lead inbox + web form." },
    { id: "stg_roofing_sales_workflows", page_id: "spg_roofing_sales_workflows", notes: "Guided per-job-type sales setup: contact strategy, follow-up cycle, bid timing, checklist, payment terms, and job-specific contract/proposal." },
    { id: "stg_roofing_sales_appointments", page_id: "spg_roofing_schedules_commissions", notes: "Conditional sales-appointment availability, duration, per-day hours, and recurring blocked times." },
    { id: "stg_roofing_commissions", page_id: "spg_roofing_commissions", notes: "Per-job-type commission plans with same-as shortcuts, custom line items, and optional self-generated rules." },
    { id: "stg_roofing_production", page_id: "spg_roofing_production", notes: "Per-job-type production to-do templates + crew payment model." },
    { id: "stg_roofing_team", page_id: "spg_roofing_team", notes: "Office, sales, field, crews; skippable for solo operators." },
    { id: "stg_roofing_summary", page_id: "spg_roofing_summary", notes: "Read-back, sending identity, SMS add-on recap." },
    { id: "stg_roofing_import", page_id: "spg_roofing_import", notes: "'One more thing': contact CSV import + active jobs. Skippable." }
  ],
  tags: ["template", "roofing", "full-company"]
};

const INSTANT_FULL_ORG_WORKFLOW: JsonObject = {
  id: "swf_instant_full_org",
  title: "Instant full org (dev)",
  description: "Zero-step dev shortcut: creating the test instance IS the whole signup. A fresh org with a random name and every capability enabled (full platform, Money and merchant processing included) lands straight in the portal — ready to test payments boarding end to end.",
  entry_mode: "signup_first",
  stages: [
    { id: "stg_instant_signup", page_id: "spg_firstmate_signup", notes: "Skipped by sandbox instances like every signup stage — with no setup stages after it, the instance opens directly in the portal." }
  ],
  tags: ["template", "dev", "instant"]
};

export async function ensureSeedData() {
  for (const page of SEED_PAGES) {
    if (!(await sandboxStore.readPage(String(page.id)))) {
      await sandboxStore.savePage(normalizePage(page));
    }
  }
  if (!(await sandboxStore.readWorkflow(String(SEED_WORKFLOW.id)))) {
    await sandboxStore.saveWorkflow(normalizeWorkflow(SEED_WORKFLOW));
  }
  if (!(await sandboxStore.readWorkflow(String(HOME_IMPROVEMENT_WORKFLOW.id)))) {
    await sandboxStore.saveWorkflow(normalizeWorkflow(HOME_IMPROVEMENT_WORKFLOW));
  }
  if (!(await sandboxStore.readWorkflow(String(INSTANT_FULL_ORG_WORKFLOW.id)))) {
    // defaults are computed (not literal on the const) so the flag list always
    // reflects the current capability registry at seed time.
    await sandboxStore.saveWorkflow(normalizeWorkflow({
      ...INSTANT_FULL_ORG_WORKFLOW,
      defaults: { app_flags: instantFullOrgAppFlags() }
    }));
  }
  const existingRoofingWorkflow = await sandboxStore.readWorkflow(String(ROOFING_WORKFLOW.id));
  if (!existingRoofingWorkflow) {
    await sandboxStore.saveWorkflow(normalizeWorkflow(ROOFING_WORKFLOW));
  } else {
    const stages = Array.isArray(existingRoofingWorkflow.stages) ? existingRoofingWorkflow.stages : [];
    const needsRoofingMigration = stages.some((stage) => ["stg_roofing_proposal_doc", "stg_roofing_schedules"].includes(String((stage as JsonObject).id || "")))
      || !stages.some((stage) => String((stage as JsonObject).id || "") === "stg_roofing_commissions");
    if (needsRoofingMigration) {
      await sandboxStore.saveWorkflow(normalizeWorkflow({
        ...existingRoofingWorkflow,
        description: ROOFING_WORKFLOW.description,
        stages: ROOFING_WORKFLOW.stages
      }));
    }
  }
  const channelsOnlyDefaults = {
    app_flags: channelsOnlyAppFlags(),
    settings: {
      "channels_onboarding.product_mode": "channels_only",
      "channels_onboarding.completed": false
    }
  };
  const existingChannelsWorkflow = await sandboxStore.readWorkflow(String(CHANNELS_ONLY_WORKFLOW.id));
  if (!existingChannelsWorkflow) {
    await sandboxStore.saveWorkflow(normalizeWorkflow({
      ...CHANNELS_ONLY_WORKFLOW,
      defaults: channelsOnlyDefaults
    }));
  } else {
    // Migrate the first Channels-only seed away from its intentionally thin
    // branding mock. The shared production wizard already owns a much better
    // website/logo/palette/live-preview experience, so this workflow must
    // reference that page rather than maintaining a degraded copy.
    const stages = (Array.isArray(existingChannelsWorkflow.stages) ? existingChannelsWorkflow.stages : []) as JsonObject[];
    const existingDefaults = asObject(existingChannelsWorkflow.defaults);
    const existingFlags = asObject(existingDefaults.app_flags);
    await sandboxStore.saveWorkflow(normalizeWorkflow({
      defaults: {
        ...existingDefaults,
        app_flags: {
          ...existingFlags,
          "channels.sidebar_tab": true,
          "platform.left_column_default_mode": "channels",
          "platform.cobrand_sidebar_logo": true,
          "platform.separate_user_section": false,
          "platform.custom_fields": false,
          "platform.terminology_settings": false
        }
      },
      stages: stages.map((stage) => String(stage.page_id) === "spg_channels_brand"
        ? { ...stage, page_id: "spg_firstmate_branding", notes: "Use the shared production branding experience: website discovery, logo preview/upload, palette extraction, color editing, and live branded previews." }
        : stage)
    }, existingChannelsWorkflow));
  }
  const workflows = await sandboxStore.listWorkflows();
  const legacyBrandingReferenced = workflows.some((workflow) =>
    (Array.isArray(workflow.stages) ? workflow.stages : []).some((stage) => String((stage as JsonObject).page_id) === "spg_channels_brand"));
  if (!legacyBrandingReferenced && await sandboxStore.readPage("spg_channels_brand")) {
    await sandboxStore.deletePage("spg_channels_brand");
  }
}
