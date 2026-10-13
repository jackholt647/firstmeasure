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

## Published views

The `measurement-schemas` provider (permission `view_project_data`) exports:

- `dictionary` — every definition.
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
