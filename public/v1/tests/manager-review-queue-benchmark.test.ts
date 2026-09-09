import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();
test("isolated native queue benchmark: 1249 historical samples, one PostgreSQL connection", { skip: !databaseUrl }, async () => {
  const target = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "benchmark requires an isolated local PostgreSQL instance");
  assert.equal(target.pathname, "/firstmeasure_test", "benchmark may reset only the embedded test database");
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-queue-benchmark-"));
  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
  await reset.query("CREATE SCHEMA public");
  await reset.end();
  Object.assign(process.env, {
    FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl,
    DATABASE_ADMIN_URL: databaseUrl, FIRSTMEASURE_STORAGE_ROOT: root, INTERNAL_STORAGE_ROOT: path.join(root, "internal"),
    PLATFORM_STORAGE_ROOT: path.join(root, "platform"), POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "true",
    POSTGRES_ALLOW_EMPTY_IMPORT: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local", FIRSTMEASURE_JOB_WORKERS: "0"
  });
  const count = 1249, sampleDate = "2026-09-09";
  const ids = Array.from({ length: count }, (_, i) => `historical-${i}`);
  try {
    for (let start = 0; start < count; start += 50) {
      await Promise.all(ids.slice(start, start + 50).map(async (id) => {
        const dir = path.join(root, "projects", id);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ id, status: "completed", address: id,
          timestamps: { created_at: "2026-07-01 00:00:00", updated_at: "2026-07-01 00:00:00", completed_at: "2026-07-01 00:00:00" } }));
        await Promise.all(["app_metadata.json", "pdf_state.json", "branding_defaults.json"].map((file) =>
          writeFile(path.join(dir, file), JSON.stringify({ fixture: "x".repeat(2048) }))));
      }));
    }
    const [storage, index, database] = await Promise.all([import("../firstmeasure/storage.js"), import("../firstmeasure/project_index.js"), import("../src/database/postgres.js")]);
    try {
      await index.ensureFirstMeasureProjectIndexReady();
      const bulk = await index.readIndexedProjectManifestsByIds([...ids, ids[0]!, "nonexistent"]);
      assert.equal(bulk.length, count, "bulk lookup spans multiple chunks, deduplicates, and omits missing rows");
      assert.deepEqual(await index.readIndexedProjectManifestsByIds([]), []);
      const current = await readFile(new URL("../internal/api.ts", import.meta.url), "utf8");
      const before = execFileSync("git", ["show", "64db594b1e1265ad8886087510bdb9e609d92db1:public/v1/internal/api.ts"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      const timings: Record<string, number> = {};
      for (const [name, source] of [["before", before], ["after", current]] as const) {
        const method = source.slice(source.indexOf("async function managerReviewData("), source.indexOf("function managerReviewAggregate("));
        const sample = { id: sampleDate, data: { sample_date: sampleDate, entries: ids.map((project_id) => ({ project_id })) } };
        let saves = 0;
        const context = vm.createContext({
          requireManagerReviewResultsAccess: async () => {}, requireManagerReviewAccess: async () => {},
          managerReviewSettings: async () => ({ daily_target: count }), managerReviewSampleDate: () => sampleDate,
          managerReviewQueryProjects: async () => [], listInternalDocuments: async () => [sample],
          managerReviewDocumentData: (v: { data?: unknown } | undefined) => v?.data || {},
          managerReviewText: (...v: unknown[]) => v.find((x) => String(x ?? "").trim()) || "",
          managerReviewAuditRecord: () => null, managerReviewStratifiedCandidates: () => [],
          managerReviewSampleEntry: (v: unknown) => v, managerReviewProjectRow: (v: unknown) => v,
          asObject: (v: unknown) => v || {}, saveInternalDocument: async () => { saves++; return sample; },
          getProjectDetail: storage.getProjectDetail, readManifest: storage.readManifest,
          readIndexedProjectManifestsByIds: index.readIndexedProjectManifestsByIds
        });
        vm.runInContext(ts.transpileModule(method, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
        const started = performance.now();
        const result = await vm.runInContext("managerReviewData({}, {}, false)", context);
        timings[name] = Math.round(performance.now() - started);
        assert.equal(result.projects.length, count);
        assert.equal(saves, 1, "sample write is stubbed in memory only");
      }
      console.log(JSON.stringify({ benchmark: "native historical queue", projects: count, pool: 1, timings_ms: timings }));
      assert.ok(timings.after! < timings.before!, "bulk manifest hydration should beat full native editor bundles");
    } finally { await database.closePostgresPools(); }
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("qa-queue-benchmark-"));
    await rm(root, { recursive: true, force: true });
  }
});
