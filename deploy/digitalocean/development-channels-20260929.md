# Channels and huddles development release — September 29

User authorized pushing and deploying the Channels work to development. Production activation is not authorized.

This release covers channel membership, navigation and notifications; mentions and typing; shared files; composer tables, links, quotes, clipboard media and scheduled messages; screen clips; huddle invitations, effects, reactions and session lifecycle; avatar refresh; per-section sidebar preferences; inline translation and Translate All.

Translate All translates loaded messages and continues as earlier history or replies load. It uses the user's target language and preserves the conversation scroll position. The original project-channel disabled-send report was not reproduced exactly; the surrounding-form submission defect was corrected and project sending passed the focused checks.

Validation before release: TypeScript check and build passed; 51 focused Channels, realtime and presence tests passed. The focused browser regression covers composer, navigation, notifications and translation. Camera effects now include the missing model and WASM assets.

Deployment inherits each development role's existing complete runtime and overlays only reviewed files and compiled modules. Existing role-specific app-flag behavior is preserved. Live source hashes and predecessor release IDs are checked before staging and activation; each activation has automatic rollback on failed readiness. Development data isolation and outbound safety must remain enforced. No topology or production changes are included.

The existing development autoscale replacement-image limitation remains; this rollout verifies the currently serving nodes.

Source release `2a56ed8d9762bd618e32471eadd4db37ee0ee2cb` was pushed to `codex/consolidated-firstmeasure-20260923` and activated on web `fm-dev-web-598520065`, pool web `fm-dev-web-603124965`, worker and compatibility. All four passed post-activation file hashes, readiness and enforced development isolation. All 13 public static asset hashes and six public readiness responses passed. The isolated Chrome regression passed again using actual assets fetched from `https://dev.1m8.ai`; API fixtures and fake devices prevent messages or invitations to real users. This does not certify real microphone hardware, live camera processing or translation-provider quality.

Concurrent presence and calendar rollouts advanced the live baseline during preparation. The activation guard stopped before changing any node; candidates were rebuilt against the finished rollouts. The final web and compatibility predecessor is `3c4a4f125ab22e3045e8341e3835421dac4924c3`; the worker predecessor is `6725168169b61d748c3aa2057b1bef8fac995833`. The Channels overlay includes its required shared presence module from `1474817`, and the reviewed minimized-window restore implementation on compatibility. Calendar and project-viewer files remain inherited from the complete live baseline.

Rollback: first check for intervening releases, then restore each role's recorded predecessor through the atomic symlink/service workflow, one web node at a time. Verify local readiness, development isolation and return to public traffic before proceeding. The presence store initializes its additive SQL table through the existing store registry; rollback need not delete it. Evidence and per-role manifests are in ignored `output/channels-release-20260929/`. Production is unchanged.
