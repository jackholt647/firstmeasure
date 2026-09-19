# Development copied sticker alignment — September 18, 2026

Runtime `4b82d3564e580233785462df2012a33443286c75`; baseline `47d4779dce649c5f9224b7efbfa700adc1bdd2c2`.

The saved project reproduced Copy including one or two unselected wall patches whose corners coincided with the selected window. These extra faces made Paste take the general geometry path instead of shared sticker placement, losing cross-wall window alignment and T trim.

When faces selected for Copy are all stickers, copy their explicit geometry only. General point/geometry copies retain their existing behavior. Single and grouped sticker copies use the existing shared placement, alignment and trim functions without copying unrelated wall patches or diagonals.

899 tests pass. Two new regressions fail before the change and pass afterward, covering coincident wall patches, single/group copies, perpendicular-wall window height snapping, and unchanged placement during T trim. Read-only checks against both affected saved-project windows confirm each copies as one sticker face. Local root files were synchronized only after comparing their prior contents to the isolated checkout baseline.

Deployment is a one-file committed delta to development worker, web and legacy. Unchanged runtime hashes and readiness/isolation are checked by the deployment helper. Production is not activated.
