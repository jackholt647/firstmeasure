import path from "node:path";
import { env } from "../src/config/env.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { notFound } from "../platform/errors.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { listBranchModules, readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { setupStep } from "../guided-experiences/setup-steps.js";
import { setupStepTestExperience } from "../guided-experiences/service.js";
import { deleteEventsSince, readProgress, replaceProgress, type Progress } from "../guided-experiences/store.js";
import { SETUP_STEP_EXPERIENCE_PREFIX } from "../guided-experiences/library-checks.js";

/**
 * Setup tests (docs/architecture/dev-console.md, "Setup"): the dev console plays a setup step on its own, answered or
 * not, and saves the answer for real (its action, its events), so the organization is as if someone answered it. Roll
 * back puts it back as it was before the first test: every value the tests changed and the step's own guided progress
 * and events. Development only, for the dev console audience.
 *
 * A step's answer lives in branch modules (company_profile, appointment_setup, the scheduling catalog its kinds make,
 * whatever a later step writes), and nothing says which, so a test compares them: when it starts, the modules of the
 * default branch and the person's branch are read; when it ends (the overlay closes), every top-level key that changed
 * is kept with the value it had before. Several tests of one step keep the first value of each key, so roll back is
 * to before the first. A key something else changed while the overlay was open is rolled back too; the console lists
 * what roll back restores before it does.
 */

let database: SqlStore | undefined;
function store() {
  return database ??= openSqlStore({ id: "development-setup-tests", filename: path.resolve(env.platformStorageRoot, "development-setup-tests.sqlite"), schemaVersion: 1, initialize: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS development_setup_tests (
        organization_id TEXT NOT NULL, step_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        first_started_at TEXT NOT NULL, started_at TEXT NOT NULL, started_by TEXT NOT NULL DEFAULT '', ended_at TEXT NOT NULL DEFAULT '', tests INTEGER NOT NULL DEFAULT 1,
        before_json TEXT NOT NULL DEFAULT '{}', changes_json TEXT NOT NULL DEFAULT '[]', progress_json TEXT NOT NULL DEFAULT 'null',
        PRIMARY KEY (organization_id, step_id)
      );
    `);
  } });
}
export async function closeSetupTestStore() { const old = database; database = undefined; await old?.close(); }

type Modules = Record<string, Record<string, JsonObject>>;
/** A key a test changed: where, and its value before the first test (`absent` when the key was not there). */
export type SetupTestChange = { branch_id: string; module: string; key: string; before: unknown; absent: boolean };
type Row = { step_id: string; status: string; first_started_at: string; started_at: string; started_by: string; ended_at: string; tests: number; before: Modules; changes: SetupTestChange[]; progress: Progress | null };

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const parse = (value: unknown, fallback: unknown) => { try { return JSON.parse(String(value)); } catch { return fallback; } };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const branchesOf = (ctx: PlatformAuthContext) => [...new Set(["default", ctx.branchId || "default"])];

async function modules(orgId: string, branches: string[]): Promise<Modules> {
  const out: Modules = {};
  for (const branch of branches) {
    out[branch] = {};
    for (const doc of await listBranchModules(orgId, branch)) out[branch][String(doc.id)] = structuredClone(object(doc.data));
  }
  return out;
}
function fromRow(row: Record<string, unknown>): Row {
  return {
    step_id: String(row.step_id), status: String(row.status), first_started_at: String(row.first_started_at), started_at: String(row.started_at), started_by: String(row.started_by || ""),
    ended_at: String(row.ended_at || ""), tests: Number(row.tests || 1), before: object(parse(row.before_json, {})) as Modules,
    changes: Array.isArray(parse(row.changes_json, [])) ? parse(row.changes_json, []) : [], progress: parse(row.progress_json, null) as Progress | null
  };
}
async function read(orgId: string, stepId: string) {
  const row = await store().prepare("SELECT * FROM development_setup_tests WHERE organization_id=? AND step_id=?").get(orgId, stepId);
  return row ? fromRow(row) : null;
}
const experienceOf = (stepId: string) => `${SETUP_STEP_EXPERIENCE_PREFIX}${stepId}`;
const subjectOf = (ctx: PlatformAuthContext, stepId: string) => setupStep(stepId)?.scope === "person" ? ctx.userId : "";
const view = (row: Row | null) => row ? { step_id: row.step_id, status: row.status, first_started_at: row.first_started_at, tests: row.tests, ended_at: row.ended_at || null, changes: row.changes.map((change) => ({ branch_id: change.branch_id, module: change.module, key: change.key })) } : null;

/** Every step's test in this organization, for the Setup section. */
export async function listSetupTests(orgId: string) {
  const rows = await store().prepare("SELECT * FROM development_setup_tests WHERE organization_id=?").all(orgId);
  return rows.map((row) => view(fromRow(row))!);
}

/**
 * Starts a test: reads the modules as they are now (and, on the first test, the step's own progress), and answers the
 * step as it is played on its own, forced even when answered.
 */
export async function startSetupTest(ctx: PlatformAuthContext, stepId: string) {
  if (!setupStep(stepId)) throw notFound("setup_step_missing", "That setup step does not exist.");
  const experience = await setupStepTestExperience(ctx, stepId);
  const existing = await read(ctx.orgId, stepId);
  if (existing?.status === "open") await endSetupTest(ctx, stepId);
  const before = await modules(ctx.orgId, branchesOf(ctx));
  const at = new Date().toISOString(), by = String(ctx.identity?.email || ctx.userId);
  if (existing) {
    await store().prepare("UPDATE development_setup_tests SET status='open', started_at=?, started_by=?, tests=tests+1, before_json=? WHERE organization_id=? AND step_id=?")
      .run(at, by, JSON.stringify(before), ctx.orgId, stepId);
  } else {
    const progress = await readProgress(ctx.orgId, subjectOf(ctx, stepId), experienceOf(stepId));
    await store().prepare("INSERT INTO development_setup_tests(organization_id,step_id,status,first_started_at,started_at,started_by,before_json,changes_json,progress_json) VALUES(?,?,'open',?,?,?,?,'[]',?)")
      .run(ctx.orgId, stepId, at, at, by, JSON.stringify(before), JSON.stringify(progress));
  }
  return { experience, test: view(await read(ctx.orgId, stepId)) };
}

/** Ends a test (the overlay closed): what changed since it started joins what earlier tests changed. */
export async function endSetupTest(ctx: PlatformAuthContext, stepId: string) {
  const row = await read(ctx.orgId, stepId);
  if (!row) throw notFound("setup_test_missing", "That setup step has not been tested.");
  if (row.status !== "open") return { test: view(row) };
  const now = await modules(ctx.orgId, Object.keys(row.before).length ? Object.keys(row.before) : branchesOf(ctx));
  const changes = [...row.changes];
  const known = new Set(changes.map((change) => `${change.branch_id}|${change.module}|${change.key}`));
  for (const [branch, mods] of Object.entries(now)) {
    for (const moduleId of new Set([...Object.keys(mods), ...Object.keys(row.before[branch] || {})])) {
      const was = row.before[branch]?.[moduleId] || {}, is = mods[moduleId] || {};
      for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
        if (same(was[key], is[key]) || known.has(`${branch}|${moduleId}|${key}`)) continue;
        changes.push({ branch_id: branch, module: moduleId, key, before: was[key] ?? null, absent: !(key in was) });
      }
    }
  }
  await store().prepare("UPDATE development_setup_tests SET status='ended', ended_at=?, before_json='{}', changes_json=? WHERE organization_id=? AND step_id=?")
    .run(new Date().toISOString(), JSON.stringify(changes), ctx.orgId, stepId);
  return { test: view(await read(ctx.orgId, stepId)) };
}

/**
 * Rolls a step back to before its first test: each key a test changed gets its earlier value again (or is removed),
 * the step's own progress is put back and the events its tests recorded are forgotten.
 */
export async function rollbackSetupTest(ctx: PlatformAuthContext, stepId: string) {
  if (!(await read(ctx.orgId, stepId))) throw notFound("setup_test_missing", "That setup step has not been tested, so there is nothing to roll back.");
  await endSetupTest(ctx, stepId);
  const row = (await read(ctx.orgId, stepId))!;
  const byModule = new Map<string, SetupTestChange[]>();
  for (const change of row.changes) byModule.set(`${change.branch_id}|${change.module}`, [...(byModule.get(`${change.branch_id}|${change.module}`) || []), change]);
  const restored: string[] = [];
  for (const changes of byModule.values()) {
    const { branch_id: branch, module: moduleId } = changes[0]!;
    const current = await readBranchModule(ctx.orgId, branch, moduleId).catch(() => null);
    const data: JsonObject = { ...object(current?.data) };
    for (const change of changes) { if (change.absent) delete data[change.key]; else data[change.key] = structuredClone(change.before) as never; }
    await saveBranchModule(ctx.orgId, branch, moduleId, { data, ...(current ? { expected_revision: Number(current.revision || 0) } : {}) }, { replace: true });
    restored.push(...changes.map((change) => `${moduleId}.${change.key}`));
  }
  await replaceProgress(ctx.orgId, subjectOf(ctx, stepId), experienceOf(stepId), row.progress);
  const events = await deleteEventsSince(ctx.orgId, experienceOf(stepId), row.first_started_at);
  await store().prepare("DELETE FROM development_setup_tests WHERE organization_id=? AND step_id=?").run(ctx.orgId, stepId);
  return { restored, events };
}
