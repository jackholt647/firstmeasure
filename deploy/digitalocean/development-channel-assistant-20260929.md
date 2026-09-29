# Private channel assistant conversations — September 29

Release `b7a178b0e736f87e70c236f158eb0fdffcd457d8` is pushed to the canonical branch and activated on development web, pool, compatibility and worker. Production was not changed.

The Channels recap action now opens the existing FirstMate assistant drawer docked beside the conversation. It starts a private recap on first opening and resumes the same personal channel conversation on later openings. The shared history, composer, uploads, dictation, settings and window controls are reused. Switching preserves unsent assistant drafts. A recap no longer posts an assistant mention or answer into the source channel.

The new authenticated, CSRF-protected conversation endpoint checks both app capabilities and channel membership. Threads are personal and transactionally reused per user/channel. The shared assistant prepare hook reloads authorized source context for each turn, including visibility-filtered recent messages and replies. Revoked source membership blocks a new turn before model invocation, including via the generic agent API. The persisted thread subject cannot be bypassed with a caller-supplied subject. Provider configuration and credentials are unchanged.

Context uses bounded excerpts from up to 100 recent messages and 30 replies in each of 10 recent threads, plus attachment metadata. It does not claim to contain all history or file contents. See [assistant architecture](../../docs/architecture/global-assistant.md).

Validation:

- TypeScript check passed.
- Assistant API: 20 tests passed, including fresh follow-up context, no channel posts, concurrent thread reuse, separate users, membership denial and generic API denial. The focused channel test also passed after the final title adjustment.
- Assistant frontend/CSRF: 97 tests passed.
- Publication: 49 passed; the PostgreSQL integration case was skipped in the local environment.
- Private-tray browser regression passed locally and against dev-served assets: cold boot, docked shared UI, private follow-up, channel separation, resuming history and preserving unsent drafts.
- The isolated Channels composer/workspace regression passed locally and against dev-served assets, including the recap button making no public post. APIs, model responses and media are mocked; no actual user conversation was modified by these tests.
- The optional broader local call/overlay run passed its call checks but stopped at an existing fixture expectation for a “Dock conversation” button after opening an already-docked window. This unrelated overlay sequence is not claimed as passing.

The release copies each role's live predecessor and overlays only four frontend scripts, four backend sources and their compiled JavaScript. Existing scheduling changes are preserved. Compatibility retains its previous dictation icon through a reviewed three-way merge. No package changes or database migration were needed.

Rollback predecessors: web, pool and compatibility `856b5729cd55c3a0de7e7bc8ca29a80c1b782492`; worker `de27da2cb055537f27501608eb93e8ffd8f3229e`. Check for intervening releases before rollback, use the existing atomic current-symlink/service workflow, and wait for public readiness before moving to the next serving node.

Evidence is under ignored `output/channels-assistant-20260929/`. Runtime/source hashes and development isolation were checked on all four roles. Four public script hashes and six public readiness responses matched. One post-activation pool readiness probe failed transiently. A diagnostic probe then passed every dependency, followed by a successful repeat verification of all four roles and the public hashes/readiness checks. The existing autoscale replacement-image limitation remains.
