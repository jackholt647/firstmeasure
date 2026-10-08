# Chimney visibility with automatic parapets - October 8, 2026

Automatic parapet surfaces no longer mark the generated house body as manually
changed for chimney exposure classification. Their faces still participate in
the visible scene. Actual wall/base edits retain the existing edited-body path.

The prior regression built chimney walls before materializing parapets; the
editor recomposes afterward, which reintroduced the missing exterior faces.
The new regression reproduces that failure and checks the canonical wall mesh,
ExteriorModel collection, visibleParts and serialized-state reload with parapets.

Validation: 101 chimney, parapet, roof-layer and captured-project tests passed.
A rendered preview recomposes after adding parapets and shows the lower chimney
shaft. Evidence: `output/parapet-chimney-shell-20261008/` and
`output/wall-corner-chimney-20261008/parapet-shell-tests.txt`.

Deployment uses one-script immutable deltas from each role's freshly audited
baseline; rollback paths are recorded in the manifest. No project data or
configuration changes.

Verified application release: `4c1b803530d8c24ceb3af207a0a72cdf78dc6d85`.
All four roles passed content hashes, runtime identity, readiness and isolation.
Public HTTPS served the expected script checksum and release. The baseline
checks stopped several attempts during concurrent development activation;
roles were freshly audited and restaged, preserving the newer changes.
Final rollback baselines: web, pool and compatibility
`79babd29eab8f515a98dcdeefebae5db7320a9e4`; worker
`72c0ee4e1bec4da865d6e306ee7111ea0d8b0700`.
