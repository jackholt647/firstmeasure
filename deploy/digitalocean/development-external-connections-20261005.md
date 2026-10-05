# External Connections — development deployment, October 5, 2026

Connections source commit `b68a81ca1109160d0a8124a4284d00fd0a467b1b` was pushed
on `codex/consolidated-firstmeasure-20260923` and activated on the two serving
development web nodes, worker and compatibility. The user authorized deployment
to `dev.1m8.ai` for testing. Production was not activated.

Settings → Connections uses the shared global assistant in private setup threads,
secure credential forms, integration instructions and reusable connector packages.
Activated resources/actions publish through the existing registries with current
user authorization. See [architecture](../../docs/architecture/external-connections.md)
and [implementation verification](../../docs/architecture/external-connections-verification.md).

## Release preservation and configuration

Each immutable role artifact overlays the owned Connections commit delta on its
audited live source. The final baselines were `14c0d6c350338087955b6f5b766dce76f3ac6a0a`
for both web nodes and compatibility, and `1ce03699e5ae4e6bf883c98a2230ec1684b929b4`
for worker. Baseline guards stopped earlier attempts during concurrent rollouts;
fresh audits preserved their updates. Other staged and uncommitted local work
was excluded from the Connections commit.

Compatibility predates the shared `createAssistant`/`mountSurface` UI. Its artifact
includes the canonical shared assistant frontend needed for native secure forms.
Its older voice API is retained; the new voice authorization insertion applies
only where that endpoint exists. Shared assistant backend changes were merged
into each role's existing implementation. Worker frontend assets were excluded.

Hardlink staging detached all changed files and release metadata, checked capacity
with a 1 GiB reserve, and preserved prior releases. Source and compiled payload
hashes, previous paths and artifact checksums are recorded in the role manifest.

All roles load root-owned mode-0600
`/etc/firstmeasure/connections-development.env` through a dedicated systemd
drop-in. It contains one shared development-only 32-byte encryption key and
`CONNECTIONS_PUBLIC_ORIGIN=https://dev.1m8.ai`. No key is stored in source or
deployment evidence. Runtime checks verified valid encryption configuration and
the callback origin. OAuth still requires the provider application's registered
redirect and credentials.

The integrations SQL store was initialized once against the shared development
PostgreSQL database before activation. Its tables/indexes are additive. Existing
data, provider configuration and outbound safeguards remain in place. The existing
development autoscale-image limitation remains; this rollout updates the current
four roles and does not change topology or provision replacement nodes.

## Verification

- Focused connection suite: 17 passed again before activation.
- All four staged role artifacts passed Linux TypeScript checks, JavaScript
  syntax checks and source/compiled-payload verification.
- Each activated role passed release identity, readiness, development isolation,
  outbound protection and effective Connections configuration checks.
- Six public readiness samples reached both serving instances with the new
  release. Public Connections, Company Settings and assistant asset hashes match.
- The native desktop/mobile browser fixture passed using assets fetched from
  `dev.1m8.ai`, covering secure credential rendering, access selection and layout.
- A real Instant Full Org (`org_6d04533eda982232`, sandbox instance
  `sbi_0dfc2bfdf17e5b17`) passed owner permissions, assistant capabilities and tool
  registration, authenticated hosted Connections endpoints, encrypted synthetic
  credentials, a public API preview, synchronization of three sample records,
  a private shared-assistant thread and agent-tool discovery/paginated reads.
  The test connection was paused and its synthetic credential removed afterward.

The standalone smoke harness initially omitted the app capability bootstrap;
importing the actual server's module bootstrap corrected the harness. No product
code change was needed. The hosted checks invoke real agent tools directly;
they do not certify a live model independently authoring an unfamiliar connector.
Broad-suite limitations remain documented in the implementation verification.

Evidence is under ignored `output/connections-dev-20261005/`, including the
manifest, per-role source snapshots/payloads, Linux checks, configuration script,
schema receipt, hosted smoke result, browser screenshots and public verification.

## Rollback

Inspect intervening releases before reverting. Restore each affected role's
`previous_path` from the manifest/installed `connections-release.json`, restart
its development service, and reload PHP-FPM for serving roles. Verify readiness,
isolation and public traffic one web node at a time. Retain the encryption key and
SQL tables so already-created test accounts and credentials remain recoverable.
Do not copy this development encryption configuration to production.
