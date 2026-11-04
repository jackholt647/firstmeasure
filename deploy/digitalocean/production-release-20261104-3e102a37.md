# Production release 3e102a37: rendered view windows read their outside from the house shell, November 4, 2026

Released from Jack's PC through fm-agents-1 on Jack's go ("push it to prod", relayed by the session that started this
one), after dev verification. It is production-live `6cbd75cb` (release `85c2f559`) plus one commit on
`claude/window-both-sides-prod`:

- `3e102a37`: `public/measure/internal/editor_scripts/exterior_rendered.js` from measure-internal lane `4b2eff2f`
  (on dev as `measure-internal-20261104223740-2e641821`). Production's copy of this file was byte-identical to the
  lane base `7f8c0189` before, so the release takes only this fix and none of the dev-only lane work (curved-face
  editing and the rest stay off production).

## Change

- **Which side of a window is outside** (Textured/rendered view only): `openingDetails` chose it by whether the
  window lay away from the model's bounding-box centre, so a window in an inside corner faced into the house: its
  dark recess drew in front of the glass and the sill stuck out inside (reported by Jack from a report). Now a point
  just off the opening is tested against the house shell with three level rays (odd crossings = inside, majority
  vote, as auto trim classifies corners); the centre test is only the fallback.
- **Both faces dressed**: frames, rubber and glass-garage rails straddle the wall; sill and door handles are
  mirrored onto each face; the dark recess and warm floor draw only while the camera is on their side.
- Editor browser code only: no server code, PHP, database, migration, dependency, environment or config change. No
  production data changed. The editor's script URL version is content-based, so browsers pick it up on reload.

## Checks before release

- Build on the dev worker in 307 s (npm ci, type check, build, prune): archive sha256
  `67b90cde84ce9062565e4f038ff47e361c152c3a90bb029f3f0a65bba0297592`, verified on compatibility and the worker.
- Dev (pilot house, headless, writes and localStorage writes blocked): windows show frame, glass and sill from
  outside and inside at 1440x1000 and 900x700; with the model centre moved in front of each window (an inside
  corner) the old rule flipped 3/3 and the fix kept 3/3.

## Rollout

- Tracker router `tracker-router@bugs` stopped at 23:13:57 UTC (no dispatch in flight).
- Rollback target before activation: `85c2f5597a2912875adfc5e2d5fec3e3aacc82e4`, every host's `current`.
- Compatibility at 23:22:37 UTC: active on `3e102a37`; editor/login 502/503 only inside the restart window
  23:22:45–23:23:05, then only `top_view_reroll_proxy.php` (failing before this release).
- Worker at 23:24:16 UTC, after no jobs were running: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `f82eb721…` (85c2f559's archive). All six web nodes
  downloaded `3e102a37` / `67b90cde` from it.
- Six web nodes one at a time behind the load balancer, 23:25:22–23:38:42 UTC (94–96 s each), each asset-checked
  as in 85c2f559's run plus `function insideShell` in the release's `exterior_rendered.js`.

## After activation

- Public readiness answered `3e102a37` (`ok`) on 12 of 12 requests; all eight hosts point `current` at it.
- `https://app.1m8.ai/measure/internal/editor_scripts/exterior_rendered.js` is byte-identical to the dev lane's
  file (sha256 `0214fa7d…`).
- Production editor code on the dev pilot house (67–68 editor scripts served from app.1m8.ai, one dev-only file from
  dev; no production project opened, nothing saved): windows render from both sides, and the inside-corner check
  passes 3/3 (old rule flipped 3/3).
- Errors: web nodes 0–0.24 % 5xx since 23:38:42 (30 min before: 0.20–0.31 %), only `top_view_reroll_proxy.php`.
  Compatibility since 23:23:10: 0.61 % vs 0.76 % before, all the same proxy route. No error-level lines on
  compatibility or worker.
- Jobs since worker activation: 207 completed, none failed; 435 `report.release` queued, none due.
- Not done: opening Jack's reported project on production (no production login was used; nothing customer-side
  touched). The confirmation is Jack reloading that report's 3D view.

## Rollback

Every role keeps `85c2f559`. To roll back, republish its archive (`f82eb721…`) to the channel from
`/opt/firstmeasure/releases/85c2f559…/deploy/digitalocean/`, then run `activate-release.sh 85c2f559… <service>` on
each role. Code only: this release writes no data.
