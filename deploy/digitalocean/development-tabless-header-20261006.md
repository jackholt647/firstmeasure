# Tabless header and desktop contact spacing — October 6, 2026

Runtime commit: `fce30f38d51bba453466e9b77bd6961e0e9d94ff`.

The shared two-row entity header now sizes its navigation row to rendered content instead of reserving 32px unconditionally. Hidden single-tab bars and empty tab/tray containers leave a 36px desktop identity row. Even one visible tab retains the second row. The shared stylesheet serves loading and loaded project windows; mobile retains its 60px identity row.

Desktop Overview contact headings reserve less space before the fields. The address section uses 20px top padding without a separator; dividers between multiple contacts remain. These spacing changes use the window manager's desktop state, so narrow desktop docks retain desktop behavior and mobile contact spacing remains unchanged.

Validation: six browser tests passed for the shared shell and new tab-row regression, including empty, hidden, single visible tab, tray-only navigation and mobile behavior. Browser-computed styles confirmed desktop address padding/border, heading spacing, inter-contact dividers and unchanged mobile values. Both JavaScript files passed syntax checks.

Deployment is a two-file immutable development overlay, preserving unrelated workspace and live source differences. Evidence: `output/tabless-header-20261006/`. Production and native app binaries are outside this change.

Verified activation on web, compatibility and web-pool roles. Public asset hashes and readiness passed with development isolation enforced. The compatibility host reported existing systemd unit changes on disk; activation and subsequent runtime verification both passed without changing those unit files.
