# Document history — development, October 22–23, 2026

Every document now keeps real version history: checkpoints plus structural diffs, recorded on every save with who or
what made it, and a History panel that compares, views and restores versions. Design:
[document history](../../docs/architecture/document-history.md).

## Releases

| Release | What | Roles |
| --- | --- | --- |
| `390437ef` (with `f5cc77b0`) | Revision log (`documents/versions`), lifecycle cuts, History panel, `/revisions` routes, "Edit manually" overrides as their own revisions | worker, legacy (compatibility), web |
| `97553a98` (with `86020667`) | The e-sign seal is its own "Sealed" checkpoint; signers are named; the first revision lists no sections; documents app version bump | worker, legacy, web |

Both are on the canonical branch. Each rollout was a three-way merge onto each host's live files:
- `service.ts` on web and legacy was the older committed `0655b0a9` copy, without Edit as sent's `inputs.js`. This
  release's exact edits were replayed onto it (`output/doc-history-20261022/edit-service.py`). The `manual_edit`
  wrap applies only where `editDocumentAsSent` exists.
- The rewritten `tests/documents-versions.test.ts` shipped whole.

Other sessions activated releases between stages several times: a stage was refused with "Active release changed"
and retried. After the last rollout `audit.py` (read-only) found every change, source and compiled, on web
(`97553a98`), worker and legacy (`865ee7bf`, a later sibling release that kept them).

**Not updated: pool.** The pool host `10.124.16.3` has been unreachable since about 21:00 on October 22 ("No route
to host" from web, no ping). It was also skipped by the estimate structures and labor rollouts. When it is back it
needs this release and the others it missed.

## Storage

Schema 2 of the `document-checkpoints` SQL store adds `document_revisions` and `document_revision_heads`; the dev
PostgreSQL got them on first use (the schema version was raised). Schema 1's `document_checkpoints` table is left
unused. Existing documents start their history with a `baseline` revision of their stored state the first time they
are saved or their history is opened. No FirstMeasure production data is involved; this is dev only.

Measured in the tests (400 single-save revisions of a 60-line estimate): 21 checkpoints, 79 KB stored, against
781 KB for gzip whole copies (10%) and 7.4 MB of JSON (1%).

## Verified on dev

Run in the Sandbox Tester organization (`org_0be79c9db0e60b5a`) through the live API from a signed-in browser, on
the 68 Northfield Rd project. Document `doc_dc39c44f8e2f4657bf3d` went through Jack's flow: create, two edits,
present (the roofing presentation), send from the presentation to `history-check@example.com` (dev catch-all), and
sign as the customer through the public signing endpoints. History lists:

1. Created (checkpoint), Sandbox Tester
2. Edited, 2 saves folded, Sandbox Tester (inputs, title)
3. Presented
4. Presentation choices applied
5. Sent, 3 saves folded, with its snapshot
6. Signed (checkpoint), customer
7. The seal's later save. On release 1 it showed as "Edited by System". Release 2 makes it "Sealed" (checkpoint).

The diff between revisions 6 and 7 read field by field (`signing › final_pdf_hash`).

## Tests

- `tests/documents-versions.test.ts` 5/5: 7,500 randomized patch round trips, storage ratio and tamper detection,
  lifecycle cuts with the signed checkpoint matching the sealed package hash and frozen view, content diff and
  restore, baseline and template publish history.
- `npm run check` clean.
- `document-signing`, `document-seal`, `document-template-pins`, `publication-presentations`,
  `document-payment-checkout`, `roofing-sales-documents` and `portal-signing-access` pass.
- Four tests fail identically on the canonical base without this change (`documents-api` workflow steps,
  `documents-collab` presence 403, `production-documents` payments not ready, `document-signing-ui` modal text).
