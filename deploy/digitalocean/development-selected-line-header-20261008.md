# Selected line length in the 3D header - October 8, 2026

One selected wall or base line now displays its true 3D length at the start
of the 3D header. The readout follows report units, updates with selection,
and hides when the selection is cleared or contains multiple lines. It is
independent of tool messages and model dimension-label visibility.

Validation: 111 base/editor/mode tests passed, plus a focused wall-line test.
Regressions cover sloped lengths, deselection, multiple lines, header updates
and hiding outside wall mode. Activated `af3b797ac51a7dc132dbb84923f8657c0ebd6334` on all four development roles. Five script hashes, runtime identity, readiness, development isolation and public assets verified. Both web nodes returned 200 for the saved project. Evidence: output/selected-line-header-20261008/.
