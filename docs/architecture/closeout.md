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
commitment (`lf_<commitment id>`).

Finalizing (`finalizeLaborList`) needs every line of the list confirmed. How
they were confirmed is the `method`: `approve` (one approval), `select_all`
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

`assertLaborListOpen(orgId, listId)` is the one check. Any writer that can
change a labor list's lines must call it; the material list store does, in
`patchMaterialList` and `commitMaterialVersion` (so every new version, and
archiving, is refused too). Finalizing and reopening never write the list
through those functions, so they cannot lock themselves out.

The commitment keeps `status: committed` while finalized, because the
`labor-commitments` export is a fixed v1 contract and commitments are never
edited. Whether it is finalized is the completion record.

Reopening (`reopenLaborList`) needs `reopen_finalized_work` and a reason. It is
refused while the project is closed out.

### Pay

The `labor_commitments` pay source (`payroll/pay-sources.ts`) carries
`finalized_at`, `finalized_by_user_id` and `completion_method`, empty until the
work is finalized and again after a reopen. The sample `committed_labor` rule
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
  and requirement rows. Its selection is `{ method, complete, approved,
  confirmed_item_ids, confirmed_material_ids, confirmed_requirement_ids }`.
  `complete` is true when every line item is confirmed. A host may also pass
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
| f. Final expenses, actual against planned | `financials.records`, the lists, and finalized completions | Receipt-backed actuals and the materials, labor and equipment breakdown. |
| g. Finalize work orders | `labor-completion.items`, `labor-completion.project` | — |

Closing (`closeProject`) finalizes the remaining work orders, each confirmed
in the completion widget, and refuses (`closeout_work_orders_open`) while any
labor list with lines is not finalized. That is the only thing that stops a
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
| `labor.list.finalize`, `project-closeout.close` | `manage_projects` |
| `labor.list.reopen`, `project-closeout.reopen` | `reopen_finalized_work` (Money & payroll → Financials) |

All are project scoped and need Materials (`platform.materials`). The Project
tab calls them through `/v1/publication/organizations/:orgId/data/read` and
`/actions/invoke`; there are no separate routes.

## In the Project tab

Each work order has a More button at the top of its list. Its **Pay out**
opens the completion widget for that list beside the project's photos;
confirming finalizes and locks it. A finalized list shows "To be paid", and its
More menu says when and offers **Reopen…**. The header has **Closeout**, a
step-by-step modal over the checks above, ending with the completion widget for
each remaining work order (`libraries/apps/materials/closeout.js`).

## Not built

- Paying out part of a list. Every line must be confirmed.
- Choosing the completion method per organization; the Project tab uses the
  default.
- Change-order payment, signature requirements, signing packages, expense
  targets and receipt actuals in the published data layer.
- Equipment custody on site; "on site" is read from the equipment list's event.

Run `tests/labor-completion.test.ts` and
`tests/closeout-completion-browser.test.mjs` for changes here.
