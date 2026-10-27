# Mobile ordering live-layer recovery — October 26, 2026

The report/Documents rollout `a730ce84` omitted the uncommitted project-request
overlay owned by `C:/Users/jackh/Code/2026/fm-live-visual-test` (base `737daccc`).
Its pre-rollout released script matched that base and lacked
`overview-order-focused`, `isMobileReportOrdering` and
`cancelMobileReportOrdering`. The rollout changed the release's script; the
live receiver retired its overlay as `conflict` (manifest generation 95).
The later Docs-only fix did not touch this script.

The source was not deleted from the owner's checkout. Its live-only changes
stopped being served. The project-map overlay remained active and still asked
for the now-missing host callbacks, so Back reverted to Shrink and the ordering
workspace lost its hidden tab/tray bars.

Recovery merges the original UI changes onto the current project-request
version, preserving the Documents report loader and Operations order entry.
It restores the Overview-owned pager, mobile ordering focus/Back behavior,
contact sizing and pin-confirmation spacing. Unrelated unfinished app-offer
changes are excluded. The exact currently served project-map overlay is also
preserved in the release, including its existing pin interaction.

Five recovered browser tests pass: pin-confirmation height across four phone
widths, compact contact controls on phone/desktop, cancellation preserving the
project and fields, Back versus normal map sizing, and hidden tabs/trays with
pager ownership, panel rebuilds and reduced-motion behavior.

Both affected scripts are committed rather than left only in the live layer.
The live-layer guide now requires examining active and conflict-retired
overlays and checking their hashes before activation.
