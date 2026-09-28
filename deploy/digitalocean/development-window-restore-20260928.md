# Minimized window restoration — development, September 28, 2026

Clicking a minimized window's title bar now restores its previous floating,
docked, or maximized placement directly. Enter/Space on the title and the
Restore control do the same. Floating geometry and dock widths survive.
Right-click and Alt+Space retain the placement menu; open titles retain their
menu. Header handling excludes control clicks even when chrome replaces the
clicked icon during the event.

Source commits `a2ee208` and `3582050` are pushed on
`codex/consolidated-firstmeasure-20260923`. The final runtime is
`358205080b54b9c540b5877e018b8b99504f572c`.
The runtime delta contains only `public/libraries/window-manager/window-manager.js`.
Each staged release inherits the live predecessor with copy-on-write file
replacement and guarded SHA-256 checks. No unrelated workspace edits are staged.

The isolated Chromium regression covers 15 restoration interactions across all
three prior modes, preserved bounds, control-icon clicks, accessible title labels,
right-click, Alt+Space, and open-window menus. The broader Channels layout test
stops at line 363 waiting for a pinned conversation to close; the same failure
reproduces with the old manager. Its earlier icon-click failure was corrected
before the final release.

Evidence and per-node manifests are in ignored `output/window-restore-20260928/`.
The initial release `a2ee208` was activated while the icon correction was being
prepared; both nodes subsequently advanced to the corrected `3582050`.

Rollback: inspect current releases for intervening work, then return each web
node to `a292b51440e1f4f3bdb2601ecb21cc087a56c1bf` using the existing atomic symlink
and service restart workflow, one node at a time. Verify readiness and development
outbound isolation. No migration or data rollback is needed. Production,
compatibility, worker, configuration and topology are unchanged. The existing
historical autoscale image limitation remains.

Final verification: both serving nodes (`do-598520065`, `do-603124965`) passed
local readiness with development isolation enforced on `3582050`. Both asset
hashes equal `52ee96a2f42109eb4f372cf4d462456bd9e2f5c15c1dadac6c75e896ff9f73db`.
Six public readiness checks passed, the public asset matched, and all 15
Chromium restoration scenarios passed using the JavaScript served by dev.1m8.ai.
