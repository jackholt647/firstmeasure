# Development AI wide-angle capture — September 23, 2026

Release `06540fabe7c9d9fba19f4746222a84a7fb92f1d1`, baseline `9dc5476ddc1646aab12ffc4c268f1ed3b4cd7ee2`.

New eight-view captures use 100° vertical FOV for both the camera and common-radius fit. Angles remain 45° apart and eye height remains six feet above local ground. FOV is saved with each run and pose. AI requests, chosen-view movement and manual replay use that saved FOV; legacy captures retain 45° or their recorded pose FOV. Recapture to use the wider lens.

All four `dev/exterior-ai.test.cjs` checks passed, including independent Three.js projection of wide/tall/sloped bounds at 100°, capture/request FOV, view selection/replay and sampling distribution. No real model calls were made.

Only `public/measure/internal/editor_scripts/exterior_ai.js` changed in the runtime. Every other public file was verified unchanged on all three development roles. Activation/readiness/outbound isolation passed. Public SHA-256 matched `76666d628ca63030b6806592f7cc15d0a8f8eeded9e385d3e172d8654d5049dc`. Production is unchanged. Ignored local manifests: `output/exterior-ai-wide-20260923/`.
