# Development notification settings grouping — September 26, 2026

Source: `99ed565` on `codex/consolidated-firstmeasure-20260923`.

The notification settings UI now groups authorized events by user activity instead
of one category per app prefix. Calls, messages and mentions share Communications;
broad direct-app controls share Miscellaneous. Duplicate Projects headings are
removed. Cron and mock-payment options are hidden from end-user settings. Common
workflow/task labels and tooltips use customer-facing language.

All categories use a consistent three/two/one-column grid based on available width,
with vertical dividers and balanced row counts. Sparse and search-filtered categories
retain that grid. Scope categories, including empty ones, and all saved keys remain
intact. The General tab replaces the Apps label.

Only `public/libraries/apps/settings/company.js` changed in the runtime. Each release
preserves its inventoried predecessor, with the owned UI delta applied separately.

| Role | Previous | New |
|---|---|---|
| web | `7bd510408edaa0851d09dd492c28e5eea61c7aee` | `5070a34c52b60688faa7afe432befd0da12d0874` |
| pool | `21e81ae9d156e348faadf417632865f3bea6ad4a` | `fb98bd981d0e38f9aaa1c243982c91a0b1f5a76e` |

Both development web roles passed readiness, development safety, source hash and
catalog import checks. Browser verification exercised all 113 registered event
fixtures plus direct controls and workflows: nine general groups, stable preference
keys, no duplicate headings, merged Communications and Miscellaneous, hidden cron,
consistent divided columns at three widths, balanced rows, sparse search results,
and preserved empty workflows. Separate interaction checks passed keyboard use,
collapse, rapid toggles, serialized saves and failed-save retry.

Authenticated live verification for notifications@1m8.ai passed: five Measurements
options, ten switches, three desktop columns with dividers, one mobile column,
search, and zero page errors. Test company flags/preferences were not changed.
The temporary test session was revoked. Screenshots and verification output are in
`output/notification-settings-grouping/` (local artifacts).

Worker, compatibility, provider credentials and native APKs were unchanged. No
backend contracts changed; no new TypeScript build or publication suite was needed.
Production was not deployed.
