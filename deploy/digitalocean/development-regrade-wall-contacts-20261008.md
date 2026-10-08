# Preserve roof contacts during regrading - October 8, 2026

Height-only base changes now retain generated wall stages and map only bottom
edges supported by the old base onto the new base. Upper roof contacts, cleaned
wall footprints and deduplicated layout remain intact. Stage base snapshots
follow the new elevations. Footprint edits still rebuild through construction.

The previous path invalidated all stages; an edited base bypassed From Roof's
roof-envelope reconciliation and recreated walls down through lower structures.

Validation: 101 tests passed, including a layered-roof UI regression, save/reload,
unchanged wall IDs and plan coordinates, fixed top edges, and isolated base
attachment tests. No saved project geometry is rewritten. Already changed
layouts need undo or regeneration before applying a new regrade.
Development verification pending. Evidence: output/regrade-wall-contacts-20261008/.
