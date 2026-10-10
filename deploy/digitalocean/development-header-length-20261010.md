# Selected line length in the main editor header

Source: `c18e2fc0b187d23686f11da4fb36777f2b1bcfeb` (October 10, 2026).

The selected-line readout now sits in the global header immediately before Google Earth, Street View and Look Around. A reserved 132 px slot with tabular numerals keeps adjacent controls stationary when selection or length changes. The former absolute readout and extra padding in the 3D toolbar are removed.

Roof mode shows the physical sloped length of exactly one selected edge using the image scale and endpoint elevations, independent of the 3D view. Wall and base modes continue using their existing selected-line/preview measurement APIs. Multiple or absent roof selections hide the text while preserving its header space. Existing ReportUnits formatting is retained.

Validation: all 80 wall-mode tests passed, including roof slope/scale, header ownership, cleared and multiple selections, and existing wall readouts. A browser layout fixture using the actual editor header markup and CSS showed zero map-button movement across 5 ft, 120 ft and cleared selections. Evidence is in `output/header-length-20261010/` and `output/header-length-tests.txt`.

All four development roles activated and independently verified at the source release above. Runtime identity, file hashes, readiness and development isolation passed; the public development endpoint returned the same release and matching wall_mode.js hash. Only editor.php and wall_mode.js are overlaid onto each audited role baseline (worker receives the script only). No database, configuration, or production changes. Per-role rollback paths are recorded in the local manifest; restore that role's previous path and verify readiness/isolation.

