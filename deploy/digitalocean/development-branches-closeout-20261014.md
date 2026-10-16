# Development rollout: branches and regions, labor finalization and closeout, projected earnings and People by branch

Development only. No production host, data or topology was touched.

- Commit: `58b3e01552cfa697a135b2655fed83bdb4045874` on `codex/consolidated-firstmeasure-20260923`, built on `d432bb48`.
- Live on all four development roles (worker, legacy, web, pool) as release `58b3e01552cfa697a135b2655fed83bdb4045874`,
  replacing `d432bb48` on every role.
- Tooling: `output/people-branches-20261014/` (`prepare.py`, `build-payload.py`, `rollout.py`, `deploy.py`).

## What changed

- **Branches and regions** ([guide](../../docs/architecture/branches.md), `public/v1/workforce/branches.ts`,
  `branch-scope.ts`, `branch-guards.ts`, `branch-publication.ts`): the organization has branches, optionally grouped
  into flat regions, and each department belongs to one branch. Users, groups and outside companies belong to one or
  more branches. With the `platform.multiple_branches` feature and more than one branch, People data and its writes are
  limited on the server to the caller's own branches unless they hold `view_region_branches`, `manage_region_branches`,
  `view_all_branches` or `manage_all_branches`. Scoped grants take a department, branch or region; stats group by
  region; appointment catalogs offer their branch's departments.
- **Removed**: department categories and organizational units (divisions) as department nesting. Stored structures are
  migrated on read ([organization structure](../../docs/architecture/organization-structure.md)).
- **People by branch** (`public/libraries/apps/people/`): lists filter by branch, and a Branches page
  (`people/branches.js`) adds, renames, archives and groups branches into regions. People pages show a sentence, not a
  capability key, when the server refuses something the page should have prevented.
- **Projected earnings** (`payroll/pay-refresh.ts`, `payroll/pay-sources.ts`): a payee's own per-record pay rules
  evaluated over labor not done yet (open commitments and assigned, uncommitted labor lists), never posted. Payees see
  theirs behind `payroll.view_own_projected_earnings`, granted by every seeded role; payroll managers see anyone's and
  organization totals (`payroll.projected_earnings`, `payroll.my_projected_earnings`).
- **Labor finalization and closeout** ([guide](../../docs/architecture/closeout.md), `labor/completion.ts`,
  `closeout/`): finished work is finalized to be paid, which locks the labor list; piece-rate pay is earned on
  `finalized_at`, and release now means only taken back. `reopen_finalized_work` reopens with a reason. Project
  closeout checks change orders, signatures, payments, requirements, receipts and expenses through published data and
  warns. Requirements show scheduled and completed progress. New `work.completion` and `project.photos.review` widgets
  and a closeout panel in materials (`materials/closeout.js`).
- New published data and actions: `organization-branches.*`, `labor-completion.project`, `labor-completion.items`,
  `labor.list.finalize`, `labor.list.reopen`, `project-closeout.checks`, `project-closeout.record`,
  `project-closeout.close`, `project-closeout.reopen`. Two new collections, `labor_completions` and
  `project_closeouts`.
- `docs/optimization-backlog.md`: the one list of performance shortcuts shipped on purpose.

## Checks

Tests added or updated with the commit: branches, labor-completion, pay-projections, organization-structure,
department-access, department-communications, appointment-booking, appointment-planning, assignee-base, pay-sources,
stats-api and the server tests whose fixtures name departments; browser tests people-settings-browser,
closeout-completion-browser and payouts-projected-browser. The rollout folder does not keep test output, so pass counts
are not recorded here.

## Rollout

The hosts carried other sessions' deployed, uncommitted edits in 20 of the 90 release files (the worker role takes only `public/v1/` files). `build-payload.py` merged
each against the live copy (three-way, with the base commit as ancestor) and refused to build on any unresolved
conflict:

- `firstmate-apps-manifest.js`: bundle versions this release changes were moved on the live line and
  `people/branches.js` added after `people/people-lists.js`.
- `capability_defs.ts`: this release relabels every permission row and adds a category; rows another session added on
  the hosts were kept with their neighbours' category.
- `coverage.ts` and `permission-bundles.ts` merged word by word; `bootstrap.ts` and the `portal/index.php` script tags
  keep both sides.
- `storage.ts` and `storage_postgres.ts`: the two new collections were added to the hosts' collection list, which also
  carries `organization_feed_settings`.
- `organization-structure.ts` and `department-access.ts`: the release rewrites them; the hosts' Notes audience fields
  (`resource_group_ids`, group `label`/`kind_id`) and Feed permissions (`manage_feed`, `view_feed_all_departments`)
  were put onto the rewritten files.
- `crew/app.js` and `materials/project.js`, `platform/api.ts`, `workforce/access.ts` and `workforce/storage.ts`:
  ordinary three-way merges.
- Test files where the hosts run older copies without the edited test were kept as they are.

Staged with hardlink clones, activated worker, legacy, web, pool, and verified per role: the active release and
`RELEASE_ID` match, every shipped file hash matches, local `/v1/health/ready` reports development with outbound
safety enforced, and `https://dev.1m8.ai/v1/health/ready` returned ready twice in a row after the pool activation.

## Not done

- Branches and closeout were not exercised in a signed-in browser on dev beyond the browser tests.
