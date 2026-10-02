# Overview entry workflows and default trays — development, October 2

Initial workflow release: `b7f1299a4ac806f8cebf401929a6e97e7feb459d`.
Final source release: `3213c066946fb353f60c2bcba4bde98b7094ad10`.

Overview continues to own the persistent project details form. New Report presents a
focused heading and a searchable existing-project picker, or a New Project entry action.
Both continue into the existing report controls. Existing report projects reuse reorder
prefill; no report is submitted by choosing a project. New projects use the expanded map.

The Overview details column uses the header dropdown's flat contacts, action icons,
and separators. Its order is contacts, address, property type, custom fields, then actions.
Custom fields appear after an address. Actions include a new report even when the project
already has a report. The duplicate Overview note composer is hidden when shared trays exist.

Notes is the default project tray. Branch project settings store `default_project_tray`,
including `off`; choices come from the same tray registry as the header. Explicit tab/layout
opens retain their intent. A user's tray interaction while settings load prevents automatic
reopening. Draft Notes mounts without project reads/writes; explicit note submission or
attachment preparation can save the draft first. Acquiring a project ID preserves the composer.

Overview uses container width to stack cards and details when a tray or window placement
reduces space, keeping padding and eliminating fixed minimum-width overflow.

Validation: 19 focused browser/state checks passed across opening, header identity,
contact shortcuts, tray integration, and the new workflow/unsaved-notes/responsive tests.
All nine runtime JavaScript files parse. No backend, worker, production, or report-order
activation is included in this deployment.

## Preserved deployment baselines

- web: `/opt/firstmeasure/releases/38936a7a01b40f29094602e02a3e4e1229e4015a`
- legacy: `/opt/firstmeasure/releases-root-archive/2ddd423f0d1c12962d5a7c12aa399d143e6841a7`
- pool: `/opt/firstmeasure/releases/38936a7a01b40f29094602e02a3e4e1229e4015a`

The legacy tray merge preserves its existing agent-header behavior while applying the new
registry and lazy Notes support. Role-specific frontend work is retained by three-way merge.

All web, compatibility, and pooled-web roles activated the final release and passed
readiness/isolation checks. All nine public JavaScript assets match the expected hashes.

The live sandbox check verified:
- New Report's immediate large heading, hidden app tabs, project search, and usable Notes.
- New Project's expanded map, flat contact/address sections, and post-address/type actions.
- Notes, Activity, Agent, and Off in Configuration > Projects > Default project tray.
  Off was saved and kept the tray closed; the original Notes preference was restored.
- Saving a synthetic Workflow QA draft with a development sample address, then finding it
  through report search and entering the existing report controls with prefilled fields.
- Reopening the saved project normally shows Overview, Notes, and Order report / Build
  proposal / Schedule appointment. No report was ordered and no note/message was sent.
- Overview's 580px content width has a 580px scroll width and retains 18px right padding.

The live check uncovered an existing project persistence gap when Proposals was enabled:
queueAutosaveNotice delegated only to proposal document persistence. The final follow-up
saves Overview fields through persistActiveBaseProject before optional proposal autosave,
with suppression/loading/hydration guards retained. It also removes the duplicate legacy
Order Measurements control and preserves New Report text in the initial parent header.
The follow-up rollback baseline is the initial workflow release above on all three roles.
