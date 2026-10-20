# Base pitch no longer snaps back — development, October 19, 2026

Source `3e6e03c0b40601a507dee51ffbdc928a7c013554`.

**The problem.** Pitching a base face (Y) sometimes reverted to the starting state when the angle was placed. The commit
step makes every wall face standing on the base follow it (`WallBaseBinding.follow`). Near a corner, a sloped base
could fold the bottom of an attached wall face across its neighbouring edge by a sliver of a few square centimetres.
Validation rejected that outline, and the base editor restored the original base.

**The fix.** `wall_base_binding.js` now resolves such a fold with the planar kernel and keeps the one real region.
Secondary pieces may be at most 0.01 m² and 0.1% of the face. A base change that genuinely cuts through a wall is
still refused, now with a clear message.

**Tests.** The fixture `dev/fixtures/base-pitch-fold.json`, taken from a real house, and `dev/base-pitch-follow.test.cjs`
cover it. All 303 base, binding and wall tests pass. On three real houses every base face now pitches up to 10°;
before the fix, a 6° pitch already failed.

**Rollout.** `wall_base_binding.js` was overlaid onto `6fed67a7` on the web, legacy and pool roles. All three roles
verified, and the file served from `dev.1m8.ai` matches. The worker and production were not changed.
