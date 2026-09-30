# Assistant close control — development, September 29, 2026

Source and development web release: `89712c1d4b35b6b59c0874e6e8ea5b44eced8245`.
Previous web release: `3759e441ce3c0a3260d38f1727f18f253b35527f`.
Previous pool release: `2225af718a31a25f86bbd6b6e0eabf83f30ca7bd`.

The assistant now shows the shared X immediately to the right of expand and
hides its minimize button in every placement. Closing uses the existing
assistant close handler, preserving conversations and unsent drafts. Dock,
float and expand retain their existing behavior.

The one-file frontend delta overlays only
`public/libraries/platform-assistant/platform-assistant.js` onto each verified
predecessor, preserving concurrent work and per-node baselines. Activation is
sequential with baseline/hash guards, automatic rollback and development safety
and readiness checks. Production, worker and compatibility are unchanged.

Validation: assistant frontend checks (97 tests) and a browser fixture covering
channel recap, docked/floating/full close controls, X placement, draft retention
on reopen and phone layout. Hosted asset and readiness verification and the
same fixture against hosted scripts are recorded in ignored
`output/assistant-close-20260929/`.

Rollback: inspect for newer deployments, restore each node's previous release
above, and restart its development web service and PHP FPM one node at a time,
checking readiness before continuing. The existing autoscale image limitation
remains; no topology or configuration changes were made.
