# FirstMeasure list report status column — October 6, 2026

Runtime release: `d84177313554eeeac9b7e3ec59301991f619d9a4`.

FirstMeasure-only organizations (Measurements enabled, expanded platform access
off) always have Address and Report status in My Projects list view, including
saved older address-only column preferences. The status cell uses the same report
status logic and pill as other report surfaces. It renders on first load and
refreshes in its own cell, instead of prepending the pill to the address. Sort
uses the existing status comparison. Primary-contact refresh targets its named
cell, independent of column order.

At list-container widths up to 480px, Address and Report status retain separate
columns and headings; other selected fields follow below. The status pill can
wrap within its cell. Expanded platform column choices remain as before.
The project viewer asset version is updated.

Candidate browser checks used a fresh FirstMeasure fixture and saved address-only
column preference. They verified processing in the status cell (never inside
Address), aligned non-overlapping columns at 1440/390/320px, headings/pill at a
250px container, completed status after reload, and rejected status after a live
optimistic update with exactly one pill. Screenshots were reviewed; fixtures
were deleted. JavaScript syntax checking passed. The test deliberately does not
expect a completed report to regress to processing: delivered-report metadata
continues to take precedence, as in the existing implementation.

Audited immutable overlays update only the viewer and asset manifest on web,
compatibility and pool. Role-specific live differences are preserved. Staging
uses detach-before-write hardlink clones and baseline/hash/capacity guards.
Worker and production are excluded. Artifacts and receipts are in
`output/firstmeasure-status-column-20261006/`.

Prior serving release: `4adafff2807963322cea10380cf9365342a6030c`, under
`/opt/firstmeasure/releases/` on web/pool and
`/opt/firstmeasure/releases-root-archive/` on compatibility. Rollback restores
the recorded prior role path, restarts its service and reloads PHP-FPM;
check intervening releases first.

Activation and final verification passed on all three serving roles. Asset hashes
matched; readiness and development outbound isolation passed. Fresh hosted browser
checks passed the status-column behavior, older address-only preference, mobile
and constrained layouts, completed reload and rejected optimistic refresh.
Hosted screenshots were reviewed and the verification fixture was deleted.
