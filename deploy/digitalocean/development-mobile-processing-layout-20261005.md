# Mobile report processing layout — October 5, 2026

Runtime source: `8aff4c10bf64a798e7c0c2633c182f37958e26e2`.

Standard and Customer Report pending content on mobile now fills its tab with white, without the inset rounded card, gray surround or shadow. Content is centered with a 360px maximum width, at least 24px side padding, larger vertical gaps and more generous control padding. Expedite choices stack to give labels and prices room. Content that exceeds short viewports starts at the top and scrolls, keeping cancellation notes and controls reachable. The existing window mobile state scopes these styles; desktop and narrow desktop docks retain their presentation.

Validation: JavaScript syntax passed. Chrome computed-style and screenshot checks covered Standard/Customer at 414×744, Standard at 320×300 and 740×300, plus the unchanged desktop presentation at 640×744. Assertions checked white background, absent card radius/shadow, centered content, minimum side padding, no horizontal overflow and reachable content at the bottom of short screens. Visual review confirmed stacked expedite choices avoid wrapped price/label crowding. This CSS-only change adds no permanent behavior tests. Evidence: `output/mobile-processing-layout-20261005/`.

The deployment overlays one frontend file on each immutable role baseline, preserving unrelated live and workspace changes. Previous release on web, compatibility and pool: `a2d0018347d8a26d4fbdefd87c5fd547b4623bf3`. Rollback uses each manifest's previous release path and development service. Production and worker are unchanged.

Development activation was authorized in the ongoing conversation. All three roles passed final running-release, asset-hash, readiness and isolation checks. Public readiness and the frontend asset hash match. All five layout scenarios passed again using the stylesheet fetched from dev. No report orders or customer records were changed by verification.
