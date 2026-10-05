# Report project entry and desktop dock controls â€” October 4, 2026

Runtime source: `0f89f93cccdac09c997faf616cdaec18e3094d94`. Browser fixture correction: `c53a216e`. Development deployment explicitly authorized by the user.

`firstmeasure.new_report_project` is an operator-configurable setting with Automatic, On and Off choices. Automatic follows the effective New button mode: a primary New Report starts an unsaved new-project form; the selector menu opens the existing-project picker. FirstMeasure-only organizations already resolve their primary action to New Report. On and Off override this behavior. Existing-project report and reorder entry points retain their target. Opening the form does not itself save a project or submit an order.

Phone ordering now checks the outer portal viewport for managed project windows and split panes. Narrow desktop docks therefore retain desktop ordering and window controls instead of displaying the legacy floating mobile close button over minimize/close. Actual phone viewports retain mobile ordering.

## Validation

- JavaScript syntax and local TypeScript check passed.
- Five report-entry/reorder tests passed, covering defaults, both overrides and existing-project identity.
- Browser resize regression passed at 900, 700, 420 and 800px iframe widths in a desktop portal, including close/minimize clicks and an actual phone viewport check.
- Capability suite: 12/13 passed, including automatic entry and non-expanded access. The unrelated existing Partners capability lacks a catalog stub. Teardown also emitted SQLite worker errors.
- Broader chrome suite has an unrelated old fixture failure: its project-window stub does not provide attach. The new resize regression passes with actual window-manager controls.

## Release

All four development roles passed Linux TypeScript/source checks and activated the runtime release. Release identity, payload hashes, readiness, development session/data isolation and outbound safeguards passed on every role. The public dev.1m8.ai project-request asset matches the release SHA-256, and public readiness reports the new release. Evidence and guarded per-role manifests are in `output/report-project-entry-20261004/`. The payload contains only capability definitions (source and compiled runtime) plus project-request frontend changes on web/compatibility roles; the worker receives only capability definitions. Per-role source differences and unrelated working-tree changes are preserved.

Prior release on all four development roles: `39f6f68f803b9e8da475dfe8c0cbd42fb5223f6b`. Rollback uses each role manifest's previous_path, restores its current symlink and restarts the corresponding development service. Production and infrastructure topology are unchanged.
