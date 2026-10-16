# Development rollout: new leads, one project entry, lead.received rules (2026-10-16)

Release `7603342e` from `claude/new-leads-20261016` (commits `8f519335`, `7603342e`, on
`2f91fc42`), development only. Design: [opportunities](../../docs/architecture/opportunities.md).

## What shipped

- **New leads.** Intake routing runs once, when a lead arrives, and a rule or the default may
  say `entry: "unscoped"`. A project that arrived as a lead (`lead_source`), has no scope other
  than intake and no outcome is a new lead: `lifecycle.new_lead`, counted as an open
  opportunity. Lost with a reason (`not_a_lead`) and reopen work on it.
- **One project entry.** Projects start only through `receiveLead` or `createProject`
  (`projects/create.ts`), which always starts a scope: the write's `scope_template_id` or the
  branch's `manual_template_id` (default: the preset Manual scope). The lazy "start the default
  pipeline" calls on GET plans, PUT/PATCH projects and proposal creation are gone. Fifteen
  other project writers now pass `mustExist`; `tests/project-entry.test.ts` guards this.
- **Intake scopes.** Built-in `intake` category (beside `sales`): never a board, not an
  opportunity, completes as `routed` when a scope starts.
- **lead.received rules.** The new-lead notification moved out of `receiveLead` into default
  organization rules `platform_notify_new_lead` / `platform_notify_new_lead_source_roles`
  (click: `open_project` on Overview); the first call is queued on `lead.received`
  (`platform_queue_new_lead_calls`) and, for a sales scope started on a hand-made project, on
  `work.plan.started` (`platform_queue_sales_scope_calls`). The browser no longer guesses a
  lead notification from its title.
- **Missed calls.** A missed call or voicemail matching no project becomes a contact and a new
  lead by default (`call_leads` in intake routing); until routing is saved, missed calls start
  unscoped.
- **Browser.** Overview card on a new lead (start a scope, or Not a lead); a sales board may
  show a New lead column (`work_plan.metadata.new_leads_column`, a switch in the scope
  editor) and dropping a card starts the board's scope; Contacts filter (All, Leads, New
  leads, Customers, No projects); Settings > Project Scopes > Advanced: "No scope yet" entry,
  the hand-made default and the missed-call setting. `POST /v1/scopes/.../projects/:id/scopes`
  starts a scope on a project.
- **Fix found by the tests.** A Production team value filled from the first work event's
  assignee that the field's policy refuses now stays empty instead of refusing the event save.

## Checks

- `npm run check` clean. New: `tests/new-leads.test.ts`, `tests/project-entry.test.ts`;
  updated: lead-receive, opportunity-outcome, project-scopes-routing, crm-api, canvassing,
  automation-contracts, work-api, platform-workflows.
- Full suite on this machine: every failing file was rerun file by file on the base
  (`2f91fc42`) and on the release; fail counts match in every file except the two this release
  fixed (`work-api` 5, `scheduling-event-writes` 9, now passing). The remaining failures
  (assistant, payments, auth, public FirstMeasure API and others) fail identically on the base.
- Browser contract tests touched by the change (project board, overview workflow, project
  primary, unassigned views, settings search) pass; navigation, settings layout, feature gates
  and custom-fields UI contracts fail identically on the base.

## Rollout

- All four roles were on `2f91fc42`. The build three-way merged each file onto the hosts' live
  copies; `contacts/app.js`, `settings/company.js` and `comms/calls/worker.ts` carry other
  sessions' newer versions on every role, so this release's edits were applied to the live side
  (`output/new-leads-20261016/replay.py`); `tests/work-api.test.ts` kept live.
- Staged and activated worker, legacy, web, pool; `verify` passed on all four at `7603342e`.
  `firstmeasure-development-platform-worker` restarted.
- Smoke (lead-verification organization): a missed call from an unknown number created a
  contact and an unscoped project (`new_lead: true`, no plans); the platform worker completed
  `lead.received` and sent "Missed call from a new number" to inside sales and appointment
  setters with an `open_project` click action.

## Development data

48,536 of 49,120 development projects have no scope; nearly all are FirstMeasure measurement
orders (`measurement_ordered`). They are not new leads (no `lead_source`), and nothing was
migrated. Only 28 organizations use scopes.

## Not done

- The browser's New Project flow does not ask for a scope yet (it starts the branch default),
  and there is no "New lead" button; answered calls from unknown numbers do not create leads.
- Production is untouched.
