import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "../platform/sql_store.js";
import type { GuidedEventType, GuidedStatus } from "./contracts.js";

/**
 * Progress and analytics for guided experiences. Progress is one row per experience for the organization (a setup)
 * or for a person (a tutorial): its variant, where they are, what they picked and whether it is finished. Events are
 * append-only exposure, step and outcome records for later analysis; they are never read to decide behavior except
 * that an exposure is recorded once and a skip put off for later (`defer`) is remembered (lastEvent). Raise schemaVersion with every table or column change, or Postgres hosts never
 * run it.
 */

let database: SqlStore | undefined;
export function guidedStore() {
  return database ??= openSqlStore({ id: "guided-experiences", filename: path.resolve(env.platformStorageRoot, "guided-experiences.sqlite"), schemaVersion: 2, initialize: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS guided_progress (
        organization_id TEXT NOT NULL, subject_id TEXT NOT NULL, experience_id TEXT NOT NULL,
        experience_version INTEGER NOT NULL DEFAULT 1, variant_id TEXT NOT NULL DEFAULT '', bucket REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'started', step_id TEXT NOT NULL DEFAULT '', data_json TEXT NOT NULL DEFAULT '{}',
        thread_subject TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT '', finished_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (organization_id, subject_id, experience_id)
      );
      CREATE TABLE IF NOT EXISTS guided_events (
        organization_id TEXT NOT NULL, id TEXT NOT NULL, experience_id TEXT NOT NULL, experience_version INTEGER NOT NULL DEFAULT 1,
        variant_id TEXT NOT NULL DEFAULT '', bucket REAL NOT NULL DEFAULT 0, unit_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, step_id TEXT NOT NULL DEFAULT '', properties_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS guided_events_experience ON guided_events(organization_id, experience_id, type, created_at);
    `);
    // Copy is config library data now; older stores' guided_copy rows are moved into it once (dev.ts).
  } });
}
export async function closeGuidedStore() { const old = database; database = undefined; await old?.close(); }

const now = () => new Date().toISOString();
const parse = (value: unknown) => { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } };

export type Progress = {
  experience_id: string; experience_version: number; variant_id: string; bucket: number; status: GuidedStatus; step_id: string;
  data: Record<string, unknown>; thread_subject: string; revision: number; started_at: string; updated_at: string; finished_at: string; finished_by: string;
};
function fromRow(row: Record<string, unknown>): Progress {
  return {
    experience_id: String(row.experience_id), experience_version: Number(row.experience_version || 1), variant_id: String(row.variant_id || ""),
    bucket: Number(row.bucket || 0), status: String(row.status || "started") as GuidedStatus, step_id: String(row.step_id || ""), data: parse(row.data_json),
    thread_subject: String(row.thread_subject || ""), revision: Number(row.revision || 1), started_at: String(row.started_at || ""), updated_at: String(row.updated_at || ""),
    finished_at: String(row.finished_at || ""), finished_by: String(row.finished_by || "")
  };
}

/** The subject a progress row belongs to: '' for the organization, the user id for a person. */
export async function readProgress(orgId: string, subjectId: string, experienceId: string) {
  const row = await guidedStore().prepare("SELECT * FROM guided_progress WHERE organization_id=? AND subject_id=? AND experience_id=?").get(orgId, subjectId, experienceId);
  return row ? fromRow(row) : null;
}
/** How many people in the organization finished a per-person experience. */
export async function countFinishedPeople(orgId: string, experienceId: string) {
  const row = await guidedStore().prepare("SELECT COUNT(*) AS n FROM guided_progress WHERE organization_id=? AND experience_id=? AND subject_id<>'' AND status<>'started'").get(orgId, experienceId);
  return Number(row?.n || 0);
}
export async function listProgress(orgId: string, subjectIds: string[]) {
  if (!subjectIds.length) return [];
  const rows = await guidedStore().prepare(`SELECT * FROM guided_progress WHERE organization_id=? AND subject_id IN (${subjectIds.map(() => "?").join(",")})`).all(orgId, ...subjectIds);
  return rows.map((row) => ({ subject_id: String(row.subject_id), ...fromRow(row) }));
}

/** Creates or updates a progress row. A finished row stays finished unless `restart` (a replay) is passed. */
export async function writeProgress(orgId: string, subjectId: string, experienceId: string, patch: Partial<Pick<Progress, "experience_version" | "variant_id" | "bucket" | "status" | "step_id" | "data" | "thread_subject">> & { restart?: boolean; userId?: string }) {
  const db = guidedStore();
  return db.transaction(async (tx) => {
    const current = await tx.prepare("SELECT * FROM guided_progress WHERE organization_id=? AND subject_id=? AND experience_id=?").get(orgId, subjectId, experienceId);
    const at = now();
    if (!current) {
      const status = patch.status || "started";
      await tx.prepare(`INSERT INTO guided_progress(organization_id,subject_id,experience_id,experience_version,variant_id,bucket,status,step_id,data_json,thread_subject,revision,started_at,updated_at,finished_at,finished_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(orgId, subjectId, experienceId, patch.experience_version || 1, patch.variant_id || "", patch.bucket || 0, status, patch.step_id || "",
        JSON.stringify(patch.data || {}), patch.thread_subject || "", at, at, status === "started" ? "" : at, status === "started" ? "" : patch.userId || "");
    } else {
      const was = fromRow(current);
      const finished = was.status !== "started";
      if (finished && !patch.restart && (!patch.status || patch.status === "started")) return was;
      const status = patch.status || (patch.restart ? "started" : was.status);
      const finishing = status !== "started" && was.status === "started";
      await tx.prepare(`UPDATE guided_progress SET experience_version=?,variant_id=?,bucket=?,status=?,step_id=?,data_json=?,thread_subject=?,revision=revision+1,updated_at=?,finished_at=?,finished_by=?
        WHERE organization_id=? AND subject_id=? AND experience_id=?`).run(patch.experience_version || was.experience_version, patch.variant_id || was.variant_id,
        patch.bucket ?? was.bucket, status, patch.step_id ?? was.step_id, JSON.stringify(patch.data ? { ...was.data, ...patch.data } : was.data),
        patch.thread_subject ?? was.thread_subject, at, finishing ? at : status === "started" ? "" : was.finished_at, finishing ? patch.userId || "" : status === "started" ? "" : was.finished_by,
        orgId, subjectId, experienceId);
    }
    return fromRow((await tx.prepare("SELECT * FROM guided_progress WHERE organization_id=? AND subject_id=? AND experience_id=?").get(orgId, subjectId, experienceId))!);
  }, `guided-progress:${orgId}:${subjectId}:${experienceId}`);
}

export type GuidedEvent = { experience_id: string; experience_version: number; variant_id: string; bucket: number; unit_id: string; user_id: string; type: GuidedEventType; step_id?: string; properties?: Record<string, unknown> };
export async function recordEvent(orgId: string, event: GuidedEvent) {
  const id = `gxe_${randomUUID().replace(/-/g, "")}`;
  const properties = JSON.stringify(event.properties || {}).slice(0, 4000);
  await guidedStore().prepare(`INSERT INTO guided_events(organization_id,id,experience_id,experience_version,variant_id,bucket,unit_id,user_id,type,step_id,properties_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orgId, id, event.experience_id, event.experience_version, event.variant_id, event.bucket, event.unit_id, event.user_id, event.type, event.step_id || "", properties, now());
  return id;
}
/** Whether this unit was already exposed to this experience, so an exposure is counted once per unit. */
export async function wasExposed(orgId: string, experienceId: string, unitId: string) {
  return !!(await guidedStore().prepare("SELECT id FROM guided_events WHERE organization_id=? AND experience_id=? AND type='exposure' AND unit_id=? LIMIT 1").get(orgId, experienceId, unitId));
}
/** The newest event of one type for this unit, or null: a skip put off for later (`defer`, service.ts deferral). */
export async function lastEvent(orgId: string, experienceId: string, type: GuidedEventType, unitId: string) {
  const row = await guidedStore().prepare("SELECT properties_json, created_at FROM guided_events WHERE organization_id=? AND experience_id=? AND type=? AND unit_id=? ORDER BY created_at DESC LIMIT 1").get(orgId, experienceId, type, unitId);
  return row ? { properties: parse(row.properties_json), created_at: String(row.created_at) } : null;
}
export async function listEvents(orgId: string, experienceId: string, limit = 500) {
  const rows = await guidedStore().prepare("SELECT * FROM guided_events WHERE organization_id=? AND experience_id=? ORDER BY created_at DESC LIMIT ?").all(orgId, experienceId, Math.min(5000, Math.max(1, limit)));
  return rows.map((row) => ({ id: String(row.id), experience_id: String(row.experience_id), experience_version: Number(row.experience_version), variant_id: String(row.variant_id), bucket: Number(row.bucket), unit_id: String(row.unit_id), user_id: String(row.user_id), type: String(row.type), step_id: String(row.step_id), properties: parse(row.properties_json), created_at: String(row.created_at) }));
}

/**
 * The newest step views, answers and skips of some steps across every experience (dev console's Setup section: where
 * each setup step was asked and answered). Newest first, at most `limit`.
 */
export async function listStepEvents(orgId: string, stepIds: string[], limit = 2000) {
  if (!stepIds.length) return [];
  const rows = await guidedStore().prepare(`SELECT experience_id, user_id, type, step_id, created_at FROM guided_events WHERE organization_id=? AND type IN ('step_view','step_done','step_skip') AND step_id IN (${stepIds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`)
    .all(orgId, ...stepIds, Math.min(5000, Math.max(1, limit)));
  return rows.map((row) => ({ experience_id: String(row.experience_id), user_id: String(row.user_id), type: String(row.type) as GuidedEventType, step_id: String(row.step_id), created_at: String(row.created_at) }));
}

/** Development (dev console's Setup tests): puts a progress row back as it was, or removes it when there was none. */
export async function replaceProgress(orgId: string, subjectId: string, experienceId: string, progress: Progress | null) {
  const db = guidedStore();
  await db.prepare("DELETE FROM guided_progress WHERE organization_id=? AND subject_id=? AND experience_id=?").run(orgId, subjectId, experienceId);
  if (!progress) return;
  await db.prepare(`INSERT INTO guided_progress(organization_id,subject_id,experience_id,experience_version,variant_id,bucket,status,step_id,data_json,thread_subject,revision,started_at,updated_at,finished_at,finished_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orgId, subjectId, experienceId, progress.experience_version, progress.variant_id, progress.bucket, progress.status, progress.step_id,
    JSON.stringify(progress.data || {}), progress.thread_subject, progress.revision, progress.started_at, progress.updated_at, progress.finished_at, progress.finished_by);
}
/** Development: forgets an experience's events since a moment (a rolled-back Setup test). */
export async function deleteEventsSince(orgId: string, experienceId: string, since: string) {
  return (await guidedStore().prepare("DELETE FROM guided_events WHERE organization_id=? AND experience_id=? AND created_at>=?").run(orgId, experienceId, since)).changes;
}

/** Clears an experience's progress for the organization and, or only, one person. */
export async function clearProgress(orgId: string, experienceId: string, subjects: string[]) {
  if (!subjects.length) return 0;
  return (await guidedStore().prepare(`DELETE FROM guided_progress WHERE organization_id=? AND experience_id=? AND subject_id IN (${subjects.map(() => "?").join(",")})`).run(orgId, experienceId, ...subjects)).changes;
}
/** Forgets the exposures of a unit, so a reset experience counts as new. */
export async function clearExposures(orgId: string, experienceId: string, unitIds: string[]) {
  if (!unitIds.length) return 0;
  return (await guidedStore().prepare(`DELETE FROM guided_events WHERE organization_id=? AND experience_id=? AND type='exposure' AND unit_id IN (${unitIds.map(() => "?").join(",")})`).run(orgId, experienceId, ...unitIds)).changes;
}
