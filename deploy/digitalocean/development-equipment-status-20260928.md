# Equipment status presentation — September 28, 2026

Unit details now show a single full-width Status row with the current status
badge aligned at the right. The duplicate header badge is removed. A scheduled
event title is available in a collapsed Schedule details disclosure, explicitly
labeled Scheduled event; it no longer runs into the status badge. Internal legacy
migration instructions are no longer displayed in the detail form. Status data
and schedule behavior are unchanged.

JavaScript syntax and three focused browser/contracts pass. Browser coverage
includes the Sample trailer reservation example, a single popup status badge,
collapsed/expanded event details, and no status-panel overflow at 360 pixels.
Existing save, icon selection, swatch and disabled-feature coverage also passes.
Tests use synthetic API fixtures.

Deploy only the Equipment frontend asset on both existing development web nodes
from the canonical commit, preserving their verified live baselines. Verify local
readiness, development isolation and hashes, public health/hash and the served
script's browser flow. Evidence: output/equipment-status-20260928/ (ignored).
No backend, database, configuration, topology or production changes.

Rollback: first inspect intervening releases, then restore the previous per-node
release recorded in the receipt through the existing atomic symlink/service
workflow. Recheck readiness and development isolation.
