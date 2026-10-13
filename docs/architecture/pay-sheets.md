# Pay sheets

Materials can be priced centrally because every supplier sells the same
products. Labor cannot: two subcontractors charge for different things on the
same roof, one by the square, one by the bundle, an in-house crew by the hour.
So there is no shared catalogue of priced labor tasks. Each
[assignee](assignees.md) has a **pay sheet** (`labor/pay-sheets.ts`, collection
`labor_pay_sheets`): how that one party is paid, written as data that can be
evaluated against any job.

## Shape

A sheet belongs to one [assignee](assignees.md), stored as its
`subject` (`organization_user`, `resource_group` or `organization_connection`),
and has:

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

An assignee has one sheet for each kind of work, and at most one that names no
kind of work; a second is refused, so it is never unclear which applies. A sheet
can only be saved for an assignee that exists.

Bind material inputs to an item type where possible. A type covers items added
to the price book later; a single item id must be revisited when that item
changes. Sheets are evaluated against the project's current lists, so signed
documents never need changing to suit a pay sheet.

## Evaluation

`evaluatePaySheet(sheet, context)` is pure and deterministic: the same job
gives the same lines every time. It never invents a quantity:

- a required input that is missing leaves its entries in `unresolved`, with the
  reason, and `complete` is false. That includes an entry whose `when` gate is a
  required input nobody has entered: the gate cannot be decided, so the entry is
  not dropped;
- an optional input with nothing recorded and no default simply does not apply;
- a measurement recorded in another unit is not that measurement;
- material of one type recorded in different units is not added together; the
  input is missing and says why;
- when a whole source could not be read (project fields, measurements), every
  input of that kind is missing whatever its default says, because "could not
  read" is not "zero".

Measurements are read through `measurementAmount` in
`platform/publication/measurement-schemas.ts`, the same reading the assessment
uses, so the two never disagree. A pitch band with no key of its own is summed
from the exact pitches a producer recorded.

**Structures.** The project total is what gets paid, because it carries manual
corrections. A `per_structure` input is priced structure by structure only when
every structure has a value and together they equal the recorded total (or no
total is recorded, in which case their sum stands in for it). Otherwise it is
priced once on the total. A partial breakdown never reduces pay.

**Minimums** apply to the entry as a whole. When an entry's lines come to less
than its `minimum_cents`, the difference is added as its own "(minimum)" line.

`evaluateProjectPaySheets` prices every sheet (or one) against the same
project, so assignees can be compared on the same job. It reads the project's
selected measurement dataset, the material on its lists that are not archived,
and its fields. Project fields are read on the server through the same path the
data layer publishes them (`custom-fields-project.values`): stored values,
defaults, formulas and published calculations, with yes/no fields counting as 1
and 0 and text never read as a number. A field input names the field's path, or
the `custom_<path>` name the Project tab's formulas use. Numbers entered by
hand, and any field value the caller wants to override, are passed in.

An agent may write or propose a pay sheet from a subcontractor's price sheet;
it does not compute pay. Pay comes only from an approved sheet's evaluation.

## Published

Provider `pay-sheets`. A pay sheet is a compensation record:

- `catalog` — every sheet. `manage_company_settings`.
- `requirements` — per sheet, the schemas it covers and each declared input
  with its source and whether it is required. `manage_company_settings`. This is
  the consumer side of the data layer: compare it with
  `measurement-schemas.assessment` and a project's lists to see what an assignee
  still needs.
- `evaluation` (project; arguments `sheet_id`, `fields`, `manual`).
  `manage_projects`.

Actions `pay-sheets.sheet.save` and `pay-sheets.sheet.archive` need
`manage_company_settings`. The HTTP routes are under
`/v1/materials/organizations/:orgId/pay-sheets` and
`…/projects/:projectId/pay-sheets/evaluate`, with the same permissions.
Documents, scope code and the assistant read these views when granted them.

Material calculations do not yet publish their declared inputs the same way.

## Not built

Generating a labor list from a sheet, the editor for sheets, and equipment needs
covered by a crew. Committing a list and delivering it are described in
[assignees](assignees.md). Development Instant
Full Orgs start with two sample sheets (`labor/sample-pay-sheets.ts`), with
placeholder rates.

Run `tests/labor-pay-sheets.test.ts` for changes here.
