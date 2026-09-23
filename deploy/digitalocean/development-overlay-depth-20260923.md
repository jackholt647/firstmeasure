# Development: roof-contact lines and point visibility

Release: `8a322e205537b165ef2d99f44a8bb898e26d590d`.
Baseline: `a66efdc91fcfe8bb5ae8bec6ce9d3a700f0a4fa2`.

Lines previously had a one-CSS-pixel camera-depth allowance, while point anchor occlusion used only a floating-point epsilon. Both now have a four-CSS-pixel depth allowance derived from projection, viewport height and view depth, plus a numerical floor at extreme zoom. Point ray distances account for off-axis perspective rays. Line projection and model coordinates are unchanged; markers still draw as whole squares based on anchor visibility, not corners. Opaque/textured wire retains depth testing. Translucent behavior is unchanged.

This is a bounded contact tolerance, not a surface-normal displacement or an always-visible overlay. A truly nearer surface beyond that allowance still occludes the line or marker.

All 52 focused tests passed, including actual Chrome WebGL rendering. Coverage includes orthographic and perspective cameras, three zooms, grazing views, selected and ordinary markers, ordinary/selected/soffit lines, contact depth, nearer occluders, translucent behavior, and imagery exclusion. Both new point and line regressions fail against the previous implementation. Evidence: `output/overlay-depth-tests.log`, `output/overlay-depth-before.log`, `output/overlay-depth-browser-before.log`.

The one-script immutable delta preserves the baseline runtime. Staging verified 24,508 unchanged public files on web/legacy and 24,522 on worker. Deployment evidence: `output/overlay-depth-20260923/`. Browser tests use isolated fixtures, not the user's authenticated model. Production is unchanged.

All three roles passed activation and exact-release readiness checks. The public script checksum matches the immutable release, and public readiness confirms development data and enforced outbound isolation.
