# Website-owned login billboard and regional continuity

Release `997e5604700a2ddb7384ef8c4cc5bd54e5b37d57` embeds the website's
`/billboards/login` page directly in one responsive rounded iframe. It has zero
padding/border and disables frame scrolling. The existing desktop 16:10 and
mobile 4:1 formats are retained; the middle-width grid now shrinks without
horizontal overflow. Referral and closed-registration marketing exclusions remain.

EU detection uses the same country list and IANA country map as signup, now in
`public/v1/commerce/region-data.json`. `X-FirstMate-Region: EU` overrides only
billboard presentation. Country headers precede browser time zone and locale.
Main login password/Google signup now forward both browser hints, and the phone
input supports the existing international-number policy without ten-digit
truncation. Existing organization profiles and prices are not migrated.

See [regional billing](../../docs/architecture/regional-billing.md#login-billboard-and-signup-continuity-october-5-2026)
for the exact defaults, EU-versus-Europe distinction, saved profile/order
behavior, trusted-geography limitations and remaining referral-offer work.

## Validation and rollout

Local TypeScript and PHP checks passed. All seven regional-commerce and report
localization tests passed; the regional test now verifies resolved order units
after signup for US, Canada, France, Britain and Japan. Browser checks covered
15 routing/exclusion scenarios, signup hints, international phones and nine
widths from 320px through 1440px. Both external billboard endpoints returned
404; publishing their content remains with the website team.

Development rollout uses the existing immutable per-role overlay workflow,
preserving audited live sources, runtime dependencies and configuration. Owned
payload: login PHP, shared geography JSON, and two region module adapters with
compiled outputs. The worker receives only the regional modules. No production,
database, infrastructure topology or outbound-provider configuration changes.

Evidence and per-role rollback paths: `output/login-billboard-20261005/manifest.json`.
Rollback restores the role's `previous_path`, restarts its development service,
and reloads PHP-FPM for serving roles. The audit recorded one pool node whose
running RELEASE_ID lagged its current symlink; staging checked that actual
runtime identity and readiness separately before activation.

Activation completed on both development web nodes, compatibility and worker.
All four roles verified release identity, owned source/runtime hashes, readiness
and development isolation. Final serving baseline before this release was
`8aff4c10bf64a798e7c0c2633c182f37958e26e2`; the worker retained its own audited
baseline. A concurrent rollout was detected during initial staging and the
serving overlays were rebuilt before activation to preserve it.

Hosted Chromium checks passed for US, France, Britain and the EU request-header
override across 20 responsive layouts (320-1440px), including region hints and
international phone validation. Production remains untouched. The website's
missing content remains the only blocker to a populated billboard.
