# Project measurement presentation — October 10, 2026

Development only. Source quantities retain full precision; the editable presentation shows whole square feet/counts, feet to one decimal, and roofing squares to two decimals. Roof area, edges, flashing/openings, and pitch quantities appear in two-column groups. Exact saved editor pitches supersede legacy grouped pitch display. Missing edge quantities remain unavailable rather than fabricated zeros.

The completed-report publication preserves saved editor line classifications and pitch quantities, including chimney back/step/apron, skylight perimeter, parapets, transitions and protrusions. Existing dataset cards can display additional quantities from their matching completed report through the authorized read-only report export; existing dataset values/overrides win, and reads do not rewrite datasets.

The aerial widget uses fill sizing through the shared widget runtime. The standalone roof stage has square corners; its dock collapses with a 260 ms grid/opacity animation and the canvas ResizeObserver updates camera aspect throughout. Reduced-motion preferences disable the transition.

Validation: browser tests cover the user's precision example, readable units and pitch labels, unavailable fields, tall aerial sizing through the real runtime, zoom/drag/fit, and key animation. Saved-report normalization tests verify classifications, exact pitch totals, invalid-value rejection, and source immutability. TypeScript and publication contracts are checked before development activation.

## Verified development rollout

Activated immutable source commit `1e0d09bbe3a57e5c62987430ae0f66da5c3dab52` on both development web nodes, the compatibility host, and the development worker. All four roles passed source/runtime hash, health, environment, and outbound-isolation verification. Public readiness returned the new release repeatedly. Existing role-specific baseline changes were preserved by bounded three-way overlays. Per-host rollback paths are retained in the deployed `channels-release.json` receipt.

Validation completed: 12 browser tests, saved-report normalization test, TypeScript check, 69 passing publication tests (one PostgreSQL test skipped), and hosted desktop/mobile checks with no page errors. The hosted measurement fixture uses the reported long decimal quantities and verifies rounded labels/units and exact pitch presentation. The actual fixture project has no completed report; the full-height aerial integration and roof dock animation were verified through the real widget runtime/browser fixtures. No production activation was performed.
