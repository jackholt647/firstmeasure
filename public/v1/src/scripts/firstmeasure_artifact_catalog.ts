import { ensurePostgresProjectIndexReady } from '../../firstmeasure/project_index_postgres.js';
import { queryPostgres, getPostgresPool } from '../database/postgres.js';
import { listProjectArtifacts } from '../storage/project_artifacts.js';
import { catalogEnabled, catalogState } from '../storage/artifact_catalog.js';

// Bounded, restartable reconciliation. Listing-only: never rewrites objects or
// clears pending writer tokens. A crashed writer requires an operator audit.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const limit = Math.max(1, Math.min(10_000, Number(option('--limit', '100')) || 100));
const delay = Math.max(50, Number(option('--delay-ms', '100')) || 100);
let after = option('--after', '');
let checked=0, reconciled=0, pending=0;
try {
  if (!catalogEnabled()) throw new Error('Catalog reconciliation requires PostgreSQL and a self-contained Spaces namespace (no read fallback).');
  await ensurePostgresProjectIndexReady();
  while (checked < limit) {
    const batch = await queryPostgres<{id:string}>('SELECT id FROM projects WHERE id>$1 ORDER BY id LIMIT $2', [after, Math.min(50,limit-checked)]);
    if (!batch.rows.length) break;
    for (const {id} of batch.rows) {
      if (args.includes('--apply')) {
        await listProjectArtifacts(id, true, true);
        const state = await catalogState(id);
        if (state?.ready) reconciled++; else pending++;
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
      after=id; checked++;
    }
  }
  console.log(JSON.stringify({ apply:args.includes('--apply'), checked, reconciled, pending, next_after:after }));
} finally { await getPostgresPool().end(); }
