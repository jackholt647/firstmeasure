# Channels and huddles development release — September 29

User authorized pushing and deploying the Channels work to development. Production activation is not authorized.

This release covers channel membership, navigation and notifications; mentions and typing; shared files; composer tables, links, quotes, clipboard media and scheduled messages; screen clips; huddle invitations, effects, reactions and session lifecycle; avatar refresh; per-section sidebar preferences; inline translation and Translate All.

Translate All translates loaded messages and continues as earlier history or replies load. It uses the user's target language and preserves the conversation scroll position. The original project-channel disabled-send report was not reproduced exactly; the surrounding-form submission defect was corrected and project sending passed the focused checks.

Validation before release: TypeScript check and build passed; 51 focused Channels, realtime and presence tests passed. The focused browser regression covers composer, navigation, notifications and translation. Camera effects now include the missing model and WASM assets.

Deployment inherits each development role's existing complete runtime and overlays only reviewed files and compiled modules. Existing role-specific app-flag behavior is preserved. Live source hashes and predecessor release IDs are checked before staging and activation; each activation has automatic rollback on failed readiness. Development data isolation and outbound safety must remain enforced. No topology or production changes are included.

The existing development autoscale replacement-image limitation remains; this rollout verifies the currently serving nodes.

The verified activation result and predecessor IDs will be recorded after rollout.
