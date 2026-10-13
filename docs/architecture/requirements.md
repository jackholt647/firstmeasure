# Requirements, work items and coverage

A project has two lists that carry money, **materials** and the **work order**,
and a third that carries none: its **requirements**. Requirements say what has
to exist or be done. The lists say how, by whom and for how much. Coverage is
the link between them: which lines account for which requirement.

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
never change. The quantity rules are rules of thumb and are in code today; an
organization cannot yet change them or add its own items.

`workRequirements(schemaIds, context)` returns what a job requires. An item two
kinds of work both require is one requirement with the amounts added.

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

Equipment adds up, so two dumpsters are not a duplicate. Material on a material
list is a requirement that has already been made specific, so each material
type is listed as covered by its own lines.

A project's kinds of work come from the scope each list was generated from and
from the sheet each work order is priced on. With neither, there is nothing to
require and the result is `empty`.

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

## Published

- `work-items.dictionary`, `work-items.catalog` — `view_project_data`.
- `measurement-schemas.partitions` — `view_project_data`.
- `work-requirements.project` — `manage_projects`.
- `assignee-capabilities.assignee` — `manage_projects`; action
  `assignees.capabilities.save` — `manage_company_settings`.

Routes under `/v1/materials/organizations/:orgId`:
`POST projects/:projectId/requirements`, and `GET`/`PUT`
`assignees/:type/:assigneeId/capabilities`.

## In the Project tab

Labor and equipment lists share one **Work order** column. Equipment an
assignee brings is a line on their own list. The **Requirements** tray follows
the columns: closed, its bar shows red when anything is open, yellow when
anything has a warning, and green otherwise; open, it pins what needs attention
first and groups the rest. A row expands to the lines that account for it and
to the actions: take work off a work order, give it back, or mark a
hand-added line as covering it. A line with a warning carries a triangle in its
list. The tray has no total.

## Not built

- Equipment types declaring the functions they fulfil, and the editor for it.
  Today a function is covered by a pay sheet's equipment or by a marked line.
- Organization-defined work items and quantity rules.
- Requirements added by hand for one project.
- Splitting a requirement by structure.
- Whether work was actually done. Coverage is about what is planned and paid
  for; "done" belongs with actuals.
- Load weight alongside volume, and a cost per load.

Run `tests/work-requirements.test.ts` for changes here.
