# Development signup sandbox storage repair — September 24, 2026

The signup workflow builder at `https://dev.1m8.ai/portal/signup-sandbox/` returned
`ENOENT: no such file or directory, mkdir 'storage'` from its `/state` API.
The sandbox used a relative JSON directory inside the immutable release, while
development web services can write only to their configured cache. Even if
that directory were writable, separate autoscaled web nodes would have had
different workflow libraries.

Commit `0f1fa56445a3b9ae6a0ed023a4c29b640609cf3a` changes the sandbox to
store workflows, pages, and test-org records in the platform's shared
PostgreSQL control documents when PostgreSQL is enabled. Mutations use the
existing transaction lock. Local file storage remains available for the
single-node development mode, with its fallback placed beside the configured
platform storage root. Deleting a test organization now uses the PostgreSQL
platform deletion functions when appropriate.

The isolated commit was based on exact development release
`4d9aa8674197b36be18b4b186c3861d38199506b`. TypeScript check and build,
the existing experimental signup test, and a new embedded PostgreSQL test
passed. The PostgreSQL test verifies concurrent saves, listing, reading, and
deletion.

Both serving development web nodes were staged from their exact `4d9aa86`
runtime with only the sandbox source, compiled module, and test overlaid.
The payload SHA-256 was
`09d92d60a01f8fbaf2038e9b6ddd44985b06fe56a792e49d9ae2932e4ab1da16`;
source and compiled module hashes were checked before activation. Each node
was activated in turn and reported `0f1fa56`, development data, and enforced
outbound isolation. The `/v1/signup-sandbox/state` request returned HTTP 200
with the same five seeded workflows and 21 pages on each node. Twelve public
requests returned HTTP 200 and the expected state. Production and the
development autoscale image were not changed.

Rollback is the previous immutable `4d9aa86` release on each web node; it
restores the relative storage failure. The autoscale image remains historical,
so a new replacement node still needs the current release before it can serve
the repaired sandbox. Preserve the PostgreSQL sandbox records across rollback.
