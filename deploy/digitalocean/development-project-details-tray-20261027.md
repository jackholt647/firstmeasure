# Development release: project details tray (2026-10-27)

Release `0bf560cd` (branch `claude/project-details-tray-80eca4`, on top of `codex/project-reports-measurement-order` at `6c6beb68`) is active on the development legacy (compatibility) and web roles. Browser files only; the worker is unchanged.

Shipped files (three-way merged onto each host's live copy, base `6c6beb68`, no conflicts):

- `public/libraries/apps/project-request/app.js`: the project details tray (header title toggles it; pushes tabs and content; phone sheet), the details form's new home, measurements under the address, order launch from the measurement ordering widget, Overview's Order report action removed.
- `public/libraries/apps/materials/scope-of-work.js`: `mountSidebar(..., {measurementsOnly:true})`, `mountMeasurementStart` (the measurement ordering widget), the "Add a scope with a measurement schema" line removed.

Verification: `rollout.py verify` reported web verified at `0bf560cd`; legacy activation reported `0bf560cd` and `prepare.py legacy` reads it back. The verify step's worker check fails by design (no worker staging for a browser-only release). Served md5 of both files on https://dev.1m8.ai equals the commit's; the live layer copies retired.

Reviewed on dev with Jack's test org (2205 Mimosa Pl) at 1600x1000, 1280x760 and 390x844: tray open/close, measurements fill the remaining column height without an outer scroll, New > Report picker, New > Project widget, Order measurement report starting the unchanged order session (nothing submitted).

Not yet in canonical: the base branch `codex/project-reports-measurement-order` is not merged into `codex/consolidated-firstmeasure-20260923`. Follow-up: `materials/project.js` imports scope-of-work with `?v=20261026-report-documents`; bump it so cached browsers load the new Operations start widget.
