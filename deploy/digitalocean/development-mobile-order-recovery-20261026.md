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

## Verified development activation

Recovery and shared report icon/color release `8e94cf13` was activated on development legacy and web. Follow-up `82fa4dc69165f8416c72d7f0cca66b0fae50925c` adds all three delivered report files to Operations > Documents beside accepted contracts. PDFs use the rail viewer; XML offers a download. Both locations use the primary-color ruler, with user/code badges. Report files do not become accepted scope publications.

Legacy's old release volume had insufficient free inodes. No releases were deleted: `8e94cf13` was staged on the root disk at `/opt/firstmeasure/frontend-releases/`, and the Operations release safely hardlinked that baseline there. Web retains `/opt/firstmeasure/releases/`. Both activations passed development identity, cookie, readiness, outbound-safety and immutable-baseline checks. Worker and production were untouched.

Public readiness identifies `82fa4dc6`; gzip-decoded public hashes match all five task browser scripts, with no live overlay header remaining. Operations' 24 tests, both report-specific Docs tests and all five mobile ordering tests pass. The contact-size test now waits for animations to finish before measuring. A broader Docs run has one unrelated mobile-search collapsed-width assertion failure; the remaining 14 Docs tests pass. This is not a claim that the user's authenticated organization was manually verified: the available browser session belongs to another sandbox.

Task deltas were merged into canonical with three-way comparisons and saved originals, preserving unrelated edits. The deployed browser changes are committed and pushed, not solely live-layer changes.
