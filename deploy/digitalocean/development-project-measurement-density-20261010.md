# Compact project measurements — October 10, 2026

Each measurement is one inline name/value/unit row, retaining rounded presentation and editable project-local overrides. Pitch and roofing-square explanations are tooltips rather than paragraphs. Missing quantities use an em dash with the explanation available on hover and through the input accessibility description.

Each section measures its actual label/unit font widths, reserves numeric input space and gutters, and chooses one, two, or three columns independently. A ResizeObserver recalculates on rail/divider changes, with a second pass after fonts load. Short edge/pitch sections can use three columns while longer flashing names retain enough space. Source quantities, publication contracts, eager viewer caching, and override lifetime remain unchanged.

Validation covers inline label/value alignment, no explanatory paragraphs, tooltip content, compact block height, and automatic one/two/three-column transitions at narrow and wide rail sizes. Development activation only, using immutable owned-file overlays over audited current role baselines.

## Verified rollout

Source merge `43583b571140330bf75a41231b01230f56af9660` is pushed to the canonical branch. Both development web nodes and the compatibility service contain the exact compact scope renderer, adaptive grid CSS, and cache versions. Compatibility and pool run this release; the primary web node runs concurrent release `5dc8e29f9103401970c65a63c3ec3532d4decd7d`, which retains the same compact renderer and styling. Unrelated manifest changes are preserved. Public readiness was verified twice against the current healthy development release with outbound isolation enforced. A poll requiring all public traffic to return the compact release ID was stopped after confirming that the concurrent primary release contains the same owned UI changes.

Eight browser tests passed, including automatic observer-driven width changes, inline alignment, tooltip metadata, and compact height. Hosted desktop/mobile checks confirmed a measurement block under 420 pixels tall, three-column edge rows, no visible explanation paragraphs, and no page errors.
