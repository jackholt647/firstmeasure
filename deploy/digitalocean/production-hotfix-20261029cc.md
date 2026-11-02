# Production hotfix 3d1fdb12: the portal summary and CSV show each report's own measurements again (1M8-254), October 29, 2026

Released under Jack's standing approval. It is production-live `b58c5e99`, with compatibility on `091e5c36` (Exteriors engine) and every other role on `ef39262b`, plus:
- `claude/csv-summary-1m8-254` (`f67c79a2`);
- `3d1fdb12`, which updates one test assertion for the intended fallback.

All roles now run `3d1fdb12`, which contains `091e5c36`.

## Cause

This was a regression from the Oct 20 release `31f87be5`. No CSV or XML was lost or overwritten. The CSV button downloads the Roof Report Summary's Measurements list.

1. **Projects since Oct 20 got the same fake numbers.** The summary searched the whole order manifest for anything named like a roof line. `31f87be5` began writing `language_snapshot.report_dictionary` into every order, with labels such as "Eave Drip Edge (10 ft)". Every project therefore showed eave 10, valley 10, ridge 5 and so on.
2. **All projects lost the real numbers.** `31f87be5` first loads the shared project measurement dataset, which customers can't read (403, about 1,400 a day). The error was swallowed, so the report's `model_data.xml` was never read.

## Fix

The fix is frontend only, in `measurements/project.js`:
- the manifest scan skips branches that never hold measurements (`language_snapshot` and the like);
- under a line-type key it counts a length only when the value is a number;
- a refused shared load falls back to the report XML, as before Oct 20.

The manifest key is `20261029-summary-measurements-1m8-254`, and `portal/index.php` versions the script by content.

## Checks

- **Passing:** `report-summary-measurements-browser` (new, 2 of 2) and `full-house-customer-summary` (with the updated assertion).
- **Read-only check by the fixing session:** the fixed code produces the real values on production manifests and XML, for example 0247577f: 44.5 sq and eaves 242 ft.
- **Pre-existing failure:** `full-house-customer-summary`'s Summary.pdf test also fails on production's code, so it is not from this change.

**Build:** archive `4e370cd7…`, verified.

## Not changed

Customer 403s on the publication measurements dataset. The summary routes around them; whether customers should read it is a separate question.

## Rollout

- Compatibility at 16:12:53Z, from `091e5c36`, with 0 errors and 0 crashes in the next 20 s.
- Worker.
- Signed channel, published against `b0e797a0…`.
- Six web nodes, 16:14 to 16:22 UTC, each ready with matching assets.

Public readiness returned `3d1fdb12` 10 out of 10 times. Production serves the manifest key `20261029-summary-measurements-1m8-254` and the fixed `measurements/project.js`.

## Rollback

Compatibility keeps `091e5c36`; the worker and web nodes keep `ef39262b`. Republish `ef39262b` (`b0e797a0…`) to the channel before rolling back a web node.
