# Project activity descriptions and user previews — October 12, 2026

Development source: `c9df85696311127d3d7bb1d3f3a99101fead0dec`, pushed to
`codex/consolidated-firstmeasure-20260923`. This is a frontend-only release.

Activity now uses the names of recorded tasks, stages, appointments, documents,
photos and material lists. Action words are bold; item names remain regular.
Recorded actors use the existing `summary.user` hover and keyboard-focus widget.
Directory lookups resolve actor IDs; child rollups and scheduled timer transitions
are not attributed to a scheduler or assignee. Native communication attribution
uses the message's recorded user source; delivery attribution uses its creator
only for the matching creation-time event.

Filters distinguish actionable work nodes from stages, classify checklists as
field work, and classify media in the documents slot as documents. Search uses
readable descriptions and actor names. Proven cross-source audit/work duplicates
are merged, retaining distinct actions and namespaced IDs. Optional authorized
resource reads are bounded and do not mutate domain records or ensure pipelines.

Five focused presenter/browser tests pass, including combined category filters,
search, pagination, refresh retry, keyboard controls, action weight, safe text
rendering, cross-source deduplication and shared user previews. The readable-feed
browser test also passes against snapshots of the actual deployed widget runtime
and user-preview renderer. Recorded Taylor Chen activity was reviewed using its
78 work events, seven plans, twelve users, media, documents and three messages.

Web, pool and compatibility activation passed readiness with development data
and outbound isolation enforced. Each immutable candidate cloned its own current
release, preserving runtime configuration and unrelated changes. The first web
activation was followed by a concurrent Feed download release; the final rollout
retained that newer baseline (`199e35f9ea028fc2d2bfe0c366a9863490b9cd7a-download`).
Final release directories use `c9df85696311127d3d7bb1d3f3a99101fead0dec-activity-r2`.
Compatibility has an older agent-tray implementation, so only the activity patch
was applied there. The worker has no frontend serving role and was not changed.

Final source checksums:

| Asset | SHA-256 |
| --- | --- |
| Activity presenter, all roles | `70947f19e6a418ace422167efbcddd0f60e65140698428e8f730f1604de49184` |
| Project trays, web and pool | `41097e9eefb56c24789e8702088ddb8decb04aadecb252d4bb53a8c63150823b` |
| Project trays, compatibility | `c8f1371c9451a9f5316d0232c65d18ad6475fbb25050b361395d6445a1a66429` |
| Preserved deployed user widgets | `847bcfe664b0c90f7a749a2fd20af4b2ee7eba40dfa4800b7189ded3529f1872` |

Public assets and readiness were verified. The in-app browser's full portal
reload stalled and eventually timed out, so a full live-page visual check was
not completed; the rendered component tests, including deployed widget assets,
passed. No project records were changed by this renderer work. Production was
not changed.

Per-role checksum receipts and rollback targets are installed as
`activity-readability-release.json` inside each release. Local staging scripts,
asset snapshots, screenshots and recorded-data review are under ignored
`output/activity-readability-20261012/` in the task workspace.
