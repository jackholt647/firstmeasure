# Exterior report: measured trim, left-aligned totals — development, October 23, 2026

Release `53c787f8` (parent `9b12921d`). One file: `public/measure/internal/editor_scripts/exterior_pdf.js`.

**Trim.** Trim was drawn but never measured. The Opening Schedule's "Trim ft" was the opening perimeter, even for
openings without trim. The PDF now measures the trim the model draws, so saved snapshots report it too:

| Trim | How it is measured |
| --- | --- |
| Openings (window, door, garage door, gable vent) | Each trim board along its outside edge. Doors and garage doors have no bottom board. |
| Wall trim (horizontal, vertical) | Faces with a trim material, along their run. |
| Roof trim (fascia) | Along the roof edge it hangs from. Edges set to zero height are excluded. |

- **Exterior Quantities** has two columns: Measured lengths and Trim.
- **The Trim column** lists window, door, garage door, horizontal wall, vertical wall and roof trim, then the
  total. Gable vent and other opening trim rows show only when present; an empty kind shows "-".
- **The Opening Schedule's** trim column is the measured trim, "-" when the opening has none. Its note says so.
- **Pilot house.** On the pilot house's saved model (`exteriors_057d…`), only the front door has trim (18.1 ft:
  7.6 + 3.0 + 7.6 ft). The windows and garage doors have none, and the roof trim is 345.1 ft.

**Totals box.** In the narrow totals box (the landscape elevation side panels), the figures were drawn flush right
under a left-aligned label. They are now left-aligned under it.

**Tests.** In `dev/exterior-pdf-layout.test.cjs` (29/29):
- the Opening Schedule assertion now expects measured trim, not the perimeter;
- a new case covers door, garage, wall and roof trim lengths and the total.

`exterior-report`, `pdf-landscape`, `report-localization`, `exterior-orientation`, `sticker-divisions`,
`roof-materials` and `full-house-customer-summary` all pass. Run the `dev/` tests from the repository root.

**Rollout.**
- Legacy and web: three-way merged, with `output/fh-trim-20261023/pdf-edits.py` to replay on conflict. Verify
  passed, and dev serves the new file.
- No cache bump: editor scripts are versioned by content hash.
- The pool node (`10.124.16.3`) is still unreachable.
- **Worker not updated.** The worker's server-side PDF runtime loads `exterior_pdf.js` from its own release. That
  copy is from October 7 (28 KB), so it already lacks two weeks of report layout work. Patching only this change
  into it would be wrong; the worker needs a full update of its editor scripts.
