# FirstMeasure development storage and refresh changes

This is a source change for the canonical development branch, not a production
activation record. Production remains on its isolated hotfix. Existing unrelated
development edits, including the sidebar changes in `core.js`, are preserved.

## Implemented behavior

- Port the production full-detail JSON version cache and missing-thumbnail
  protection. Detail bodies remain available to editors; summary responses are
  explicitly marked and cannot mark a project as fully loaded.
- Batch visible FirstMeasure project summaries in the platform project viewer
  (up to 100 IDs), rather than hydrating every card with a full-detail request.
  Regular polling is two minutes and pauses while the document is hidden.
- Opt-in refresh on the existing project-list route returns changed rows,
  removals, current order and a signed, expiring comparison cursor. The browser
  retains unchanged rows and coalesces concurrent identical requests. Cursor
  state is bounded and isolated by actor/query/page. Every request resolves the
  current session, report permission and visibility; a cursor is not authority.
  Existing list projections and non-opt-in responses are retained.
- Summary revision changes invalidate previously loaded details. Single-summary
  conditional reads also reauthorize before returning `unchanged`.
- A PostgreSQL artifact catalog tracks filenames, sizes, ETags, generation and
  pending writer tokens. Successful writes/deletes update known inventories;
  ambiguous overlap, interrupted writes and failures require reconciliation.
  Catalog updates use short SQL operations; object I/O holds no database client.
  Both project artifact APIs and generic `projects/...` shared-object writes
  participate, including streamed artifact migration writes.
- Catalog reads can eliminate Spaces LISTs for established projects. Full-detail
  JSON bodies are reused only when their object version matches, with a bounded
  128 MiB / 12,000-entry process cache. Thumbnail cache keys use source versions
  when catalog reads are active; missing sources are not probed repeatedly.
- Artifact saves update the known artifact flags without listing storage inside
  the manifest row lock. Explicit flag reconciliation reads storage before taking
  the row lock and preserves concurrently changed flags.
- Async imagery requests persist `imagery.process` jobs in the existing durable
  queue before reporting acceptance. Workers use existing claim renewal/fencing,
  five attempts and delayed, jittered retries. Payloads exclude provider secrets.
  Provider 408/429/5xx errors retry; confirmed coverage failures keep their existing
  classification. Permanent processing problems are recorded for attention.
  Terminal projects are skipped. Existing synchronous processing remains supported.
  Async acceptance avoids a second full storage detail read; initial project
  creation and manifest mirroring still have their existing storage durability
  work. This is not a claim that order acceptance has no external dependencies.
- Numeric storage-operation/attempt latency, failure and throttle aggregates are
  logged each minute. Database pool size, waiting callers, acquisition failures
  and wait durations are logged separately. Job starts record queue age and
  attempt; existing Fastify logs provide route latency/status. No object keys,
  query text, provider URLs, credentials or request bodies are added to metrics.

## Release activation requirements

1. Deploy the verified immutable development commit through the normal workflow;
   include web, worker and compatibility roles. Do not deploy this entire dirty
   checkout or replace production with the development branch.
2. Ensure dedicated workers accept `imagery.process`. If `FIRSTMEASURE_JOB_TYPES`
   is set, add that type while preserving existing types. Deploy workers before
   web so async requests do not accumulate without a consumer. Verify an actual
   development order, worker completion, retries and queue-age metrics.
3. Keep `FIRSTMEASURE_ARTIFACT_CATALOG_READS` unset/false until every artifact
   writer runs the catalog-aware code. Audit external scripts/direct bucket
   uploads. Older binaries cannot maintain this catalog; reads must also be
   disabled before rolling a writer back.
4. After all writers are upgraded, reconcile the existing catalog against Spaces.
   From `public/v1`, run the compiled
   `node dist/src/scripts/firstmeasure_artifact_catalog.js --limit 100` to preview;
   add `--apply` to reconcile. Use `--after <next_after>` to resume and
   `--delay-ms 100` or a higher delay to bound load. Continue until the namespace
   is covered, checking errors and pending writers. The tool never rewrites
   objects or automatically clears pending writer tokens.
5. Then enable `FIRSTMEASURE_ARTIFACT_CATALOG_READS=true` on a canary, verify reads,
   overwrites, deletions and thumbnails, and roll through the fleet. A failed or
   interrupted writer leaves a conservative LIST fallback. Investigate abandoned
   pending tokens before repairing them; do not erase a live writer's token.

Catalog reads intentionally remain unavailable for copy-on-write development
namespaces with `SPACES_READ_FALLBACK_PREFIX`: a mutable fallback may change
without notifying this database. Those environments retain fresh merged listings
and the production JSON/thumbnail protections. Use an independently owned artifact
namespace before enabling authoritative catalog reads; do not silently discard
the overlay or its tombstones.

The refresh cursor is a bounded page comparison, not a database-wide change log.
The server still queries the authorized indexed page. Platform-wide project-list
enumeration/import outside FirstMeasure is not replaced by this change. Capacity
remains finite; this removes repeated object-store work, not provider quotas.

## Verification

- TypeScript check and build; JavaScript syntax checks.
- Refresh additions/removals/order, cursor tampering and scope changes; browser
  cache reconciliation, account isolation and concurrent-request coalescing.
- Summary permission rechecks, including when a client supplies a current revision.
- Real S3-client integration against a local object-store fixture with PostgreSQL:
  100 warm concurrent reads issue zero object-store requests; writes, deletes,
  generic shared writes and overlapping mutations update or reconcile correctly.
- Catalog race/failure tests with `POSTGRES_POOL_MAX=1`.
- Existing imagery/no-coverage, artifact migration, background runtime, pool
  reentrancy and SQLite tests; durable imagery handler and credential exclusions.
- Existing PostgreSQL migration/concurrency/jobs/locks and shared platform session
  tests. Scale fixture: 102,000 projects, 600 reads at concurrency 64; one observed
  run had p95 148.5 ms. This is local synthetic evidence, not a production SLA.

Before a production release, verify customer cards, details/editor, released and
held reports, replacement reports, image overwrite/deletion, orders and worker
recovery on the integrated development deployment. No live provider requests,
customer orders, billing operations or production changes were used for testing.
