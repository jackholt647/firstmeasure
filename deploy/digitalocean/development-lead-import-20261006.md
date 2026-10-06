# Development lead import — October 6, 2026

The user authorized complete lead import implementation and deployment to
`dev.1m8.ai`. They explicitly selected signed development fixture deliveries
while keeping the production mail route. No production activation is authorized
or performed.

## Release

Application release: `9e63c07a7ff51f30a18773af103ed035f497b2fd`.
Implementation starts at `95b0c1a458188059cbde1b28ba360f9c16a5937a`, with
follow-ups for the test type assertion, project-window API and email capability
checks. Only task-owned changes were committed; unrelated staged and working
changes remain preserved.

Email inboxes, Connections webhooks and API polling now share durable lead
intake. Stable provider identities deduplicate retries. Contact-only inquiries
are supported. Provider fields and connector versions are retained. Interrupted
effects require explicit review rather than automatic replay. Company settings
offers assistant setup for other lead sources and paginated delivery history.
The shared catalog publishes `leads.import` and `lead-import.deliveries`.
See [lead import architecture](../../docs/architecture/lead-import.md).

## Development preparation

The deployment inventories each current role, its source hashes, service process
release and development isolation before preparing an overlay. Existing live
role-specific changes are merged into the artifact; the dirty workspace is not
bulk deployed. Source and transpiled payloads are hashed, syntax-checked and
checked with the role's Linux TypeScript toolchain.

The initial staging capacity check stopped before activation on the web host.
The measured 3,288 directories and 27 symlinks allowed the conservative fixed
metadata allowance to be reduced from 64 MiB to 16 MiB, retaining the 1 GiB
free-space reserve, double overlay allocation and directory/inode bounds.
No historical release was deleted. The unactivated intermediate candidate was
verified and rebuilt in place under the final release identity to avoid retaining
a second duplicate staging tree. Active releases were untouched during staging.

The additive `lead-intake` SqlStore was initialized once against shared
development PostgreSQL before activation. Existing receipts and data are retained.
A private shared `EMAIL_INBOUND_WEBHOOK_TOKEN` was added to the existing protected
development environment file on all four roles. No token is included in source
or this record. It takes effect on service restart. Connections encryption and
its public callback origin remain configured through the existing environment.

The Cloudflare mail worker's real-email route remains `app.1m8.ai`; it is not
redirected to development. The development authenticated inbound endpoint is
verified with signed fixtures, as requested. Connecting a real external lead
provider still requires that account's credentials and provider-side webhook
or API setup. Unsupported verification protocols require a host adapter.

## Validation

- TypeScript check passes.
- Email/intake tests: five pass on SQLite and embedded PostgreSQL, including
  token failures, retry races, generalized trade requests, contact-only leads,
  source/tenant isolation, review, inbox regeneration and action receipts.
- Connections tests: twenty pass on SQLite and embedded PostgreSQL, including
  provider body keys, test-lead suppression, no-effect mapping preview, revoked
  access, pause and snapshot replay.
- Publication suite: fifty pass, one PostgreSQL-specific case skipped in the
  ordinary local invocation.
- Connections and lead-history browser tests pass, including mobile layout,
  source filtering, history pagination and review controls.

## Activation and hosted verification

The guarded rollout activated all four roles after their Linux checks. A
concurrent to-do release changed worker/compatibility baselines and later retained
this import on the web role; those artifacts were re-audited and the registry
changes reconciled rather than overwritten. Subsequent native camera and to-do
follow-ups also retained the import. Verification therefore checks the actual
current source/compiled hashes and process release identity, rather than forcing
an older release ID onto newer development code.

All 145 owned source/compiled hashes match the reviewed role overlays. All four
roles pass readiness, development isolation, the effective private inbound token,
Connections encryption and its development callback origin. Verified current
release identities are `08e24e410c8f40d86c5e6097fca38357252cd373` on web and
compatibility, and `68aebd0cb6304c7f62477e4533c66e041bfdeb68` on worker and
web pool. The original exact-ID public readiness wait was stopped after a newer
concurrent web release appeared; current source hashes and public readiness were
then verified directly. No application rollback was needed.

Signed public requests to `https://dev.1m8.ai/v1/email/inbound/events` and
`/v1/integrations/webhooks/<fixture-org>/<fixture-connection>` pass: authenticated
email and its retry produce one project; a provider body-key webhook suppresses
a test lead and repeated real fixture deliveries produce one additional project.
The isolated fixture has exactly two projects and two imported delivery records,
each with two attempts. Its email intake and connection were paused afterward.
No real customer account or provider subscription was used.

The existing development autoscale-image limitation remains: this rollout updates
the current four roles, without a template change or replacement-node provisioning.

## Recovery

Per-role release receipts retain the prior current path. Restore that symlink and
restart the applicable development service if application rollback is needed.
Keep the additive lead ledger and private configuration. Older application code
that bypasses this ledger does not preserve the new retry protection, so pause
provider delivery before such a rollback. Do not delete receipts or replay an
uncertain delivery. Review its retained project and workflow first.

Ignored local evidence: `output/lead-import-audit/` and
`output/lead-import-dev-20261006/`.

## UI follow-up

[Lead import workspace polish](development-lead-import-ui-20261006.md) records the full-height shared assistant, compact inbox and delivery controls, narrow-screen view switching, browser checks and frontend-only development rollout.
