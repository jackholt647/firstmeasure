# Measurement dictionary and schemas

Measurements are standardized; work is not. Documents, material calculations and
(next) crew pay sheets all need to agree on what "roof area" is called without
agreeing on anything else. `platform/publication/measurement-schemas.ts` holds
that agreement.

## Dictionary

A **definition** is the meaning of one measurement: a stable id
(`roof.ridge_length`), the key measurement datasets store it under (`ridgesLf`),
its unit, and the levels it can be recorded at (`project`, `structure`). A family
of keys uses `keyPattern` (`pitch6Squares`, `pitch7.5Squares`, …). One key has
one meaning: registering a second definition for a claimed key fails.

`measurementAmount` and `measurementAmounts` are the only place a measurement is
read as a number: the assessment and pay evaluation both use them. A banded
definition (`roof.squares_9_to_12`) may `derive` from a family: when a producer
recorded exact pitches instead of the band, the band is the sum of the pitches
that fall inside it. With no project total recorded, structures that are all
measured stand in for it.

Write definitions as facts about the building, not as a trade's idea of it.
`exterior_wall.net_area` is a fact; "siding area" is an interpretation that a
mason and a painter would each read differently. Facts are what stay true across
industries nobody has thought about yet.

The dictionary only grows. These rules are what keep it from ever needing a
migration:

- Never change a definition's meaning, unit or key. If one turns out wrong,
  add the right one beside it and stop using the old one.
- When unsure whether two trades mean the same thing, define two. Declaring
  later that two definitions are the same is an addition; splitting one that
  was shared too early is not.
- Prefer a narrow name. `roof.area` can coexist with whatever another
  industry needs; a bare `area` cannot.

## Parts of a measurement

Some measurements are a part of another: squares over 8/12 are roof squares
narrowed by pitch. A definition says so with `slice: { partition }`, and a
**partition** says which base measurement it cuts, by which attribute of the
building, and whether its parts add up to the whole.

Roof squares are cut three ways: `roof.pitch_bands` and `roof.pitch_exact`
(both complete, since every square has a pitch) and `roof.access_carried` (not
complete: it names the hand-carried squares and leaves the rest unnamed).

This is what lets a consumer tell overlap from addition without being told case
by case. Parts of one partition never overlap. Parts of two partitions of the
same base may count the same squares, so they are never added together: ten
hand-carried squares are ten of the squares the pitch bands already count, not
ten more. A combination nobody measured (steep and hand-carried) is unknown,
and is only added to the dictionary when something prices on it.

`measurementBase`, `measurementRelation`, `measurementCover` and
`measurementWhole` answer these questions. A partition must cut a whole
measurement, not another part, and a part must be in its base's unit. When
FirstMeasure produces the measurement, any combination could be worked out from
the roof planes; a hand-entered dataset holds only the parts someone gave.

[Requirements](requirements.md) uses this to decide whether a pay line pays for
a piece of work or only adjusts its price.

## Schemas

A **schema** (`roofing`, `gutters`, `siding`) is a selection from the
dictionary for one kind of work, marking each measurement required or optional.
Two schemas share a measurement by naming the same definition — gutters and
roofing both use `roof.eave_length` — so nothing needs pairing when an
organization does both. A new industry is mostly a new selection plus the few
definitions it adds. Schemas carry a version; a changed selection is a new
version, not an edit.

Scope templates say which schemas they work in with `measurement_schema_ids`
(`measurementSchemaIdsForScope`). The built-in production presets declare
theirs. A template with none is unscoped, which is correct for work whose pay
and materials do not depend on measurements, such as hourly or salaried labor.
Labor pricing must declare a schema whenever it binds to a measurement, because
labor terms are ambiguous across trades; material and equipment calculations
may, since product identity already disambiguates them.

## Producers and structures

FirstMeasure is one producer. Its adapters in `firstmeasure-datasets.ts` write
dictionary keys and may not introduce a name of their own; a test fails if they
do. Manual entry and other tools fill the same keys.

A measurement dataset holds project totals in `measurements` and may also hold
`structures: [{ id, name, measurements }]`. Totals stay authoritative for
consumers that only want a total. Manual overrides apply to totals. A
FirstMeasure report with more than one structure publishes each structure's own
faces and lines (its model file has one `ROOF` element per structure). Those
come from the model geometry, while totals prefer the saved report's
classifications, so the structures need not sum exactly to the total. Exterior
wall measurements are not yet broken down by structure.

### Entered by hand

A project with no completed report can still have measurements. The Project
tab rail's Measurements view becomes an editor when the project's scope
templates name a schema (from its running work plans and its lists): it lists
the project-level dictionary measurements those schemas select that have a key
of their own (`manualMeasurementFields`; a `keyPattern` family such as squares
at each exact pitch is entered through its bands), required ones first, with
their labels and units. Projects whose scopes name no schema keep the empty
state.

Two definitions can be the same quantity in different units: roof area in
square feet and roof squares of 100 square feet. The dictionary says so with an
**equivalence** (`registerMeasurementEquivalence`), an addition that changes
neither definition. Its units must be the same kind in `UNIT_SCALES` (area,
length), neither may be a part of a partition, and the first member listed is
the one a person enters. When a schema asks for any member, the editor asks
once, for the first, required if any member is; the writer stores every other
member beside it, converted by the units' scales
(`measurementEquivalents`), so readers that want square feet and readers that
want squares both find a value and the assessment never reports the other one
missing. A value sent for another member (an agent sending roof area) is taken
as the same entry. Units are never converted outside a declared equivalence.

The entries are an ordinary measurement dataset, one per project, with role
`manual`, producer `manual` and `source: "manual"` on each value
(`platform/publication/manual-measurements.ts`). `measurements.manual.save` is
the only writer: a number sets a key, null clears it, only the schemas' keys in
the dictionary's unit are accepted, it carries the dataset's store revision so
two people cannot overwrite each other, and it records a `measurements` change
in [project history](project-history.md). `measurement-schemas.manual` reads
what the editor shows. Because the entries are a dataset, everything that reads
the project's selected dataset (`effectiveProjectMeasurements`: material
calculations, measurement defaults, pay sheets, requirements, the assessment,
`project-widgets.measurements`) reads them exactly as it reads a report.

**Precedence.** A project reads one selected dataset, never a mix. The entries
are selected only while nothing else is, and unselected when the last one is
cleared. A completed report replaces them when it is published
(`publishCompletedFirstMeasureDataset` selects the report when nothing or the
manual dataset is selected, and records the switch); it never displaces any
other selected dataset. The entries stay stored and the rail shows them as
"Your entries" beside the report's numbers until they are cleared, but nothing
reads them while the report is selected. Adjusting a report's numbers is the
separate override mechanism above, which survives reimports and is not this.
Run `tests/manual-measurements.test.ts` and
`tests/manual-measurements-browser.test.mjs` for changes here.

### Structures in an estimate

The Documents estimate workflow's measurements step lists the structures and
keeps the document's choices in `params.measurement_structures`
(`FMDocWorkflow.structures` in `doc-workflow/firstmate-doc-workflow.js`):
which report structures are on, their names, and structures **entered by
hand** (`origin: "manual"`, with who and when). The report's dataset is never
written: these are the document's own choices. `params.measurements` stays the
combined values every formula reads: the report's totals, less what a turned-off
structure measured, plus what a hand-entered structure measured. Everything on
and nothing added is exactly the report.

A structure entered by hand asks for the structure-level dictionary
measurements of the schemas its scope templates name (`measurement_schema_ids`),
narrowed to the ones the estimate reads; a part of a partition the estimate
holds brings its siblings (squares by pitch band), and a whole whose complete
partition is asked for adds up from its parts. A template that names no schema
falls back to the step's own fields. The document can price the structures
together (default, the step's `structure_pricing`) or as one section of line
items per structure, each generated from that structure's own measurements: a
value the report did not split (pipe boots) goes to the first structure, and a
shared percentage (waste) applies to each. Lines nobody edited since they were
generated follow a change of structures on their own; edited lines show the
regenerate warning instead.

After signing, the roofing materials calculation (`roofingCalculus`) labels each
material line with its structure: its own section's when the estimate priced each
structure on its own, otherwise the structures the estimate includes ("House +
Shed"). A document with structures states its combined measurements as the
measurements its work is sized from ([requirements](requirements.md#where-requirements-come-from)),
so required work follows the structures too. Pay sheets still read the project's
measurement dataset. Run `tests/estimate-structures.test.ts` for changes here.

## Published views

The `measurement-schemas` provider (permission `view_project_data`) exports:

- `dictionary` — every definition.
- `partitions` — how base measurements are cut into parts.
- `catalog` — every schema.
- `assessment` (project, argument `schema`) — that schema against the project's
  selected measurements: each measurement's status (`ready`, `missing`,
  `unit_mismatch`) and values in total and per structure, the required ones
  still missing, and dataset keys no definition recognizes. Missing is never
  reported as zero and a value in another unit is never converted.

`assessment` is the start of a requirements view: what a kind of work needs
against what a project has. [Pay sheets](pay-sheets.md) publish their declared inputs through
`pay-sheets.requirements`; material calculations do not yet.

Run `tests/publication-measurement-schemas.test.ts` and `npm run test:publication`
for changes here.
