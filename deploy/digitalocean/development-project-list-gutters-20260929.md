# Projects list gutters - September 29, 2026

Development-only release `257c373dacbdb03e3baba301591e5de632f5c011` adds an 8px inset around list content and column headings, an 8px gap between sections, and 4px gaps below group headers and between rows. Rows use 8px rounding and soft highlights instead of full-width divider borders, including mobile. Sticky headers retain an 8px top gutter and replace one another at section boundaries.

Validation: JavaScript syntax and Projects Playwright fixture passed. Browser assertions check inset distances, header/row gap, absent borders, row rounding, stage-pill suppression, sticky takeover, dynamic columns, sorting, view switching and mobile. Desktop and mobile screenshots inspected.

Payload: Projects viewer and its app-manifest bundle token only, over each role's audited live source. Development web, pool and compatibility prior release: `6feed5449d4536cef99d145672e8effa3501350f`. Compatibility manifest differences are preserved. Deployment verifies runtime environment isolation, role/source hashes and prior release before staging or activation; readiness failure automatically rolls back. Production and worker roles are unchanged.

Rollback: restore each development role's `/opt/firstmeasure/current` symlink to `/opt/firstmeasure/releases/6feed5449d4536cef99d145672e8effa3501350f`, restart its development service and PHP-FPM, and confirm development readiness/environment isolation.

Activated and verified on development web, pool and compatibility roles. All runtime/file checks passed with development isolation and outbound safety enforced. Two public frontend asset hashes matched and six public readiness responses passed. The Projects browser fixture passed against the hosted viewer, including spacing, border removal, mobile row styling and sticky-header takeover.
