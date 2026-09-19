# Development downward edge extrusion — September 18, 2026

Runtime `68bc6c78fc269710d2263355b718c49109f8dfbe`; baseline `8cc783db5112c7b2f9d085b9ebad5d46e9f254ec`.

The line-extrusion face path preserved neighboring boundaries, but the shared edit application still moved every coincident sketch node and loose-line endpoint. This could leave a diagonal unselected wire, especially where downward extrusion leaves the neighboring face unchanged. E now retains original sketch and loose geometry and adds only uncovered original-to-clone connecting segments. Ordinary M movement remains unchanged.

868 tests pass. Added positive and negative 2 ft regressions with a drafted front wall and a loose edge to a remote corner. They verify fixed sketch nodes, unchanged unselected loose edges, complete original-to-clone connections, cancellation and a single undoable commit.

The root files were synchronized after matching their existing baseline. Deployment uses a guarded one-file delta on all three development roles, preserving other runtime files, checking readiness and outbound isolation. Production is unchanged.

Refresh and undo/retry the faulty extrusion; existing saved geometry is not automatically rewritten.
