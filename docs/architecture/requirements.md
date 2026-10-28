# Requirements, work items and coverage

A project has two lists that carry money, **materials** and the **work order**,
and a third that carries none: its **requirements**. Requirements say what has
to exist or be done. The lists say how, by whom and for how much. Coverage is
the link between them: which lines account for which requirement.

## Where requirements come from

Three layers, and they do different jobs:

1. **The scope set** for a kind of work (roofing) standardizes the vocabulary:
   which measurements exist, which work items and functions a job of that kind
   *could* include, and how each is sized. It describes the type of job, not
   any one job.
2. **The project's scope artifacts** say what *this* job includes. They are the
   sets in the project's materials ledger ([materials calculus](materials-calculus.md)).
   Each set carries material lines and, in `work`, the work items and functions
   the job includes. An accepted document's calculation publishes them; Operations
   can also explicitly publish a retained internal scope snapshot before customer
   acceptance. That origin is marked `planning: true`, never signed or accepted.
   A later signed version of the same proposal replaces that set's source in place,
   preserving its identity, material lines and orders instead of doubling requirements. A
   person can add work by hand; an agent can build a set from scratch. They
   take their shape from the scope set and the measurements, and their content
   from whatever defined the job.
3. **The requirements** are those artifacts added together, and nothing else
   (`labor/scope-artifacts.ts`, `requiredWork`). No artifact naming work means
   no work is required, however much roof has been measured. No material
   artifact means no material is required.

An artifact names a work item by its dictionary id. An amount it states is
taken as stated, and stated amounts from several artifacts add. An amount left
out means "all of it": the scope set's rule sizes it from the project's
measurements, counted once however many artifacts say it. An artifact may state
the `measurements` its work is sized from instead (dictionary keys with explicit
units): an accepted estimate that left a structure out or added one by hand does,
so tear-off covers the roof that was sold, not every roof the report measured.
The latest artifact that states them sizes the item; the rules stay the scope
set's.

Nothing here prices anything. Pay stays in [pay sheets](pay-sheets.md); who can
be assigned stays in [assignees](assignees.md); what can be measured stays in
the [measurement dictionary](measurement-schemas.md).

## Work items and functions

`platform/publication/work-items.ts` holds one shared dictionary of what a job
can require:

- A **work item** is something that has to happen, with no price and nobody
  named: `roofing.tear_off`, in squares.
- A **function** is a capacity the job needs that is not labor:
  `disposal.debris`, in cubic yards. It is met by equipment, or by a company
  that simply takes care of it. Functions are not specific to one trade.

A **work schema** has the same id as a measurement schema (`roofing`) and lists
the items that kind of work requires, each with a rule for how much: dictionary
measurements added together, times a factor, times any project field named in
`scale` (existing layers). An item may sit `under` the item that causes it, as
disposal sits under tear-off; it is still met on its own. An `optional` item is
required only where there is some of it.

The amount is the work, never the pay. Thirty squares need tearing off whatever
pitch they are at. Pitch, access and everything else stay in the measurements
for a pay sheet to read. An amount that cannot be worked out is unknown, not
zero.

Like the measurement dictionary, this only grows: an item's meaning and unit
never change. Items and work schemas are [config library](config-library.md)
entries of the append-only kinds `work_item` and `work_schema`, edited on dev and
rebuilt into `work-items.ts` whenever the library changes. An item's `kind` and
`unit` never change (its label and description may); a work schema never drops an
item, and any change to it, including its quantity rules (which are rules of
thumb), needs a new `version`. An organization cannot yet change them or add its
own items.

`workRequirements(schemaIds, context)` is the scope set's sizing: what a job of
that kind would need if it included everything. It is used for amounts only.
What a project requires is `requiredWork(sets, context)` over its artifacts.

### Publishing a scope

- **From a document.** A `materials_calculus` deliverable's code returns
  `{ lines, warnings, work }`. `work` is `[{ item, quantity?, explanation? }]`.
  It is validated against the dictionary when evaluated and becomes the set's
  `work` when the evaluation is applied, with the material lines. The sample
  roofing proposals do this (config library templates `tpl_instant_roofing_*`).
- **By hand.** `saveManualScope` keeps one manual set per project ("Added by
  hand") and replaces its work as a whole, through the ledger's own create,
  evaluate and apply commands. Action `work-requirements.manual.save`, route
  `PUT projects/:projectId/scope/manual`.
- **From the organization's measurement defaults.** A project with a
  measurement report and no signed document can generate straight from the
  report: Settings › Reports › Default materials and labor holds material rules
  (roof measurements added together, a waste allowance, a package and a price
  book product) and the roofing work the job includes, each half switched on or
  off on its own (`materials/measurement-defaults.ts`; unsaved, an organization
  has the industry defaults with both on). Generating (`POST
  projects/:projectId/calculus/defaults`, the Materials column's wand) publishes
  them as one ledger set with origin `defaults` and evaluates and applies it as
  the `materials.calculus` generator. A packaged line keeps its measured amount
  and cost per measured unit, and is bought and priced in whole packages: its
  order quantity rounds up, and it costs what those packages cover
  (`materials/calculus.ts` `lineCost`; an order is priced per package). A
  package's coverage is in the rule's own unit, so the price book setup copies a
  product's coverage onto a rule only when its research rule measures the same
  unit. The calculation only interprets what it is
  given: the rules, and the measured amounts read on the server (the selected
  dataset, else the Project tab's `legacy_measurements`). Work is named without
  amounts, so the scope set sizes it; an optional item is named only where the
  roof has some. With default labor off the set names no work and nothing is
  required of a work order. **A document overrides the defaults completely:**
  once a set a document published is in the ledger, nothing is generated from
  the defaults and `projectScopeSets` leaves a defaults set out, so it is no
  longer a requirement (the Project tab still shows it if something was ordered
  against it).
- **By an agent.** The same two paths. `materials.calculus.command` lets an
  agent create a set whose code returns material and work, evaluate it and apply
  it; `work-requirements.manual.save` sets the hand-added work directly. The
  dictionary an agent needs is `work-items.dictionary` and `work-items.catalog`.

A set that has only been evaluated requires nothing; applying it does.

## Parts of a measurement

Deciding whether a pay line pays for a requirement, or only adjusts the price
of one, depends on knowing how measurements overlap. The dictionary records it:
a definition may be a `slice` of a **partition**, which cuts one base
measurement by one attribute of the building (roof squares by pitch band, by
exact pitch, by how material reaches the roof).

- Parts of one partition never overlap.
- Parts of two partitions of the same base may count the same thing and are
  never added together.
- A complete partition's parts add up to the base.
- A combination nobody measured (steep *and* hand-carried) is unknown.

`measurementBase`, `measurementRelation`, `measurementCover` and
`measurementWhole` answer these questions. See
[measurement schemas](measurement-schemas.md#parts-of-a-measurement).

## Coverage

A pay sheet maps how its assignee is paid onto the work (see
[pay sheets](pay-sheets.md#mapping-pay-to-the-work)). When a labor list is
generated, each line is stamped with what it accounts for, so the list itself
says what it covers:

| On the line or list | Meaning |
| --- | --- |
| `metadata.covers` | This line is the pay for these items. |
| `metadata.adjusts` | This line changes the price of work another line pays for. It is not a cover. |
| `metadata.covers_outside` | This line also pays for items that are not this work order's. |
| `metadata.provides` | Equipment on this line fulfils these functions, with a capacity or per load. |
| list `metadata.labor_generation.work_items` | What the assignee does at no separate charge. |
| list `metadata.work_scope.excluded_items` | Work this order leaves to someone else. |

A line a person added can be marked as covering a requirement by putting the
item in its `metadata.covers`. Generated lines are never marked by hand: they
are rewritten the next time the list is generated.

`projectRequirements` (`labor/requirements.ts`) reads coverage from the lists as
they stand, never from what a pay sheet would write, and gives each requirement
one of three states:

- **open** — nothing accounts for it.
- **covered**.
- **warning** — covered, with something to check. Warnings never block:
  `duplicate` (two parties account for it), `paid_outside` (a combined line on
  another work order still pays for it), `unpriced` (someone is doing it but
  the line has no price yet), `not_capable` (the assignee is not marked as able
  to do it), `short` (the equipment named holds less than is needed),
  `adjusted_only` (a line changes its price but none pays for it).

Equipment adds up, so two dumpsters are not a duplicate. Material in a set, or
on a material list a person made, is a requirement that has already been made
specific, so each is listed as covered by its own lines. A set an accepted
document published that has not been generated yet is material that is
required and not yet accounted for.

Each requirement lists its `sources`: the artifacts that say it is required.
The result also carries `manual_work` (what was added by hand) and `available`
(what the project's kinds of work would let a person add). A project's kinds of
work come from the scope each list was generated from and the sheet each work
order is priced on; they decide what can be added, never what is required.

### Splitting work between assignees

There is one assignee per work order. Tear-off by one party and install by
another is two work orders. Each records the items it leaves to someone else in
`work_scope.excluded_items`; generating then writes only the lines for what is
left. An entry that pays for one thing in scope and one thing out of it is
charged in full and reported as `paid_outside`: a single price for two things
is never split by guessing. That is a weakness of the pay sheet, and the fix is
to give the sheet one entry for each item.

Splitting by structure (the house to one party, the garage to another) is not
built.

## Capabilities

`labor/capabilities.ts` records what an assignee is able to do, apart from how
they are paid. They are granted the way permissions are: a kind of work grants
every item it requires, a scope the assignee is marked as doing
(`capability_scope_ids`) grants the kinds of work that scope works in, and
single items can be added or excluded on top. An assignee nobody has said
anything about is `known: false`, which is not the same as unable, and nothing
is reported against them.

## Equipment that provides a function

An equipment type lists the functions it provides as
`provides: [{ item, capacity?, per_load }]`, the same shape as a pay sheet's
equipment. `item` must be a function in the work item dictionary; capacity is
in the function's unit; `per_load` means it can be emptied and used again, so
capacity never limits the job. A unit may hold a different amount than its type
with `provides: [{ item, capacity }]`, only for functions its type provides.
`effectiveProvides` (`equipment/functions.ts`) is the type's list with the
unit's capacity where it has one; fleet units carry it as `effective_provides`.

An organization is offered only the functions needed by the kinds of work its
enabled scopes work in (`measurement_schema_ids`, then work schemas, then items
of kind `function`): `availableEquipmentFunctions`,
`GET /v1/equipment/organizations/:orgId/functions`, published as action
`equipment.functions.available` under `equipment.view`.

When equipment is picked for a line item on a project's equipment list, the
line is stamped with `metadata.equipment_unit_id`, `metadata.equipment_type_id`
and `metadata.provides`, a copy taken at the time. Coverage reads the line, not
the type, so a later change to the type does not change existing lines.

## Published

- `work-items.dictionary`, `work-items.catalog` — `view_project_data`.
- `measurement-schemas.partitions` — `view_project_data`.
- `work-requirements.project` — `manage_projects`; action
  `work-requirements.manual.save` — `manage_projects`.
- `equipment.functions.available` — `equipment.view`.
- `assignee-capabilities.assignee` — `manage_projects`; action
  `assignees.capabilities.save` — `manage_company_settings`.

Routes under `/v1/materials/organizations/:orgId`:
`POST projects/:projectId/requirements`, `PUT projects/:projectId/scope/manual`,
and `GET`/`PUT`
`assignees/:type/:assigneeId/capabilities`.

## In the Project tab

Labor and equipment lists share one **Work order** column. Equipment an
assignee brings is a line on their own list. The **Requirements** tray follows
the columns: closed, its bar shows red when anything is open, yellow when
anything has a warning, and green otherwise; open, it pins what needs attention
first and groups the rest. A row expands to the lines that account for it and
to the actions: take work off a work order, give it back, or mark a
hand-added line as covering it. A line with a warning carries a triangle in its
list. The tray has no total. Its "+ Add" adds something the kind of work offers
that no artifact has listed; a requirement added by hand says so and can be
removed there.

A covered requirement also shows how far it has got, from `progress`: a green
calendar when every list covering it is scheduled (each list's event in
`project.events`), and a green check on a green row when every covering list's
part is done (labor finalized to be paid, material delivered, equipment on
site). Each list cover carries `scheduled` and `completed`. Progress is read
from the lists as they stand, never changes `status`, and a warning stays a
warning. See [closeout](closeout.md#requirements-tray).

## Not built

- Organization-defined work items and quantity rules.
- A stated amount for a requirement added by hand in the Project tab (the
  server accepts one; the tray adds items sized from measurements).
- Documents accepted before this was built captured a calculation with no
  `work`, so they publish material only.
- Splitting a requirement by structure.
- Partial completion. A labor list is done when its work is finalized to be
  paid ([closeout](closeout.md)); there is no done state for part of a list.
- Load weight alongside volume, and a cost per load.

Run `tests/work-requirements.test.ts` for changes here, and
`tests/equipment-functions.test.ts`, `tests/equipment-functions-browser.test.mjs`
and `tests/equipment-functions-project.test.mjs` for equipment functions.
