import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "../src/config/env.js";
import { openSqlStore, type SqlStore } from "./sql_store.js";

const activeTask = new AsyncLocalStorage<{ name: string; assertLease: () => Promise<void> }>();

/** Hold the claim row lock until the accompanying data writes commit. */
export async function withPlatformTaskLease<T>(operation: () => Promise<T>): Promise<T> {
  const task = activeTask.getStore();
  if (!task) return operation();
  return getPlatformTasksDatabase().transaction(async () => {
    await task.assertLease();
    return operation();
  }, task.name);
}

let database: SqlStore | undefined;
export function getPlatformTasksDatabase() {
  return database ??= openSqlStore({ id: "platform-worker-tasks", filename: path.resolve(env.platformStorageRoot, "worker_tasks.sqlite"), initialize: async db => {
    await db.exec(`CREATE TABLE IF NOT EXISTS platform_worker_tasks (
      name TEXT PRIMARY KEY, lease_owner TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '',
      next_at TEXT NOT NULL DEFAULT '', last_started_at TEXT NOT NULL DEFAULT '', last_finished_at TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS platform_worker_tasks_due ON platform_worker_tasks(next_at,lease_until);`);
  }});
}
export async function claimPlatformTask(name: string, leaseMs = 120000) {
  const db = getPlatformTasksDatabase();
  return (await db.transaction(async () => {
    const now = new Date().toISOString();
    const token = `${process.pid}:${randomUUID()}`;
    await db.prepare("INSERT INTO platform_worker_tasks(name) VALUES(?) ON CONFLICT(name) DO NOTHING").run(name);
    const result = await db.prepare(`UPDATE platform_worker_tasks SET lease_owner=?,lease_until=?,last_started_at=?,attempts=attempts+1
      WHERE name=? AND lease_until<=? AND next_at<=?`).run(token, new Date(Date.now()+leaseMs).toISOString(), now, name, now, now);
    return result.changes ? token : null;
  }, name));
}
export async function renewPlatformTask(name: string, token: string, leaseMs = 120000) {
  return (await getPlatformTasksDatabase().prepare(`UPDATE platform_worker_tasks SET lease_until=? WHERE name=? AND lease_owner=? AND lease_until>?`)
    .run(new Date(Date.now()+leaseMs).toISOString(), name, token, new Date().toISOString())).changes === 1;
}
export async function finishPlatformTask(name: string, token: string, intervalMs: number, error?: unknown) {
  return (await getPlatformTasksDatabase().prepare(`UPDATE platform_worker_tasks SET lease_owner='',lease_until='',next_at=?,last_finished_at=?,last_error=?
    WHERE name=? AND lease_owner=? AND lease_until>?`).run(new Date(Date.now()+intervalMs).toISOString(), new Date().toISOString(),
    error ? String(error instanceof Error ? error.message : error).slice(0,2000) : "", name, token, new Date().toISOString())).changes === 1;
}
export async function runPlatformTask<T>(name: string, intervalMs: number, operation: (assertLease: () => Promise<void>) => Promise<T>) {
  const token = await claimPlatformTask(name);
  if (!token) return { ran: false as const };
  let lost = false;
  let renewing: Promise<void> | undefined;
  const assertLease = async () => {
    if (lost || !(await renewPlatformTask(name, token))) { lost = true; throw new Error(`Platform task lease lost: ${name}`); }
  };
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = assertLease().catch(() => { lost = true; }).finally(() => { renewing = undefined; });
  }, 30000);
  timer.unref();
  try {
    const value = await activeTask.run({ name, assertLease }, () => operation(assertLease));
    await assertLease();
    await finishPlatformTask(name, token, intervalMs);
    return { ran: true as const, value };
  } catch (error) {
    await finishPlatformTask(name, token, Math.max(5000, intervalMs), error);
    throw error;
  } finally { clearInterval(timer); if (renewing) await renewing; }
}

export async function platformTaskStatus(name: string) {
  const row = await getPlatformTasksDatabase().prepare("SELECT * FROM platform_worker_tasks WHERE name=?").get(name);
  return { running: Boolean(row && String(row.lease_until) > new Date().toISOString()),
    last_error: String(row?.last_error || ""), last_finished_at: String(row?.last_finished_at || "") };
}
