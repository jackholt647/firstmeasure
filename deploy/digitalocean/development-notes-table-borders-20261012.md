# Notes table borders — October 12, 2026

Feature commit: `2c118e671e0689fc523dce04ae6b4dfeb8b01c8f`.

Saved Notes and replies render valid table markup through Channels' shared
renderer, but their `.pn-card-content` container did not match the Channels
message table selectors. The grid therefore lost its borders and cell padding.
Notes now owns scoped collapsed table borders, padded cells, shaded headers and
wrapping for long values. Horizontal overflow remains accessible for tables
with saved column widths. The Notes bundle version is
`20261012-notes-table-borders-v1` in both application manifest entries.

The browser regression verifies actual computed borders and header styling in
saved notes and replies at 360, 280 and 240 pixels, alongside the existing
composer, draft, upload, archive and audience flows. It passed locally and again
with assets fetched from development. JavaScript syntax and diff checks passed.

Only the Notes library and its manifest version tokens were deployed. Each live
role baseline was audited and the owned patch applied without replacing other
frontend changes. All three Notes payloads matched the tested source exactly.
Immutable stages checked hashes, preserved prior release files, guarded current
paths and backend runtime identity, then activated with PHP-FPM reload. Final
role and public dev hashes, readiness and enforced development isolation passed.

| Role | Activated frontend release |
| --- | --- |
| Web | `/opt/firstmeasure/releases/2c118e671e0689fc523dce04ae6b4dfeb8b01c8f-notes-table` |
| Pool | `/opt/firstmeasure/releases/2c118e671e0689fc523dce04ae6b4dfeb8b01c8f-notes-table` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases/2c118e671e0689fc523dce04ae6b4dfeb8b01c8f-notes-table` |

Previous frontend releases were `5b2eb1a823614698ac8ddf0fa65bda4b2e0fe1d8`
under the corresponding release roots. Backend runtime identity was preserved;
there were no API restarts, migrations or worker changes. Receipts, payloads and
before/after hashes remain in ignored `output/notes-table-deploy/` and release
receipts. Rollback must preserve subsequent releases and reverse only these
owned frontend changes. Production was not changed.
