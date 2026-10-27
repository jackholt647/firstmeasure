# Operations and offered-app handoff — development

Runtime candidate: `a487ec8815cfa0143f1d395eb84a854db427004b`.
Baseline on development web, worker and legacy: `65b356253a4ed8f9f0d0d7cd2ee562c85463eb29`.

Activated and verified on all three development roles. Readiness, outbound isolation and deployed hashes passed. Live browser verification on the current MVP organization confirms Feed is visible on desktop/mobile while Photos remains offered, and terminology resolves to Operations. The saved MVP workflow now reports configuration revision 19 and Operations in its description.

Changes:
- Operations is the shared project-tab default and the MVP preset's terminology (configuration revision 19). The tutorial no longer hides it before measurements.
- Offered apps prepare their scripts without mounting. Activation refreshes guide eligibility before the host redraw, skips the normal setup delay, and fades the advertisement over the mounted app.
- Feed has its own app capability and browser gate; an offered Photos tab no longer disables it.

Each role's payload was built by replaying the committed changes onto its audited live source. Other live changes were retained. The worker's older MVP configuration was reconciled to the current canonical configuration, including the already-established empty launch and report-followup defaults. No production deployment.

Preparation and manifests are in ignored `output/operations-welcome-20261027/`. All roles passed source/output hash checks and Linux TypeScript checks in staged immutable releases. The earlier candidate `553ba777` was staged but never activated; Feed was added before activation.

Regression checks cover welcome preloading without mounting, activation ordering and fade cleanup, mobile/desktop banner layout, guide setup/tour flows, tab switching, Operations visibility before measurements, app entitlements, and Feed availability in a fresh MVP organization. The capability suite retains its unrelated pre-existing missing `platform.collaboration.catalog_stub` assertion.

The map's empty-project welcome and organization/person-scoped open-tray preference were applied through the live layer from `C:/Users/jackh/Code/2026/fm-live-visual-test`; those files retain the separate visual-tweaks chat's uncommitted changes. Live inspection confirmed the current new organization shows an open project tray, “No projects yet” and New project.
