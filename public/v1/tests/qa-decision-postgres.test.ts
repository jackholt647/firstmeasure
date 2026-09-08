import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

// Two independent Node/Fastify instances, using the real shared PostgreSQL
// manifests/lock/job queue. No provider calls: workers are disabled and all
// files/users/projects live in a disposable local test environment.
test("PostgreSQL serializes QA/manager/bulk decisions across independent processes", { skip: !databaseUrl, timeout: 150_000 }, async () => {
  assert.equal(new URL(databaseUrl).hostname, "127.0.0.1", "Only the disposable local PostgreSQL runner is allowed");
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-qa-decisions-"));
  Object.assign(process.env, {
    FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl,
    DATABASE_ADMIN_URL: databaseUrl, FIRSTMEASURE_JOB_WORKERS: "0", POSTGRES_POOL_MAX: "1",
    POSTGRES_AUTO_MIGRATE: "true", POSTGRES_ALLOW_EMPTY_IMPORT: "true",
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, "projects"), INTERNAL_STORAGE_ROOT: path.join(root, "internal"),
    PLATFORM_STORAGE_ROOT: path.join(root, "platform"), FIRSTMEASURE_ARTIFACT_STORAGE: "local",
    EMAIL_OUTBOUND_DISABLED: "true", SMS_OUTBOUND_DISABLED: "true", LOG_LEVEL: "fatal"
  });
  const storage = await import("../firstmeasure/storage.js");
  const internal = await import("../internal/storage.js");
  const database = await import("../src/database/postgres.js");
  const index = await import("../firstmeasure/project_index.js");
  const actor = { email: "concurrency@example.test", name: "Synthetic concurrency admin", roles: ["admin"] };
  try {
    await index.ensureFirstMeasureProjectIndexReady();
    await internal.saveInternalUser({ ...actor, role: "admin", is_admin: true, permissions: { is_admin_legacy: true } });
    for (const kind of ["qa", "manager", "bulk", "mixed"]) {
      const id = `qa-decision-${kind}`;
      await storage.createProject({ id, address: `Synthetic ${kind}`, status: kind === "manager" ? "awaiting_manager_review" : "awaiting_review" });
      await storage.patchManifest(id, {
        qa_claimed_by_email: actor.email, qa_claimed_by_name: actor.name, qa_claimed_at: new Date().toISOString(),
        qa_history: [], work_history: [], is_vip: false, complexity: "simple"
      });
      await storage.saveStoredPdf(id, "main", Buffer.from("%PDF-1.4\nsynthetic concurrency fixture\n%%EOF"));
      const script = `
        import { buildApp } from './src/app.ts';
        const app = await buildApp(); await app.ready();
        const input = JSON.parse(process.env.QA_DECISION_INPUT);
        process.on('message', async message => {
          if (message !== 'go') return;
          try {
            const results = await Promise.all(Array.from({length:4}, async () => {
              const response = await app.inject({method:'POST',url:input.url,payload:input.payload});
              return {status:response.statusCode,body:response.json()};
            }));
            process.send({type:'result',results}, () => process.exit(0));
          } catch (error) { process.send({type:'failure',message:String(error)}, () => process.exit(1)); }
        });
        process.send({type:'ready'});
      `;
      const processes = [0, 1].map(nodeIndex => {
        const bulk = kind === "bulk" || (kind === "mixed" && nodeIndex === 1);
        const payload = bulk
          ? { actor, project_ids: [id], criteria: { max_score: 1000, include_claimed: true } }
          : { actor, status: "approved", threads: [] };
        const url = bulk ? "/v1/firstmeasure/qa/bulk-approve" : `/v1/firstmeasure/projects/${id}/${kind === "manager" ? "manager" : "qa"}/decision`;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
          cwd: process.cwd(), env: { ...process.env, QA_DECISION_INPUT: JSON.stringify({ url, payload }) },
          stdio: ["ignore", "ignore", "pipe", "ipc"]
        });
        let stderr = "";
        child.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-4000); });
        const ready = new Promise<void>((resolve, reject) => {
          child.on("message", (message: any) => { if (message.type === "ready") resolve(); });
          child.once("error", reject);
          child.once("exit", code => { if (code !== 0) reject(new Error(stderr || `Child exited ${code}`)); });
        });
        const result = new Promise<any[]>((resolve, reject) => {
          child.on("message", (message: any) => {
            if (message.type === "result") resolve(message.results);
            if (message.type === "failure") reject(new Error(message.message));
          });
          child.once("error", reject);
          child.once("exit", code => { if (code !== 0) reject(new Error(stderr || `Child exited ${code}`)); });
        });
        return { child, ready, result };
      });
      try {
        await Promise.all(processes.map(item => item.ready));
        processes.forEach(item => item.child.send("go"));
        const replies = (await Promise.all(processes.map(item => item.result))).flat();
        assert.ok(replies.every(reply => [200, 400, 409].includes(reply.status)), JSON.stringify(replies));
        const manifest = await storage.readManifest(id);
        const jobs = await database.queryPostgres<{ count: string }>(
          "SELECT count(*)::text AS count FROM firstmeasure_jobs WHERE type='report.delivery' AND payload_json->>'project_id'=$1", [id]
        );
        assert.equal(jobs.rows[0]?.count, "1", `${kind}: exactly one delivery job`);
        assert.equal(manifest.status, "completed");
        const decisions = (manifest.work_history as any[]).filter(row => ["qa_approved", "manager_approved", "qa_bulk_approved"].includes(row.event));
        assert.equal(decisions.length, 1, `${kind}: exactly one decision history event`);
      } finally { processes.forEach(item => { if (item.child.exitCode == null) item.child.kill(); }); }
    }
  } finally {
    await database.closePostgresPools();
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
});
