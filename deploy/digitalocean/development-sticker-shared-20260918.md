# Development shared sticker placement — September 18, 2026

Runtime `47d4779dce649c5f9224b7efbfa700adc1bdd2c2`; baseline `9d5ae2be91dbea3c50798ea42ea6292977ae1470`.

New and copied stickers use stickerPlacement for filtered snap targets and fit/overlap validation, F.placeGroup for a shared translation, and installStickers for draft insertion and selection. Groups retain each shape, dimensions and relative spacing; edge/center candidates include individual stickers and the whole group. Generic geometry paste still handles non-sticker geometry.

T uses shared trim cycling during new placement, copied placement and selected sticker editing. Pasted groups remain face-selected so T continues to apply to all eligible members. The original clipboard and source stickers are not mutated. Sticker paste commits as one undo step and Escape restores the prior model.

897 regression tests pass. New tests cover single/group copies, intentional point snapping, fixed spacing/custom dimensions, preview and placed T, unchanged clipboard, cancellation, shared solver invocation and one-step history. Root files were synchronized after baseline comparison.

Deploy only the two committed wall scripts to development worker, web and legacy. Verify unchanged runtime hashes, readiness, isolation and public script bytes. Production is unchanged.
