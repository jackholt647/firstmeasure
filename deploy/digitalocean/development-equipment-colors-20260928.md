# Equipment type and unit colors — September 28, 2026

Equipment icons use their equipment type's color. Add/edit type exposes a Type
icon color picker using the existing persisted type color field. Existing types
without a color get defaults by classification: vehicle blue, trailer purple,
tool amber and other teal. User-selected type colors override those defaults.

The unit's physical color is shown separately as a small swatch on fleet media
and the detail header, including photos. Its light/dark border follows relative
luminance, with a neutral outer ring so it remains visible on its surroundings.
Type icons also choose a contrasting background. The former unit-colored card
border and icon tint are removed. Unit colors and stored records are preserved.

Validation: JavaScript syntax plus three focused browser/contract checks.
Chromium covers new type color submission, classification defaults, existing
type color edits, type-to-unit icon propagation, white icons, white and dark-gray
unit swatches, narrow cards, save success/failure, and disabled UI features.
The browser tests use synthetic API fixtures; persistence uses the existing
validated Equipment type endpoint and storage column without backend changes.

Deployment is a one-asset frontend delta on the two existing development web
nodes, preserving each current immutable release baseline. Verify local
readiness, development isolation and asset hashes, public readiness/hash and
the browser flow against the served asset. Evidence: ignored
output/equipment-colors-20260928/. No migrations or production changes.

Rollback must account for intervening releases. Restore each node's previous
release from the receipt using the existing atomic symlink/service workflow,
then verify readiness and isolation. Saved type colors remain in storage.

Rollout completed: `98a5a1897295af2384b2160ffed47211a5ce86e1` is active on
both development web nodes (`do-598520065`, `do-603124965`). Both passed local
readiness, development isolation and asset hash verification. Six public health
checks and the public asset hash passed. The expanded Chromium flow also passed
against the served Equipment script using synthetic API fixtures. Both prior
releases were `8099f33af373ecf3ac9788079c25bef0f8485a38`.
