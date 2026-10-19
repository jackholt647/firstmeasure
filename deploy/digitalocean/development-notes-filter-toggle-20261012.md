# Notes author filter toggle — October 12, 2026

Feature commit `31d47774730bc957b96d00765d74ef13733354e5`.

The Notes tray Filters footer shows Deselect All whenever every author is
selected, and Select All whenever any author is deselected. The button clears
or restores the complete author selection, including authors hidden by search.
Checking the last unchecked author also returns the label to Deselect All.
The Notes bundle version is `20261012-notes-filter-toggle-v1`.

JavaScript syntax and the existing Notes browser regression pass. The regression
now checks initial and partial-selection labels, clearing all during search,
restoring all during search and manually checking every author. It passes again
using development-hosted assets after activation. Public Notes and application
manifest SHA-256 values match the reviewed payloads.

The frontend-only rollout preserves each role's audited live application manifest
and all unrelated release files. Staging checks the previous source hashes and
creates an immutable release. Activation guards the current path and retained
backend identity, switches the release atomically and reloads PHP-FPM. All three
roles pass final source hashes, readiness, development environment and enforced
outbound-safety checks. Backend runtime remains
`5b2eb1a823614698ac8ddf0fa65bda4b2e0fe1d8`.

| Role | Activated frontend release |
| --- | --- |
| Web | `/opt/firstmeasure/releases/31d47774730bc957b96d00765d74ef13733354e5-notes-filter-toggle` |
| Pool | `/opt/firstmeasure/releases/31d47774730bc957b96d00765d74ef13733354e5-notes-filter-toggle` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases/31d47774730bc957b96d00765d74ef13733354e5-notes-filter-toggle` |

Previous releases use the same role-specific parent directories with suffix
`c1d1e83c60475d32cf79802cc7cdb7b15143abfc-polish-icon-order`. Rollback must
preserve subsequent unrelated changes and reverse only this owned frontend patch.
Audited baselines, payloads, scripts and receipts remain in ignored
`output/notes-filter-toggle-deploy/`. Browser checks use fixture APIs and do not
post customer notes. No backend, database, worker or production change is included.
