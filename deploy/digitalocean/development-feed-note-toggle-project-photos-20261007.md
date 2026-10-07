# Development Feed note toggles and project Photos link — October 7, 2026

Source commit: `65ab06c32fd91e688a6c12aed55a9fbc13abb419` on `codex/pioneer-puffin-feed-photos`.

The Feed now measures each note at its rendered width. One-line notes show their full text without an expand control; notes that wrap show the preview and an inline chevron. The measurement updates when the Feed width changes. In list view, **See more** on a grouped photo upload opens that project's modal with the Photos tab selected. Clicking an individual thumbnail still opens the Feed photo viewer. The Feed header no longer has the forced gray background introduced by the preceding list preview release; content still scrolls below the header.

All three development frontend roles were serving `9609d398a459f4debf62afc252ffc6990e8f810e` with matching Feed hashes before staging. A guarded overlay changed only `public/libraries/apps/photos/feed.js` and the Feed bundle version in `public/libraries/apps/firstmate-apps-manifest.js`. Web, pool, and compatibility roles activated `65ab06c32fd91e688a6c12aed55a9fbc13abb419` sequentially. The prior release remains available for rollback.

Validation: the Feed browser test passed on desktop and mobile, including a note that gains a toggle when the layout narrows. All three development roles and the public endpoint reported ready with development data and environment safety. In a signed-in sandbox browser, two paragraph notes had toggles and four one-line notes did not; the header stayed clear while the list scrolled; **See more** opened the correct project with `projectTab=photos`; and no page errors occurred. Production was not changed.
