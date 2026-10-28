# Ordering materials

How a project's material lists are ordered from the Materials column of the
project window. The order record itself is unchanged: `createMaterialOrder`
for a material list, the ledger's `order` command for a generated set
([materials calculus](materials-calculus.md)).

## The order window

The left side holds one tile per material list: whether it is in this order,
its supplier (or another email address), its delivery date and time, and which
other list it is delivered with. Lists sent to the same supplier or address
are that supplier's part of the order. The right side has three tabs over the
same selection, and **Mark as ordered** at the bottom right on every tab:

| Tab | What it is | Its action |
| --- | --- | --- |
| Email | One card per supplier, collapsible, side by side when there is room. Each card is copied and sent on its own; sending one marks only its lists ordered. The order goes as the purchase order attached (PDF), a table in the email, or both. Order date and requested delivery are always in the email. | Send (one supplier) or Send all |
| Purchase order | The `purchase_order` document for each supplier, previewed as it prints. The PO number, message to the supplier, notes and terms are edited here; supplier, dates, lines and prices come from the tiles. | Download PO |
| Shopping list | A checklist by supplier for whoever picks the materials up, with quantities and images. | Download shopping list; share with the project's assignees, or a link sent or copied |

**Mark as ordered** records the selected lists as ordered without sending
anything. Ordering never depends on scheduling: when a delivery date cannot be
put on the schedule (scheduling off, or the event write fails) the order still
records the date and time in its `scheduled_window`.

An order's `metadata` says how it was placed (`order_method`: `email` or
`marked`), which parts its email carried, and its `po_number` and
`po_document_id` when it had one.

## Purchase orders

`purchase_order` is a document type (`documents/types/registry.ts`) with the
template `tpl_purchase_order_default` (a config library `document_template`
entry; its default terms are that template's `terms` parameter default),
a system template an organization can edit like any other to change how every
purchase order is written. One document per supplier's part of an order: its
id comes from the project and the order's key (supplier plus lists), so editing
it in the order window rewrites the same document. The PO number comes from the
organization's sequence (`material_purchase_order_sequences`, prefix `PO-`,
starting at 1001) the first time the document is made; a number typed in the
order window is kept. Numbers are not reused.

- `POST /v1/materials/organizations/:org/projects/:project/purchase-orders/preview`
  writes it and returns what the renderer needs to show it.
- `.../purchase-orders/pdf` renders it through `renderTemplatedArtifact`.
- `.../supplier-emails` sends one supplier its email through the project's
  email (`sendProjectEmail`, which takes attachments from server callers only),
  with the purchase order PDF attached when it is given.
- Action `materials.purchase_order.write` publishes the same writer.

## Shopping lists

A shopping list is a project checklist (`workforce/crew_storage.ts`) whose
`metadata.source` is `materials_shopping_list`. Each item is one material, in
supplier order, with its quantity, unit, SKU, image and the list and line it
came from in its metadata. It is assigned to the people and groups the project's
work orders are assigned to (as chosen), who see it in their checklists on the
project and check items off there.

Anyone else gets a [public link](../public-links-api.md) of kind
`materials_shopping_list`: `view` only, or `view` and `check`, for 30 days by
default. The address given out is the page itself,
`/v1/materials/public/shopping-lists/:token/app` (a bare `/l/` link is not routed
to the API on every host), a page that needs no account; opening it records the
link's use, and checking an item there completes the checklist item as
`public_link:<link id>`. The link can be sent by email or text through the
project's conversations, or copied.

The PDF is a `shopping_list` document (`tpl_shopping_list_default`) written from
the checklist as it stands, with ticked boxes for what has been picked up.
Action `materials.shopping_list.create` publishes the writer.

## Deleting a list

Any material list can be deleted, including the last one and a generated one.
A generated set is retired (`retire` on the ledger): it leaves `sets` for
`retired_sets`, stops counting toward requirements, and is never published again
under the same identity. Orders placed against it are kept and show as
unallocated.

## Verification

From `public/v1`: `tests/materials-ordering.test.ts`,
`tests/materials-calculus.test.ts`, `npm run test:materials`,
`npm run test:publication` and `tests/access-gates.test.ts`.
