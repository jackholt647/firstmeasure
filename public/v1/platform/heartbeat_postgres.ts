import { createPostgresDedicatedClient } from "../src/database/postgres.js";

type ProjectDocument = Record<string, unknown>;
type Candidate = { organization_id: string; id: string; document: ProjectDocument };

export const PROJECT_EVENT_PREDICATE = `collection = 'projects' AND
  CASE WHEN jsonb_typeof(document #> '{data,events}') = 'array'
       THEN jsonb_array_length(document #> '{data,events}') ELSE 0 END > 0`;
export const PROJECT_EVENT_BATCH_SQL = `SELECT organization_id, id, document
  FROM platform_documents WHERE ${PROJECT_EVENT_PREDICATE}
  AND (organization_id, id) > ($1, $2)
  ORDER BY organization_id, id LIMIT 64`;

let cursor: [string, string] = ["", ""];

// A separate session keeps the cluster-wide lock without holding a request-pool
// connection across trigger processing. Closing the session releases the lock,
// including on process failure. Re-reading each batch under the lock prevents
// concurrent heartbeat instances from processing the same stored event state.
export async function runPostgresPlatformHeartbeat(
  processProject: (organizationId: string, document: ProjectDocument) => Promise<void>,
  onProjectError: (error: unknown, organizationId: string) => void
) {
  const client = createPostgresDedicatedClient("firstmeasure-platform-heartbeat");
  let connectionLost: Error | null = null;
  client.on("error", (error: Error) => { connectionLost = error; });
  try {
    await client.connect();
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(1179471169, 1) AS acquired"
    );
    if (!lock.rows[0]?.acquired) return;
    const batch = await client.query<Candidate>(PROJECT_EVENT_BATCH_SQL, cursor);
    const deadline = Date.now() + 20_000;
    let processed = 0;
    for (const row of batch.rows) {
      if (connectionLost) throw connectionLost;
      if (processed > 0 && Date.now() >= deadline) break;
      try {
        await processProject(row.organization_id, row.document);
      } catch (error) {
        onProjectError(error, row.organization_id);
      }
      cursor = [row.organization_id, row.id];
      processed++;
    }
    if (processed === batch.rows.length && batch.rows.length < 64) cursor = ["", ""];
  } finally {
    await client.end();
  }
}
