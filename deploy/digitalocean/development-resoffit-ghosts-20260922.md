# Resoffit source-wire cleanup — September 22, 2026

Runtime release: `03c76e5d5c4cb02f50940503691e7a640c353720`.
Baseline / rollback: `59fc259934108ff238d7664d5843a25e1e02058e`.

## Cause and correction

Resoffit materialized replacement faces and moved their original sketch nodes, but the consumed source regions used to mask that sketch retained their previous coordinates. The mismatch exposed obsolete source boundaries as cyan loose edges. A five-contact turret reproduction generated 19 such line segments after an otherwise successful edit.

Consumed-region points and holes now follow their referenced sketch node IDs after a non-extruding line operation. Reload normalization also repairs stale masks referencing existing `line-move-` replacement faces. This updates source bookkeeping, not the replacement wall surfaces.

Retained sketch stations are not always topology vertices, so they could also miss the normal boundary displacement. Resoffit now projects them onto their replacement wall plane, follows the contacted roof sheet when appropriate, and retains only stations inside the resulting face pieces.

## Validation and scope

- All 911 editor and geometry tests pass.
- The turret reproduction has zero generated cyan line segments after the fix.
- New tests start at both 18 and 24 inches, change to six inches, two feet, and six inches again, with reloads between changes.
- Retained points stay supported by actual faces; unrelated deliberate loose lines survive unchanged.
- Undo snapshots retain complete pre-edit geometry.
- A stale persisted-mask reproduction is repaired on reload without moving its replacement surfaces. Repeating normalization is idempotent.

Runtime delta: `wall_face_draft.js` and `wall_resoffit.js`. Source and tests are synced to the primary workspace after checking the previous versions. Development activation checks changed-file baseline hashes and more than 24,000 unchanged files per role; PHP-serving roles refresh PHP-FPM. Production is unchanged.

All three development roles activated successfully. Public readiness reports the matching isolated development release, and both changed JavaScript assets match their expected HTTP checksums. The user model was not modified through the browser or saved to the server during this task.
