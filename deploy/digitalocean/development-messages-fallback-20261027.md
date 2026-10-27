# Messages fallback and Operations follow-ups — October 27, 2026

## Behavior

`topbar.messages` independently controls the header Messages inbox. MVP configuration revision 21 disables it while retaining Channels for project notes. Enabled mentions/message notifications then use the regular bell; retained entries follow the current switch without cloning or redelivery. Explicit in-app opt-outs, badge preferences, recipient/branch scope, current channel/media access, mutes, deletion, and read state remain respected. Photo and separate project-note tags emit notifications, and photo tags open the photo from either surface.

Operations now uses the ordinary FirstMeasure report loader when no published dataset is selected. Selected datasets remain authoritative and preserve structure provenance; denied/unavailable selections never silently fall back. Setup only reads measurements. The quick-scope walkthrough contains no proposal/payment/signature explanations; initial path choice and optional proposal setup remain available.

## Validation and rollout

Release `943d95420d8fb9fdd2e9982c7f85e33e9aeb1bd3` activated and verified on development worker, compatibility and web. All roles passed Linux TypeScript, payload hashes, isolation/readiness/outbound-safety checks. Local TypeScript passed. Notification/tag regressions: 32 passed; browser notifications/topbar: 8 passed plus photo route check; Operations browser: 8 passed; publication: 87 passed and one PostgreSQL-only skip; automation/scope artifacts: 18 passed. MVP default test passed.

The active MVP organization `org_85689c2864692650` received only `topbar.messages=false` through the ordinary app-flags API. Live read-only measurement loading for its project returned 25 measurements, including 35.2 roof squares. The open browser caught a temporary restart response during activation; the same URL then returned 200 and the tab was restored successfully. Runtime payload preserves each development role's live baseline. Production is unchanged. Evidence is retained in ignored `output/messages-fallback-20261027`.
