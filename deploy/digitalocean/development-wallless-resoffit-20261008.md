# Wallless resoffit - October 8, 2026

Source `fcb10b3915284d8bbbf3b356695d9a4719b8928d` adds **Wallless (canopy)**
to the Resoffit dropdown. Select the roof-contact lines, check Wallless and
Apply. Depth presets return to ordinary depth mode. The action is one atomic,
undoable wall edit and leaves the rendered roof and base geometry intact.

Selected canopy wall regions and their contained features become persistent
removed surfaces. Connected fragments are limited to the selected contact span
and below its roof; a coplanar upper wall is not consumed. Generated draft
ownership is transferred so removed original walls do not reappear on reload.

Connected pitches of the selected canopy roof layer no longer stop a descending
house wall at that layer. Existing lower wall boundary segments that actually
contact the canopy are continued to the next real roof or base. Partial canopy
coverage is split at the roof boundary. Continuations are unioned into the
existing wall, excluding areas already owned by other coplanar walls and their
openings. Missing required base coverage rolls back the complete operation.

For sideways continuation, a removed connected wall chain with exactly two
unambiguous surviving ends can reconnect. Intersecting wall planes extend
forward to their common corner under the roof; collinear ends receive the
missing span. Parallel distinct planes, more than two owners, absent targets,
or an intersection outside the roof leave an open end rather than guessing a
closure. Existing wall-plane positions remain authoritative. Trim follows the
normal editor result path. No full building regeneration is performed.

## Verification

- 21 geometry tests pass (10 new Wallless cases plus existing Resoffit cases).
- 42 focused editor Resoffit/selection tests passed, including initial Wallless
  ownership/serialization coverage. Both Wallless editor tests passed after
  adding a second case using generated draft ownership.
- Additional pitched-base and atomic-failure coverage is committed in `4bd1b51e`.
- The saved Lake Washington model was replayed independently across its 20
  available roof-contact parent groups without geometry errors. This is an
  offline replay, not an edit to the customer's saved project.
- Changed JavaScript syntax and diff whitespace checks pass.
- Public bytes for all three changed scripts match the immutable source commit.

The three-file overlay preserves each development role's audited source baseline,
uses the existing immutable rollout and rollback mechanism, and keeps production
untouched. Evidence is in `output/wallless-resoffit-20261008/`.

The UI handler test in d45982fc also passes for Wallless selection, disabled depth validation, and return to numeric depth. The authenticated public page opened, but browser DOM inspection timed out during project initialization; the temporary verification tab was closed. UI behavior was verified through the actual handler test, with public script bytes checked separately.

Final verification passed on web, pool, worker and compatibility: all three owned files match fcb10b39, runtime identities match their immutable releases, readiness is healthy and development isolation is enforced. Public readiness and all three served assets also passed.
