# Lead import workspace polish — October 6, 2026

Runtime source: `fbb237f39b3dfac8d097acf580be3c9e0c624dbd`, following active-pane sizing `c1649ee3a754b395190ea33f211b830c5d904c3d` and the main UI change `abcc54c27af90740e152d5b9891d1098b1c9f8e8` on `codex/consolidated-firstmeasure-20260923`.

## Layout

Lead import now uses a bounded workspace. The unique inbox, connected sources and recent deliveries occupy the independently scrolling left side; the existing shared assistant starts alongside them and fills the available height. Connect source prepares a branch-specific draft in that assistant instead of adding a 650-pixel panel underneath delivery history. Credentials, connection conversation ownership and intake APIs retain their existing architecture.

Inbox actions and delivery actions use content-sized buttons. Sources use compact rows with status pills; delivery IDs truncate visually while retaining the full title, and long source identifiers wrap. Connected-source details replace the workspace temporarily with a visible return control. The assistant is retained once, and remounting inbox settings disposes the old surface and event subscription.

On narrow screens, Sources & deliveries and Assistant switch views within the available height. The composer stays visible instead of sitting beneath a long stack. Sizing applies only while the Lead import pane is active; leaving the tab hides the workspace.

## Verification

`node --test tests/lead-import-browser.test.mjs tests/integrations-browser.test.mjs` passes all three browser tests. Coverage includes source filtering and opening/returning, history pagination, project opening, uncertain-delivery review, compact toolbar and review-action geometry, top-aligned assistant, independent scrolling, real shared assistant and inbox rendering, phone view switching, composer visibility, no horizontal overflow, disposal and inactive pane visibility. Source JavaScript passes `node --check`.

Screenshots and guarded deployment evidence are under ignored `output/lead-ui-20261006/`.

## Development rollout

The frontend-only overlay contains Connections UI, Company Settings and its cache-version manifest. Each role was audited against the active immutable release. Role-specific manifest differences and all other runtime files are preserved. Staging verified syntax and capacity while retaining the existing 1 GiB reserve; the unused initial candidate was reused for the final reviewed candidate. No worker deployment, database migration, mail routing change or production activation is part of this pass.

All three frontend roles were activated. A concurrent development release retained this final overlay on web and compatibility, so verification compared current owned hashes rather than forcing an older release identity. All nine role/file checks pass, along with runtime identity, readiness and development outbound isolation. Verified current releases are `f722fd6579fe567583fe3d7232195990683543e6` on web and compatibility and `fbb237f39b3dfac8d097acf580be3c9e0c624dbd` on the web pool.

Public requests to all three frontend assets return HTTP 200 with reviewed role hashes. Public `/v1/health/ready` is healthy and development-isolated. A transient HTTP 503 during concurrent activation cleared before final verification. The existing autoscale-image limitation remains; this rollout updates the current web hosts without provisioning or image changes.

## Native chat styling correction

User review exposed styling collisions missed by the original fixture: broad Connections button/input rules reached into the shared assistant, explicit welcome overrides changed its alignment, and the fixture omitted the real Company Settings inbox styles.

Source `4e8ecc79764eecac4c84ca69d8e6dc28a70cb4f1` excludes the shared chat subtree from host control/typography rules and removes all lead-specific welcome/suggestion styling. The subtitle is removed. Inbox guidance is an existing platform information tooltip; source and delivery guidance also moves to information controls. The inbox uses a single address row without the redundant outer card, with 16 pixels of space before the next divider.

All three browser tests pass. The lead fixture now uses the actual Company Settings stylesheet and inbox template, the real assistant, fonts and icons. It compares native button, composer, welcome and suggestion styling against an unmodified assistant; verifies mouse and keyboard tooltip opening and Escape dismissal; measures divider spacing; and retains the delivery/source interaction checks. Desktop and 390-pixel phone renders were personally inspected in Chrome with the real fonts and icons; drafting and attachment-menu opening were exercised without sending a message.

All three current frontend hosts are active on the correction. All nine owned role/file hashes match, readiness and development isolation pass, and the public assets return HTTP 200 with reviewed hashes. No worker, mail routing or production change occurred. Evidence is under `output/lead-ui-css-20261006/`.
