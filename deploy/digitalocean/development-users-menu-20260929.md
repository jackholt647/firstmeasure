# User row actions menu — development, September 29, 2026

The three-dot Users / People & Access button now opts out of settings autosave
in both company.js and firstmeasure-users.js. The shared autosave capture handler
previously treated Actions as an edit and clicked a hidden Save control on the
next timer tick. That synthetic click reached the outside-click listener and
immediately closed the menu. No user access rules or action implementations change.

Source commit: `4697480` on `codex/consolidated-firstmeasure-20260923`.

Validation: four focused tests pass, including Chromium checks of both menu
implementations with the real autosave runtime, mouse/icon and keyboard opening,
Edit, Escape, outside dismissal, and continued field autosave. Both regression
cases fail without the opt-out. The defect was reproduced against the hosted
full-test organization; a browser using the corrected source kept the menu open
and opened Edit. No Edit form was saved and no invite/delete/suspend action was
used for verification.

The development release changes only the two browser scripts, inheriting each
live predecessor with copy-on-write replacement and guarded source hashes
(normalized line endings for predecessor comparison). Unrelated local seed work
is excluded. Evidence and per-role manifests: `output/users-menu-20260929/`
(ignored). No migrations, configuration, topology, worker, or production changes.
The existing historical development autoscale image limitation remains.

The first web activation was superseded by the concurrent picker-font release
`298eeb4`, which preserved these assets on that node. Remaining nodes are staged
from their latest live baselines so the font update is also preserved. Final
per-role identities and verification are recorded after rollout.
