# Sealed parapet ends - October 8, 2026

Automatic parapets now include editable end faces between the outside, cap and
inside at exposed endpoints. Matching shared cross-sections at mitered corners
and collinear continuations do not receive duplicate internal faces. Interrupted
runs each receive their own closures. Existing generated surfaces remain editable;
From Roof regeneration creates closures on previously open parapets.

Validation: 59 focused tests passed, covering single runs, corners, straight
continuations, reversed source lines, interrupted runs, persistence, Resoffit,
roof insets and the parapet/chimney visibility regression. Evidence is under
`output/parapet-ends-20261008/`.

Development deployment is a one-script immutable delta, preserving each role's
current baseline. Rollback paths are in the manifest. No project data or runtime
configuration changes. Activation verification pending.
