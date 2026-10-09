# Base snapping guides - October 8, 2026

Base drawing already called the shared WallSolidGeometry.draftSnap solver, but
consumed only its point and discarded its guide geometry and snap label. Restore
the yellow projected alignment/extension guides and labels from that same solver.
Guide projection uses the selected base plane elevation. Placement, cancellation,
free movement and tool switching clear the overlay. The snapping kernel and its
finite-edge, point, midpoint and guide-intersection decisions are unchanged.

All 47 base editor and sketch control tests passed. New 2D/3D regressions use a
raised, pitched, concave base and verify continuation of the incoming edge,
yellow guide output, exact collinearity of the placed endpoint, plane membership,
and overlay cleanup. Both regressions fail against the previous implementation.
JavaScript syntax and diff whitespace checks passed.

Source c6bd465e7c829b26106c14c4e4b50ad5f78a9a93 was pushed and deployed to
development web, pool and worker. The single owned runtime file matched its
committed hash on all three roles; readiness and development isolation passed.
Internal editor capability and the saved project returned HTTP 200 on both web
nodes. Customer geometry was not written and production was untouched. The
compatibility mirror remains excluded under its previously recorded disk/inode
capacity limitation.
