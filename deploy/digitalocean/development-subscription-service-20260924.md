# Recurring subscriptions and allowances — September 24, 2026

Final development release: `91046fca06b533a381223366db14161ab78779d9`.
Implementation commits: `f062785`, `5899c82`, `b1b0d17`, `4c91d43` and `91046fc`.

## Delivered

- Automatic recurring Stripe subscriptions, immediate prorated tier changes,
  cancellation, resuming renewal and dedicated subscription card/address management.
- One Billing workspace with credits, subscriptions, usage, payment history and
  statement export. FirstMeasure-only billing keeps its existing fitted layout.
- Automatic collection of month-end usage; customer Pay Invoice actions removed.
- Editable versioned plans, descriptions, highlights and allowances. Standard
  development catalog: SMS Basic $30/1,000 messages; Advanced $100/provisional
  5,000 messages; Enterprise contact/custom plan. Basic AI free; Advanced AI $20
  with placeholder benefits. Storage 10 GB/$5, 100 GB/$15, 1 TB/$50, 10 TB/$250,
  with explicitly provisional development prices.
- Atomic SMS reservations prevent concurrent overspending. At the allowance,
  outgoing messages pause until upgrade/renewal; tier changes preserve usage.
- Storage checks include originals and renditions before persistence, serialize
  competing uploads, credit replaced bytes and retain files after cancellation.
- Enrolled accounts require an SMS subscription and receive the configured free
  storage allowance until they upgrade. Legacy un-enrolled contracts remain intact.

## Verification

- Exact committed source passed Linux TypeScript check and production build.
- Linux domain/API/legacy Stripe/media/communications suite: 27 passes, one browser
  skip. Real Chrome checkout acceptance passed locally, including mobile.
- Publication contracts: 47 passes, one PostgreSQL-specific skip.
- Nine existing UI contracts plus the new unified subscription-controls browser
  test pass. Desktop/phone screenshots were inspected.
- Seventeen billing/subscription tests pass against isolated PostgreSQL schemas;
  each schema was removed after the run. Eleven subscription tests also pass on
  SQLite, covering declines, lost responses, tier allowance carryover, cancellation
  and resumption, automatic usage collection, storage concurrency and enrollment.
- Real Stripe test-mode assertions passed for hosted Checkout, a $30-to-$100 tier
  change charging a $70 difference, cancellation/resumption, card portal and
  `charge_automatically` usage invoices. The initial cleanup could not deactivate
  Stripe's default portal configuration; a follow-up removed the temporary
  customer/subscription and archived prices/product. The default test-mode portal
  configuration remains; no real card or live-mode charge was used.

## Deployment evidence

- Compiled payload SHA-256:
  `65ffb8aee691f2c31c7e9f006d2fb3f510eb80f6d2ca2e89c7ea8d0bb6440ec7`.
- Selected payload SHA-256:
  `fb233d6b7a87c1be51257845609d778827ed680f5254ec95304b42d9a9c019eb`.
- Each role copied its current serving baseline. Company Settings, manifest and
  media upload functions used scoped patches; full backend replacements were
  checked against their pre-change source hashes. No dependencies changed.
- Previous web/pool: `f22d81a5d937e1627672b5da9f8b3b57e9b4d4da`;
  worker: `f48e7b2ae384aa162caab106f7dc978913a368b0`;
  compatibility: `5c63c2adb6d3b9b6bd1ca2bb1d527a7d9ab24f28`.

The main release activated successfully on all four roles. Every role passed
readiness and hash verification, and the worker had no running measurement jobs.
Twenty-four public readiness probes reached both serving instances (13 web,
11 pool), all with the expected release and enforced development isolation.
The three public settings assets matched their deployed hashes. The seven standard
prices were installed idempotently without enrolling or charging any customer.

A follow-up connects the pre-existing Storage settings checkout placeholder to
the same reusable picker/review flow, and exposes purchased capacity through the
effective storage limit consumed by existing upload controls. Its source commit
is `b1b0d17`. The focused browser and eleven subscription checks passed locally;
Linux verification and deployment evidence are recorded below.


## Follow-up verification

The Storage follow-up `b1b0d17e5390620ae08f8a9c9327bbf0c0e4deb2` passed
Linux typecheck/build, eleven subscription tests on SQLite and isolated PostgreSQL,
and the shared storage picker browser check. It activated on all four roles.

A final Stripe test-mode run verified a $70 downgrade credit and a subsequent
$5 usage invoice settled with $0 newly paid. Commit `4c91d43` persists Stripe's
actual paid and remaining amounts for both subscriptions and usage. Statements
therefore do not count account credit as another cash payment or overstate an
outstanding amount. Its Linux typecheck/build, eleven subscription tests and six
unified statement/UI contracts passed. The real Stripe contract and cleanup both
completed successfully.

The accounting payload is explicitly limited to seven billing files. A concurrent
exterior commit appeared in an initial range-based candidate; it was caught by
baseline verification before activation. That inactive candidate was discarded
and rebuilt from the exact billing commit's file list. Compatibility staging also
ran out of disk space. Only the unused `f062785` and failed `4c91d43` copies created
by this task were removed, with active-path and process checks, before restaging.
Existing active releases and unrelated work were preserved.

Accounting compiled archive SHA-256:
`7e218e8c9c887f794e9332527b07b85411a9d07243c56976f8ab71d8e2fe09dd`.
Accounting selected payload SHA-256:
`b29cc5545030bdfa1a73f70e3306a776da7de479eef521f1df64e363f46e6802`.


## Saved-card follow-up

Commit `91046fca06b533a381223366db14161ab78779d9` synchronizes the latest saved
card onto both subscription renewals and already-open automatic usage invoices.
Switching back to a previously used card cannot replay an obsolete assignment.
Payment-creation and invoice-finalization idempotency are retained.
The exact immutable source passed Linux typecheck/build, twelve subscription
checks on SQLite, the same twelve on isolated PostgreSQL, and six unified billing
contracts. PostgreSQL test schemas were removed afterward.

This final delta contains only two billing source files and their two compiled
JavaScript files, based on `4c91d43` on each role. Compatibility needed disk space;
the inactive task-owned `5899c82` copy was removed only after every retained file
was compared with `b1b0d17`, excluding the known five-file follow-up and release
metadata, and current-symlink/process checks proved it was unused. Both recent
rollback releases were retained.

Compiled archive SHA-256:
`b3edc932c359beb00c569fc849915a89126013c4a37c7bd657f727f6e5f9d499`.
Selected payload SHA-256:
`b827889b86df8b33239ec5d299a4e2e143a0d0666875319ee2aac5e597d28503`.


All four development roles activated the saved-card release successfully with
readiness, outbound-isolation and all inherited billing-file hashes verified.
The worker had no running measurement jobs at activation.
Deployed Chrome checks passed at 1440x900, 1366x768, 1280x720, 900x900 and
390x844: only history scrolls, statements stay visible, and outer page overflow is
zero. The actual Test Company remains FirstMeasure-only; client-only fixtures
also verified the combined workspace, controls, statement export and feature-off
fallback, without enrolling a real customer or changing its flags. No browser
page errors occurred. Temporary smoke-test sessions were revoked.

A concurrent unrelated web rollout followed activation (`54fcd99`). Public
readiness briefly returned `draining` during that rollout; final checks verify
the current serving release and preserved billing hashes instead of requiring
the prior release identifier.


Final public verification passed after the concurrent rollout: 24 ready responses
reached both serving instances (14 primary, 10 pool), now on
`54fcd99f4204250534cd12e241fad8c91f3b1c4b`, with development isolation enforced.
Billing backend files and the billing frontend matched their deployed hashes on
all applicable roles; the public manifest, company settings and billing assets
matched the current serving files. The manifest/company retain the concurrent
assistant changes. Evidence is in `output/subscription-card-followup/public-verify.json`.

Source history was merged with concurrent remote work in a detached publication
worktree and pushed without forcing the canonical branch. The shared checkout's
uncommitted work was preserved; its fast-forward was refused because concurrent
assistant edits overlap the incoming committed changes. No stash/reset was used.
