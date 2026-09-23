# Development: opaque soffit occlusion and deselection

Release: `ff8e94a3a66dc6dea5694705df968e91d4c3e36b`.
Baseline: `1535481284d21a6b1d6efd3a08071e6ee0bad249`.

The soffit material override disabled depth testing after the general opaque-line policy had enabled it. Opaque and textured soffit contacts now retain depth testing and the existing one-screen-pixel shader depth bias. This clears their supporting surface without drawing through nearer roof/wall geometry. Translucent mode retains its through-surface overlay behavior. Coordinates and measurements are unchanged.

Resoffit picking returned early on a miss without clearing its existing line selection. An unmodified miss now clears it and redraws; Shift/Ctrl/Meta misses preserve additive selection. This addresses a reproduced first-selection miss path, not a claim that every intermittent selection issue has been reproduced.

Validation: ten wall-editor tests, the new first-selection/miss regression, and two real Chrome WebGL tests passed. WebGL coverage includes soffit contact visibility versus nearer occluders across orthographic/perspective cameras, three zooms and three viewing angles, plus translucent visibility. Logs: `output/soffit-display-tests.log` and `output/soffit-depth-browser.log`.

The two-script immutable delta preserves the baseline runtime. Deployment evidence: `output/soffit-depth-20260923/`. Production is unchanged.

All three roles passed exact-release readiness verification; both public script hashes match the immutable release. Public readiness initially reported the previous release during restart and passed on retry. Development outbound isolation is enforced. The public editor URL requires login; the WebGL test uses an isolated fixture rather than the user's authenticated model.
