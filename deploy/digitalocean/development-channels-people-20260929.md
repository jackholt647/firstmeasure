# Channels people picker and list icons — September 29

Release `fb0f640586f69fd3cc73b483e1bda64204d1b6f3` is pushed and active on both development web nodes and compatibility. Worker and production are unchanged.

Adding members and starting group conversations now reuse a compact people picker: immediate name/email search, case/accent-insensitive matching, 40-pixel rows with identity details, selection chips, selected counts, and selections retained across filters. Existing members are excluded from additions. The results area scrolls independently and initially renders 50 people, with Show more for the remainder. Adding selected people uses the existing batch membership API; permissions and backend behavior are unchanged.

Bulleted and numbered list buttons now use self-contained SVG list icons with accessible names, native tooltips and active-state highlighting. Their existing editing commands are unchanged.

JavaScript syntax and diff checks passed. A real-browser harness passed locally and using dev-served assets with a 500-user directory: bounded initial rendering, Show more, live name/email filtering, accent/case matching, empty results, retained selections, correct batch user IDs, group creation, list insertion/conversion and active states. Desktop and mobile screenshots were reviewed; the picker fits a 390-pixel viewport. The harness uses fake messaging/directory APIs and does not add real members or send messages.

The immutable release inherits each role's predecessor and overlays only the shared Channels UI and bundle manifest. All updated roles passed source hashes, readiness and development-isolation checks. Two public asset hashes and six public readiness responses matched. No backend, package or database change was needed.

Rollback predecessor for all three updated roles is `c2998c968551e1d28806cc45b1e56ce2175d758e`. Check for intervening releases before rollback, use the existing atomic symlink/service workflow, and verify public return before moving to the next web node. Evidence is under ignored `output/channels-people-20260929/`. The existing autoscale replacement-image limitation remains.
