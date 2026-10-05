# Mobile loading parity — October 5, 2026

Runtime source: `9486cf66c778eccc5004e31b408a85c1b2275a65`.

The server-rendered project route precover now fills mobile screens from first paint, uses the same 760px breakpoint and 60px title/44px close geometry as the managed modal, and removes the old rounded sheet, gray inset card and fabricated eight-tab menu. The interim managed loader no longer adds 10px between its header and content. Account-specific navigation still arrives with configuration; the precover reserves the tab row without pretending all apps are available.

Nine focused browser tests passed locally, plus PHP/JavaScript syntax and whitespace checks. The before snapshot reproduced y=20 and height=824 at 390x844, versus the expected full viewport. Six geometry/resize/close scenarios passed after activation using served JavaScript and the exact deployed PHP stylesheet payload (server-side PHP source hashes verified on each role): 320x568, 390x844, 720x500, 740x900, 760x900 and 761x900. Evidence: `output/mobile-loading-audit-20261005/`. The separate existing Overview form-width test fails at 780px in code not loaded from either modified runtime file; it was reported to the user and not changed here.

Two runtime files were overlaid on immutable role baselines, preserving unrelated changes. Concurrent web activation was detected by readiness and baseline checks; web was re-audited/restaged on `ce57ad563725ee51034f3d47a01dec1506d1d4d3`. Compatibility/pool retain their baseline `6f179e94405dadc4bd351adb60b3919733ded225`. All three final release, source hash, readiness and development-isolation checks passed. Public JavaScript hash and readiness matched. PHP was linted on each server; it is verified as source via SSH rather than compared to rendered HTTP output.

User explicitly authorized pushing the prepared fixes; existing authorization covers development activation. Production and worker were not changed. Rollback uses each role's previous path and development service in the deployment manifest. No customer records or orders were changed during verification.
