# Development rollout: partial payouts and closeout, payroll history, split rule previews and the work roster (October 19, 2026)

Release `d63d657fec59938fd58eeea95c75fb37219b8e5f` on `codex/consolidated-firstmeasure-20260923`, built on
`e10f1be2`, activated on all four development roles (worker, legacy, web, pool) and verified. It replaced `dd704773`
on every role. The development platform worker was restarted on it. Production is unchanged.

Shortly after, another session's release `6fed67a7` (bank payment windows, built on this one) was activated on
legacy and web; the host check below was run again there and this release's actions and exports are present.

## What shipped

80 files changed, 5,002 insertions and 759 deletions.

### Work orders paid out in parts

Design: [closeout](../../docs/architecture/closeout.md).

- `labor.list.finalize` takes `partial: true`: each payout pays the confirmed lines, is its own completion with its
  own `finalized_at`, and locks only those lines; a list is finalized once every line is paid out (`listPayState`).
- `labor.list.cancel-remaining` takes the open lines off a list paid out in part and finalizes it on what was paid.
- The organization's confirmation method is `labor-completion.settings` / `labor-completion.settings.save`
  (Settings > Configuration > Projects, "Confirming work orders", and the Confirm by choice in Pay out).
- The `work.completion` widget takes `partial`; Closeout pays out in part and offers Cancel the rest; paid lines are
  read-only in the work order; the `labor_commitments` pay source and projections earn each line once.
- Labor lists and scope labor pieces no longer carry a `compensation` record, and the Labor resource type suggests no
  lines ([pay sheets](../../docs/architecture/pay-sheets.md)).

### Payroll

Design: [pay rules](../../docs/architecture/pay-rules.md), [assignee base](../../docs/architecture/assignee-base.md).

- Type history: `assignee_type_history`, assignees store schema 2 -> 3, written at the writes that change a user's
  roles, a group's type or a company's types. Default pay coverage follows it.
- Membership history: `resource_group_membership_history`, workforce store schema 2 -> 3, backfilled with current
  active members as members since always (481 rows on dev). Member writes take `effective_from`, removals
  `effective_on`; equal splits divide among the members on the earned day.
- `payroll.work_roster` publishes the schedule roster for split rules; the time clock publishes projected shifts.
- `payroll.paySplitRule.preview` with per-group samples; previews carry the pay date; Settings > Payroll edits split
  rules.
- Reports for dates are export templates (earning and reimbursement rows), CSV and PDF.
- Archiving a user runs the assignee cleanup, and payroll posts their pay through their last day before closing it.
- The payee's Why has a Divided tab and opens by route from People.
- New [optimization backlog](../../docs/optimization-backlog.md) entry: "Payroll work roster reads every scheduled
  event".

### Also

- Untranslated labels in `payroll/app.js` (the built-in pay run file names and descriptions) and a placeholder in
  `people/pay-sheets-editor.js` are wrapped for localization.
- Localization outputs, the settings search index and the access gates snapshot were regenerated in a clean worktree.
  The snapshot change is exactly this release's five entries.

## Tests

In a clean worktree of the commit (`node_modules` junctioned): `npm run check` clean, and 42 files, all passing:
every `pay-*` and `payroll-*` suite, `payouts-projected-browser`, `pay-sheets-editor-browser`, `labor-completion`,
`closeout-completion-browser`, `project-scope-work-browser`, `materials-api`, `materials-resource-types`,
`labor-pay-sheets`, `labor-commitments`, `assignee-base`, `assignee-base-store`, `branches`, `user-archive`,
`people-compensation-panel-browser`, `publication-permissions`, and `access-gates`.

## Rollout

Tooling: `output/payroll-closeout-20261019/` (copied from the people and payroll gaps release; `candidate.py`,
`commit.py`, `prepare.py`, `build-payload.py`, `host-tree.py`, `host-overlay.py`, `host-regen.py`, `rollout.py`,
`deploy.py`, `remote-check.py` with `host-check.mjs`, `restart-platform-worker.py`).

- The commit was built from HEAD plus only this release's hunks through a temporary index. Left out of shared files:
  two `materials/project.js` hunks (calculated material list copy), a `payroll-api.js` comment, and every other
  session's edits. The manifest's working copy is another session's and was left as it was (it lacks this release's
  bundle version bumps relative to HEAD).
- All four roles were on `dd704773`. Each role was re-audited right before it was staged; every file merged three
  ways onto the role's live copy without conflict.
- Generated files were regenerated per host from each role's own tree with the payload on top (legacy, web, pool).
  The worker's tree lacks the settings app scripts the search index generator loads, so the worker ships web's
  regenerated `public/v1` localization files (inert there except the terminology contract).
- Staged 64 files on the worker, 90 on legacy, 89 on web and pool (with compiled `dist/` copies); staging passed the
  hash, `node --check`, compiled-copy and Linux `tsc --noEmit` checks. Activated worker, legacy, web, pool in turn;
  public readiness answered twice after pool.
- Host check on every role: `payroll.paySplitRule.preview`, `labor.list.cancel-remaining`,
  `labor-completion.settings.save`, `payroll.work_roster` and `labor-completion.settings` registered. Postgres
  `platform_sql_schemas`: assignees 3, workforce 3 (the assignees store was opened once by the check to apply it),
  both tables present.
- `firstmeasure-development-platform-worker.service` restarted, active on `d63d657f`, no errors in its log.
- Smoke: `dev.1m8.ai/v1/health/ready` 200, the portal redirects to sign-in, and the changed scripts and widget catalog
  are served with this release's content. Pages behind sign-in (Payroll, People, a project's Closeout) were not opened.
