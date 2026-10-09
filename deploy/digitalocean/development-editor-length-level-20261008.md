# Editor length, preview and level verification - October 8, 2026

Source `4ff41c79586a6b65515ca66778d6c749ae5dd4a1` fixes the length readout
in a reserved area at the right of the 3D toolbar, using subtle text and tabular
digits. Selection no longer shifts the toolbar. Pending base and wall drawing
report the live three-dimensional line length. Source `0ee3f237` also renders
the finite white base drawing preview above faces and yellow snap guides, with
placement/cancellation cleanup. Editor asset URLs now use content hashes.

The existing L implementation levels one selected purple base face using the
same flat-plane transformation as zero pitch. Both saved project base faces
passed replay with zero resulting slopes. No leveling algorithm change was
necessary in this release.

## Correction to earlier development verification

Nginx on development web and pool forwards `/measure/internal/` to the legacy
compatibility server. Earlier editor receipts, including base draw start, base
snap guides and chimney merged edit, verified files on web/pool/worker while
excluding compatibility for capacity. Those checks did not establish that the
public editor served the changes. Fresh browser inspection confirmed old assets
and no L control. This release corrects that deployment gap without route changes.

Compatibility root capacity was recovered by downloading three unused `/tmp`
deployment archives, verifying SHA-256 locally and remotely, checking for open
handles, then removing only those exact backed-up temporary originals. Recovery
copies and hashes remain under
`output/base-length-level-20261008/legacy-archive-backup/`. Release snapshots and
customer data were preserved. The existing 1 GiB deployment reserve remained
enforced; the alternate release volume had no free inodes and was not used.

All tracked editor scripts were compared against compatibility's live baseline
`50208dfb4eea63d7109aee04bb6f689bf0500ca3`. Ten differing scripts plus editor.php
were reviewed and deployed as a consistent overlay from the immutable source
commit. Audited baseline copies were rechecked before staging. Unrelated live
files were preserved in the cloned release, with rollback available.

Web, pool, worker and compatibility now identify source `4ff41c79`. Owned file
hashes, readiness and development isolation passed on all four roles (eleven
files on compatibility). Capability and saved-project reads returned HTTP 200
on both web nodes. A fresh public browser page confirmed content-versioned
assets, the L control and the right-positioned length element after initialization;
its console error list was empty. The user's working geometry was not changed.
Production was untouched.

## Validation

- Base editor/sketch controls: 47 passing tests, including preview and length.
- Focused wall selection/pending length: 2 passing tests.
- Closed soffits and base binding: 13 passing tests.
- Changed JavaScript syntax, deployment PHP lint and whitespace checks passed.
- The previously known broader chimney-support selection test failure is not
  claimed resolved by this release.

Local deployment and audit evidence is under `output/base-line-preview-20261008/`,
`output/base-length-level-20261008/` and
`output/editor-compatibility-repair-20261008/`.
