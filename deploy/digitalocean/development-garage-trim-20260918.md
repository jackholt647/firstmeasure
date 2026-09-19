# Development garage door trim — September 18, 2026

Runtime `cf2f2d99bd18aeafc104360ed5c8fb654b714fd2`; baseline `c21d3dc6426c1f54360d897b44d8501a40be5b41`.

Garage doors were excluded from sticker trim eligibility. On a selected solid garage face, T therefore fell through to the generic geometry Flip command. Adding trim appeared to rotate the door and skew its lower edge.

WallFeatures now exposes shared trim eligibility for windows, doors and garages. Placed and new garage stickers use that eligibility for T; copied stickers already use the shared trim setter. The Trim panel includes garages. Garage trim is top and sides only, with no threshold, and remains in the garage plane without changing the opening or recess depth.

905 tests pass. Regressions cover cycling T on solid and saved-draft garage faces without entering a transform, unchanged geometry after a full trim cycle, and trim on a rotated 16-by-7-foot garage recessed six inches. Trim retains that plane, perpendicular to the recess returns, and has no bottom strip.

Root files synchronized only after baseline comparison. Deploy the three committed scripts to development worker, web and legacy with baseline and unchanged-file hash verification. Production is not activated. Previously committed accidental flips are not automatically reversed.
