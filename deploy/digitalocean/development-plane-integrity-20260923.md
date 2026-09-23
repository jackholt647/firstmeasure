# Development: plane selection and analytic spline editing

Release: `27b499736c25dae868743ab10b55f459a922c405`.
Baseline: `06540fabe7c9d9fba19f4746222a84a7fb92f1d1`.

Entering a face drawing plane clears the source face selection. Plane curve picking selects original interpolation controls and highlights the complete curve, rather than exposing render samples as editable selections. Moving an original spline control updates its analytic definition, sampled face boundary and sketch knot ranges together.

Clipboard collection includes explicitly selected line endpoints outside plane mode. Spline copy, flip and paste retain analytic definitions and original controls; sampled rendering segments are not pasted as independent lines. Straight lines selected alongside draft curves remain in the clipboard.

The idle Drawing plane status text is hidden. Exit Plane invokes the same toggle as P; the rotation Cancel button retains Escape behavior.

All 519 wall drafting, wall mode, solid geometry and sketch geometry regression tests passed on the final source. Coverage includes face deselection, unchanged plane-entry geometry, spline control movement, straight-line paste, analytic curve copy/flip/paste, and the actual Exit button handler.

The four-script immutable delta preserves the baseline runtime, including concurrent AI camera changes. Evidence: `output/plane-integrity-20260923/`; test output: `output/plane-integrity-final.log`. Production is unchanged.

All three development roles passed exact-release readiness verification. All four public script SHA-256 hashes match the immutable commit; development outbound isolation is enforced. An initial public 503 during restart settled on retry. The editor URL redirects to login, so these checks do not constitute an authenticated interaction test against the user's model.
