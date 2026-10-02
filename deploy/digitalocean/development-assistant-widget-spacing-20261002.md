# Assistant widget spacing — October 2, 2026

Source/release: `298b5495fea43b0174289fe4223f7a2e3c98030a`.
Target: `https://dev.1m8.ai`, development web/pool.

The side panel has no section heading or duplicate close control. Its persistent
left/right switch is in the main header. Widgets have responsive outer padding,
a maximum content width, a compact measurements grid, and vertical centering
when space permits. Removing the forced 100% wrapper height eliminates overflow
created solely by wrapper margins. Longer widgets retain normal panel scrolling.
The centered composer remains below both columns.

Chat columns have more padding and a 28px edge fade only when content lies above
or below the scroll position. Scroll, resize and transcript mutations update the
fade. Hidden header controls are explicitly removed from layout, including when
voice mode is active in a narrow window.

## Verification

Browser regressions verify 11 measurement values fit without panel overflow,
vertical centering, a compact aspect ratio, no duplicate section controls, the
single header close action, and all three scroll/fade states. Existing inline
expansion and side switching tests pass. Voice, shared project assistant and
payment browser checks also pass. A screenshot of the revised layout was reviewed.

## Deployment

Activated and verified on both roles. Only the shared assistant JavaScript was
overlaid on baseline
`dddac94c99755f79d674dff274c3a5cfca85a6d1` on both roles. Evidence is under ignored
`output/assistant-widget-spacing-20261002/`.

Rollback restores each manifest prior release path, restarts the web service,
reloads PHP and verifies readiness and development outbound isolation. Review
subsequent releases before restoring an older baseline.

Both roles passed release/hash/readiness and development outbound-safety checks.
Public readiness reported the expected release and the served asset matched the
manifest. Widget spacing/fades, voice and project-assistant browser tests passed
again against public development assets. Unauthenticated voice routes retained 401.
