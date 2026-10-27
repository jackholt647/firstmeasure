import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

// 1M8-225: list pages pick their ids before reading manifests. Every page must equal the single sorted query it replaced.
test("project list pages equal the previous single-query pages", { skip: !databaseUrl }, async () => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "legacy-list-page-"));
  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
  await reset.query("CREATE SCHEMA public");
  await reset.end();
  Object.assign(process.env, {
    FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl, DATABASE_ADMIN_URL: databaseUrl,
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "fm"), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "index.sqlite"),
    INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"), PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    POSTGRES_AUTO_MIGRATE: "true", FIRSTMEASURE_JOB_WORKERS: "0", PLATFORM_HEARTBEAT_DISABLED: "1"
  });
  const { buildApp } = await import("../src/app.js");
  const index = await import("../firstmeasure/project_index.js");
  const app = await buildApp();
  await app.ready();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Shared timestamps make sort_ts and updated_at_ms tie, so the id tie-break decides the order too.
    const base = Date.now() - 50 * 86_400_000;
    for (let i = 0; i < 137; i += 1) {
      const at = new Date(base + Math.floor(i / 7) * 3_600_000).toISOString();
      const org = i % 3 === 0 ? "org_list_a" : "org_list_b";
      await index.upsertProjectIndex({
        id: `list-${String((i * 37) % 137).padStart(3, "0")}`, schema_version: 2, status: i % 5 === 0 ? "processing" : "completed",
        organization_id: org, owner_email: `${org}@example.test`, instant_only: i % 11 === 0,
        address: `${100 + i} ${i % 2 ? "Oak" : "Elm"} St, Springfield, MO 65807, USA`,
        timestamps: { created_at: at, queued_at: at, completed_at: at, updated_at: at }
      } as any, { fileNames: i % 4 === 0 ? ["report.pdf"] : [] });
    }

    const previousPage = async (where: string, values: unknown[], order: string, limit: number, offset: number) => {
      const result = await client.query(`SELECT p.id, p.revision::text AS revision FROM projects p WHERE ${where}
        ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
      return result.rows.map((row) => `${row.id}:${row.revision}`);
    };
    const list = async (payload: Record<string, unknown>) => {
      const response = await app.inject({ method: "POST", url: "/v1/firstmeasure/projects/list", payload: { view: "card", include_all: true, ...payload } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const sortOrder = "p.sort_ts DESC, p.updated_at_ms DESC, p.id DESC";
    const cases = [
      { label: "all", payload: { filter: "all", actor: { email: "admin@example.test", roles: ["admin"] }, include_instant_only: true },
        where: "left(p.id, 10) <> 'fullhouse_'", values: [], order: sortOrder },
      { label: "org", payload: { filter: "org", actor: { email: "nobody@example.test", organization_id: "org_list_a" } },
        where: "left(p.id, 10) <> 'fullhouse_' AND p.instant_only = 0 AND ((p.organization_id = $2 AND p.organization_id <> '') OR p.owner_email = $1 OR p.issuer_email = $1 OR p.assigned_to_email = $1)",
        values: ["nobody@example.test", "org_list_a"], order: sortOrder },
      { label: "processing", payload: { filter: "all", status_filter: "processing", actor: { email: "admin@example.test", roles: ["admin"] } },
        where: "left(p.id, 10) <> 'fullhouse_' AND p.instant_only = 0 AND NOT (p.status = 'completed' AND p.has_report_pdf = 1) AND p.status NOT IN ('rejected_no_coverage','rejected','cancelled')",
        values: [], order: sortOrder },
      { label: "search", payload: { filter: "all", search: "oak st", actor: { email: "admin@example.test", roles: ["admin"] } },
        where: "left(p.id, 10) <> 'fullhouse_' AND p.instant_only = 0 AND p.search_vector @@ websearch_to_tsquery('simple', $1)",
        values: ["oak st", "oak st%", "%oak st%"],
        order: `(CASE WHEN p.id_normalized = $1 THEN 220 WHEN p.id_normalized LIKE $2 THEN 140 WHEN p.id_normalized LIKE $3 THEN 80 ELSE 0 END
          + CASE WHEN p.address_normalized = $1 THEN 180 WHEN p.address_normalized LIKE $2 THEN 130 WHEN p.address_normalized LIKE $3 THEN 90 ELSE 0 END
          + CASE WHEN p.resident_name_normalized = $1 THEN 170 WHEN p.resident_name_normalized LIKE $2 THEN 120 WHEN p.resident_name_normalized LIKE $3 THEN 95 ELSE 0 END) DESC,
          ts_rank_cd(p.search_vector, websearch_to_tsquery('simple', $1)) DESC, ${sortOrder}` }
    ];
    for (const entry of cases) {
      const limit = 20;
      const seen: string[] = [];
      let total = 0;
      for (let page = 1; page <= 9; page += 1) {
        const data = await list({ ...entry.payload, limit, page });
        total = data.pagination.total_count;
        const actual = data.projects.map((row: { id: string; revision: string }) => `${row.id}:${row.revision}`);
        assert.deepEqual(actual, await previousPage(entry.where, entry.values, entry.order, limit, (page - 1) * limit), `${entry.label} page ${page}`);
        seen.push(...actual);
      }
      assert.ok(total > 0, entry.label);
      assert.equal(seen.length, Math.min(total, 9 * limit), entry.label);
      assert.equal(new Set(seen).size, seen.length, entry.label);
    }
    // Full rows (the customer portal's view) carry the same manifest-derived fields as before.
    const full = await list({ filter: "org", actor: { email: "nobody@example.test", organization_id: "org_list_a" }, limit: 5, page: 2, view: "full" });
    assert.equal(full.projects.length, 5);
    for (const row of full.projects) assert.match(row.address, /Springfield/);
  } finally {
    await client.end();
    await app.close();
  }
});
