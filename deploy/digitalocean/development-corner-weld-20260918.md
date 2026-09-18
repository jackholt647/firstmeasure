# Development generated corner welding — September 18, 2026

Runtime `06b984f518dc4b17bed771a400289648a8f35dfb`; baseline `313e9de52398a367c3f9b159cae0963131bc22b1`. Only wall_geometry.js changes at runtime.

The saved inside corner has about 3 mm plan drift and 23 mm roof-height drift at 18 inches of soffit. The old combined column test rejected the entire junction when either top or bottom failed its tolerance. The new pass groups nearby bottom columns independently, keeping floors with genuine height differences separate. Top clusters retain the existing 10 mm tolerance unless their recorded original roof corners coincide, in which case up to 50 mm of roof fitting discrepancy is reconciled. Splitting, reversing and coalescing generated wall fragments preserve those original-corner references. Larger upper steps remain distinct.

The generated foundation traces the welded wall footprint. Manual wall/base detachment behavior is retained; no saved user edits are rewritten by this deployment.

864 regression tests pass, including the saved corner at 0.2, 1, 1.5 and 2 ft, matching bottom and top vertices, foundation agreement to its existing micrometre coordinate precision, preserved larger roof and floor steps, and nonmutation of inputs. Deployment uses the guarded one-file delta on development only; other runtime files, access and production remain unchanged.

Refresh and regenerate with From Roof to apply to existing generated walls.
