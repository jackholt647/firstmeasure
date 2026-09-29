# Programmable notification delivery - development, September 29, 2026

Source release: `a1378aa16ecfb44208e589073ccabe5155520c9a`, pushed on the canonical branch.

Includes canonical document.signed events, template-inherited document tags,
recipient/method delivery records, quiet hours, grouping, customer-portal copy,
publication-backed programs and bounded background agent repair using existing
credentials/settings. Failure releases default delivery; repairs are versioned.

Staging preserves each role's audited live baseline and unrelated access checks.
Only listed source files and their compiled outputs are overlaid into immutable
release directories. Linux TypeScript checks and source/compiled hashes are required
before activation. The two web roles, worker and compatibility require this release.
The database additions are backward compatible and initialized once against the
isolated development PostgreSQL service before rolling activation.

Validation includes local TypeScript; notification, signing, agent, automation,
scope and publication suites; browser checks for quiet-hours saving and rule toggles;
PostgreSQL schema/read/claim checks using rolled-back temporary fixtures. The legacy
proposal lifecycle test expects the retired signature path; it is not reopened.

Deployment status: verified active on both web nodes, worker and compatibility.
All four passed release identity, changed-file hashes, runtime readiness and enforced
development outbound isolation. Four public frontend hashes and six public readiness
responses passed. The hosted settings script passed quiet-hours saving, rule toggle,
history and mobile-fit checks with mocked API data. Both notification endpoints reject
unauthenticated requests with HTTP 401. Recent logs show zero notification-lane errors
on all four roles. PostgreSQL additive initialization and temporary fixture checks
passed. No production changes were made.
Evidence is in ignored `output/notification-runtime-20260929/`.

## Recorded predecessors

- web: `ed9789df2c4e54db1b74fdc42705bd19dacafca2`
- worker: `ed9789df2c4e54db1b74fdc42705bd19dacafca2`
- legacy: `ed9789df2c4e54db1b74fdc42705bd19dacafca2`
- pool: `ed9789df2c4e54db1b74fdc42705bd19dacafca2`

Rollback must check for intervening releases, restore the corresponding previous
symlink and restart the affected development service (plus PHP-FPM where applicable),
one role at a time. Additive tables can remain; code rollback does not reverse
notifications already sent. Existing autoscale replacement-image limitations remain;
this rollout does not replace nodes or change topology.
