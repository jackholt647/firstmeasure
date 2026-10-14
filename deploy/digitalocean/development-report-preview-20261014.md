# Report settings: live preview of every report page (development, October 14)

Commit `1ce1aa0b8c907c0b288e76e1717d570483e26491`, built on `0132a997`. Frontend only:
legacy (compatibility), web and pool.

## What changed

- Settings › Reports is half settings, half preview. The preview has two tabs, **Customer
  PDF** and **Internal PDF**. Each shows every page of that report, stacked to scroll through,
  with prev/next buttons, a page counter and a strip of page thumbnails along the bottom.
- `public/libraries/apps/settings/report-preview.js` (new) draws the pages as HTML. It lays them
  out in PDF millimetres using the constants of `measure/internal/editor_scripts/pdf.js`, and
  places text on the same baselines jsPDF uses.
  - Its data is the website's sample report, 9210 NE 37th Pl, Yarrow Point, WA (the
    `report-page-N` renders on the landing pages).
  - The diagrams and imagery are cut from those renders into
    `public/libraries/apps/settings/report-preview/*.webp` (about 390 KB), by
    `output/report-preview-20261014/crop.py`.
  - The gutters page uses the gutter sample's diagram (10181 Stoneridge Terrace, Parker, CO),
    because it is the only gutter sample there is.
- **Customer PDF** ("summary" mode) follows the customer settings:
  - The dynamic cover (Prepared For, the squares figure, pitch/waste/facets, the line breakdown).
  - Each page toggle.
  - The gutters page when chosen.
- **Internal PDF** ("full" mode) has every page and the fixed two-box cover.
- Both use the organization's colours and logo; without a logo, the default FirstMate logo in
  the primary colour.
- The sample is treated as having elevation imagery, a flat section and gutters ordered, so
  every setting shows its page. The page titles are the current code's ("Roof Imagery",
  "Roof Pitch Diagram", …), which are newer than the titles on the website renders.
- The single-page sample (`companyReportPreview`) and its page chips are removed.
- `company.js` loads the preview script the first time Reports renders.

## Checks

- Rendered all 28 pages and compared them side by side with the sample PDF renders. Layout,
  text and tables match closely.
- `tests/report-preview-browser.test.mjs` (new) covers:
  - The page list for each document, and how the customer settings change it.
  - The cover contents.
  - Thumbnail and step paging.
  - That the file stays ASCII.
  - That every image exists.
- It passes, as does `project-cover-browser`.
- The updated `app-placement-ui-contract` assertion was checked directly; the test stops
  earlier on an assertion that already fails on HEAD.

## Rollout

All roles were on `3cd2cc5e`. `company.js` 3-way merged onto the hosts' copies, which carry
other sessions' deployed edits; the merge changed exactly this release's 57 lines. The
manifest bundle version was re-applied to the live text. Images ship byte for byte: the
payload builder hashes them the way `deploy.py` does.

Staged, then activated legacy, web and pool one at a time. `verify` passed on all three.
The script and images are served, and `imagery.webp` is byte-identical to the commit.

The first commit attempt carried the previous task's message; it was rewritten before
anything was deployed. Not verified in a signed-in browser session.
