# Full-house workflow — development rollout

Runtime release: `8661111e894e662f8bf356d921b1370d6bbcb9b6`.

Deployed to **https://dev.1m8.ai** with user authorization. Web, pool,
compatibility and PDF worker all report this release and pass readiness and
development outbound-isolation checks. Nine publicly served editor/portal scripts
match the release hashes. Per-role source and compiled-file verification passed
(27 files on each serving role, 21 on the PDF worker).

The release adds qualified full-house drafting and QA, enforced exterior/gutter
PDF content, synchronized submission, revision-specific QA confirmations, saved
report delivery and conditional QA Quality fields. See
[workflow and pilot configuration](../../docs/full-house-workflow.md).
Organization feature flags and staff qualifications were not enabled. No database
migration, provider change or production activation was performed.

The initial stage used `49c80d359719f6bdd3b4ace4532ed627a6feeb1c`. A concurrent
development release activated before ours; baseline guards stopped our first
activation without switching any role. All roles were re-audited and the overlay
was rebuilt on `d242018a906e89236fbed2db00cb1837682975c9`, preserving that release's
Documents/settings work. Linux TypeScript checks and compiled-source checks passed
on all four final staged roles. Immutable hardlink clones detached updated files
before writing and retained role-specific runtime assets and configuration.

A public readiness request returned 503 during the final node restart. Subsequent
rollout checks and independent final checks passed on all roles and the public
endpoint. No customer emails or charges were created for verification. The local
workflow, captured-delivery and browser/PDF tests are documented in the workflow
notes; a real pilot order still requires explicitly configured organization and
staff flags.

Deployment evidence and rollback paths are in ignored
`output/full-house-deployment-20261006/manifest.json`, `verified-deployment.json`
and `verified-public.json`. The immediate previous release on all roles is
`d242018a906e89236fbed2db00cb1837682975c9`; compatibility uses
`/opt/firstmeasure/releases-root-archive/`, the other roles use
`/opt/firstmeasure/releases/`. Recheck for intervening deployments before rollback.
Restore the recorded previous symlink, restart the corresponding development
service and reload PHP-FPM on serving roles, then verify readiness and isolation.
Keep the coordinated editor/backend PDF recipe at `2026-10-06.1`; already-open
editors should be reloaded.
