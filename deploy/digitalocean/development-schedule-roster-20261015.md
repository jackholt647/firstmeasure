# Development rollout: schedule roster, who is on each event and its warnings

Development only. No production host, data or topology was touched.

- Commit: `7888eda4fac81ec369800cb9b202d4863c57f5bd` on `codex/consolidated-firstmeasure-20260923`, built on `0cc0ed0b`.
- Live on all four development roles (worker, legacy, web, pool) as release `7888eda4fac81ec369800cb9b202d4863c57f5bd`,
  replacing `926ebc39` on every role.
- Tooling: `output/schedule-roster-20261015/`.

## What changed

- `schedule-roster.events` (`public/v1/scheduling/roster.ts`, published in `scheduling/publication.ts`) answers, for
  saved events and for a draft being placed, the people the assignment roster puts on each event and its warnings:
  unmet staffing requirements and conflicts. It is derived and never stored, and warnings never stop a save.
- The overlap check (`scheduling/occupancy.ts`) is fed the roster's people, so a person reaching two events through
  different groups is a conflict with reason `person`, using each assignee's overlap setting (`overlapModeLookup`).
- The schedule view (`platform-schedule-view.js`) shows faces and warnings on chips, the day grid and the timeline; the
  Scheduling app and the project schedule show them while placing work.
- Docs: [schedule events](../../docs/architecture/schedule-events.md) and
  [assignee base](../../docs/architecture/assignee-base.md).

## Checks

Tests added with the commit: `tests/schedule-roster.test.ts` and `tests/schedule-roster-browser.test.mjs`. The rollout
folder does not keep test output, so pass counts are not recorded here.

## Rollout

The hosts carried other sessions' deployed, uncommitted edits in 5 of the 11 release files, merged against the live
copies by `build-payload.py`: `firstmate-apps-manifest.js` (bundle versions moved on the live line), `coverage.ts` and
`permission-bundles.ts` (word by word), `bootstrap.ts` (both sides' registrations), and a three-way merge of
`project-schedule/panel.js` on legacy. No conflict was left unresolved. The worker role takes only `public/v1/` files.

Staged with hardlink clones, activated worker, legacy, web, pool, and verified per role: active release and
`RELEASE_ID` match, every shipped file hash matches, local readiness reports development with outbound safety
enforced, and `https://dev.1m8.ai/v1/health/ready` returned ready twice in a row after the pool activation.

## Not done

- The roster faces and warnings were not checked in a signed-in browser on dev beyond the browser test.
