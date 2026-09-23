# AI opening aspect ratios — September 23, 2026

Release `d1dc861aa99315b97e90a24af80d4795c86a91e1`, baseline `7a5daa9c0f35ee5a85e393190610e3a218be0a38`.

New Counts + placements requests return x/y offsets and width as face percentages, plus `aspectRatio` defined as physical opening width divided by height. Geometry derives height from physical width / aspectRatio. Thus a ratio of one produces a square regardless of hidden wall height beneath a soffit. The prompt asks for a perspective-correct opening ratio, with square, wide and tall examples. Derived boxes must still fit the real face; geometry validation skips invalid placements rather than stretching them.

Requests and saved run configuration declare `placementSizing: width-aspect`. Existing browser clients can still use the previous height-percentage schema, and saved old placements retain their dimensions. Evidence shows the returned ratio for new runs. Counts-only behavior is unchanged.

All 86 focused browser, wall-feature and wall-mode tests passed, including square/wide/tall openings on walls of different heights, both request styles, legacy percentages, validation, persistence and undo/redo. PHP lint passed. No live AI call was made for this change.

This three-file runtime delta preserves the existing private PHP project API override and all other runtime files. Local deployment evidence is in ignored `output/exterior-ai-aspect-20260923/`. Production is unchanged.

Activation and readiness verification passed on all three development roles. Both public JavaScript hashes match the release manifest.
