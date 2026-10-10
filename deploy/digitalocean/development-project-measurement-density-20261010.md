# Compact project measurements — October 10, 2026

Each measurement is one inline name/value/unit row, retaining rounded presentation and editable project-local overrides. Pitch and roofing-square explanations are tooltips rather than paragraphs. Missing quantities use an em dash with the explanation available on hover and through the input accessibility description.

Each section measures its actual label/unit font widths, reserves numeric input space and gutters, and chooses one, two, or three columns independently. A ResizeObserver recalculates on rail/divider changes, with a second pass after fonts load. Short edge/pitch sections can use three columns while longer flashing names retain enough space. Source quantities, publication contracts, eager viewer caching, and override lifetime remain unchanged.

Validation covers inline label/value alignment, no explanatory paragraphs, tooltip content, compact block height, and automatic one/two/three-column transitions at narrow and wide rail sizes. Development activation only, using immutable owned-file overlays over audited current role baselines.
