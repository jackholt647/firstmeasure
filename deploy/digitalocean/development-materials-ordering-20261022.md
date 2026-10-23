# Development rollout: materials ordering (October 22, 2026)

Releases `3d45f7cc` (the ordering rework) and `29562fd1` (fixes from the dev walkthrough) on the canonical branch
`codex/consolidated-firstmeasure-20260923`, rolled out to the worker, legacy (compatibility) and web roles on
dev.1m8.ai with `output/materials-ordering-20261022/ship.sh`. The pool host (10.124.16.3) was unreachable
("No route to host" through web) for every session during this window and did not receive either release; other
sessions' recent releases also skipped it.

## What changed

The project window's Materials order window ([ordering materials](../../docs/architecture/materials-ordering.md)):

- Tabs are **Email**, **Purchase order** and **Shopping list**; **Mark as ordered** sits at the bottom right of every
  tab and records the selected lists as ordered without sending anything. The placeholder Order with Agent and Log
  Order Only tabs are gone (they had no backend).
- **Email**: one collapsible card per supplier, side by side when the window is wide; each card copies and sends on
  its own and marks only its own lists ordered. The order goes as the purchase order PDF attached, a table in the
  email, or both; order date and requested delivery are in the email.
- **Purchase order**: new `purchase_order` document type and `tpl_purchase_order_default` template (PO number from
  the organization's sequence, starting PO-1001; supplier, ship-to, ordered-by, requested delivery, lines with the
  supplier's SKU, quantity, unit and price, totals, notes, terms). Previewed and edited in the tab; Download PO.
- **Shopping list**: a project checklist by supplier with quantities and images, assigned to the project's
  assignees, or shared by a link (view, or view and check off) sent by email or text or copied. Download as a
  `shopping_list` PDF. The link is the page's own `/v1/materials/public/shopping-lists/:token/app` address: dev's
  nginx sends a bare `/l/` public link to PHP, which bounces it to the portal.
- Ordering records the delivery date even when it cannot be put on the schedule (scheduling off), and re-reads the
  list before recording the order (saving the delivery event writes the list again; it was a revision conflict).
- Every material list can be deleted, including the last one and a generated one (ledger `retire`).
- `DOCUMENT_PRESET_REVISION` 37 -> 38 for the two templates; collection `material_purchase_order_sequences`; published
  actions `materials.purchase_order.write` and `materials.shopping_list.create`.

## Checks

- New: `tests/materials-ordering.test.ts` (3), `tests/materials-ordering-ui.test.mjs` (7); added a retire test to
  `tests/materials-calculus.test.ts` (11).
- Passing: `npm run test:materials` (11), `tests/materials-suppliers.test.ts`, `tests/project-history.test.ts`,
  `tests/payments-api.test.ts` (9), `tests/labor-work-order-documents.test.ts`, `tests/project-scope-work-browser.test.mjs`
  (23), `tests/project-tab-labor-scheduling-off-browser.test.mjs` (5, its source check updated for the new order
  writer), `tests/materials-scope-ui.test.mjs`, `tests/closeout-completion-browser.test.mjs`, `tests/access-gates.test.ts`
  (snapshot regenerated), `npm run test:publication` (86), `npm run check`.
- Failing on canonical without this change too: `tests/production-documents.test.ts` (payments not set up in the
  fixture) and one `tests/comms-api.test.ts` notification assertion.

## Rollout

- `3d45f7cc`: integrated with `integrate.py`; first ship failed at prepare (pool unreachable), then waited for the
  labor/work-order release (`c52ecca5`) to reach the hosts, since this release's `seeds.ts` and `materials-api.js` sit
  on top of it. Activation on legacy and web lost several races to other sessions' activations; shipped one role at
  a time. Web verified on `3d45f7cc`; worker and legacy carried its files under later releases (audited file by file).
- `29562fd1`: shipped web, legacy, worker one at a time; all three activated, then other sessions' releases replaced
  "current", so `verify` reports a moved release. Audited live files on all three roles for this release's edits.

## Verified on dev

Sandbox organization `org_0be79c9db0e60b5a`, project `project_1jxr2sd1ru59k4`, test suppliers ABC Supply (test) and
Beacon Building Products (test) with example.com order addresses (dev's catch-all):

- Two lists from two suppliers: one card each, side by side at 1800 px and stacked at 1024 px without overlap;
  per-card Copy carries only that supplier's email (clipboard captured: the browser pane denies clipboard writes).
- Purchase order tab: PO-1001 (Beacon) and PO-1002 (ABC) with supplier SKUs; a typed note re-renders the preview;
  Download PO returns the Chromium-rendered PDF; the PO is a `purchase_order` document in the project's Documents.
- Sending ABC only marked only Roof ordered (order: email, PO-1002); Gutters stayed open. Sending Beacon then marked
  Gutters ordered with its Oct 29 delivery date and event, PO-1001. Both emails are in the project's comms, the
  supplier email with `purchase-order-po-1001.pdf` attached.
- Shopping list: assigned to the project's assignee; link sent by email; the public page checked an item off and
  kept it on reload; a view-only link shows no boxes; the PDF shows a ticked box for the picked-up item.
- Mark as ordered on a generated list recorded it without sending; deleting that generated list worked (the delete
  button had been disabled for generated lists, which is what Jack hit).

Not verified on dev: item images on the shopping list (the sandbox price book has no images; the path is covered
by the tests), SMS sending of the link, and the pool role.
