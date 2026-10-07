# Report credit gate and constrained project list — October 6, 2026

Runtime release: `4adafff2807963322cea10380cf9365342a6030c`.

The insufficient-credit gate used to close the project before opening top-up.
A retained project is an embedded window: closing removes that frame, so its
billing event/dialog could not survive. The live zero-credit reproduction detached
the frame without opening a usable checkout. The gate now leaves the project
open. Billing requests from a registered embedded project are dispatched in its
owning portal, using that window's CustomEvent constructor. Standalone requests
continue using their own window. This also covers server credit rejections and
other paid actions using the common helper. Existing credit checks, pending-order
capture, payment processing and server debit enforcement remain unchanged.

My Projects now has an inline-size query container. At constrained widths its
heading, icon and view controls scale down using the available list width. The
tile grid can shrink below its previous 290px minimum. Grid box sizing and tile
minimum widths prevent horizontal clipping; footer links remain inside the card.
Expanded board controls can still wrap. Asset versions were updated for both apps.

Candidate Chrome verification used a fresh zero-credit FirstMeasure organization
and an ordinary roof-order form (no instant development report or credit bypass).
The existing submit handler opened parent top-up while preserving the project,
pins and technician notes; cancellation restored a retryable form. A stale
positive balance that refreshed to zero followed the same gate. Neither attempt
sent a queue request. The real docked layout and 280/250/220px containers passed
one-row/non-overlap checks, tile/link bounds and no horizontal grid overflow.
Screenshots were visually reviewed; no page errors occurred. Fixtures were deleted.

Audited immutable overlays update only project request, project viewer and the
manifest on web, compatibility and pool. Role-specific existing differences are
preserved by three-way merge. Staging uses detach-before-write hardlink clones,
baseline/hash checks and capacity guards. Worker and production are excluded.
Receipts are in `output/report-credit-gate-20261006/`.

Prior serving release: `8c06e90029c6d502c31cab5c3cfa446186bd35d6`, under
`/opt/firstmeasure/releases/` on web/pool and
`/opt/firstmeasure/releases-root-archive/` on compatibility. Rollback restores
the recorded role path, restarts its service and reloads PHP-FPM; review
intervening releases before rollback.

Activation and final verification passed on all three serving nodes. Owned hashes
matched and readiness/development outbound isolation passed. The hosted fresh-org
credit gate and real dock checks passed, including both credit branches, retained
notes and retryable form, no queue request, no page errors and 280/250/220px bounds.
The mobile header/view-switch and company contact regression checks passed at
1440/620/390/320px as applicable, with repeated switching and reload. A check begun
during activation timed out while nodes restarted; its complete post-rollout rerun
passed. Verification fixtures were deleted; no purchase/payment was performed.
