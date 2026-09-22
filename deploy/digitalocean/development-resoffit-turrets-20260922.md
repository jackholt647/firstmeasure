# Turret Resoffit junctions — September 22, 2026

Development runtime: `20b08ab6a68df26ef5521244fd4bcbb2f27ce3a3`.
Previous runtime: `6e0163edef2db805c2d618dc2312cec870df03b7`.
Branch: `codex/dev-chimney-edit-20260922`.

## Correction

Resoffit rejected individual turret edges because moved lower-roof return vertices could jump to an overlapping upper roof, millimetre-wide survey seams moved independently, and shortened walls retained boundary vertices beyond their new corners. The edit now follows the originally contacted roof sheet, inserts actual pitch transitions, reconciles surveyed joins and clips boundaries against adjoining wall planes. A short neighbor consumed by an inset is removed and its surviving neighbors meet at their plane intersection. Adjacent walls retain their own offsets.

Repeated edits use a stable source reference and the actual wall plane rather than a different offset for every subdivided edge. Split regions retain distinct identities and selections follow the resulting roof-contact edges. Zero-area returns are removed; an edit that removes the selected wall altogether still rejects atomically.

Roof-contact highlights render in the transparent pass above roof surfaces, with depth writes/tests disabled and the existing visibility filter retained. This prevents roof faces from covering an earlier opaque line pass.

## Validation

All 887 editor and geometry tests pass. The 24 initial new geometry cases fail against the previous deployed implementation. Regression coverage includes each edge on all three turrets, single and combined selections, different adjacent depths, zero-depth edits, repeated edits, reload, undo snapshots, lower-roof continuity, hip transitions, and consuming short returns. The material test verifies transparent-pass ordering in all display modes.

The freshly saved dev house passes all 75 individual turret-edge cases at 0, 0.5, 1, 2 and 3 feet, plus 28 repeated/combined edits. Selected depths and neighboring planes are checked independently of successful return values.

Only `wall_resoffit.js` and `wall_editor.js` are deployed. The five changed runtime/test files were synced locally after baseline comparison; unrelated workspace changes were preserved. No project metadata or production changes are included.

All three development roles activated successfully. Served JavaScript checksums and readiness match the runtime, and outbound isolation remains enforced. Staging verified 24,129 unchanged web files, 24,143 worker files, and 24,129 compatibility files.

Live authenticated verification on the dev house: individual turret contact selection, 0.5 ft then 2 ft on the same edge, a subsequent combined 0.5 ft edit, and undo all completed. The view showed the changed wall following the roof and meeting its neighbors; contact highlights remained continuous in opaque display. The verification tab was closed without saving.

## Rollback

Restore the previous runtime on all three development roles with the standard activation workflow. Refresh PHP-FPM on web and compatibility hosts; verify readiness and asset checksums. Do not replace project metadata.
