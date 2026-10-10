# Project resource list density — October 10, 2026

The Materials, Labor, Equipment and custom resource panes on the Project tab rendered every line item as a bordered card with stacked, labelled quantity, unit and price boxes (about 100px per item). Items are now dense rows chosen by a pane container query:

- under 360px: two tight lines (name and color; then variant or pay type, quantity, unit, price), 50px;
- from 360px: one 28px line with a column header strip; a variant or product code adds a small second line only where present;
- from 480px: a read-only line total column, and labor rows join the one-line layout.

Each list's Schedule/Order (or labor compensation) controls and the measured/order unit toggle share one toolbar row, Add is a slim row, every section is labelled once a list has more than one, and a list shows its subtotal when its pane holds several lists. Editing, ordering, scheduling, list moves and the domain writers are unchanged; only `renderLineRow`, the list pane markup and the pane styles changed. The script bundle version is `20261010-dense-lists`.

Validation: `node --test tests/project-scope-work-browser.test.mjs` (10 passing), including real rows at 233px columns (two-line rows no taller than 52px, no horizontal overflow, no total column) and at 500px+ columns (one-line rows no taller than 30px with the computed line total). Rendered fixtures were inspected at four-, three- and one-column widths. The hosted modal was not inspected in a signed-in browser session.

Development activation only: release `ec60fd34f55e55d535e80997dcc98dd24bf1854a` over audited `38cf7fe47f1fbea31f7a0bfd06185219d1a10942` baselines on compatibility, web and pool, as immutable hardlink overlays of two owned files merged onto each role's live content (the deployed line-total fix in `listTotals` is retained). The worker serves no library files and stays on its baseline. Each role passed stage, activate and verify; the public readiness endpoint reports the release and `/libraries/apps/materials/project.js` serves the new rows. Rollback: repoint `/opt/firstmeasure/current` to the retained baseline release on each role and restart its development service.
