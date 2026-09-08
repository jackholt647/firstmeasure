import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectManifest } from "../firstmeasure/storage.js";

const databaseUrl = process.env.TEST_POSTGRES_URL || "";

test(`remote metrics work on ${databaseUrl ? "PostgreSQL" : "SQLite"} with identical aggregate semantics`, async () => {
  // The PG variant accepts only the disposable local test database.
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/firstmeasure_test");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-remote-metrics-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = databaseUrl ? "postgres" : "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "index.sqlite");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_ADMIN_URL = "";
  process.env.DATABASE_CA_CERT_PATH = "";
  process.env.POSTGRES_POOL_MAX = "1";
  process.env.POSTGRES_AUTO_MIGRATE = "true";
  process.env.POSTGRES_ALLOW_EMPTY_IMPORT = "true";
  const index = await import("../firstmeasure/project_index.js");
  const storage = await import("../firstmeasure/storage.js");
  const database = await import("../src/database/postgres.js");
  const metrics = await import("../firstmeasure-remote/metrics.js");
  try {
    await index.ensureFirstMeasureProjectIndexReady();
    const today = new Date().toISOString().slice(0,10);
    const previous = new Date(Date.parse(today+"T00:00:00Z")-86400000).toISOString().slice(0,10);
    const tomorrow = new Date(Date.parse(today+"T00:00:00Z")+86400000).toISOString();
    for (const [id,status,day,team,type] of [
      ["remote-a","completed",today,"team-a","residential"],
      ["remote-b","completed",previous,"team-a","commercial"],
      ["remote-c","queued",today,"","residential"],
      ["remote-d","in_progress",previous,"team-b","multifamily"],
      ["remote-instant","completed",today,"team-a","residential"]
    ] as const) {
      await storage.saveManifest(id, { id, schema_version:2, status, project_type:type, team_id:team,
        address:"Synthetic private address must not be returned", owner_email:"private@example.test",
        workflow:{assigned_to:null,reserved_to:null,correction_to:null,history:[]},
        timestamps:{created_at:day+"T12:00:00Z",updated_at:today+"T12:00:00Z",...(status==="completed"?{completed_at:today+"T12:00:00Z"}:{})}
      } as unknown as ProjectManifest);
    }
    const sql = "UPDATE projects SET instant_only = 1 WHERE id = 'remote-instant'";
    if (databaseUrl) await database.queryPostgres(sql);else index.getFirstMeasureProjectIndexDb().exec(sql);
    const summary = await metrics.buildRemoteSummary({timezone:"UTC"});
    assert.deepEqual(summary.projects,{total:4,ordered_today:2,ordered_today_completed:1,completed_today:2});
    const team = await metrics.buildRemoteSummary({timezone:"UTC",team_id:"team-a"});
    assert.deepEqual(team.projects,{total:2,ordered_today:1,ordered_today_completed:1,completed_today:2});
    const daily = await metrics.runRemoteAggregateQuery({group_by:"day",start:previous+"T00:00:00Z",end:tomorrow});
    assert.equal(daily.total,4);
    assert.deepEqual(daily.rows,[{group:previous,project_count:2},{group:today,project_count:2}]);
    const completed = await metrics.runRemoteAggregateQuery({date_field:"completed",group_by:"none",statuses:["completed"],start:today+"T00:00:00Z",end:tomorrow});
    assert.equal(completed.total,2);
    const filtered = await metrics.runRemoteAggregateQuery({group_by:"project_type",project_types:["commercial"],team_id:"team-a"});
    assert.deepEqual(filtered.rows,[{group:"commercial",project_count:1}]);
    assert.equal((await metrics.runRemoteAggregateQuery({statuses:["completed') OR 1=1 --"]})).total,0);
    assert.equal((await metrics.runRemoteAggregateQuery({team_id:"team-a' OR 1=1 --"})).total,0);
    await assert.rejects(metrics.runRemoteAggregateQuery({group_by:"address"}),/group_by must/);
    await assert.rejects(metrics.runRemoteAggregateQuery({date_field:"created; DROP TABLE projects"}),/date_field must/);
    await assert.rejects(metrics.runRemoteAggregateQuery({start:tomorrow,end:today+"T00:00:00Z"}),/start must/);
    await assert.rejects(metrics.buildRemoteSummary({timezone:"Not/AZone"}),/valid IANA/);
    assert.ok(!JSON.stringify([summary,daily,filtered]).includes("private@example.test"));
    assert.ok(!JSON.stringify([summary,daily,filtered]).includes("Synthetic private"));
  } finally {
    await index.closeFirstMeasureProjectIndex();
    await database.closePostgresPools();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("fm-remote-metrics-"));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
