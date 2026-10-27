# 1M8-234 reopened: cache-only drafts no longer stand in for orders - development, October 23, 2026

Source `cd6b04f2` on `claude/impersonation-orders-20261023`, cut from production branch `codex/hotfix-20261023d`
(`9ada3dc1`). Not on the canonical branch.

**Report.** Livia, 00:56 UTC: active orders still look cancelled (order button, no expedite or ETA) "when I impersonate
customers with active projects". No account was named.

**What impersonation does (checked).** The internal admin endpoint creates an ordinary platform session for the
customer's own user (`startCustomerImpersonation`); expanded access comes from the organization's capabilities and app
flags load per organization (production: every app-flags and capabilities read since 00:00 UTC returned 200); the portal
has no impersonation-specific code besides the banner. Production has 274 completed orders in a release hold (194
organizations) and 48 awaiting review in the last two days; their list rows (`buildLegacyProjectRow`) carry no `folder`
and a flattened release hold. Those rows render as Processing with no new-order offer in the real app.

**Cause addressed.** Without expanded access projects live only in the browser's per-organization cache. Drafts minted
there before `772f66fb` (seen: `project_mvk3j5kc_ffp4ewq6` at 22:11:58 UTC over held order `3c3c672c...`) stay and can be
reopened in place of the order. `Portal.ProjectStore.discardDraftsShadowingOrders` (project_viewer.js), called by the
FirstMeasure-only order listing (core.js), removes cache-only drafts at a listed order's address that carry nothing of
their own (no report order, proposal, photo, document or note) and were untouched for ten minutes.

**Tests.** `public/v1/tests/order-status-real-app-browser.test.mjs` (5 pass): adds an impersonated customer (support-mode
page flags) with processing, queued and release-held orders in the production row shape, stale and legitimate cached
drafts, the listing pass, and each order opening as Processing with no new-order offer. Related suites and `npm run
check` pass (`project-opening-browser` fails 3 identically on the base).

**Rollout.** `output/draft-cleanup-20261023/`, core.js and project_viewer.js 3-way merged onto live `cb33d4c3` (another
session's release activated during the rollout; legacy and web went first, pool was staged and activated alone after
it settled). All three roles verified on `cd6b04f2`; dev serves the change. Production not changed.
