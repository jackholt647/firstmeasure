# Mobile windows and responsive report layout — October 4, 2026

Runtime source: `f9951cd170bb82b49ba83a99abeaa0d006f8c4da`. Development deployment authorized in the ongoing conversation.

All shared windows now default to full-screen, close-only chrome when the outer portal viewport is at most 760px. The portal header is covered; docking, minimizing, maximizing and moving/resizing are unavailable. Apps can explicitly opt out with `mobileFullscreen: false`. Mobile project titles sit at top left with the padded shared X at top right; multiple tabs sit below, and lone tabs are hidden. The legacy floating mobile report close is suppressed in managed windows.

Overview form sizing now follows its content container rather than competing 30-percent and full-width rules. Narrow desktop docks keep desktop controls and stack a full-width form above the map. Mobile location entry retains map space, and later ordering steps use the form. Redundant Customer Info/Customer information and Property Address labels are suppressed while retaining contact/project-address headings and an accessible address input name.

The deployed window-manager baseline lacked previously committed mobile full-screen handling. Its complete delta was reviewed and reconciled as part of this fix. Other live role differences and unrelated workspace changes were preserved.

## Validation

- Eight shared window/shell browser regressions passed, including default mobile policy, explicit override, iframe chrome, preserved form state, responsive map sizing, and single/multiple tabs.
- The desktop dock close/minimize regression and three report-entry tests passed.
- A temporary FirstMeasure-default development organization exercised the real portal with the exact candidate frontend assets: desktop docks at 740/650/500px, phone viewport at 390x844, address autocomplete, map pin confirmation, next report step, closing and cold reopening a saved project. Map geometry, full viewport coverage, controls and screenshots were inspected. No report was purchased. Browser error list was empty.
- JavaScript syntax checks passed. This release has no backend changes.

## Rollout

All three roles activated and passed final release, hash, readiness and development-isolation verification. All five public assets match their release hashes. Eight hosted browser scenarios passed against the live assets with no interception and zero browser errors; screenshots were inspected after address selection and advancing to the details step. Five frontend files are deployed to the two development web roles and compatibility role. Worker, production, organization feature settings and topology are unchanged.

Evidence: `output/mobile-project-window-20261004/`, including guarded per-role manifest/payloads, browser logs and screenshots. Previous release on all affected roles: `0f89f93cccdac09c997faf616cdaec18e3094d94`. Rollback restores each manifest's previous_path symlink and restarts its development service. Existing autoscale replacement-template limitations are unchanged.
