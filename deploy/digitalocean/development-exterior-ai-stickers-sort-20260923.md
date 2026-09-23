# Development sticker count sorting — September 23, 2026

Release: `ebcfb8b3af3f0d96bc02a122c706ba3f6384ea60`.
Baseline: `df21902fb2cdd4a2db1b27f7829aaf8ba617360c`.

The experimental AI Stickers table has clickable Face/W/D/G headers. Counts sort descending on first click and toggle direction thereafter; unknown, pending and failed counts stay last. Ties use face number. Sorting changes presentation only, preserving face identities and row selection.

Only `public/measure/internal/editor_scripts/exterior_ai_stickers.js` changed in the deployed runtime. The immutable delta verified all other public files unchanged on web, worker and legacy roles. All three roles activated successfully and passed development readiness and outbound isolation checks. Production was not changed.

Validation: `node --test dev/exterior-ai-stickers.test.cjs` passed, including descending/ascending sorting, ties, failed rows remaining last, selection after reordering, captures and saved history. The public script SHA-256 matched the committed asset: `97f5ba12df7609d5715c1d39fe4c09b2afcd4e58260a2a516a8d706bad5d57e5`. No new model calls were needed.

Local staging/activation/verification manifests are under ignored `output/exterior-ai-stickers-sort-20260923/`.
