# Report settings beside the sample report; Project Scopes under Configuration (development, October 14)

Commit `d46c3f6a2989ac6c3dbe1a281937a17ae7e27465` on the canonical branch, built on `34d2d8f3`.
Frontend only (`settings/company.js` and the apps manifest): legacy (compatibility), web and pool.

## What changed

- Settings › Reports is two columns: compact report settings on the left, the sample report on
  the right. The sample moved here from Company information, which no longer shows it. The
  sample cover follows the cover toggles as they change, and a list under it shows which pages
  each report includes.
- The header's "future reports only" note and each section's explanation are now `?` tooltips
  instead of text. Every setting has a tooltip describing what it adds (taken from what the
  report PDF builder in `editor_scripts/pdf.js` actually draws).
- Project Scopes no longer has its own entry in the Settings list while Configuration is
  available: it is the last Configuration subtab. Its route stays `sub=project_scopes` (its
  editor uses `settingsView` for its own pages). While it is open, Configuration stays
  highlighted and titled, and the subtab bar shows Configuration's row with Project Scopes
  selected.
- `companyReportPreview` takes the report settings; the logo preview updates in both
  Company information (brand kit) and Reports.

## Checks

- Rendered the Reports pane from the source in a headless browser, wide and narrow: two columns,
  tooltips, and the cover following the toggles.
- Ran the settings test files from scratch archives of the base and of the release. Both had the
  same failures, which already fail on HEAD (missing patterns such as `canScopeFlags`, Money
  views and portal core).
- The updated `app-placement-ui-contract` assertions were checked directly. The test stops
  before reaching them because of an earlier assertion that already fails.

## Rollout

The hosts carried other sessions' deployed, uncommitted Settings edits (about 1,100 lines in
`company.js`). The payload 3-way merged cleanly onto them, changing exactly this release's
337 lines. Two staging attempts stopped on "Active release changed" because other sessions
were activating, and nothing was activated. After the hosts settled on `ee1bbdb5`, the
release was restaged and activated on legacy, web and pool one at a time, and `verify`
passed on all three.

Not verified in a signed-in browser session.
