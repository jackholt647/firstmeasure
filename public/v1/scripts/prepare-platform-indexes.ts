/** Explicit preparation only; concurrent indexes must not run in web startup transactions. */
import { pathToFileURL } from "node:url";
import { closePostgresPools, isFirstMeasurePostgresEnabled, withPostgresClient } from "../src/database/postgres.js";
import { ensurePostgresPlatformStorage } from "../platform/storage_postgres.js";

export async function preparePlatformIndexes() {
  if (!isFirstMeasurePostgresEnabled()) throw new Error("Platform index preparation requires PostgreSQL.");
  await ensurePostgresPlatformStorage();
  return withPostgresClient(async client => {
    // Serialize this explicit maintenance operation across release operators.
    await client.query("SELECT pg_advisory_lock(hashtext('platform-index-preparation'))");
    try {
      await client.query("SET statement_timeout='30min'");
      await client.query("SET lock_timeout='5s'");
      const existing = await client.query("SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='platform_expanded_orgs_idx' AND c.relnamespace=current_schema()::regnamespace");
      if (existing.rows[0]?.indisvalid === false) {
        // A cancelled concurrent build leaves an unusable index. Rebuild only
        // this integration-owned index; never drop core FirstMeasure indexes.
        await client.query("DROP INDEX CONCURRENTLY IF EXISTS platform_expanded_orgs_idx");
      }
      await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS platform_expanded_orgs_idx ON platform_documents(organization_id)
        WHERE collection='global' AND id='global' AND document #> '{data,app_flags,platform,expanded_access}' = 'true'::jsonb`);
      return { index: "platform_expanded_orgs_idx", ready: true };
    } finally {
      await client.query("RESET statement_timeout");
      await client.query("RESET lock_timeout");
      await client.query("SELECT pg_advisory_unlock(hashtext('platform-index-preparation'))");
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await preparePlatformIndexes())); }
  finally { await closePostgresPools(); }
}
