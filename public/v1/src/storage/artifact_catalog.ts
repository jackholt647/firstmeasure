import { randomUUID } from 'node:crypto';
import { isFirstMeasurePostgresEnabled, queryPostgres, withPostgresTransaction } from '../database/postgres.js';
import { env } from '../config/env.js';

export type CatalogEntry = { name: string; size: number; updated_at: string; etag?: string };
type State = { generation: string; ready: boolean; files: CatalogEntry[]; pending: Record<string, string> };
let ready: Promise<unknown> | undefined;
const namespace = () => JSON.stringify([env.spacesEndpoint, env.spacesBucket, env.spacesPrefix, env.spacesReadFallbackPrefix]);
// Enable reads only after every writer is upgraded; writes always invalidate metadata.
export const catalogEnabled = () => isFirstMeasurePostgresEnabled() && !env.spacesReadFallbackPrefix;
export const catalogReadsEnabled = () => catalogEnabled() && process.env.FIRSTMEASURE_ARTIFACT_CATALOG_READS === 'true';

async function ensure() {
  ready ??= withPostgresTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('firstmeasure-artifact-catalog-schema-v1'))");
    await client.query(`CREATE TABLE IF NOT EXISTS firstmeasure_artifact_catalog (
    namespace text NOT NULL, project_id text NOT NULL, generation bigint NOT NULL DEFAULT 0,
    ready boolean NOT NULL DEFAULT false, files jsonb NOT NULL DEFAULT '[]',
    pending jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(namespace, project_id))`);
  }).catch(error => { ready = undefined; throw error; });
  await ready;
}
export async function catalogState(projectId: string): Promise<State | null> {
  if (!catalogEnabled()) return null;
  await ensure();
  const result = await queryPostgres<State>(`SELECT generation::text, ready, files, pending
    FROM firstmeasure_artifact_catalog WHERE namespace=$1 AND project_id=$2`, [namespace(), projectId.toLowerCase()]);
  return result.rows[0] ?? null;
}
export async function beginArtifactWrite(projectId: string) {
  if (!catalogEnabled()) return null;
  await ensure();
  const token = randomUUID(), id = projectId.toLowerCase();
  await queryPostgres(`INSERT INTO firstmeasure_artifact_catalog(namespace,project_id) VALUES($1,$2)
    ON CONFLICT DO NOTHING`, [namespace(), id]);
  // One short SQL statement; no database connection is held during object I/O.
  const result = await queryPostgres<{ generation: string; was_ready: boolean }>(`WITH previous AS (
    SELECT * FROM firstmeasure_artifact_catalog WHERE namespace=$1 AND project_id=$2 FOR UPDATE
  ) UPDATE firstmeasure_artifact_catalog c SET generation=c.generation+1, ready=false,
    pending=c.pending || jsonb_build_object($3::text, now()::text), updated_at=now()
    FROM previous p WHERE c.namespace=p.namespace AND c.project_id=p.project_id
    RETURNING c.generation::text, p.ready AS was_ready`, [namespace(), id, token]);
  await queryPostgres('UPDATE projects SET revision=revision+1 WHERE id=$1', [id]);
  return { ...result.rows[0]!, token, id };
}
export async function finishArtifactWrite(lease: Awaited<ReturnType<typeof beginArtifactWrite>>, name: string, entry?: CatalogEntry | null) {
  if (!lease) return;
  // Overlapping writes, failures and interrupted uploads leave the catalog
  // untrusted. A subsequent successful reconciliation repairs it, never a guess.
  await queryPostgres(`UPDATE firstmeasure_artifact_catalog SET pending=pending-$3,
    files=CASE WHEN generation=$4 AND $5::boolean THEN
      COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(files) x WHERE x->>'name'<>$6),'[]'::jsonb) || $7::jsonb
      ELSE files END,
    ready=(generation=$4 AND $5::boolean AND pending=jsonb_build_object($3::text,pending->>$3)),
    updated_at=now() WHERE namespace=$1 AND project_id=$2`,
    [namespace(), lease.id, lease.token, lease.generation, lease.was_ready && entry !== undefined, name, JSON.stringify(entry ? [entry] : [])]);
  await queryPostgres('UPDATE projects SET revision=revision+1 WHERE id=$1', [lease.id]);
}
export async function reconcileArtifactCatalog(projectId: string, before: State | null, files: CatalogEntry[]) {
  if (!catalogEnabled()) return false;
  await ensure();
  const result = before
    ? await queryPostgres(`UPDATE firstmeasure_artifact_catalog SET files=$3::jsonb, ready=true, updated_at=now()
        WHERE namespace=$1 AND project_id=$2 AND generation=$4 AND pending='{}'::jsonb`,
      [namespace(), projectId.toLowerCase(), JSON.stringify(files), before.generation])
    : await queryPostgres(`INSERT INTO firstmeasure_artifact_catalog(namespace,project_id,files,ready)
        VALUES($1,$2,$3::jsonb,true) ON CONFLICT DO NOTHING`, [namespace(), projectId.toLowerCase(), JSON.stringify(files)]);
  return result.rowCount === 1;
}
