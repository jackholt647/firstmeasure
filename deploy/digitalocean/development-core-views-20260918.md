# Resources Core views — development

Release: `e583720737060dac1494650f0546e8787c9dcb9a`.
Baseline: `a6282cafe40ff410945df3b27cf540849b14261f`.
Source branch: `codex/resources-core-views`, isolated FirstMeasure Core Views checkout.

Entering wall mode opens Resources. A Core views button in the Files tray returns to a responsive three-by-three board of assigned elevation photos, with a house orientation diagram in the center and the front entrance at the bottom. Thumbnails open in the existing viewer; missing slots are labeled. The board/file choice survives refresh.

Validation: 52 focused tests passed, including browser tests at two viewport widths, thumbnail opening, returning to the board, reload persistence, existing file/markup behavior, and wall-mode entry routing.

The guarded development delta stages only project_resources.js, project_resources.css and wall_mode.js. Each role verified 18,092 other runtime files unchanged. Worker, web and compatibility services activated successfully with development data, outbound isolation and the existing experimental owner allowlist verified. Production is unchanged.

Deployment artifacts on each role: /tmp/core-delta.tar.gz, /tmp/core-delta.json and /tmp/deploy-core-delta.py. The baseline remains installed for rollback through the existing guarded release workflow. Refresh the development editor to load the new scripts.

Public verification: dev.1m8.ai readiness returned this release with healthy development data and enforced outbound isolation. All three served browser assets matched the tested release after line-ending normalization.
