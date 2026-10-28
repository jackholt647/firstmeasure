import { badRequest, notFound } from "../platform/errors.js";
import { readGlobal, readOrganization, saveGlobal, type JsonObject } from "../platform/storage.js";
import { libraryStore } from "./store.js";

/**
 * A sandbox test organization's state and its starting state (docs/architecture/config-library.md, "Test
 * organizations"). The start is recorded when the organization is created: its global settings (flags, app offers and
 * activations, placements, project tabs, settings) and its scope flags. The dev console shows what changed since, flips
 * one flag or setting, and restores some paths or everything. A full restore also clears guided experience progress
 * and exposures so every Get Started tour and setup plays as new. Money (credits, billing) is never captured or
 * touched; projects, documents and other records are not part of the state.
 *
 * Paths: `flags.<capability key>` (flat; a flag never set reads as its default), `settings.<global key>`,
 * `scope_flags.<scope template id>`.
 */

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
/** Global settings that are an account's money, not its configuration. */
const NOT_STATE = new Set(["credits_balance", "credits_ledger", "billing", "platform_billing"]);
const FLAG_KEYS = new Set(["app_flags", "feature_flags"]);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type Captured = { global: JsonObject; scope_flags: Record<string, boolean> };
export type InitialState = Captured & { captured_at: string; captured_by: string };
export type StateView = { flags: Record<string, unknown>; settings: JsonObject; scope_flags: Record<string, boolean> };
export type StateChange = { path: string; initial: unknown; current: unknown };

async function captureNow(orgId: string): Promise<Captured> {
  const data = object((await readGlobal(orgId)).data);
  const global = Object.fromEntries(Object.entries(data).filter(([key]) => !NOT_STATE.has(key))) as JsonObject;
  const { readScopeFlagState } = await import("../scopes/storage.js");
  const scope = await readScopeFlagState(orgId).catch(() => null);
  return { global: structuredClone(global), scope_flags: { ...(scope?.flags || {}) } };
}

/** Flags flat (defaults filled in), other settings by top-level key. */
async function view(captured: Captured): Promise<StateView> {
  const { capabilityDefaultValues, flattenGroupedValues } = await import("../platform/capabilities.js");
  const flags = { ...capabilityDefaultValues(), ...flattenGroupedValues(object(captured.global.app_flags || captured.global.feature_flags)) };
  const settings = Object.fromEntries(Object.entries(captured.global).filter(([key]) => !FLAG_KEYS.has(key))) as JsonObject;
  return { flags, settings, scope_flags: captured.scope_flags };
}

function changes(initial: StateView, current: StateView): StateChange[] {
  const out: StateChange[] = [];
  const compare = (prefix: string, a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!same(a[key], b[key])) out.push({ path: `${prefix}.${key}`, initial: a[key] ?? null, current: b[key] ?? null });
    }
  };
  compare("flags", initial.flags, current.flags);
  compare("settings", initial.settings, current.settings);
  compare("scope_flags", initial.scope_flags, current.scope_flags);
  return out;
}

async function requireSandboxOrg(orgId: string) {
  const org = await readOrganization(orgId);
  if (object(org.metadata).sandbox_test_org !== true) throw badRequest("sandbox_org_required", "Only sandbox test organizations keep a starting state.");
  return org;
}

/** Records what the organization looks like now as its starting state (at creation, or later by hand). */
export async function captureInitialState(orgId: string, by = "system") {
  await requireSandboxOrg(orgId);
  const state: InitialState = { ...(await captureNow(orgId)), captured_at: new Date().toISOString(), captured_by: by };
  await libraryStore().prepare(`INSERT INTO config_library_initial_states (organization_id, state_json, captured_at, captured_by) VALUES (?,?,?,?)
    ON CONFLICT(organization_id) DO UPDATE SET state_json=excluded.state_json, captured_at=excluded.captured_at, captured_by=excluded.captured_by`)
    .run(orgId, JSON.stringify(state), state.captured_at, by);
  return state;
}

export async function readInitialState(orgId: string) {
  const row = await libraryStore().prepare("SELECT * FROM config_library_initial_states WHERE organization_id=?").get(orgId);
  if (!row) return null;
  return { ...(JSON.parse(String(row.state_json)) as InitialState), restored_at: String(row.restored_at || ""), restored_by: String(row.restored_by || ""), restores: Number(row.restores || 0) };
}

/** The organization's flags and settings now, its start, and every path that differs. */
export async function organizationState(orgId: string) {
  await requireSandboxOrg(orgId);
  const current = await view(await captureNow(orgId));
  const start = await readInitialState(orgId);
  const initial = start ? await view(start) : null;
  return {
    ...current,
    initial: start && initial ? { captured_at: start.captured_at, captured_by: start.captured_by, restored_at: start.restored_at, restores: start.restores, ...initial } : null,
    changed: initial ? changes(initial, current) : []
  };
}

function parsePath(path: string) {
  const match = /^(flags|settings|scope_flags)\.(.+)$/.exec(String(path || "").trim());
  if (!match) throw badRequest("state_path_invalid", "A path is flags.<key>, settings.<key> or scope_flags.<id>.");
  const [, area, key] = match as unknown as [string, "flags" | "settings" | "scope_flags", string];
  if (area === "settings" && (FLAG_KEYS.has(key) || NOT_STATE.has(key))) throw badRequest("state_path_invalid", `settings.${key} is not part of the state.`);
  return { area, key };
}

/** Writes one global setting (null removes it), replacing the document so a removal sticks. */
async function writeSetting(orgId: string, key: string, value: unknown) {
  for (let attempt = 0; ; attempt += 1) {
    const current = await readGlobal(orgId);
    const data = { ...object(current.data) };
    if (value === null || value === undefined) delete data[key]; else data[key] = structuredClone(value) as never;
    try { await saveGlobal(orgId, { data, metadata: object(current.metadata), expected_revision: current.revision }, { replace: true }); return; }
    catch (error) { if ((error as { code?: string }).code !== "revision_conflict" || attempt >= 2) throw error; }
  }
}

async function writePath(orgId: string, path: string, value: unknown) {
  const { area, key } = parsePath(path);
  if (area === "flags") {
    const { saveCapabilityValues } = await import("../platform/capabilities.js");
    await saveCapabilityValues(orgId, { [key]: value });
  } else if (area === "settings") {
    await writeSetting(orgId, key, value);
  } else {
    const { readScopeFlagState, patchScopeFlags } = await import("../scopes/storage.js");
    const scope = await readScopeFlagState(orgId);
    if (!scope.catalog.some((template) => template.id === key)) throw notFound("scope_template_not_found", `There is no scope template ${key} here.`);
    await patchScopeFlags(orgId, { expected_revision: scope.revision, flags: { [key]: value === true } });
  }
}

/** Flips one flag, setting or scope flag (the dev console's switch). */
export async function setOrganizationState(orgId: string, path: string, value: unknown) {
  await requireSandboxOrg(orgId);
  await writePath(orgId, path, value);
  return organizationState(orgId);
}

/** Puts the start back: the listed paths, or (no paths) everything, which also replays guided experiences. */
export async function restoreInitialState(orgId: string, by: string, paths?: string[]) {
  await requireSandboxOrg(orgId);
  const start = await readInitialState(orgId);
  if (!start) throw notFound("initial_state_missing", "This test organization has no starting state recorded. Record the current state first.");
  let guided = { progress: 0, exposures: 0 };
  if (paths?.length) {
    const initial = await view(start);
    for (const path of paths) {
      const { area, key } = parsePath(path);
      await writePath(orgId, path, area === "flags" ? initial.flags[key] : area === "settings" ? initial.settings[key] ?? null : initial.scope_flags[key] ?? false);
    }
  } else {
    // The whole settings document is replaced (keys added since the start are removed); money keys stay as they are.
    for (let attempt = 0; ; attempt += 1) {
      const current = await readGlobal(orgId);
      const kept = Object.fromEntries(Object.entries(object(current.data)).filter(([key]) => NOT_STATE.has(key)));
      try {
        await saveGlobal(orgId, { data: { ...structuredClone(start.global), ...kept }, metadata: object(current.metadata), expected_revision: current.revision }, { replace: true });
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "revision_conflict" || attempt >= 2) throw error;
      }
    }
    const { readScopeFlagState, patchScopeFlags } = await import("../scopes/storage.js");
    const scope = await readScopeFlagState(orgId).catch(() => null);
    if (scope) {
      const known = new Set(scope.catalog.map((template) => template.id));
      const flags = Object.fromEntries([...known].filter((id) => (start.scope_flags[id] ?? false) !== scope.flags[id]).map((id) => [id, start.scope_flags[id] ?? false]));
      if (Object.keys(flags).length) await patchScopeFlags(orgId, { expected_revision: scope.revision, flags });
    }
    const { guidedStore } = await import("../guided-experiences/store.js");
    guided = {
      progress: Number((await guidedStore().prepare("DELETE FROM guided_progress WHERE organization_id=?").run(orgId)).changes),
      exposures: Number((await guidedStore().prepare("DELETE FROM guided_events WHERE organization_id=? AND type='exposure'").run(orgId)).changes)
    };
  }
  await libraryStore().prepare("UPDATE config_library_initial_states SET restored_at=?, restored_by=?, restores=restores+1 WHERE organization_id=?").run(new Date().toISOString(), by, orgId);
  return { ...(await organizationState(orgId)), guided };
}
