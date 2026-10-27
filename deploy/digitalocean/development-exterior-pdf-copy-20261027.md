# Full Exterior Report title and removed notes — development, October 27, 2026

Release `1584597b` (parent `e56c9ca7`), on development legacy and web, and on the worker for its source files only.
Made by a side session on `claude/wizardly-heisenberg-9cc71e` (`f5bede88`), rebuilt on canonical and integrated into
`codex/consolidated-firstmeasure-20260923`.

**Change.**

- A report with Full Exterior pages, and a full-house customer summary, is titled "Full Exterior Report" on its
  cover and in the PDF's metadata title (`pdf.js`, new language key). Roof-only reports keep their titles.
- Removed from the exterior pages (`exterior_pdf.js`):
  - Exterior Summary: the note about wall IDs and every face being counted once. The house drawing now extends
    to the even bottom margin.
  - Hidden Wall Faces: "They are listed here so every face is counted once." The first sentence stays.
  - Material Allowances: the note about waste percentages and horizontal returns.
- The removed keys were dropped from `catalog-source.json`, `catalog-overrides.json`, the 15 language packs and
  `translation-context.json`. The `reports` catalog was rebuilt as `reports.349636fea983bcc9.json`.

**Integration.** Another session has staged, uncommitted edits in 17 of these files (catalog manifest, catalog
source, language packs). `output/pdf-copy-20261027/integrate.py` moved canonical by compare-and-swap and merged the
change into their staged and working copies, so their edits stay staged. In the manifest only the `reports` line
was swapped, because their re-hashed neighbouring lines conflict textually.

**Tests.** `exterior-pdf-layout`, `exterior-report`, `pdf-landscape`, `report-localization` and
`exterior-orientation`: 59/59. Server `platform-localization` and `report-localization`: 9/9.
`localization-catalogs.mjs --check` fails with "Stale terminology contract", and it fails the same way on the base
`e56c9ca7`, so the failure predates this change.

**Rollout.** `output/pdf-copy-20261027/`, with `ship.sh` taking `ROLES`.

- On legacy and web, the catalog manifest's `reports` line is replayed onto each host's live file, since their
  neighbouring lines differ from canonical.
- `translation-context.json` keeps each host's copy. Hosts carry a 4 KB stub without report messages, and nothing
  reads that file at runtime.
- The first ship activated the worker, which received only the inert `public/v1` source JSONs. Legacy refused
  because another session activated a release meanwhile. Legacy and web were re-shipped after dev's health check
  returned: staged, activated and verified.
- Dev serves `exterior_pdf.js`, `pdf.js`, `exterior_cover.js` and the new reports catalog with the release's
  hashes, and the served catalog manifest points at it.

**Checked.** The pages were rendered locally from the released `exterior_pdf.js` with the pilot house's saved
report state (Exterior Summary, Hidden Wall Faces, Exterior Quantities and Material Allowances). The three notes
are gone, and no blank space is left. No PDF was generated in a dev project.

**Not covered.** The worker's server-side PDF runtime still loads its own older editor scripts (see
`development-exterior-trim-20261023.md`), so a server-rendered PDF keeps the old title and notes until the worker's
editor scripts are updated.
