# Pay sheets

Materials can be priced centrally because every supplier sells the same
products. Labor cannot: two subcontractors charge for different things on the
same roof, one by the square, one by the bundle, an in-house crew by the hour.
So there is no shared catalogue of priced labor tasks. Each crew, person or
subcontractor has a **pay sheet** (`labor/pay-sheets.ts`, collection
`labor_pay_sheets`): how that one party is paid, written as data that can be
evaluated against any job.

## Shape

A sheet belongs to one subject (`organization_user`, `resource_group` or
`organization_connection`) and has:

- **inputs** — everything it reads, each named, each `required` or optional
  with a `default`. A source is one of:
  - `measurement`: a dictionary definition such as `roof.squares`, optionally
    `per_structure`;
  - `material`: the quantity on the project's material lists of one price book
    item, or of every item of a type ("Hip & Ridge");
  - `field`: a numeric project field production fills in (pack-out distance);
  - `manual`: a number entered for this job (hours, extra layers).
- **entries** — pay lines. `piece_rate` and `hourly` multiply an input by a
  rate; `flat` is one amount; `salary` is recorded but never charged to a job.
  An entry may have a `minimum_cents`, a `multiplier`, and a `when` input that
  gates it.
- **equipment** — what the party brings, `included` or charged.
- **duration** — an input and how much of it the party gets through in a day,
  giving estimated days in half-day steps for scheduling.
- **schema_ids** — the kinds of work it prices.

A sheet that reads a measurement must name a measurement schema, and may only
read measurements that schema selects. Labor words mean different things in
different trades, and this is what stops "per square" on a roofing sheet being
matched to siding. A sheet that reads no measurement — purely hourly or
salaried — names none.

Bind material inputs to an item type where possible. A type covers items added
to the price book later; a single item id must be revisited when that item
changes. Sheets are evaluated against the project's current lists, so signed
documents never need changing to suit a pay sheet.

## Evaluation

`evaluatePaySheet(sheet, context)` is pure and deterministic: the same job
gives the same lines every time. It never invents a quantity:

- a required input that is missing leaves its entries in `unresolved`, with the
  reason, and `complete` is false;
- an optional input with nothing recorded and no default simply does not apply;
- a measurement recorded in another unit is not that measurement;
- a `per_structure` input yields one line per structure when the project has
  more than one.

`evaluateProjectPaySheets` prices every sheet (or one) against the same
project, reading its selected measurement dataset and material lists, so
parties can be compared on the same job. Project field values and manual
numbers are passed in by the caller; field values are not yet read server-side.

An agent may write or propose a pay sheet from a subcontractor's price sheet;
it does not compute pay. Pay comes only from an approved sheet's evaluation.

## Published

Provider `pay-sheets` (permission `view_materials`):

- `catalog` — every sheet.
- `requirements` — per sheet, the schemas it covers and each declared input
  with its source and whether it is required. This is the consumer side of the
  data layer: compare it with `measurement-schemas.assessment` and a project's
  lists to see what a crew still needs.
- `evaluation` (project; arguments `sheet_id`, `fields`, `manual`).

Actions `pay-sheets.sheet.save` and `pay-sheets.sheet.archive` need
`manage_company_settings`. The HTTP routes are under
`/v1/materials/organizations/:orgId/pay-sheets` and
`…/projects/:projectId/pay-sheets/evaluate`.

Material calculations do not yet publish their declared inputs the same way.

## Not built

Generating a labor list from a sheet, committing it to its recipient, the
editor for sheets, and equipment needs covered by a crew. Development Instant
Full Orgs start with two sample sheets (`labor/sample-pay-sheets.ts`), with
placeholder rates.

Run `tests/labor-pay-sheets.test.ts` for changes here.
