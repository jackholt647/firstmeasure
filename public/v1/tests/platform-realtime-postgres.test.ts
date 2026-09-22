import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import test from "node:test";

const url = process.env.TEST_POSTGRES_URL || "";
test("realtime cursors, private audiences and replay survive separate API processes", { skip: !url }, async t => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname), "Use the isolated local PostgreSQL test runner");
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: url, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const db = await import("../src/database/postgres.js");
  const hub = await import("../platform/realtime.js");
  const store = await import("../platform/realtime_postgres.js");
  const org = `realtime_${randomUUID()}`;
  t.after(async () => {
    hub.resetRealtimeForTests();
    await db.queryPostgres("DELETE FROM platform_realtime_events WHERE organization_id = $1", [org]);
    await db.queryPostgres("DELETE FROM platform_realtime_heads WHERE organization_id = $1", [org]);
    await db.closePostgresPools();
  });
  const child = promisify(execFile);
  const script = `
    const { appendRealtimeEvent } = await import('./platform/realtime_postgres.ts');
    const { closePostgresPools } = await import('./src/database/postgres.ts');
    const org = process.env.TEST_EVENT_ORG;
    await Promise.all(Array.from({length: 20}, (_, i) => appendRealtimeEvent({ organization_id: org, topic: 'test.changed', user_ids: null, payload: { writer: process.pid, i } })));
    await closePostgresPools();
  `;
  await Promise.all([1, 2].map(() => child(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, TEST_EVENT_ORG: org }, windowsHide: true
  })));
  const initial = await hub.pollRealtimeEvents(org, "alice", 0);
  assert.equal(initial.next, 40);
  assert.deepEqual(initial.events.map(event => event.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(new Set(initial.events.map(event => event.payload.writer)).size, 2);
  await hub.publishRealtimeEvent({ organization_id: org, topic: "private.changed", user_ids: ["alice"], payload: { private: true } });
  assert.equal((await hub.pollRealtimeEvents(org, "bob", 40)).events.length, 0);
  assert.equal((await hub.pollRealtimeEvents(org, "alice", 40)).events[0]?.topic, "private.changed");
  hub.resetRealtimeForTests();
  assert.equal((await hub.pollRealtimeEvents(org, "alice", 40)).next, 41);
  assert.equal((await hub.pollRealtimeEvents(org, "alice", 99)).resync, true);
  const batch = await store.readRealtimeStreams([{ organization_id: org, after: 40 }, { organization_id: `${org}_other`, after: 0 }]);
  assert.equal(batch.find(page => page.organization_id !== org)?.events.length, 0);
  assert.equal(batch.find(page => page.organization_id === org)?.events.length, 1);
  for (let i = 0; i < 1000; i++) await hub.publishRealtimeEvent({ organization_id: org, topic: "test.retention", payload: { i } });
  const expired = await hub.pollRealtimeEvents(org, "alice", 1);
  assert.equal(expired.resync, true);
  assert.equal(expired.next, 1041);
  assert.equal(expired.events.length, 1000);
  assert.equal((await hub.pollRealtimeEvents(org, "alice", 41)).resync, false);
});
