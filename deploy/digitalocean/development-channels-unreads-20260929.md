# Per-conversation unread counts — September 29

Release `36544d9d7ae8630b5d8a5ed2fd1f7cd42263864c` is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

Channel, direct-message and group-message rows now show their total unread message count instead of only their mention count. Category totals remain available. Badges have an unread-message tooltip and accessible label, disappear at zero, and use the existing refreshed unread data and nonshrinking badge styling.

JavaScript syntax and diff checks passed. An isolated real-browser check passed locally and against dev-served assets for DMs, group DMs, channels, mention counts smaller than unread counts, zero counts, hover actions, refreshed counts and clearing a count to zero. A screenshot was reviewed. The harness uses fake messaging APIs and does not modify user messages.

The immutable release overlays only the shared Channels UI and bundle manifest on each role's verified predecessor. All updated roles passed source hashes, readiness and development-isolation checks. Two public asset hashes and six public readiness responses matched. No backend, package or database change was needed.

Rollback predecessor for all three updated roles is `bc39f939c220b8b17d9fed5f019256cac8227fe0`. Check for intervening releases before rollback, use the existing atomic symlink/service workflow, and verify public return before moving to the next web node. Evidence is under ignored `output/channels-unreads-20260929/`. The existing autoscale replacement-image limitation remains.
