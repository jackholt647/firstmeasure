# Project preview widget — October 9, 2026

The expanded `summary.project` hover preview is active at `https://dev.1m8.ai`. Production was not changed. Feature commit `06f28f31` is on `codex/consolidated-firstmeasure-20260923`.

The preview shows a large cover at the upper left, project name and address, stage, job type, deal value, the primary contact's details, Call/Text/Email actions, and an Open project button at the lower right. Contact and financial details respect their resource permissions. The Feed project-name hover remains the entry point.

## Verification

- TypeScript check and build passed. The publication suite passed 69 tests with one optional PostgreSQL skip. The widget and Channels hover browser fixtures passed five tests.
- All three development roles serve the same project widget source and compiled provider. Their SHA-256 values are `1a69021d7c448e97a2ef18613586a46452df46892dc9ddd0700d7d144c60006b` for `grouped-widgets.js`, `dc7db5067a8804fa31d917b523047083963ddaeaa44bf86af96104d8121131a3` for `runtime.js`, and `7ebb7835ee09a14bae651b8618c959dad2127c4239d7ec437567a6e4ff20f1b2` for compiled `objects.js`.
- Each role returned `ok=true`, `state=ready`, `data_environment=development`, and enforced outbound isolation. The public widget asset contains the new project card.

## Deployment topology

The main web role received the feature through release `e27292caa896cb3493df7e867609ea1ddcb12cad-2e929f3b`. The pool web role was activated from an immutable overlay at `/opt/firstmeasure/releases/project-preview-06f28f31-fm-dev-web-603124965` on its then-current `e27292ca...` release. The compatibility role was activated from `/opt/firstmeasure/releases/project-preview-06f28f31-firstmeasure-development-compatibility-restaged` on its then-current `2959d8af...` release. Only the project widget source, browser runtime, and compiled provider were overlaid; each role retained the other changes in its baseline release. The background worker was not changed.

## Rollback

Before rolling back, inspect each role's current release symlink; concurrent development releases may have advanced it. Restore that role's preceding release only if it still points to the project preview overlay, restart the corresponding development service and PHP-FPM, and verify local readiness. Preserve the release directories.
