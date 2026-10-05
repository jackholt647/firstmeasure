# External connections verification — October 5, 2026

Implementation and operational boundaries: [external connections](external-connections.md).

This work was tested in the shared Windows checkout while other changes were being
made concurrently. The broad repository suites are **not green**. The results below
separate connection coverage from the broad suite snapshots rather than treating
the entire workspace as release-ready.

## Connection checks

| Check | Result |
| --- | --- |
| Full TypeScript check (`npm run check`) | Passed |
| Connection API/runtime with local SQLite | 17 passed |
| Same connection suite using an isolated PostgreSQL server | 17 passed |
| Desktop/mobile Chrome UI | 1 passed |
| Shared publication contracts | 50 passed; 1 PostgreSQL-only test skipped in this command |
| Event catalog and work-store regression tests | 4 passed |
| JavaScript syntax: Connections, Company Settings, shared assistant | Passed |

The PostgreSQL connection suite explicitly asserts that the integration store is
using PostgreSQL. It uses the real application, shared SQL abstraction, external
HTTP transport, QuickJS runtime and publication adapters.

The dummy API exercises irregular response shapes, pagination, snapshots, partial
failures, recovery, incremental checkpoints, tombstones, HTTP redirects, writes,
duplicate receipts, dropped responses, OAuth authorization/rotation and signed
webhooks. Tests also cover:

- User-bound, expiring credential requests; encryption and no plaintext exposure.
- Tenant isolation, disabled operations and write-only grants.
- Version changes, rollback, retained revisions and current authorization.
- Reusable packages without account credentials or grants.
- Organization events, bounded custom code and duplicate event delivery.
- Document and organization-rule usage indexing and cached AI descriptions.
- The real global assistant tool loop with scripted model responses.
- A deliberately blocked sync request while an event automation completes.
- Secure forms in the actual shared chat renderer, read/write selection and
  mobile horizontal-overflow checks.

No live customer/provider credentials were used. Scripted model responses verify
the orchestration and secure widget path, not the quality of a live model's API
research or connector authoring. Real provider account onboarding still needs a
provider-specific smoke test before rollout.

## Broad repository runs

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| All `tests/*.test.ts` | 1,082 | 76 | 24 |
| All `tests/*.test.mjs` | 683 | 102 | 1 |

These are the recorded full-run counts, not adjusted estimates after repairs.
The full backend run exposed two regressions caused by this work: the new event
needed an intentional notification category, and a work-store test teardown
needed to close the newly participating SQL store. Both were fixed and their four
targeted regression tests pass. The Connections browser fixture was also repaired
and rerun successfully after its earlier full-suite failure.

Other broad failures include notification expectations, legacy proposal-signing
flows, capability catalog expectations, UI string contracts and Windows SQLite
fixture-cleanup locks. The shared-assistant browser startup failure on an
`about:blank` fixture was separately reproduced with the unchanged HEAD asset:
its existing relative-URL initialization fails on that fixture. The Connections
browser test runs on a real HTTP origin and passes.

The broad failures have not all been repaired or individually proven pre-existing.
They remain a rollout limitation. No production activation was attempted.

## Evidence and commands

Raw logs, failure inventories and desktop/mobile screenshots are under
`output/integrations-verification/` in the working checkout. Relevant files:

- `connections.txt`, `connections-postgres.txt`, `connections-browser.txt`
- `publication.txt`, `regressions.txt`, `check.txt`
- `backend-final.txt`, `backend-final-failures.json`
- `frontend-full.txt`, `frontend-full-failures.json`
- `connections-desktop.png`, `connections-mobile.png`

Run the focused checks from `public/v1` with `npm run test:integrations`,
`npm run test:integrations:postgres`, `npm run test:integrations:ui`,
`npm run test:publication` and `npm run check`.
