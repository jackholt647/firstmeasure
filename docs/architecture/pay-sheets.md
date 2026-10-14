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
  rate and are what the assignee is paid; `flat` is one amount. `cost_rate` is
  for salaried people: hours at what their time costs the business. It projects
  the job's cost and is never paid out (their pay is their salary), and the
  evaluation reports it separately as `projection_only_cents`. `salary` is
  recorded but never charged to a job.
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

A sheet prices a job. Paying the assignee for a committed list, their hours or
a salary is done by [pay rules](pay-rules.md), which can read what a committed
list came to. Piece-rate pay for a list is earned when its work is confirmed as
done and finalized to be paid, which also locks the list; see
[closeout](closeout.md).

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

## Generating a labor list

A labor list's lines come from its assignee's pay sheet (`labor/generation.ts`).
`generateLaborList` prices the list's project on the one sheet that applies —
the sheet asked for, else the assignee's sheet for the list's kind of work, else
their only sheet; more than one candidate is an error, never a guess — and
writes the result as the list's lines:

- one line per pay line, carrying the sheet and entry it came from. A number
  only a person can supply that is paid directly at a rate (hours, extra layers)
  is typed into the list as that line's quantity: the line is written at its
  rate with no quantity, and regenerating prices the job on whatever has been
  typed. A line has no pay type of its own to choose;
- a line with no price for anything unresolved, saying what it is waiting for;
- a line for each piece of equipment the assignee brings, free when included.

Lines someone added by hand are kept; generating again replaces only what
generation wrote, so reassigning a list reprices the same job on the new
assignee's sheet. Salary entries are not written: they are not a cost of the
job. The list records what it was generated from in `metadata.labor_generation`.
Generating never commits; committing is its own step.

`compareAssigneesForList` prices every assignee that has a pay sheet on the same
job, complete prices first and cheapest first, so one can be chosen before
anyone is assigned. `previewLaborList` shows what generating would write
without writing it.

**Measurements for a project with no dataset.** Most projects still keep their
measurements where the Project tab reads them rather than in a selected
measurement dataset, and the dataset layer treats a missing dataset as enabling
that older path. So these three calls accept `legacy_measurements`: dictionary
keys, in the dictionary's units, supplied by the caller. Anything else is
dropped, they are ignored the moment the project has a selected dataset, and the
result says which was used (`measurement_source`: `dataset`, `project` or
`none`). Remove this once projects have datasets.

Routes: `lists/:listId/generate`, `…/generate/preview`, `…/assignee-pay`, and
action `labor.list.generate`, all `manage_projects`.

## Mapping pay to the work

A sheet is three things: how the assignee is paid (its entries), the work they
do (work items from [requirements](requirements.md)), and the mapping between
the two. The mapping may read anything a sheet can read.

- An entry's `covers` lists the work items and functions it pays for. An entry
  that covers nothing is always charged.
- `work` lists items done at no separate charge (`included`) and roughly how
  many hours one unit of each takes (`hours_per_unit`).
- Equipment `provides` the functions it fulfils, with a `capacity`, or
  `per_load` when it can be emptied and used again.
- An item that is none of these is not offered on the sheet, and stays open on
  the project until something else accounts for it.

**Counting and adjusting.** Work is paid for once. An entry that reads the
measurement the work is sized by is its pay. An entry that reads a part of that
measurement (steep squares, where the work is all the squares) adjusts the
price and is not a second cover, unless the sheet's entries for that item read
parts that add up to the whole, in which case those parts are the pay. An entry
that reads something else entirely (hours, bundles, a flat price) covers by
declaration. `role` on an entry overrides this. `paySheetCoverRoles` and
`paySheetWork` work it out.

**Hours.** An input with source `work_hours` is estimated from the job's
requirements and the sheet's `hours_per_unit`, to the nearest quarter hour. A
number typed for the job replaces the estimate; an estimate nobody changed is
worked out again each time. The estimate is meant to be shaped like the work,
so that more work means more hours, not to be exact. `duration` may be
`{ hours_per_day }` to turn the same hours into days.

**Part of the work.** Evaluation takes a `scope` of work items. Entries for
work outside it are not charged. An entry that pays for work both inside and
outside it is charged in full and says so (`covers_outside`).

### Writing a good mapping

A weak mapping does not break anything; it produces a warning or a wrong
number that a person has to catch. When writing or reviewing a sheet:

- Prefer one entry for each work item where the assignee's pricing allows it. A
  single price for tear-off and install cannot be split when someone else does
  the tear-off.
- If the assignee does something without charging for it, say so with
  `included`. Leaving it off says they do not do it.
- Do not mark a surcharge as covering work on its own. A sheet whose only line
  for an item is an adjustment never pays for that item.
- Give hours to every item the assignee does, so an estimate moves when the
  scope of work does.
- When an assignee brings equipment, say what it provides. Otherwise the
  function stays open.

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

The editor for sheets. Pay against what was committed is in [pay rules](pay-rules.md). What a job
needs and what covers it is in [requirements](requirements.md). Committing a list and delivering it are described in
[assignees](assignees.md). Development Instant
Full Orgs start with five sample sheets (`labor/sample-pay-sheets.ts`), with
placeholder rates.

Run `tests/labor-pay-sheets.test.ts` for changes here.
