# Shared entity window layouts — development

Source release: `0841d03a7792e56cc53c850874aa5adde85bfc65`.
Target: https://dev.1m8.ai; user-authorized development rollout only.

Projects and Contacts share declarative tabs, optional persistent sidebar,
weighted ordered panes, tray selection and common window chrome. Contacts retain
their details sidebar; project apps retain their own content rails. See
[layout API](../../docs/architecture/window-shell.md).

The scoped commit excludes concurrent notes, feedback and other uncommitted work.
Role-specific manifests retain their existing app entries with only owned cache
versions changed. Compatibility lacked the prior retained-window/content-rail
integration, so its Contact modal, Project modal and Overview declaration use
the committed canonical implementations required by this shell. Other role
source and runtime files are retained.

Validation: six original browser checks, JavaScript syntax and TypeScript checks
passed. Six browser checks also passed against the staged web and compatibility
payloads with mocked domain APIs. They cover ratios/order, draft retention,
optional sidebar/tabs/trays, validation, minimize/restore and retained project
reopen/error recovery. This does not claim authenticated end-to-end UI coverage.

Staging encountered the web host's low free disk space and concurrent development
activation. Baseline guards stopped before activation; the inventory was refreshed.
Frontend-only staging uses hardlink clones on each source filesystem, atomic
replacement of every changed asset/receipt/environment file, and a second live
hash check proving staging did not mutate current files. Space budgeting reserves
1 GiB plus 256 MiB metadata and ten times the compressed overlay size. No releases
were deleted. Compatibility's current physical parent was verified as
`/opt/firstmeasure/releases-root-archive`; that existing filesystem was retained.

Previous serving release on web, pool and compatibility:
`1e0858b281c905950e7d6476d67357d77f37e123`.
The worker is unaffected by this frontend-only release. There are no database,
provider, organization flag, production or topology changes.

Rollback: check for later deployments before restoring each role's recorded
previous immutable release symlink. Restart only that development role and
PHP-FPM; verify development identity, readiness and enforced outbound safety.
Per-role source hashes, previous paths, artifacts and deployment receipts are
retained in ignored `output/window-shell-20260930/` and the release's
`channels-release.json`.

Completion: web, pool and compatibility independently verified release 0841d03a. Public readiness passed with development outbound safety enforced. All eight public assets matched expected role hashes on three fetches each. Three focused browser tests passed again using scripts downloaded from dev.1m8.ai (mocked domain APIs). Reload the portal to recreate retained project frames with the new shell.
