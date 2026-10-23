# Development rollout: estimate structures (2026-10-22)

Release `c8ecbce6` ("Estimate structures: turn a report's structures on or off, add one by hand, price them together
or one section each"), committed on `claude/estimate-structures-267ff6` and integrated into
`codex/consolidated-firstmeasure-20260923`. Development only; production unchanged.

## What shipped

The Documents estimate workflow's measurements step (`doc-workflow/firstmate-doc-workflow.js`) lists the structures
the project's measurement dataset measured and keeps the document's choices in `params.measurement_structures`:
which are on, their names, and structures entered by hand (`origin: "manual"`, with who and when). `params.measurements`
stays the combined values every formula reads: the report's totals, less a structure that is off, plus a structure
entered by hand. A structure entered by hand asks for the structure-level dictionary measurements of the schemas the
selected scope templates name (`measurement_schema_ids`), narrowed to what the estimate reads, with units. The document
can price structures together (default) or as one section of line items per structure. Lines nobody has edited since
they were generated follow a change of structures on their own. See
[measurement schemas](../../docs/architecture/measurement-schemas.md#structures-in-an-estimate).

Files: `public/libraries/doc-workflow/firstmate-doc-workflow.js`, `public/libraries/apps/documents/project.js`,
`public/libraries/apps/firstmate-apps-manifest.js` (both bundles at `20261022-estimate-structures`; the runtime
inherits `documents/project.js`'s query string), `public/v1/tests/estimate-structures.test.ts`,
`docs/architecture/measurement-schemas.md`.

## Rollout

- Browser-only release: legacy and web, `output/estimate-structures-20261022/ship.sh` with `ROLES="legacy web"`.
  Both verified at `c8ecbce6`. The first attempt to web was refused ("Active release changed") because another
  session activated mid-stage; the script re-audited and restaged.
- **Pool not updated.** The pool node (10.124.16.3) answered "No route to host" through the whole window (also
  recorded by the estimate photos rollout). When it is reachable:
  `ROLES=pool bash output/estimate-structures-20261022/ship.sh`.

## Tests

- `tests/estimate-structures.test.ts`: 5/5 (a real two-ROOF model through the roofplan producer; turning a structure
  off and back on, with real price-book generation; a structure entered by hand from the roofing schema; hand-changed
  values survive; per-structure pricing). `npm run check` passes.
- Pre-existing failures, identical on a clean checkout of canonical without this change:
  `documents-api` "instances attach the default workflow; workflow routes serve state and audience-filtered public
  views"; `pricebook-scope-generation` "the bundled template offers the GAF lines, more by search, with colors and a
  finish on the line"; `workflow-builder-ui-contract` "workflow preview owns fixed pagination…" and "workflow fields
  support descriptive and type-specific presentation"; `document-attach-library-browser` "the line item attach
  popover shows the media library inside itself and saves the pick".

## Verified on dev

No completed report on dev has more than one ROOF in its model (newest 4,446 scanned) and no measurement dataset
carried structures, so a test project was made in the pilot test organization "FH Pilot Roofing (test)"
(`org_301b0d762ed917ba`): `project_018e892c4f2df367`, "Estimate structures test - house + garage (synthetic report)",
whose selected dataset is the roofplan producer's output for a small two-ROOF model (26 sq + 6 sq), provenance
`producer: test` (`output/estimate-structures-20261022/seed-test-project.mjs`, run on dev web).

Headless Chrome as the pilot customer (`pilot/s6-flow.cjs`), new "Roof replacement · Itemized proposal":

| Step | Combined roof squares | Line items total |
| --- | --- | --- |
| Both structures on | 32 | $20,195.80 |
| Garage off | 26 | $15,860.00 (lines followed on their own) |
| Garage back on, shed entered by hand (4 sq at 4–6/12, 30 ft eaves, 10 ft ridges) | 36 | $22,662.30 |
| One section per structure | 36 | $23,180.30 (sections House, Garage, Shed) |

The hand-entry form asked for roof squares (summed from the pitch bands), the six pitch bands and seven line lengths,
with units; the shed shows "Entered by hand (FH Pilot Customer, 2026-10-23)" and the combined fields it feeds show
"incl. by hand". The live preview shows a section and subtotal per structure.

To reach the Documents app with the pilot login, `platform.documents`, `platform.pricebook` and
`platform.expanded_access` were switched on for that organization during the check and switched back to `false`
afterwards (`caps-set.mjs` / `caps-restore.mjs`). The test project and its dataset remain.

## Not done here

- After signing, the roofing materials calculation still stamps every line `structure: 'Main house'`.
- No document widget summarizes structures; per-structure sections are how the document presents them.
