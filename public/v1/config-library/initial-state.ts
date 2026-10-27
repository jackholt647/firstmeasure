import { badRequest, notFound } from "../platform/errors.js";
import { readGlobal, readOrganization, saveGlobal, type JsonObject } from "../platform/storage.js";
import { libraryStore } from "./store.js";

/**
 * A sandbox test organization's starting state (docs/architecture/config-library.md, "Test organizations"): the
 * flags and settings it was created with, kept so the dev console can put them back in one click. Restoring puts
 * every captured setting of the organization's global settings back (keys added since are removed), puts its scope
 * flags back, and clears guided experience progress and exposures so every tour and setup plays as new. Money
 * (credits, billing) is never captured or touched. Projects, documents and other records are not part of it.
 */

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
/** Global settings that are an account's money, not its configuration. */
const NOT_STATE = new Set(["credits_balance", "credits_ledger", "billing", "platform_billing"]);

export type InitialState = { global: JsonObject; scope_flags: Record<string, boolean>; captured_at: string; captured_by: string };

async function captureNow(orgId: string): Promise<Omit<InitialState, "captured_at" | "captured_by">> {
  const data = object((await readGlobal(orgId)).data);
  const global = Object.fromEntries(Object.entries(data).filter(([key]) => !NOT_STATE.has(key))) as JsonObject;
  const { readScopeFlagState } = await import("../scopes/storage.js");
  const scope = await readScopeFlagState(orgId).catch(() => null);
  return { global: structuredClone(global), scope_flags: { ...(scope?.flags || {}) } };
}

async function requireSandboxOrg(orgId: string) {
  const org = await readOrganization(orgId);
  const meta = object(org.metadata);
  if (meta.sandbox_test_org !== true) throw badRequest("sandbox_org_required", "Only sandbox test organizations keep a starting state.");
  return org;
}

/** Records what the organization looks like now as its starting state (at creation, or later by hand). */
export async function captureInitialState(orgId: string, by = "system") {
  await requireSandboxOrg(orgId);
  const state = { ...(await captureNow(orgId)), captured_at: new Date().toISOString(), captured_by: by };
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

function diffKeys(before: JsonObject, after: JsonObject) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => !NOT_STATE.has(key)));
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

/** What has changed since the start: global setting keys and scope flags that differ. */
export async function initialStateDiff(orgId: string) {
  const initial = await readInitialState(orgId);
  if (!initial) return null;
  const now = await captureNow(orgId);
  const scope = [...new Set([...Object.keys(initial.scope_flags), ...Object.keys(now.scope_flags)])].filter((id) => initial.scope_flags[id] !== now.scope_flags[id]).sort();
  return { settings: diffKeys(initial.global, now.global), scope_flags: scope, captured_at: initial.captured_at };
}

export async function restoreInitialState(orgId: string, by: string) {
  await requireSandboxOrg(orgId);
  const initial = await readInitialState(orgId);
  if (!initial) throw notFound("initial_state_missing", "This test organization has no starting state recorded. Record the current state first.");
  const changed = (await initialStateDiff(orgId))!;
  // The whole settings document is replaced (keys added since the start are removed); money keys are kept as they are.
  for (let attempt = 0; ; attempt += 1) {
    const current = await readGlobal(orgId);
    const kept = Object.fromEntries(Object.entries(object(current.data)).filter(([key]) => NOT_STATE.has(key)));
    try {
      await saveGlobal(orgId, { data: { ...structuredClone(initial.global), ...kept }, metadata: object(current.metadata), expected_revision: current.revision }, { replace: true });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "revision_conflict" || attempt >= 2) throw error;
    }
  }
  const { readScopeFlagState, patchScopeFlags } = await import("../scopes/storage.js");
  const scope = await readScopeFlagState(orgId).catch(() => null);
  if (scope && changed.scope_flags.length) {
    const known = new Set(scope.catalog.map((template) => template.id));
    const flags = Object.fromEntries(changed.scope_flags.filter((id) => known.has(id)).map((id) => [id, initial.scope_flags[id] ?? false]));
    if (Object.keys(flags).length) await patchScopeFlags(orgId, { expected_revision: scope.revision, flags });
  }
  const { guidedStore } = await import("../guided-experiences/store.js");
  const progress = Number((await guidedStore().prepare("DELETE FROM guided_progress WHERE organization_id=?").run(orgId)).changes);
  const exposures = Number((await guidedStore().prepare("DELETE FROM guided_events WHERE organization_id=? AND type='exposure'").run(orgId)).changes);
  await libraryStore().prepare("UPDATE config_library_initial_states SET restored_at=?, restored_by=?, restores=restores+1 WHERE organization_id=?").run(new Date().toISOString(), by, orgId);
  return { restored: changed, guided: { progress, exposures } };
}
