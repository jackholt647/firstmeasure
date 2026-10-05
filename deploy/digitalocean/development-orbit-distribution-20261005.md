# Orbital introduction space distribution — October 5, 2026

Runtime source: `14c0d6c350338087955b6f5b766dce76f3ac6a0a`.

Replaces viewport-derived gutters with a full-height mobile video intro: title/description/animation stay at the top, actions and photo fallback stay at the bottom, and the three instructions evenly share remaining height. Heading-to-description and description-to-animation gaps are fixed at 16px. Actions use 8px gaps and the photo fallback starts 4px below them. Adding Review video reduces flexible instruction space before increasing content height. Short screens retain scrolling when intrinsic content cannot fit.

Five browser scenarios passed locally and with deployed source, each before and after adding the review action: 390x844, 412x915, 390x1800, 700x500 and 320x568. Assertions cover equal top gaps, evenly distributed steps, close footer grouping, and no scrolling/bottom anchoring at portrait heights of 844px and above. Screenshot reviewed for 412x915 with review. Browser fixtures use actual renderer/styles with a representative pager; they do not record/upload media. JavaScript syntax passed. Regression: public/v1/tests/orbital-intro-layout.test.mjs. Evidence: output/orbit-layout-distribution-20261005/.

One frontend file overlaid on each immutable dev role baseline `1ce03699e5ae4e6bf883c98a2230ec1684b929b4`, preserving unrelated code. All roles passed final release, file hash, readiness and environment-isolation checks; public asset/readiness matched. Existing conversation authorizes dev activation. Production and worker unchanged. Rollback uses each manifest role's previous path.
