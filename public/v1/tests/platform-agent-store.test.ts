import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("agent storage preserves isolation, atomic updates, rollback and exclusive renewable claims", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-agent-store-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root, FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "", POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const store = await import("../agents/storage.js");
  const postgres = await import("../src/database/postgres.js");
  t.after(async () => { await store.closeAgentsDatabase(); await postgres.closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const org = `org_${randomUUID()}`;
  const thread = (await store.createAgentThread({ agent_id: "assistant", organization_id: org, title: "Initial", created_by_user_id: "alice" }))!;
  const id = String(thread.id);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.appendAgentMessage("assistant", org, id, { content: `message ${i}`, data: { i } })));
  assert.equal((await store.listAgentMessages("assistant", org, id)).length, 20);
  await assert.rejects(store.appendAgentMessage("assistant", "another-org", id, { content: "forbidden" }));
  await assert.rejects(store.appendAgentMessage("another-agent", org, id, { content: "forbidden" }));
  assert.equal(await store.readAgentThread("assistant", "another-org", id), null);
  await Promise.all([store.updateAgentThread("assistant", org, id, { title: "Renamed" }), store.updateAgentThread("assistant", org, id, { subject_id: "project_1" })]);
  const updated = (await store.readAgentThread("assistant", org, id))!;
  assert.equal(updated.title, "Renamed");
  assert.equal(updated.subject_id, "project_1");
  const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => store.acquireAgentThread("assistant", org, id, `owner_${i}`)));
  assert.equal(claims.filter(Boolean).length, 1);
  const token = `owner_${claims.indexOf(true)}`;
  assert.equal(await store.renewAgentThread("assistant", org, id, "other-owner"), false);
  assert.equal(await store.releaseAgentThread("assistant", org, id, "other-owner"), false);
  assert.equal(await store.resetStuckAgentThreads(), 0);
  assert.equal(await store.renewAgentThread("assistant", org, id, token), true);
  assert.equal(await store.releaseAgentThread("assistant", org, id, token), true);
  await store.acquireAgentThread("assistant", org, id, "expired", -1);
  assert.equal(await store.resetStuckAgentThreads(), 1);
  assert.equal(await store.acquireAgentThread("assistant", org, id, "replacement"), true);
  await store.releaseAgentThread("assistant", org, id, "replacement");
  await assert.rejects(store.getAgentsDatabase().transaction(async () => {
    await store.writeAgentMeta(`${org}:rollback`, "written");
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(await store.readAgentMeta(`${org}:rollback`), "");
  const schedule = (await store.createAgentSchedule({ agent_id: "assistant", organization_id: org, origin_thread_id: id, fire_at: new Date().toISOString() }))!;
  const wins = await Promise.all(Array.from({ length: 15 }, () => store.claimDueOnceAgentSchedule(String(schedule.id), new Date().toISOString())));
  assert.equal(wins.filter(Boolean).length, 1);
  const jobs = await store.getAgentsDatabase().prepare("SELECT * FROM agent_wakeup_jobs WHERE organization_id=?").all(org);
  assert.equal(jobs.length, 1, "claim and durable occurrence must commit together");
  const occurrenceId = String(jobs[0]!.id);
  await store.closeAgentsDatabase();
  const owners = await Promise.all(Array.from({ length: 10 }, () => store.claimAgentWakeup()));
  assert.equal(owners.filter(Boolean).length, 1);
  const job = owners.find(Boolean)!;
  assert.equal(await store.finishAgentWakeup(occurrenceId, "wrong-owner", "succeeded"), false);
  assert.equal(await store.renewAgentWakeup(occurrenceId, job.lease_owner, -1), true);
  assert.equal(await store.claimAgentWakeup(), null, "an interrupted external action must not be blindly repeated");
  assert.equal(await store.finishAgentWakeup(occurrenceId, job.lease_owner, "succeeded"), false);
  assert.equal((await store.getAgentsDatabase().prepare("SELECT state FROM agent_wakeup_jobs WHERE id=?").get(occurrenceId))!.state, "uncertain");
  const future = (await store.createAgentSchedule({ agent_id: "assistant", organization_id: org, origin_thread_id: id, fire_at: new Date().toISOString() }))!;
  await assert.rejects(store.getAgentsDatabase().transaction(async () => {
    await store.claimDueOnceAgentSchedule(String(future.id), new Date().toISOString());
    throw new Error("worker terminated before commit");
  }), /worker terminated/);
  assert.equal((await store.readAgentSchedule(String(future.id)))!.status, "active");
  assert.equal((await store.getAgentsDatabase().prepare("SELECT * FROM agent_wakeup_jobs WHERE organization_id=?").all(org)).length, 1);
  await store.closeAgentsDatabase();
  assert.equal((await store.listAgentMessages("assistant", org, id)).length, 20);
  if (url) await assert.rejects(stat(path.join(root, "agents.sqlite")), { code: "ENOENT" });
  const marker = `${org}:legacy-import`;
  let unavailable = true;
  const importedThread = `${org}:legacy-thread`;
  const secondThread = `${org}:second-thread`;
  const migration = {
    agentId: "assistant", marker,
    listThreads: async () => [{ id: importedThread, organization_id: org }, { id: secondThread, organization_id: org }],
    listMessages: async (threadId: string) => {
      if (threadId === secondThread && unavailable) throw new Error("legacy file unavailable");
      return [{ id: `${threadId}:message`, content: "Legacy conversation", role: "user" }];
    }
  };
  await assert.rejects(store.importLegacyThreads(migration), /Could not import/);
  assert.equal(await store.readAgentMeta(marker), "");
  assert.equal((await store.listAgentMessages("assistant", org, importedThread)).length, 1);
  unavailable = false;
  await store.importLegacyThreads(migration);
  assert.equal(await store.readAgentMeta(marker), "done");
  assert.equal((await store.listAgentMessages("assistant", org, importedThread)).length, 1);
  assert.equal((await store.listAgentMessages("assistant", org, secondThread)).length, 1);
  assert.equal(await store.deleteAgentThread("assistant", org, id), true);
  assert.equal((await store.listAgentMessages("assistant", org, id)).length, 0);
});
