# Development sticker snapping and trim — September 18, 2026

Runtime `598146a875939f3710ed33deb59a88d119708e1b`; baseline `68bc6c78fc269710d2263355b718c49109f8dfbe`.

Sticker placement uses the opening footprint and center without expanding and shrinking it around trim. Trim-derived alignment targets and trim-owned snap primitives are excluded, retaining real boundary geometry. Opening centers are explicit center-to-center targets alongside existing edge alignment. Sticker moves filter trim snap geometry as well.

T on selected placed windows or doors cycles off, 2, 3, 4 and 6 inches without changing opening vertices. It works for drafted and solid stickers and records undoable edits. Trim colors are retained while present; new trim uses the configured default.

873 regression tests pass, including dense nearby trim with identical opening placement across trim widths, different-sized center alignment, solid and freshly placed draft T cycling, unchanged positions and undo records. Root source was updated only after matching the existing baseline.

The guarded three-file delta preserves other public files on all development roles and verifies release identity, readiness and outbound isolation. Production is unchanged. Refresh the editor to load the update.
