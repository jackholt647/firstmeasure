# Development rollout: full-house production points (October 19-20, 2026)

Releases `7c811330` and `03d57cc1` on `codex/consolidated-firstmeasure-20260923`,
rolled out to dev.1m8.ai on all four roles (worker, legacy, web, pool) with the
tooling in `output/fh-points-20261019/` (git-ignored). Design:
[full-house production points](../../docs/architecture/full-house-points.md).

## What shipped

- `7c811330`: a customer full-house job is scored at the drafter's submission
  from the reviewed PDF snapshot: roof points (existing facet calculation) plus
  2 × wall points (windows, doors and wall planes proxy) become one
  `point_value`, `complexity` and `point_calculation` (`mode: "full_house"`).
  Stored point values keep the total. The editor shows only the elapsed
  stopwatch while drafting a full-house job and reads the score back for the
  post-submit modal. Staff Production Timing waits for the first submission.
  Roof jobs are unchanged.
- `03d57cc1`: the wall proxy ignores walls under 1 sq ft (zero-area slivers).

Files: `public/v1/firstmeasure/{full_house_points,constants,processing,storage,api}.ts`,
`public/v1/tests/firstmeasure-full-house-points.test.ts`,
`public/measure/internal/editor.php`, `editor_scripts/report.js`,
`portal_scripts/projects.js`. Every file was three-way merged onto each host's
live copy; there were no conflicts.

## Rollout notes

- `7c811330`: staged and activated in order, verify passed. The worker was on
  `70770aae` and the other roles on `58249cdc` at the time; the merge kept each
  role's own versions of the files.
- `03d57cc1` (base `42ca4abc`): the first activation was refused because
  another session activated `c1240ed1` between staging and activation, the
  second because the worker had running jobs. The third attempt activated
  worker, legacy, web and pool in order and verify passed.

## Verification on dev

Pilot order `exteriors_e98e14a5321293cc9663088a56979821` (4725 W Mercer Way),
placed by the pilot customer, reserved for and claimed by the pilot drafter, with
the drawn model copied from internal draft `fullhouse_ce52…` as in the first
pilot.

- While drafting, the editor header showed only the stopwatch: no allotted-time
  bar, no rush pill.
- On submit the server stored roof 39 facets → complexity 5 (10 points), walls
  66 planes, 0 windows, 0 doors → complexity 5 (10 points), total 30, project
  complexity 5. The roof's 39 matches the PDF's "Total Facets".
- The post-submit modal read the score back: Complexity 5, 30 points at ₱19 per
  point. The driver's request proxy dropped a connection as the modal opened,
  so the modal was confirmed by re-running the editor's post-submit path in the
  drafter's session.
- The pilot QA pulled and approved it. The project is `completed` with
  `point_value` 30, and the QA leaderboard credits the pilot QA 33 points
  (3 from the first pilot plus 30).
- Re-counted with `03d57cc1` on the host: 59 wall planes, still 30 points.

The QA grab first pulled an unrelated dev roof project (`479f2bf3…`); its claim
was released at once.
