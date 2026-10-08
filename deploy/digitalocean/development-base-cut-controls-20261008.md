# Base drawing controls - October 8, 2026

C with multiple base points now reaches Connect in base mode. In shared wall
selection, base points resolve to the base graph before the loose-wire fallback,
so connecting two perimeter points splits the floor into editable faces.

H on the saved pitched building exposed a small but valid corner region below
the new-face UI area threshold. Graph-generated regions now use the geometry
tolerance while retaining finite-coordinate and triangulation checks.

Validation: 543 of 544 focused editor tests passed. The existing generated
chimney-support face-selection regression fails identically on the unchanged
HEAD; evidence is in output/base-cut-controls-20261008/baseline-test.txt.
New regressions verify shortcut routing, C with a pitched base, H on a saved
base fixture, preserved area, cancellation and undo. Activated commit `3946ce55066c2af5ca605a7c420f25ceaf8935a8` on pool,
worker and compatibility roles. A concurrent web release
`4e78a7a0f68b253835597bf67fa91b8d31d6e23b` preserved the exact same
three editor script hashes and was retained. All four roles passed script-hash,
runtime-identity, health and development-isolation verification. Public assets
match the source commit; both web nodes return 200 for full-house capability
and the saved project. Evidence is under output/base-cut-controls-20261008/.
No saved project or runtime configuration changes.
