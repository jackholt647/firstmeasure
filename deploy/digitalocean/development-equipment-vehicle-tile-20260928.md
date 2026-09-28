# Vehicle details on Equipment tiles — September 28, 2026

Equipment tiles show year, make and model as a single descriptive row beneath
the name/type header (for example, 2024 Ford F-150). Missing values are omitted,
and the row is absent if all three are empty. Long descriptions wrap within the
metadata area while the status tag retains its dedicated top-right space.
Values are HTML-escaped. Existing stored fields and autosave behavior are reused.

JavaScript syntax and the three existing Equipment browser/contract checks pass.
Deploy only the Equipment frontend asset over verified live development web
baselines, preserving other work. Verify per-node readiness, development isolation
and hashes, public health/hash and the existing browser flow against the served
script. Evidence: output/equipment-vehicle-tile-20260928/ (ignored).
No backend, database, topology or production changes. Rollback uses the existing
symlink/service workflow and the receipt's previous per-node releases after
checking for intervening work; reverify readiness/isolation afterward.
