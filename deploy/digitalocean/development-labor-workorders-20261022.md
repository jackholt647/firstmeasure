# Work order documents, scheduling off, assignment states — development, October 22, 2026

Release `c52ecca5f14d3773e47732ac609b681975a3bb3a` (parent `2b6d6db1`) on `codex/consolidated-firstmeasure-20260923`,
from branch `claude/labor-workorders-scheduling-off-4c59e9`.
Architecture: [closeout, work order documents](../../docs/architecture/closeout.md#work-order-documents) and
[project content layout](../../docs/architecture/project-content-layout.md).

**Why.** Jack's project window list: generate a work order document from a labor list or the whole labor section;
keep the list header's overflow menu and put the new buttons in it; the project must fully work with scheduling off;
the "assign work" section once showed no one to assign; the labor section should start minimized when the
documents require no work.

**What changed.**
- Work order documents (`public/v1/labor/work-order-documents.ts`): a labor list or the whole Work order column is
  written as a `work_order` document from the new seeded system template `tpl_work_order_default`
  (`DOCUMENT_PRESET_REVISION` 37). One document per source (`doc_work_order_<list>`,
  `doc_work_order_project_<project>`), updated in place when generated again, marked out of date when a list changes.
  Routes `GET`/`POST /v1/materials/organizations/:orgId/projects/:projectId/work-orders` (`manage_projects`).
- Project tab: list header Generate work order, then Open / Download / Update, folding into ⋮; the workspace header's
  placeholder Work Order button now does the same for the column. The Documents tab refreshes on
  `fm:documents:refresh`.
- Scheduling off (`platform.scheduling`): no Schedule rail view, Schedule buttons, Schedule job, Reserve equipment or
  "Not scheduled" states; orders keep their delivery date on the order and no schedule event is made (browser and
  `createMaterialOrder`).
- Assignment: loading, failed reads (with retry), empty directory and nobody-marked states are each said, and
  everyone who can be assigned is listed; the directory redraws the blocks when it arrives.
- The Work order column starts minimized when requirements hold no work and the column has none.

**Tests.** `npm run check`; `labor-work-order-documents`, `materials-api`, `labor-completion`, `access-gates`
(snapshot updated, including siblings' unrecorded routes), `app-experience`, `app-experience-registry`,
`schedule-events`, `work-requirements`, `project-scope-work-browser`, `project-tab-labor-scheduling-off-browser`,
`closeout-completion-browser`. Failing on untouched canonical too, not from this release: `documents-api`
"instances attach the default workflow", `production-documents` "change order, invoice and completion certificate"
(`payments_not_ready`), several `scheduling-ui-contract` string checks.

**Rollout.** Scripts in `output/labor-workorders-20261022/` (candidate.py, integrate.py, ship.sh). Integrated into
canonical by compare-and-swap at `c52ecca5`. Worker, legacy (compatibility) and web were staged and activated with
`c52ecca5` (worker first; legacy's first activation was refused because another session activated legacy between
stage and activate, so legacy and web were reshipped). Other sessions activated later releases on every role within
the hour; each was checked on the host and still carries this release's files (`dist/labor/work-order-documents.js`,
the work-orders routes, the scheduling gate in `dist/materials/storage.js`, the browser bundle). The access-gates
snapshot keeps each host's own copy (a test fixture the hosts never read).

**Pool not updated.** The pool host (private `10.124.16.3`, reached through web) did not answer: "No route to host"
from the jump and 100% packet loss from web. Another session's rollout skipped pool for the same reason. Nothing was
changed on pool; it needs this release once it is reachable again.

**Follow-up** (the commit that adds this record): the Generate work order icon was `fa-file-circle-plus`, which the
Font Awesome build on the hosts does not have (blank button). It is `fa-clipboard-list` now, the icon the old
placeholder used; `materials/project.js` is `20261022-work-order-docs-2`. Browser-only, shipped to legacy and web.

**Verified on dev** (built-in browser, sandbox owner of `org_0be79c9db0e60b5a` "Cedar Heron Test Co e9c7ed", project
`project_1jxr2sd1ru59k4`, 68 Northfield Rd):
- Generate work order on the Roof install list made `doc_work_order_material_list_fdea718fe8444d30b55d`; the list then
  showed Open and Download. Open switched to Documents and opened the editor; Preview showed the assignee, job site,
  the line (Install shingles 30 sq $85, $2,550) and the total. The Documents gallery lists it. Its PDF route returned
  200 `application/pdf`.
- The workspace header's Generate work order made `doc_work_order_project_project_1jxr2sd1ru59k4`.
- Changing the line to 31 marked both out of date (amber dot, Update work order). Update rewrote the list's document
  in place (31 sq, $2,635); the project still had exactly two work order documents.
- At 1050 px the list header kept Generate from pay sheet and its ⋮ held Pay out, Open work order, Download work order
  PDF and Delete list.
- Scheduling off: `platform.scheduling` was switched off for the sandbox org with an operator script on web
  (`set-scheduling.mjs`, the browser API refuses non-operators) and switched back on afterwards (before true, after
  false, restored to true). With it off: no Schedule tab in the window, no Schedule appointment on Overview, rail views
  Measurements/Documents/Photos only, no Schedule button on any list or in the header, no "Not scheduled". The order
  dialog's date reached the supplier email ("I need the Gutters delivery on Thursday, November 5, 2026", subject
  "... - 2026-11-05"). The order was not sent (it would email the supplier); the server test covers saving it.
- A project with no requirements (`project_1xbijwb1a9qc4m`, Avery Morgan sample) opened with the Work order column
  minimized; restored, its assign block said no one can be assigned here yet, with Reload (this sandbox org's
  assignee directory is empty).
