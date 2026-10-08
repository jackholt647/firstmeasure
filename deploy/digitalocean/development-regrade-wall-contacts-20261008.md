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
Activated source commit `cda9837ec5fc15ee531a7995993e206de75af633`. Both web nodes subsequently adopted concurrent release `f0d720c893796120f106af4fa1c0a303df7ee507` with the exact same two editor hashes; worker and compatibility remain on the source release. All four roles passed hashes, runtime identity, readiness and development isolation. Public assets match; saved-project access returned 200 on both web nodes. Evidence: output/regrade-wall-contacts-20261008/.
