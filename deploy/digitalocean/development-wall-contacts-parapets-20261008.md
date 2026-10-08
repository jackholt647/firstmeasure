# Wall contacts and raised parapets — development, October 8, 2026

The foundation reconciliation pass now retains upper wall bands above projecting
lower roofs. When a lower roof terminates within an upper overhang, the wall
meets that measured roof edge, closing the horizontal opening as well. Existing
foundation wall area is subtracted before retaining the band to avoid overlaps.

Complete chimney footprints fill roof notches before the building inset is
calculated. This prevents the selected soffit from creating a gap between the
house and a correctly detected chimney. The captured three-layer project now
retains the wall above its glass roof and attaches its chimney to the house.

Automatic parapets rise 2 ft above the surveyed roof, cap 6 in inward and return
to roof level. Connected corners remain mitered and all faces remain editable.
The visible roof is inset beneath the live caps without changing the surveyed
roof. Insets compose with chimney openings and edited cap heights. Advanced
settings still control generation on the next From Roof rebuild.

Validation: 312 focused tests passed, followed by 11 focused checks including
one new combined chimney/parapet roof test (313 distinct tests). Coverage includes
multi-level walls, chimney contacts/heights, zero soffits, custom generation,
foundation construction, Resoffit and editable parapets. A 3D preview of the
saved project confirmed the repaired section, attached chimney and raised caps.
Evidence and immutable four-script role-specific deltas are in
`output/wall-contacts-parapets-20261008/`.

Rollback baseline: `b89f6d445d348e8a0ca6b3d68e134dd4e60bc9b1` on all four roles;
use each manifest role's previous_path. Project records, production, runtime
configuration and topology are unchanged.
