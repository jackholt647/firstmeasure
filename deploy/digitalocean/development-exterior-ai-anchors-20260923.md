# AI opening anchors — September 23, 2026

Release `ed6d7ed6957809420ba513791c0107b3ecb904a3`, baseline `d1dc861aa99315b97e90a24af80d4795c86a91e1`.

New placement requests use `width-aspect-anchors`, adding required `xAnchor` (left/center/right) and `yAnchor` (top/center/bottom). An anchor aligns the corresponding opening edge or center with that of the upright face bounds. Edge offsets move inward; center offsets are signed, positive right/down. Bottom with y=0 places the opening bottom exactly at the face bottom while preserving width and physical aspect ratio. Prompt examples specifically cover ground-level garage doors, centered squares and raised sills.

Saved evidence includes anchor names and offsets. Legacy width/aspect and percentage-height clients and runs keep their previous coordinate interpretation. Invalid anchors, negative edge offsets, derived overflow, holes and overlap remain rejected; geometry is never stretched to fit. Irregular faces still use upright bounding references and must pass actual outline containment.

All 87 focused tests passed, including all nine anchor combinations, raised bottom offsets, signed center offsets, invalid anchors, both request styles, legacy runs, persistence and undo. PHP lint and JavaScript syntax checks passed. No live AI call was made for this change.

The three-file delta preserves the private PHP project API override and all other runtime files. Local evidence is in ignored `output/exterior-ai-anchors-20260923/`. Production is unchanged.

All three roles activated and passed readiness verification. Both public script hashes matched the release manifest.
