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
`298eeb4`, which preserved these assets on that node. The second web node and compatibility were staged
from that newer font baseline and activated as
`3550f2bd124f2d5ca92fe3ff8db9eb348f9652db`. The first web node retains
`298eeb47b31620d987b1d16fae608b1ac98ed4d9` with both corrected menu assets.
All three roles have matching corrected script hashes and passed local readiness.
Both web instances were observed healthy through the public load balancer with
development isolation enforced. Public script hashes match source `4697480`.
Authenticated browser checks passed against both hosted interfaces, including
Edit, keyboard opening, Escape, outside dismissal, and zero autosave clicks.
Temporary verification sessions were revoked.

Rollback must account for intervening work. For the second web node and
compatibility, the recorded predecessor is `298eeb4`; use the existing guarded
symlink/service workflow, one node at a time. To undo the menu fix across the
fleet while retaining other releases, prepare a new two-script delta from the
current baselines. Do not revert the first node wholesale to its pre-font release.
