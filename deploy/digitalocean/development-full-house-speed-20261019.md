# Full-house editor speed pass — development, October 19, 2026

Source `f709807f34712aa67ad7ec55c25d2590886ca7fc` on `codex/consolidated-firstmeasure-20260923`. It makes drafting in the
full-house editor faster without changing any result: the same geometry, scene output and model state.

## What changed

- **Shader programs are kept.** Exterior redraws replace their materials, and three.js deleted and recompiled the same
  WebGL programs several times per frame (249 compiles in a four-second face move). The frame pipeline and
  `render3D` keep one reference per compiled program, bounded at 256.
- **Occlusion stops at the first hit.** Point and label occlusion use the layer and world bounding-sphere tests that
  `Mesh.raycast` starts with, computed once per frame. This gives the same answer as `intersectObjects(...).length`.
- **The 2D plan is a passive pane during 3D gestures.** While a tool runs in the 3D view, the plan redraws at most every
  100 ms and always once afterwards. Full renders and 2D gestures still redraw it at once.
- **The wall composition cache is keyed on its exact inputs.** `wallSceneInputs` is checked by projection, scramble and
  sensitivity tests. Nudges no longer serialize the whole 420 KB state about 90 times per press.
- **Drawing memoizes within one render-cache generation:** per-face parts, chimney clipping and selection.
- **Previews are cheaper.** They use an exact, faster JSON-equivalent copy, fewer copies, cached snap candidates,
  bounding-box prefilters and string-free equality. Equivalence tests compare them against the previous
  implementation on saved houses.

Details are in `dev/EXTERIOR_PERFORMANCE.md`. Work deliberately left for later is in `docs/optimization-backlog.md`.

## Measurements

These were measured in a real-browser harness (real GPU, the real wall/base/ground editors, OrbitControls and the
`scene_3d` render loop) on a 420 KB drafted house, with paired runs before and after.

| Action | Before | After |
| --- | --- | --- |
| 20 arrow nudges, long tasks | 2.8–8.1 s | 0.2–0.3 s |
| Arrow nudges, frame p95 | 170–400 ms | 46–55 ms |
| Extrude preview, long tasks | 2.7–6.1 s | 0.5–0.7 s |
| Extrude preview, median frame | up to 48 ms | about 17 ms |
| Point drag, long tasks | up to 5.5 s | 0.26 s |
| Point drag, median frame | up to 87 ms | about 17 ms |
| Face/point selection | | roughly half the latency |
| Face move, long tasks | 5.1–7.8 s | 1.4–2.6 s |

Other sessions were loading the machine, so the numbers are noisy. Harness and runs are under
`output/full-house-speed-20261019/`.

Tests: the full suite passes 1,619 of 1,621. The two failures predate this release (exterior-ai and
wall-plane-editor.browser).

## Verified development rollout

The six editor scripts were three-way merged onto each role's live release, `c255dda3`. There was no drift. Each role
was staged and then activated in turn, and PHP was reloaded. The worker and production were not changed.

All three roles verified file hashes, runtime identity, readiness and development isolation. The six files were each
fetched three times over HTTPS from `dev.1m8.ai`, and all 18 fetches matched the commit's SHA-256. `/v1/health/ready`
reports `f709807f` in the development environment.

| Role | Release | Previous |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/f709807f34712aa67ad7ec55c25d2590886ca7fc` | `/opt/firstmeasure/releases/c255dda34a0738f41487579cbd0d3b17284fdddb` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/f709807f34712aa67ad7ec55c25d2590886ca7fc` | `/mnt/firstmeasure_dev_releases/releases/c255dda34a0738f41487579cbd0d3b17284fdddb` |
| pool | `/opt/firstmeasure/releases/f709807f34712aa67ad7ec55c25d2590886ca7fc` | `/opt/firstmeasure/releases/c255dda34a0738f41487579cbd0d3b17284fdddb` |

Rollback: if nothing has been deployed since, restore each role's previous symlink and reload PHP.

Not verified: the full editor was not opened on dev, because that needs a staff sign-in.
