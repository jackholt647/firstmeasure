# Completion, paying out and project closeout

A work order is paid when its work is done, not when it is handed over. This page
covers how work is confirmed as done and marked to be paid, and how a project is
closed out. Read it before changing how labor lists are finished or paid, the
completion widgets, or the closeout checks.

## Words

| Word | Meaning |
| --- | --- |
| **Commitment** | What was handed to an assignee and for what pay ([assignees](assignees.md)). Never edited. |
| **Finalized** | The work on a labor list was confirmed as done and is to be paid. Also said "completed and to be paid", or "paid out" in the interface. |
| **Released** | A commitment taken back: the work will not be done by that assignee. Never a way of finishing work. |
| **Reopened** | A manager took finalized work back so the list can change again. Recorded with a reason. |
| **Closeout** | The record that a project's work orders are all finalized and its finances are finished. |

## A completion

`labor/completion.ts`, collection `labor_completions`, one record per
**payout**. Paying out a whole work order at once is one record per commitment
(`lf_<commitment id>`, `scope: list`), as it always was. A work order can also
be paid out in parts (`partial: true`): each payout pays the lines confirmed in
it, is its own record (`lp_<commitment id>_<lines>`, `scope: lines`) with its
own `finalized_at`, and lists the lines it paid in `line_ids`. `fully_paid` says
that payout paid the last open line. A list is **finalized** once every line it
has is paid out, in one payout or several (`listPayState`: `open`, `part`,
`paid`).

Finalizing (`finalizeLaborList`) needs every line not yet paid out confirmed,
unless `partial`, which pays out only the confirmed lines and leaves the rest
open; a line already paid out cannot be confirmed again. How they were
confirmed is the `method`: `approve` (one approval), `select_all`
(checkboxes with Select all) or `each` (every line checked by itself). The
record keeps who and when, the method, every line and whether it was
confirmed, the material lines and requirement rows confirmed with it if they
were shown, the photos reviewed (`evidence.media_ids`), a note, and the
closeout it was part of. `history` lists every finalize and reopen and is never
shortened.

What is paid is a frozen commitment of the list as it stands. A list with no
current commitment, or one that changed since it was committed, is committed
first with nothing sent (`commitLaborList(..., { deliver: false })`; the
delivery is recorded as delivered because the work is already done). An
unchanged list keeps the commitment it has.

Once finalized the list is locked, like an ordered material list:

- `commitLaborList` and `generateLaborList` refuse it (`labor_list_finalized`);
- `releaseCommitment` refuses its commitment (`labor_commitment_finalized`);
- the assignee no longer holds it (`currentCommitmentsFor`);
- the Project tab shows it locked, with no generate, assign, add or delete.

A list paid out in part locks only its paid lines: a new version must carry
them unchanged (`labor_line_paid`), its assignee cannot change, and it cannot be
generated again or archived (`labor_list_partly_paid`); its open lines change
as usual, and it can be committed again for the rest. Its assignee still holds
it until every line is paid out.

`assertLaborListOpen(orgId, listId, { items, strict, assignment })` is the one
check. Any writer that can change a labor list's lines must call it; the
material list store does, in `patchMaterialList` and `commitMaterialVersion`
(passing the lines a new version would have; archiving is strict), and
generating is strict. Finalizing and reopening never write the list through
those functions, so they cannot lock themselves out.

The commitment keeps `status: committed` while finalized, because the
`labor-commitments` export is a fixed v1 contract and commitments are never
edited. Whether it is finalized is the completion record.

Reopening (`reopenLaborList`) needs `reopen_finalized_work` and a reason. It
reopens every payout of the list, or one (`completion_id`), and is refused
while the project is closed out.

**Cancelling the rest** (`cancelRemainingLines`, action
`labor.list.cancel-remaining`, `manage_projects`, with a reason) is for a work
order paid out in part whose other lines will not be done. Those lines come off
the list in a new version, the commitment still holding them is released with
the reason ("Rest cancelled: …"), and the work order is then finalized on what
was paid out: nothing more is earned, projected or held by the assignee. It is
recorded on the list (`labor_completion.remainder_cancelled`, with the lines
taken off). Refused unless some lines are paid out and some are open.

### Pay

The `labor_commitments` pay source (`payroll/pay-sources.ts`, rows built by
`laborPayRows` in `labor/completion.ts`) carries `finalized_at`,
`finalized_by_user_id` and `completion_method`, empty until the work is
finalized and again after a reopen. A whole-list payout is on its commitment's
row, as before. Each payout of part of a list is its own row (`id` its
`pay_unit`, with `commitment_id` and `payout_id`), with the total of the lines it
paid and its own `finalized_at`; the commitment's row then carries only what is
still unpaid, with no `finalized_at`, so every line is earned exactly once.
Projected pay counts only the lines not paid out (`unpaidShares`). Paid work
stays paid when the list is committed again: a payout row is `committed`
whatever happens to the commitment it was made on. The sample `committed_labor` rule
earns on `finalized_at`, so piece-rate pay is earned only when the work is
finalized, and a reopening reverses it at the next refresh. A released
commitment is never finalized and is never paid by that rule. Hourly and salary
pay are unaffected. A labor list's cost counts as actual only once finalized
(closeout step f).

## The completion widgets

Declared once in `libraries/platform-widgets/catalog.json`, rendered by
`completion-widgets.js`:

- `work.completion` — source `labor-completion.items`, action
  `labor.list.finalize`. One parameter changes how it works, `method`:
  `approve` (one button, no checkboxes), `select_all` (checkboxes with Select
  all; the default) or `each` (every item checked on its own). `list_id` limits
  it to one work order; `materials` and `requirements` add the material lines
  and requirement rows. `partial` lets some lines be paid out now and the rest
  later (never with `approve`, which confirms everything); lines already paid
  out show "Paid out" with the date and are not confirmed again. Its selection
  is `{ method, complete, partial, approved, confirmed_item_ids,
  confirmed_material_ids, confirmed_requirement_ids }`. `complete` is true when
  every open line item is confirmed; `partial` when some, but not all, are. A host may also pass
  its own items as `context.data['work.completion'] = { items }`.
- `project.photos.review` — source `media.library`. Opening a photo marks it
  reviewed; the selection is `{ media_ids }`.

A selection is screen metadata. The actions check it again: finalizing refuses
unconfirmed or unknown lines, and reviewed photos must be media of the project
the caller can read.

## Closeout

`closeout/closeout.ts`, collection `project_closeouts`, keyed by project.

`closeoutChecks` reads other apps only through the published data layer, with
the caller's own access. A step whose source is not visible or not published is
`unavailable` and says why; `missing` names what is not published. Every check
warns and none blocks.

| Step | Source | Not published yet |
| --- | --- | --- |
| a. Change orders signed and paid | `widget-objects.document-directory` (`document_type: change_order`) | Whether each change order is paid: `payments.records` does not say which obligation belongs to which change order. |
| b. Documents that need signatures are signed | `widget-objects.document-directory` | Which documents require a signature. Sent and unsigned is treated as waiting for one. Signing packages are not published. |
| c. Payments received | `payments.records` (outstanding is amount less allocated; `balance_due_cents` is not filled in) | — |
| d. Every requirement accounted for | `work-requirements.project` | — |
| e. Receipts for paid expenses | `receipts.record`, matched to ordered or paid material and equipment lists by `attributed_target_keys` | Supplemental expense items and payables; the project's expense targets are not published. |
| f. Finalize work orders | `labor-completion.items`, `labor-completion.project` | — |
| g. Final expenses, actual against planned | `financials.records`, the lists, and finalized completions | Receipt-backed actuals and the materials, labor and equipment breakdown. |

The work orders come before the final expenses, because the expenses include
them: a labor list's cost is actual only once it is finalized. In the closeout
dialog, step f shows the completion widget for each open work order and
finalizes each confirmed one on its own with `labor.list.finalize`, the only way a
list becomes to be paid. The checks are then read again, so step g counts those
costs as actual. Step g, the final expenses, is the last step and closes out the
project and its finances; it cannot close while a work order is open and points
back to step f.

Closing (`closeProject`) can also finalize work orders passed in `finalize`, each
confirmed in the completion widget (agents and other callers use this; the
dialog finalizes in step f and passes none), and refuses
(`closeout_work_orders_open`) while any labor list with lines is not finalized. That is the only thing that stops a
close. The record keeps who and when, the work orders finalized with it, the
checks as they stood, and every close and reopen. Reopening it
(`reopenCloseout`) needs `reopen_finalized_work` and a reason, and leaves the
work orders finalized.

Events: `labor.list.finalized`, `labor.list.reopened`,
`project.closeout.completed`, `project.closeout.reopened`.

## Requirements tray

Each requirement carries `progress`, worked out in `labor/requirements.ts`
from the covering lists as they stand: `scheduled` when every covering list has
a scheduled event on the project (`scope_resource_list_id`), `completed` when
every covering list's part is done (labor finalized, material list delivered,
equipment whose event has started or is completed). Each cover that is a list
carries `scheduled` and `completed`. Progress never changes `status`, and a
warning stays a warning. The tray shows a green calendar for scheduled and a
green check on a green row for completed.

## Published

| | Permission |
| --- | --- |
| `labor-completion.project`, `labor-completion.items`, `project-closeout.checks`, `project-closeout.record` | `manage_projects` |
| `labor.list.finalize`, `labor.list.cancel-remaining`, `project-closeout.close`, `labor-completion.settings` | `manage_projects` |
| `labor-completion.settings.save` | `manage_company_settings` |
| `labor.list.reopen`, `project-closeout.reopen` | `reopen_finalized_work` (Money & payroll → Financials) |

All are project scoped and need Materials (`platform.materials`). The Project
tab calls them through `/v1/publication/organizations/:orgId/data/read` and
`/actions/invoke`; there are no separate routes.

## In the Project tab

Each work order has a More button at the top of its list. Its **Pay out**
opens the completion widget for that list beside the project's photos;
confirming every line finalizes and locks it, and confirming some of them
offers **Pay out N lines now**, which pays those and leaves the rest open. A
list paid out in part says how much in its More menu and offers **Pay out the
rest** and **Reopen…**. A finalized list shows "To be paid", and its More menu
says when and offers **Reopen…**.

A labor line that is paid out is read-only in the work order: greyed, with a
lock whose tooltip says "Paid out <date>", and no inputs, remove or drag
(`renderPaidLineRow`). Its other lines stay editable until they are paid out
too.

**How work is confirmed** is the organization's setting: one approval, Select
all (the default) or each line (`labor-completion.settings`, saved with
`labor-completion.settings.save`, which needs `manage_company_settings`; kept in
the default branch's `work_completion` module). Pay out and Closeout both use
it as the widget's `method`. Its home is **Settings › Configuration ›
Projects** (“Confirming work orders”, `apps/settings/crm.js`), shown with
Materials on and company settings access, and saved as soon as it is chosen;
the **Confirm by** choice in Pay out changes the same setting.

In Closeout's work order step the widget has `partial` too: a work order can be
paid out in part there, and stays in the step with what was paid and a
**Cancel the rest…** choice. The step, and the close, finish only when every
work order's lines are all paid out or the rest is cancelled; closing still
requires every line finalized (`closeout_work_orders_open`). The header has **Closeout**, a
step-by-step modal over the checks above, ending with the completion widget for
each remaining work order (`libraries/apps/materials/closeout.js`).

## Work order documents

A work order can be written out as a document: one labor list, or the project's
whole Work order column (its labor and equipment lists), becomes a document of
the built-in `work_order` type, filled from the seeded system template
`tpl_work_order_default` (`labor/work-order-documents.ts`). It is an ordinary
document in the documents system: it shows in the project's Documents tab,
opens in the document editor and downloads as a PDF through the documents
routes. There is no separate PDF path.

- Each source has exactly one document, with a stable id:
  `doc_work_order_<list id>` for a list and `doc_work_order_project_<project
  id>` for the project. Generating again rewrites that same document in place
  (`prepareTemplatedArtifact` in `documents/artifacts.ts`); it never makes a
  second copy. Archiving it in Documents and generating again brings it back.
- The document records the list revisions it was written from
  (`metadata.source_list_revisions`). When a list changes, the document is out
  of date: the Project tab marks it and offers **Update work order**, which
  rewrites the same document.
- What it says: who is assigned, the job site and customer (from the
  project), each line with its quantity, unit, rate and amount, and the total
  pay. Equipment lines and projection-only lines (cost of salaried time) are
  listed without an amount. A scheduled date is shown only when the
  organization has scheduling on and a list has one. An organization changes
  what a work order looks like by editing the template in Doc Studio.
- Routes: `GET` and `POST /organizations/:orgId/projects/:projectId/work-orders`
  (`manage_projects`; the POST takes an optional `list_id`). Writing the
  document never changes the lists, so a finalized list can still be written
  out.
- In the Project tab, a labor list's header has **Generate work order**;
  once written it has **Open work order** (the document in the Documents tab)
  and **Download work order PDF**, plus **Update work order** when out of date.
  They are list actions, so they fold into ⋮ when the header is narrow, before
  Pay out does. The workspace header has the same controls for the whole
  column.

Run `tests/labor-work-order-documents.test.ts` and
`tests/project-tab-labor-scheduling-off-browser.test.mjs` for changes here.

## Not built

- Change-order payment, signature requirements, signing packages, expense
  targets and receipt actuals in the published data layer.
- Equipment custody on site; "on site" is read from the equipment list's event.

Run `tests/labor-completion.test.ts` and
`tests/closeout-completion-browser.test.mjs` for changes here.
