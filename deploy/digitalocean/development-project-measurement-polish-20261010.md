# Project measurement presentation — October 10, 2026

Development only. Source quantities retain full precision; the editable presentation shows whole square feet/counts, feet to one decimal, and roofing squares to two decimals. Roof area, edges, flashing/openings, and pitch quantities appear in two-column groups. Exact saved editor pitches supersede legacy grouped pitch display. Missing edge quantities remain unavailable rather than fabricated zeros.

The completed-report publication preserves saved editor line classifications and pitch quantities, including chimney back/step/apron, skylight perimeter, parapets, transitions and protrusions. Existing dataset cards can display additional quantities from their matching completed report through the authorized read-only report export; existing dataset values/overrides win, and reads do not rewrite datasets.

The aerial widget uses fill sizing through the shared widget runtime. The standalone roof stage has square corners; its dock collapses with a 260 ms grid/opacity animation and the canvas ResizeObserver updates camera aspect throughout. Reduced-motion preferences disable the transition.

Validation: browser tests cover the user's precision example, readable units and pitch labels, unavailable fields, tall aerial sizing through the real runtime, zoom/drag/fit, and key animation. Saved-report normalization tests verify classifications, exact pitch totals, invalid-value rejection, and source immutability. TypeScript and publication contracts are checked before development activation.
