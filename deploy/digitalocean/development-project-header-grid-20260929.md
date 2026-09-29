# Project header control grid — development, September 29, 2026

Source and development web release: `147e3158f5b0ee4ede478499f21ffe0ed732258c`.
Previous release on both web nodes: `499a0ce1903f41cc1e32925b28406b91902abbb4`.

The six project display controls now form two rows of three inside the existing
48-pixel tab header, with Close beside the grid. The separate top bar is removed;
unused tab-header space remains a floating-window drag handle. The left-column
title and folder icon remain in place. Shared minimized-window presentation and
independent project state are preserved.

Tab fitting measures the natural label width against the actual available tab
strip width, which already excludes the control grid and app-owned actions.
ResizeObserver and tab-content observation update the fit after resizing or
app tab changes. Labels collapse to icons before crowding and return when space
permits. At very narrow widths, tabs scroll within their own strip. Existing
mobile icon policies, badges, accessible names and tooltips remain available.

Only `public/libraries/apps/project-request/app.js` was overlaid onto each
verified predecessor release. Concurrent Notes and other workspace edits were
excluded. Both development web nodes were activated sequentially, with guarded
baseline hashes, environment safety, readiness and final asset hash checks.
The public asset hash and six public readiness responses matched the release.

Browser validation passed with the deployed project script: eight retained
projects, all five placements, dragging, independent drafts and close, compact
horizontal minimization, a two-by-three control grid, narrow-window tab fitting,
restored labels and additional app header actions. Shared-window restore (15
interactions) and Contact window regression checks also passed. An authenticated
deployed-portal check preserved an unsent note while independently minimizing,
restoring and closing two projects, with no page errors. The disposable test
organization, identity and session were removed. JavaScript syntax and diff
checks passed. Evidence is in ignored `output/project-header-grid-20260929/`.

Production, other development roles, configuration and schemas were unchanged.
No autoscale image was created; the existing historical image limitation remains.
Rollback requires checking for newer deployments, then atomically restoring the
previous release above and restarting the development web service and PHP FPM
one web node at a time, checking readiness after each activation.
