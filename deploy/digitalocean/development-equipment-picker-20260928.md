# Equipment classification help and icon picker — September 28, 2026

Classification cards now have separate information buttons with hover/focus
help describing vehicle fields and per-unit driver/operator requirements.
Help does not change classification and remains accessible by touch and keyboard.
The icon picker is a compact grid of 50 icons without visible text captions or
button outlines; hover names, accessible radio labels, selection and keyboard
focus remain. All choices were checked against the portal's Font Awesome 6.0 CSS.

Equipment icons consistently use the primary emphasis color. Type color controls
and rendering are removed, while stored type colors remain unused. Physical unit
color remains editable and appears only as a small square swatch with a contrasting
border and neutral outer ring. It does not tint icons, cards or backgrounds.

JavaScript syntax and three focused browser/contracts pass, covering selection,
classification help, narrow tooltip bounds, no type-color control, primary icon
color despite stored type colors, white/dark unit swatches, and prior save/layout
behavior. Browser APIs use synthetic fixtures.

Deploy the Equipment asset alone from the canonical commit over each verified
live development web baseline. Guard staging/activation against intervening
releases, verify per-node readiness/isolation/hashes, public health/hash and the
served script's browser flow. Evidence: output/equipment-picker-20260928/.
No backend, migrations, topology or production changes. Rollback through the
existing symlink/service workflow to the receipt's prior per-node release after
checking for intervening work; verify readiness and isolation afterward.
