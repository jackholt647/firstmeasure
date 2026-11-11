# Production release 99446050: wall mode V face fill along existing lines (FM-384) and orange/blue structural colours inside drafts (FM-385), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. One batch of two measure-editor fixes. The
plans' branches were stacked on release `06cee255` (the commit production-live's record `4a133760` sits on), so the
release is the FM-385 plan branch as is:

| Issue | Plan commit | Verified on dev in |
| --- | --- | --- |
| FM-384 edge-aligned face fill (V) | `8138c1b0` (`claude/fm-384-fix-prod-on-06cee255`; same diff as `ef1acc33`, lane `384c9336`) | `measure-internal-20261111004112-41f2dcf9` |
| FM-385 wall mode structural colours | `99446050` (`claude/fm-385-wall-mode-orange-blue-structural-colours-prod`; cherry-pick of lane `fd7f50d6`, identical diff) | `measure-internal-20261111011631-04fe10b8` |

## Change

- `public/measure/internal/editor_scripts/wall_solid_geometry.js` (sha256 `badfd29a…` →
  `c599d157a9a8233e79483df39ed789338d7019bffc2956ae50dd328e8a3b8ab2`, as dev serves it): FM-384,
  `faceFromPoints(selected, edges, {alongLines})`. With `alongLines`, two selected points are joined only when drawn
  lines cover the whole segment between them; the face is a closed, non-crossing loop through every selected point,
  and if there is none V refuses with "The selected points are not joined into a closed outline by existing lines…".
  B (subtract plane region) keeps the old behaviour.
- `public/measure/internal/editor_scripts/wall_face_draft.js` (sha256 `c104c256…` →
  `8853700cce949d071c64a87f9ff3c29eb0c61a9384a74ead3a683fb458783cd1`, as dev serves it): FM-384, `createSelectedFace`
  (V) passes every line on screen (face edges, wire, base and draft lines) with `alongLines:true` and no longer
  deletes door/window stickers covered by the new face. FM-385, wall mode colours a line or point orange when it lies
  on the outline of any live face, read from `draftColourFaces`: each region of a visible draft with its own rings
  (stickers, holes, coplanar neighbours), where it used the draft's union before. Snapping, picking and point
  retention still use `draftSupportFaces`, unchanged.
- Not served: `dev/wall-face-draft.test.cjs`, `dev/wall-face-draft-draw-memo.test.cjs`.
- Diff from `06cee255`: 4 files, +123/−37. No Node, PHP, API, schema, environment, database, flag, nginx, dependency,
  language-catalog or config-library change, and no data repair.

## Checks before release

- At 01:57 UTC every host's `current` was `06cee255` (released by FM-380 at 01:18 UTC); readiness reported
  `06cee255` 10/10. The rollback target `06cee255` was recorded on FM-384 and FM-385 before anything was activated.
- Each plan commit's diff equals the commit verified on dev (`8138c1b0` = `ef1acc33`; `99446050` = lane `fd7f50d6`).
- Worker baseline (72 h): `pdf.sync` "browser has been closed" 10 and `report.delivery` with the same error 2 (all
  before FM-380's runtime fix), "The reviewed PDF revision was superseded before delivery" 3, "The customer report email
  failed to send" 2.
- Build on the dev worker (`npm run check` included) took 264 s, from a bundle `99446050 ^06cee255`. Archive sha256
  `e41a5a63c9672384d09bd0739b9905f31b2152cb4e53f4beaf3020ddb8ca4c97`, verified on fm-agents, compatibility, the
  worker and each web node.
- `web_activate.py` keeps every earlier assert (FM-359's pinned `wall_face_draft.js` hash replaced by this release's)
  and adds FM-384 and FM-385 asserts: both files' sha256 as above, `{alongLines=false}={}` and the refusal message
  once in `wall_solid_geometry.js`, `W.faceFromPoints(points,edges,{alongLines:true})`,
  `scene.filter(f=>!f.snapOnly&&!f.deleted&&!f.feature)` and `function draftColourFaces` once each and
  `draftColourFaces(` three times in `wall_face_draft.js`. All 40 file asserts passed on the extracted archive and on
  the installed trees on compatibility and the worker.
- Control on production before compatibility switched (plans' harnesses against app.1m8.ai): FM-384's garage-door
  gable case gave the bent face `2,0 0,0 2,7 0,9 8,12 16,9 14,7 16,0 14,0` and filled loose points; FM-385's ce52
  wall `R52:1:roof-2` drew 9 lines and 10 points blue (its window sticker).

## Rollout (scripts: fm-agents /srv/agents/work/prod-batch-fm384-385-prodrun-scripts)

- Worker first, at 02:06:23 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `2fd8d785…` (`06cee255`'s archive), and the six web
  nodes went one at a time behind the load balancer, 02:07:26–02:21:09 UTC (about 2 min 15 s each). Each passed every
  assert and returned behind the load balancer on `99446050`.
- Compatibility went last (web proxies `/measure/internal/` to it), at 02:25:39 UTC through the gate: it waited 4 min
  at 559–765 `legacy-action`/min and opened at 358, load 3.3. In the 20 s after: 0 HTTP worker exits; the only Node
  500s were 8 requests at 02:25:39–40 (4 "Fastify has already been closed": the restart).

## Verification

- `current` is `994460500990efe2a60abf75be784ce9fc52f08c` on all 8 hosts; readiness reports `99446050` 10/10 (state
  ready), after the web rollout and again at 02:42 UTC.
- app.1m8.ai serves `/measure/internal/editor_scripts/wall_face_draft.js` with sha256 `8853700c…` (with
  `function draftColourFaces` once) and `wall_solid_geometry.js` with `c599d157…`, 6/6 each.
- FM-384 proof (plan harness `fm-384-prodrun-harness/check.cjs`, Chromium, production's served scripts): the
  garage-door gable case, with the bottom line split and unsplit, gives `14,0 16,0 16,9 8,12 0,9 0,0 2,0 2,7 14,7`,
  the outline that goes around the door; four loose points and three of four sides drawn are refused with the
  message.
- FM-385 proof (plan harness `fm-385-scripts/verify.mjs`, ce52 saved house): wall `R52:1:roof-2` and its window
  sticker draw 21 lines and 26 points orange and none blue (9 lines and 10 points blue before); `R49:0` 10 and 12
  orange, none blue. Screenshot `fm385-after.png` in the scripts folder.
- Worker since activation (02:06:23 to 02:42 UTC): 251 jobs completed (`pdf.sync` 116, `report.release` 77,
  `report.delivery` 33, `imagery.process` 25), 0 failed. The queue held only `report.release` jobs scheduled for later
  (0 due). No "Worker stopping", "browser has been closed" or pool acquisition failures in the worker journal.
- Compatibility watch to 02:42 (17 min): one watchdog kill at 02:32:39 (slot 2, missed heartbeat), within its usual
  0–2 an hour over the 48 h before (5 in the 01:00 hour around FM-380's restart); no pool timeouts; no Node 500s after
  the restart second. `legacy-action` ran 490–820/min, load 0.7–2.2. This release changes no file compatibility's
  Node process loads.
- 5xx from 02:27 (compatibility settled) to 02:42 against the 30 min before: web 0.02–0.10 % per node against
  0.21–0.36 %, mostly `top_view_reroll_proxy.php` and a few `legacy-action`; compatibility 0.55 % against 0.61 %, all
  `top_view_reroll_proxy.php` (long-standing).

## Rollback

`/srv/agents/work/prod-batch-fm384-385-prodrun-scripts/rollback/` (the same scripts reversed to `06cee255`; the
channel republishes `06cee255`'s archive from `/var/tmp/firstmeasure-release-06cee255/` on compatibility, against
`e41a5a63…`). Rolling back restores V's angle-sorted fill and the union-based colours. Nothing to undo in data or
configuration.
