# Development: independent sticker fill and wire deletion

Release: `1535481284d21a6b1d6efd3a08071e6ee0bad249`.
Baseline: `85820504dc5f700758257f17cb53f664511a83dc`.

Corrects incomplete boundary deletion release `6fce7d7`. Its reconstructed face could still consume the source draft through merged-face adoption, hiding unselected interior wires. Its sketch deletion loop also compared an analytic edge's endpoint chord with the selected straight line, potentially deleting a copied curve with the same endpoints.

Sticker sources now retain independent boundary wire when their fill is recalculated. Merged-face adoption, including reload reconciliation, does not consume these sources. The fill arrangement also receives authored internal sketch connections, so deleting an upper boundary can retain the still-closed lower rectangle. Analytic edge deletion intersects evaluated curve segments and trims parameter ranges only where the actual curve was selected; untouched curve edges and controls remain unchanged.

All 461 wall drafting, solid geometry and base sketch checks passed. New regressions use a source sticker draft with an interior horizontal segment and a copied spline stored as one analytic edge sharing the deleted chord's endpoints. They assert unchanged source nodes, exactly one removed straight edge, byte-for-byte unchanged copied sketch, no source consumption on reconciliation, correct arc/remaining-rectangle fill, and surviving wire under every derived face boundary.

Evidence: `output/sticker-wire-preservation-20260923/`; tests: `output/sticker-wire-preservation-tests.log`. The two-script delta preserves concurrent photo-label work. Production is unchanged. This does not reconstruct geometry already lost by prior edits; retry from an intact pre-delete state.

All three development roles passed exact-release readiness verification. Both public script hashes match the immutable commit and outbound isolation is enforced. Public readiness initially reported the previous release during restart, then passed on retry. The editor URL requires login; these checks do not constitute an authenticated interaction test against the user's exact model.
