# Development cuts through opening trim — September 18, 2026

Runtime `8d5ae5d37e2e53c72c9528b69632b3f7661d0912`; baseline `598146a875939f3710ed33deb59a88d119708e1b`.

Axis cuts exclude trim surfaces from candidate planes and filter trim-only draft snap primitives. Boundary points on openings are accepted as incident to the adjoining wall. At a genuine corner of a trimmed opening, the adjoining wall is the first candidate; inserted edge points retain existing window-division priority. Trim geometry is not split or imported into a draft by the cut.

285 editor and axis-cut tests pass. The new regression starts at a window corner with 6-inch trim, verifies the first V reaches the outer wall boundary, cycles candidates without importing or modifying trim, cancels atomically and commits one undoable change. Existing window-edge division tests remain passing.

Root files were synchronized after verifying their prior baseline. The guarded one-file delta preserves other runtime files and verifies development identity, readiness and outbound isolation on all three roles. Production is unchanged. Refresh the editor to use the updated tool.
