# App groups and shared headers — September 30, 2026

Development release `7bab9c551b66f14dca61e302d92fed3a567c109e` is deployed to
`https://dev.1m8.ai`. The user authorized development activation. No production
service, data, provider configuration, DNS, or autoscale template was changed.

Communications, Financials and Payroll declare independently mountable member
apps with organization-configurable grouped/standalone/both/hidden placement and
an explicit default. Shared headers cover the requested global apps, with Doc
Studio retaining a separate folder row. Communications has separate Phone Setup
and App Layout settings; Payroll settings are a tab, and Off-cycle run belongs
to Upcoming payroll. Calling actions belong inside calling views. The new layout
API requires organization authentication, CSRF and company-settings permission
for writes. No organization layout or capability was changed during deployment.
See [the architecture contract](../../docs/architecture/app-groups-and-headers.md).

## Source and staging

Only the task's 17 source, documentation and test files/hunks were committed on
the canonical branch and pushed. A temporary index preserved other sessions'
staged and unstaged changes. Contact, manifest and platform API edits belonging
to other work were excluded from the commit. Each role was inspected over SSH;
development process identity, cookies and release were verified before staging.
The role payloads apply the owned changes over their existing source, retaining
live contact changes and older compatibility/worker differences. Manifest edits
preserve each role's bundle topology and update only owned bundle versions.

The established deployment script cloned immutable release baselines, detached
owned files before writing, checked compiled output against TypeScript source,
and ran full Linux TypeScript checks on all four candidates. Main web and
compatibility used the existing hardlink strategy with a measured 1 GiB free
space reserve. Other roles used their ordinary clone. No release was deleted.
An initial main-web candidate could not invoke npm because that executable was
absent; it was retained as an incomplete candidate, and the successful candidate
ran the installed TypeScript compiler directly through Node before activation.

## Activation and verification

Worker, compatibility, main web and pool web were activated sequentially. Each
activation rechecked the baseline, hashes, readiness, development data environment
and enforced outbound safety. Public readiness was checked before proceeding
between serving nodes. All four roles subsequently passed verification.

- Main web: `fm-dev-web-598520065`.
- Pool web: `fm-dev-web-603124965`.
- Compatibility: `firstmeasure-development-compatibility`.
- Worker: `firstmeasure-development-worker`.

Thirteen served JavaScript assets matched the intended hashes across repeated
public fetches. The layout endpoint returned 401 without authentication. Both
browser tests passed against downloaded deployed scripts: group defaults,
placement, denial, standalone mounting, settings, responsive headers, and actual
Communications/Financials/Payroll rendering. Their domain APIs use isolated
fixtures; they do not place calls, send messages, run payroll or modify company
settings. Local API persistence/isolation tests and payroll export checks passed.
The broader inherited contract suite still has eight sidebar/crew failures.

## Rollback

Each target contains `channels-release.json` with previous paths and owned file
hashes. The prior serving-role release is
`45b3b1f2c336d616805c45ab8539426ea2b72a67`; the worker predecessor is
`538fa1dcf08061c322fd55ff90ea13cee1fcdf28`. Compatibility lives under
`/opt/firstmeasure/releases-root-archive/`; other roles use
`/opt/firstmeasure/releases/`.

Before rollback, verify the current symlink still identifies this release.
Use the established atomic symlink switch, scoped service restart, PHP reload
on serving roles, and readiness/isolation checks. Preserve later releases.
Rollback does not erase saved organization layouts; older code ignores them.
Ignored source snapshots, role payloads, manifests, deployment scripts and hosted
fixtures are retained under `output/app-groups-20260930/`.
