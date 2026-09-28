# Regional billing and signup localization — development, September 25, 2026

## Released

Both serving development web nodes (`do-598520065`, `do-603124965`) run
`4c059e5558a20ca09cacebfc17e66ed6ebf4c51a`. Regional backend source was built
from `6b0dac70eace1970f3527c94323eaaedd1fc20ec` and initially activated as
`b94be726b407047814b819de0cf935d49fce4e5b` on web, worker and compatibility.
The worker remains on `b94be72`; compatibility subsequently received the
concurrent typography release `5685b86f214d81018aab92e312c1b3111b4a885e`.
All 55 regional backend source/runtime files remain verified on both roles.
Production was not changed.

New organizations receive their commercial profile once at signup. US/Canada
retain USD/base prices; EU accounts receive EUR/international prices; unsupported
currencies use USD-backed FirstMeasure credits. International prices initially
use 2× base prices. Subscription currency, credit display and market pricing are
separate. Existing organizations keep their current defaults. No balances,
subscriptions, capability flags, provider configuration or databases were migrated.
See [regional billing architecture](../../docs/architecture/regional-billing.md).

## Source and concurrency

The release was prepared in an isolated worktree based on the canonical remote
branch, using the task's before/after snapshots to preserve unrelated local work.
Commits were pushed without forcing `codex/consolidated-firstmeasure-20260923`.
The shared checkout's unrelated edits and staged mobile changes were untouched.

Current source was compared against all four running development roles. Existing
Forward setup, registry guards and terminology behavior were retained. Concurrent
company typography changes were preserved. A second typography rollout completed
during validation; the final startup correction was limited to four JavaScript
files over its verified `5685b86` web baseline.

The live browser check found that report, measurements and credit screens read
prices before organization settings finished loading. The follow-up initializes
those screens through the commerce readiness callback, including DOM-ready hooks
when the document has already loaded. It also uses the regional roof price for
the credit dialog's report estimate. The corrected live portal has no page errors.

## Verification

- Exact backend source: Linux TypeScript check and build passed.
- 42 Linux regional, Stripe fixture, subscription, billing, exterior-order and
  public API concurrency tests passed; no real card was charged.
- Seven local browser/statement checks passed, including deferred initialization,
  regional displays and desktop/mobile layouts.
- Each activated role passed development readiness and enforced outbound safety.
- Compiled checks confirmed US/Canada $7, France €14, UK/Japan 14 credits.
- Final public sampling: 24 ready responses, 14 from primary and 10 from pool,
  with exact final release identity and development isolation.
- All four changed public assets match their published hashes. Sixty-five
  inherited/updated regional files match on both web nodes; the concurrently
  updated company settings files agree between the nodes and were exercised live.
- Authenticated public Test Company check: commerce API and client both report
  USD/base prices, company Billing opens, and its actual Add Credit button opens
  the dialog. Desktop and mobile screenshots were inspected; no page errors.
- Temporary verification sessions were revoked. No payment was submitted.

The earlier broader publication suite's assistant-inventory mismatch remains
outside this change. The existing development autoscale-image limitation also
remains: this rollout verifies the running nodes, not a newly provisioned
replacement. No pool/template/topology change was performed.

## Artifacts and rollback

Evidence is in ignored `output/regional-deploy-20260925/`; the initial rollout
records are retained in its `initial/` subdirectory. Each new release has
`regional-billing-release.json`. Staging shares unchanged immutable files with
the preceding release and replaces every changed file with a fresh inode, which
preserved rollback releases despite low compatibility disk space. No old releases
were removed.

Final frontend payload SHA-256: `0e8c094b6142abb78f2a77bd38e3ad01be0d3b5636568027f018de20c5b4686a`.
Initial regional payload SHA-256: `2963c3498d17379f889437d9689f70bc0ec1674210b79348c2ea1f286376a7f9`.

Rollback of the four-file startup follow-up: restore each web node's
`/opt/firstmeasure/current` symlink to `5685b86f214d81018aab92e312c1b3111b4a885e`,
restart `firstmeasure-development-web.service` and `php8.3-fpm.service`, and verify
readiness on `http://127.0.0.1:3201`. That predecessor contains the startup defect;
prefer a forward correction. Full regional rollback must reconcile the current
concurrent release and any organizations created since activation. The original
pre-regional baselines were `dce04deb83782c5cab61ead3e74157aaa6c6ff49` on web and
compatibility and `91046fca06b533a381223366db14161ab78779d9` on the worker.
