# Development automation authoring contract — October 6, 2026

Code release: `758abe21e2c4a3cf130995bdd08304ebe99ae359` on `codex/consolidated-firstmeasure-20260923`.
Verified live on `https://dev.1m8.ai` and all four development roles. Backend only; no interface changed.

## Changes

- Every registered automation has a typed input schema, title and category, and
  one catalog read returns actions, events with their condition fields,
  operators, hooks and the sequence shape.
- Scope bindings, external triggers, sequence steps, organization rules and
  intake routing share one condition contract with comparison, text, presence,
  numeric and date operators and any/all groups. The original equality map
  keeps its meaning.
- A lifecycle hook means exactly its own work event. It no longer answers
  another domain's event with the same suffix, and the hook and raw-event
  spellings no longer hide each other. Template saves store one spelling.
- Work items can declare a `sequence` of timed steps, compiled to node timers
  and bindings when the plan is created. The engine is unchanged.
- An organization rule can run several actions in order, each with its own
  conditions.
- Dry runs replay events, status changes and time against a saved or draft
  definition and report what would happen without doing it. Available to the
  Automations Agent and over HTTP; not offered in the product interface.
- Running scope instances can be previewed against, and moved to, the current
  template version. A save reaches running instances only when asked to.

See [automation authoring](../../docs/architecture/automation-authoring.md).

## Validation

- `npm run check`: pass, locally and on each role during staging.
- `tests/automation-contracts.test.ts`: ten tests pass, covering conditions,
  binding keys, sequence compilation and scheduler-driven steps, catalog and
  action-contract consistency, multi-action rules, template-save validation,
  dry runs that write nothing, and previewed/applied instance updates.
- `tests/scope-event-map.test.ts` (seven), `scope-artifacts`, `scope-agent`,
  `project-scopes-routing`, `kitchen-remodel`, `publication-*`, `crm-api` and
  `payroll-api` pass.
- Unchanged failures that predate this release, reproduced on the parent
  commit: seven `automation-engine` tests and two `work-api` tests that assert
  on automation-created notifications appearing in the notification list, and
  the `proposals-api` lifecycle test (`proposal_signature_reissue_required`).

## Rollout

Parent release `5069ecd3ba17c58b84ad24b48d36e895b28c9e62` on all four roles, no
drift in the twenty deployed source files. Staged with a Linux type check on
each role, then activated one role at a time: worker, compatibility, web, pool.
All four report release `758abe21`, ready, development-isolated, with forty
verified files each. Public readiness returns the release; the new catalog and
dry-run routes answer 401 without a session and an unknown route answers 404.
The deployed catalog, condition and sequence modules were loaded read-only on
the worker (18 selectable actions, 131 events, 16 operators).

Not exercised on development: an authenticated dry run or instance update
against development data. Rollout tooling: `output/automation-contracts-20261006/`.

## Notes for the next change

- `{{project.contacts.0.phone}}`-style list indexes do not resolve in action
  inputs on this release; the fix is in uncommitted cadence-control work in the
  canonical checkout.
- That uncommitted work (pause/resume, failure policy, recovery) was merged
  with this change in the working tree and is not part of this release.
