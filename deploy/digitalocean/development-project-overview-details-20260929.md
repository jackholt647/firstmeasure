# Overview-owned project details — September 29, 2026

Release: `8eaaad2d74244479cda4b603640ebbd9a7336420`.
Previous development release on both web nodes: `490f326db6b303ab37d35dd1a7658aef4256fea3`.

## Behavior and ownership

Overview now contains the former project-details form beside its main content. It retains contacts, address, tags/stages, custom fields, notes and existing order controls, with no second project title. The form is preserved across tab changes and panel rebuilds, including late capability updates.

Scope, Money, Scheduling and legacy Proposals have private content rails within their own tab panels. Their renderers receive a scoped `sidebarRoot`; they no longer overwrite the project-details form. Split panes use the same arrangement. Notes remain accessible at narrow pane widths, and report workflow layout selectors target the tab content.

Removed the configurable modal left-region registry/mounting pipeline, shared left-root/override host APIs, sidebar rollback setting, left-mode presentation interpretation and old shared mobile drawers. Removed obsolete left-mode declarations from first-party registrations. The architecture guide and AGENTS.md explicitly prohibit reintroducing a common mutable column.

## Validation

- Twelve focused tests passed: capability recovery without overwriting edits, asynchronous tab mount races, draft autosave, pin retention and report/mobile ordering sequence.
- Split-layout browser regression passed: docking, selected styling, fixed divider positions, focused-pane replacement, retained drafts and pending-pane closure.
- Full portal browser verification used a disposable development organization: Overview details and form IDs, no duplicate title, notes retained across tab switches, independent Scope and Money rails, docked Overview, notes visible at narrow widths, and no page errors.
- JavaScript syntax and committed whitespace checks passed.

## Deployment

The release overlays only 13 reviewed frontend files: project-request, Overview/FirstMeasure details and exterior selectors, window content layout, affected app adapters, and the manifest. The manifest retains the concurrently committed Projects/Contacts cache-version tags; their implementation files are not included in this overlay. Each predecessor file hash was verified. Other deployed files, production and infrastructure topology are unchanged.

The source commit was built with an isolated index and an explicit file list to preserve concurrently staged work. Unrelated working changes in shared frontend files were excluded.

Rollback by restoring both development web nodes to `490f326db6b303ab37d35dd1a7658aef4256fea3`, restarting the development web/PHP-FPM services and verifying readiness/environment safety using the established guarded workflow.

## Live verification

Both development web instances (`do-598520065`, `do-603124965`) passed readiness and environment safety on this release. All 13 public frontend asset hashes matched the immutable commit; six public readiness checks passed. The full portal test passed again against live assets without overrides, with no page errors. Temporary test organization, identity and session were removed.
