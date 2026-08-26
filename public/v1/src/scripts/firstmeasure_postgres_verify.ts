import { env } from "../config/env.js";
import { closePostgresPools, isFirstMeasurePostgresEnabled, queryPostgres } from "../database/postgres.js";
import { ensureFirstMeasureProjectIndexReady, getFirstMeasureProjectIndexStatus } from "../../firstmeasure/project_index.js";

async function main() {
  if (!isFirstMeasurePostgresEnabled()) {
    throw new Error("Set FIRSTMEASURE_DATABASE_MODE=postgres and DATABASE_URL before running PostgreSQL verification.");
  }
  await ensureFirstMeasureProjectIndexReady();
  const identity = await queryPostgres<{
    database: string;
    username: string;
    server_version: string;
  }>(`
    SELECT current_database() AS database, current_user AS username,
      current_setting('server_version') AS server_version
  `);
  const status = await getFirstMeasureProjectIndexStatus();
  process.stdout.write(`${JSON.stringify({
    ok: status.backfillComplete,
    mode: env.firstmeasureDatabaseMode,
    database: identity.rows[0]?.database,
    username: identity.rows[0]?.username,
    server_version: identity.rows[0]?.server_version,
    projects: status.indexedProjects,
    migration_complete: status.backfillComplete,
    migration_started_at: status.lastRebuildStartedAt,
    migration_finished_at: status.lastRebuildFinishedAt
  }, null, 2)}\n`);
  if (!status.backfillComplete) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closePostgresPools().catch(() => undefined));
