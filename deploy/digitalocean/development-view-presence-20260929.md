# Channel and project viewer presence — development, September 29, 2026

Source commit: `1474817f9d7479c0b2c620bed5815a8214d27c28`, pushed on
`codex/consolidated-firstmeasure-20260923`.

Channels show green dots beside online message authors and members. The project
modal shows other viewers beside its notes, with a green dot and named labels.
Visible Channels and project views establish ephemeral sessions; hidden tabs
disconnect. Multiple tabs for one user produce one roster entry. SSE delivers
roster changes on a 750 ms server check; stale disconnected sessions expire
after 30 seconds. Resource authorization is checked at entry and every 10 seconds.

The release adds the shared PostgreSQL `platform_view_presence` table and its
scope index through the existing SQL-store schema registry. No business records,
organization permissions, provider settings, or production services are changed.
The worker is unchanged because this feature serves HTTP clients only.

Each development host inherits its verified live release with only the ten
presence source/test files and two compiled backend modules overlaid. Unrelated
local Channels and sidebar work was excluded from this commit. Compatibility's
older source was merged with the presence patch to preserve its existing code.
All replaced files and the inherited baselines have SHA-256 manifests in ignored
`output/presence-deploy-20260929/`, with per-node activation receipts.

Previous web release on `do-598520065` and `do-603124965`:
`60a8d3eddd0cfe0e7cbc44310e8138d96dad00a7`.
Previous compatibility release:
`f22867ae788658f5984c678953dd9fb3bcfddbd9`.

Validation before activation: isolated committed-source Linux TypeScript check
and build, scoped presence/session tests, authenticated API tests, client
visibility/reconnect tests, and a browser test of the project viewer label.
Independent Node processes also verified cross-replica rosters and multi-tab
cleanup against development's shared PostgreSQL database. Their temporary
presence records were removed. The isolated API suite passed despite an existing
background-worker fixture log about a missing test-only queue table.

Final verification: all three roles activated `1474817` and passed local
readiness, development outbound isolation, and source/runtime hash checks. Each
web node was observed healthy through the public load balancer before this
rollout continued. A concurrent calendar rollout subsequently advanced both web
nodes to `3c4a4f125ab22e3045e8341e3835421dac4924c3`; all presence source and
compiled module hashes were verified unchanged, with the calendar's manifest
changes preserving the presence bundle versions. Compatibility retained
`1474817`. Public checks briefly saw 503 responses during overlapping restarts,
then recovered.

Authenticated SSE checks passed through the local API and `dev.1m8.ai` for
online rosters, duplicate-session suppression, and an existing development
project's viewer roster. Short-lived verification sessions were revoked on
completion. The project indicator browser test passed again using the actual
JavaScript fetched from the development hostname. Production was unchanged.

Rollback: inspect intervening releases first, then restore each recorded prior
symlink and restart its development web/legacy service and PHP-FPM, one node at
a time. Verify readiness, development isolation, and load-balancer return before
continuing. The additive presence table can remain; its data is ephemeral. The
historical development autoscale image limitation remains, so replacement nodes
must receive the current release. This rollout does not change pool topology.
