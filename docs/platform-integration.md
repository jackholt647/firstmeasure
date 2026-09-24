# FirstMate platform integration — local handoff

## Readiness and authorization

**September 19, 2026: the combined checkout is ready for a controlled development trial and test planning.** The implementation and local acceptance checks below are complete. Nothing has been pushed, deployed, installed on a server, or activated. Production readiness still requires the development, provider and load checks described below; local tests do not establish that live customers will experience zero regressions.

User requested the Polish Pass platform on the scaled FirstMeasure infrastructure, with FirstMeasure behavior as the default. Preserve report ordering, projects, credits, results, settings, internal staff workflows and editor behavior. Hide More Apps and other platform features until explicitly enabled. Minor sidebar/account styling changes are acceptable.

## Source baseline

- Worktree: `C:/Users/jackh/.codex/worktrees/firstmate-platform-integration/FirstMeasure`.
- Branch: `codex/firstmate-platform-integration`; changes are local and uncommitted.
- FirstMeasure baseline: `686d3fe` (documentation following development release `3240bc7`). `git cherry` confirmed patch equivalents of production fixes `3cd3958`, `65ca4c0`, `3d424a6` are included.
- Production readiness observed September 19: `3d424a69a869c2ba0b2b8897481af1b0e63c4b68`; development: `3240bc71374eb13dc65852c81a12f26e033fd8c6`. Verify again before a release.
- Platform source: actual working files in `C:/Users/jackh/Code/2026/FirstMate 2.0 Polish Pass`, including its uncommitted work. Its Git head alone (`df139a5c`) is incomplete.
- Original source directories were left untouched. No production database, runtime data or credentials were imported. Initial source hashes and import decisions are in [platform-source-import.json](platform-source-import.json); later reconciliation changes intentionally differ from those initial hashes.
- Current FirstMeasure backend directories `public/v1/firstmeasure` and `public/v1/public-firstmeasure` have no diff from the integration baseline. Shared authentication, platform APIs and frontend integration do change.

## Resulting behavior

Users defaults to the independent `public/libraries/apps/settings/firstmeasure-users.js` variant, extracted from FirstMeasure `686d3fe` and checked against the original working source. Its table, invitation/edit dialogs, role presets, custom permissions, status controls and responsive styles are preserved; it uses shared PlatformAPI user endpoints. Class names are isolated from platform People & Access styling. The newer screen requires `platform.people_access` (default false, requires expanded access). No user or role data migration is involved.

Company settings have three independent default-off platform flags: `platform.company_extended_palette` (supporting colors and palette generation), `platform.company_business_address` (address fields), and `platform.company_advanced_logos` (alternate logos and appearance). Each requires expanded access. With them off, customers get primary/secondary colors, basic company information and one logo. Existing hidden branding/address values are retained.

My Settings (Language and Appearance) requires the default-off `platform.my_settings` capability as well as expanded access. Default FirstMeasure settings are Company, Users, Reports and Billing, subject to the user's existing permissions.

FirstMeasure-only users see My Projects, report ordering, Settings and the account/logout controls. They do not see More Apps or expanded platform navigation. The report form retains address/type, map pins and confirmation, customer/technician/CC fields, notes, pricing, delivery choices, credits and order actions. Expanded users get the newer platform project form and app navigation within the same shell.

Local browser checks cover desktop and mobile ordering, duplicate-address confirmation, cancellation/refund, reordering, simulated credit top-up with automatic order resume, delivered standard/customer reports, summary and XML/CSV downloads, settings and billing. Reopening and reloading a reordered project preserves its current report and notes. Staff authentication, permissions, teams and editor transport have targeted automated coverage; full staff browser journeys belong in the development trial.

Reconciliation fixes include:

- Restored phone/Google authentication, identity locking, recovery, session revocation, remembered accounts and company settings from the newer FirstMeasure baseline.
- Correct FirstMeasure pricing and expedite windows; awaited the asynchronous credit check before order submission.
- Prevented map remounts from discarding pins; corrected fresh-location confirmation, reorder host calls, late form binding and event-listener cleanup.
- Prevented empty form construction/hydration from overwriting project notes. Restored saved technician and CC values without autosaving an incomplete form.
- Reorders replace every current report alias, retain prior measurement IDs as history, and exclude those historical reports from background import. A canceled report can no longer overwrite the reordered project's status.
- Billing resume links the newly queued report back to its platform project and clears the pending submission before attempting link persistence, preventing a second order if that persistence fails.
- Historical error messages in successful billing statements no longer trigger an authentication redirect.
- Restored internal CRM dialer queue/disposition contracts with authenticated staff/capability checks. New platform call-list APIs use shared PostgreSQL on each web node.
- Preserved current PostgreSQL public API keys, canonical FirstMeasure pricing and the current XML parser instead of reinstating older Polish Pass helpers.

## Rollout boundary

`platform.expanded_access` defaults to false for existing and new organizations. `platform.more_apps` is separate, defaults false, and requires expanded access. Existing application settings are retained underneath the master boundary.

An operator can select all organization users or a list of user IDs through authenticated, CSRF-protected `GET/PUT /v1/platform/organizations/:orgId/platform-rollout`. The PUT body is `{ "mode": "selected", "user_ids": ["..."] }` or `{ "mode": "all", "user_ids": [] }`. Configure the audience before enabling the master capability. Capability/app-flag updates remain separate operator operations. The current operator rule requires the designated `notifications@1m8.ai` identity and an eligible administrative role; ordinary company owners cannot grant rollout access to themselves. Additionally, the organization ID must be explicitly listed in deployment-owned `PLATFORM_TEST_ORG_IDS` (comma-separated; empty by default). New organizations never join that list through signup, presets or profile settings. Apply the same allowlist to all web nodes.

The server checks the audience and capabilities, including direct API requests. Frontend hiding is not the security boundary. Signup defaults, presets, user-document edits and concurrent partial settings writes cannot bypass the rollout. Disabling access takes effect on subsequent authenticated requests; an already open page reloads its asset selection when it receives a capability update.

PHP resolves the rollout before loading app scripts. FirstMeasure-only pages skip 76 platform bundles (approximately 5.2 MB of uncompressed JavaScript); the inventory is [platform-deferred-assets.json](platform-deferred-assets.json). Original FirstMeasure scripts and shared shell infrastructure remain. External packages also require expanded access.

Published websites/chat require their app entitlements. Previously issued document links retain historical read access; new public output writes require the document capability, and voided tokens remain rejected. Payment/provider callbacks retain their own verification and settlement behavior.

## Shared infrastructure

The integration retains the FirstMeasure PostgreSQL, Spaces, worker leases, compatibility routing, environment isolation and release layout. Expanded document collections, configuration, presets, devices and CSRF state use the shared core store. Durable realtime events retain private audiences, replay across replicas and use batched polling through the bounded pool.

Application SQL stores now support PostgreSQL for assistant/agents, appointments, equipment, training, work/scopes, workforce/connections/crew, stats, channels/calls, communications/chat/voice, payroll, document collaboration/checkpoints and platform CRM call lists. Explicit local SQLite remains available. Transactions use native SQL variants and share their connection with nested core operations; pool-size-one and rollback/retry initialization tests pass.

`src/platform_worker.ts` runs platform background work separately from clustered web nodes and the existing FirstMeasure workers. It has independent task lanes, renewable claims, fenced reporting writes, scheduled-author revalidation, durable job outcomes and shutdown draining. Interrupted agent work with an uncertain external result is not blindly replayed. Compiled startup, health, shutdown and restart were tested.

Payroll automation events are written in the payroll transaction and forwarded with stable idempotency keys. Transient failures back off; missing organizations/malformed payloads remain blocked audit records; disabled rollout defers work; a bad record does not stall healthy organizations. Work automation runs outside the originating work-store transaction. These choices avoid holding the payroll/work transaction across downstream automation.

Application mutation locks are deliberately conservative and may serialize writes within a store. No production throughput claim has been established for the expanded apps. Mixed-app contention and lazy first-use initialization must be measured in development. Public document-token discovery also retains a broad organization/document lookup from the platform source and needs workload measurement before broad adoption.

The portable external-app registry has no enabled packages. The GEO starter frontend remains as an inactive snapshot under `external-apps/packages/geo`; see its `SOURCE.md`. That source has no GEO backend. `FIRSTMATE_EXTERNAL_APPS_CONFIG` still supports independently deployed packages. The imported public website entry point is `public/sites/index.php`.

## Verification record

All tests below used local fixtures or isolated local PostgreSQL, not production accounts or data. Counts overlap between targeted runs and should not be summed.

| Check | Result |
| --- | --- |
| Final TypeScript production build | Passed (`npm run build`) |
| Changed/imported browser JavaScript syntax | 207 files passed |
| Portal/session/public-site PHP lint | Passed |
| Final customer regressions | 17/17 passed: authentication, capability recovery, reorder host calls, billing resume, notes/history persistence |
| Staff/API regression | 20/20 passed: internal authentication/permissions/teams, editor transport, user initialization and rollout |
| Public document/site/chat entitlement regression | 34/34 passed |
| Billing/calls/payroll/work recovery | 54/54 passed |
| CRM/rollout/assets | 10/10 passed |
| Account switching/session/rollout | 8/8 passed |
| Compiled platform worker | Passed startup, readiness, shutdown and restart |
| PostgreSQL shared stores | 15 store cases passed; orphan-record worker recovery then passed all 3 payroll/stats/worker cases |
| PostgreSQL reporting with pool size one | 5/5 passed |
| Worker/agent lifecycle on local SQLite | 13/13 passed |
| External app host | 2/2 passed |
| Navigation | 49/50 passed; remaining Money layout assertion also fails in untouched Polish Pass |
| Full API run | 854 reported: 835 passed, 17 skipped, 2 failure records for one checklist case (case and parent); corrected afterward, all 28 checklist cases passed |
| Full frontend run | 465 reported: 444 passed, 20 failed, 1 skipped; all 20 failures reproduce in untouched Polish Pass |

Additional PostgreSQL checks cover two-process realtime and document collaboration, rollout audiences, one-slot nested transactions, concurrent credits/claims, migration retry and lease replacement. Explicit index preparation ran twice successfully against an isolated PostgreSQL database. The full API/frontend suites were not rerun after every final targeted correction; the relevant changed areas were rerun as listed above.

The 20 inherited frontend failures are source-contract assertions, not newly introduced failures. They remain visible and unresolved; do not describe the entire suite as green. The focused untouched-source comparison ran 159 tests (139 pass, the same 20 failures). Exact names are listed below.

### Browser acceptance

- FirstMeasure-only desktop sidebar and Settings; no More Apps. Report order, duplicate address, notes/contact/CC, cancellation/refund and processing state.
- Mobile 390×844 report form, pin confirmation, fields, add-ons and $7 order submission.
- Fictional $35 checkout followed by one $7 report order, leaving $28, including automatic resume. No payment provider was connected.
- Reorder updates the existing project's current measurement and status; reload/background refresh keeps the new report and saved note instead of resurrecting the canceled report.
- Delivered standard/customer PDF views, measurement summary and XML/CSV actions using fictional files.
- Expanded pilot navigation, Channels conversation, Stats aggregates and expanded project tabs. More Apps remains hidden. Disabling expanded access returns to the FirstMeasure-only shell and corrects stale disabled routes.

Detailed local output is retained in ignored `public/v1/.integration-*.log` files, including `build-final`, `customer-final`, `staff-final`, `public-entitlements`, `compiled-worker`, `pg-stats-api`, `pg-worker-recovery`, `full-api-3`, `full-ui` and `source-ui-baseline` logs. One-time source merge/codemod/audit artifacts were archived under ignored `public/v1/.tmp/integration-audit`; do not rerun those mutation scripts over this reconciled checkout.

## Prepared operations for a later development trial

No service or migration below has been applied to a remote environment. Read `DEPLOYMENT.md`, recheck the live baseline and agree on the development test plan before deployment.

1. Review the local diff and build a release from this complete checkout. Do not substitute the original dirty source directory or blindly reimport Polish Pass. Start with both rollout capabilities off and the new platform worker stopped.
2. Keep existing FirstMeasure worker/compatibility/Spaces configuration. Clustered web replicas must not start platform schedulers. Verify the aggregate PostgreSQL and memory budget using actual process counts. The observed database connection cap was 100, with web pools of one per process and existing worker/compatibility pools of four; these are observations, not a permanent capacity promise.
3. New application schemas are additive, versioned and transactionally initialized. Run `npm run prepare:platform-indexes` separately against the intended development database before platform jobs. It uses concurrent PostgreSQL DDL outside startup transactions and handles an invalid canceled index. Do not run the old fresh/cutover commands against the live database.
4. Review the uninstalled templates `deploy/digitalocean/firstmate-platform-worker.service.example` and `platform-worker.env.example`. They use compiled code, a separate pool allocation, loopback health on port 3122, and a shutdown timeout longer than the worker drain. Adjust resource/path values for the chosen development host. Existing deployment scripts do not automatically activate this worker.
5. Check FirstMeasure customer and staff journeys with rollout off on the real NGINX/PHP/Spaces stack, including login/recovery/account switching, ordering/top-up/webhook retries, uploads/downloads, assignment/drafting/QA/corrections/delivery, cancellation/refund and existing internal CRM.
6. Enable only a small selected pilot audience, leaving More Apps off. Test permissions across users/organizations and two web replicas; restart the platform worker during jobs; verify scheduled-author revocation, blocked/retry outbox behavior and provider webhook deduplication. Use provider sandboxes and isolated delivery destinations.
7. Run a mixed FirstMeasure/platform load rehearsal. Measure report latency and queue throughput, web/worker CPU and memory, pool waits/connections, transaction lock contention, realtime replay and reporting/backfill load before expanding the audience.
8. Roll back feature exposure by disabling expanded access and stopping the platform worker. Retain additive database schema/data when rolling application code back; inspect pending jobs and external deliveries before a downgrade. Review blocked payroll events before returning them to pending; do not automatically delete audit records.

Existing platform development data was not migrated. Any later data import needs an explicit source inventory and mapping rehearsal; it must not overwrite live FirstMeasure identities, credits or projects.

## Local preview and repeatable checks

The optional preview uses fictional fixtures under `public/v1/.tmp/integration-preview`, loopback ports 3101/8011, disabled outbound email/report workers, mocked Stripe/geocoding responses and blocked backend provider fetches. Its PHP proxy is a development aid and does not support file uploads; production uses NGINX. Fake checkout state is in memory and resets with the preview process.

From `public/v1`, run `node --experimental-sqlite --import tsx scripts/integration-preview.ts --firstmeasure-only`. Optional fixture switches are `--expanded`, `--balance=0` and `--ready-report`. Use these only with that isolated preview. In a second shell from the repository root, set `FIRSTMEASURE_NODE_BASE_URL=http://127.0.0.1:3101/v1/platform`, then start PHP with session name `FIRSTMEASURE_PREVIEW`, a session directory under the preview fixture root, document root `public`, and router `dev/integration-preview-router.php`. The fictional login is printed by the preview script. Do not connect this helper to real provider accounts.

Useful repeat commands from `public/v1`:

```sh
npm run build
node --test tests/portal-auth-errors.test.mjs tests/project-capability-recovery.test.mjs tests/measurement-reorder-host.test.mjs tests/billing-resume-project.test.mjs tests/project-reorder-persistence.test.mjs
node tests/run-embedded-postgres.mjs tests/platform-sql-transaction.test.ts tests/platform-realtime-postgres.test.ts tests/platform-collab-replicas.test.ts tests/platform-worker-runtime.test.ts
node --test ../../tests/external-apps.test.mjs
npm run test:navigation
```

The last command currently retains the inherited Money layout failure. Use `TEST_COMPILED_PLATFORM_WORKER=1` with `tests/platform-worker-runtime.test.ts` after building to check the compiled entry point. Some PHP transport tests require an available PHP cURL extension; full test runs must keep real provider credentials out of the environment.

## Inherited frontend failures

- project-notes keeps its original UI while the model is channels-backed
- project schemas add nested assignment fields without replacing global custom fields
- Doc mode supplies editable-only page scaffolds and a bottom add-page control
- typing formats persist without a highlighted range and colors use a dense shared palette
- website media drops treat nested layout frames as section background space
- visual modes lead the main toolbar and widgets expose object layout controls
- Visual-placed page objects remain draggable and resizable in Doc mode
- Delete removes selected document widgets and images without stealing text-field deletion
- document widget resize edges snap and remain visible outside flow text frames
- Visual editor centers page thumbnails and lists document widgets with catalog icons
- single photos and videos stay in Media while composite photo widgets stay in Widgets
- Media opens the picker directly and Symbols use a large grid
- Calls consumes configured tagged follow-ups instead of project follow-up fields
- shared project, scope builder, and checklist scrollers reserve content clearance
- proposal picker refreshes from project-owned media inventory
- Money owns Payments, Accounts, and Disputes as canonical nested settings views
- Doc Studio owns compact mode only while an editor is active
- terminology assistant is default-off and enforced on both client and server
- shared terminology catalog covers registered portal, project, crew, and settings tabs
- every registered tab declares a terminology key

## Mobile FirstMeasure acceptance follow-up (2026-09-19)

See [firstmeasure-mobile-acceptance.md](firstmeasure-mobile-acceptance.md) for the tested workflows, local fixes, and remaining certification gaps. Mobile testing found functional regressions as well as layout issues; these were fixed locally. One FirstMeasure backend file changed in this follow-up: `public/v1/firstmeasure/project_index.ts` now quotes SQLite FTS literals so email punctuation does not throw a syntax error. PostgreSQL search behavior was not changed. The portal is not yet certified for actual phone browsers, downloads, or live provider flows. Nothing has been deployed or pushed.
