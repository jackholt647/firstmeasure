# Shared date/time picker - development, September 28, 2026

Source release: `9d1c6877257d5a32c0e64a2d77ff0a78f87fa3ed`, pushed on
`codex/consolidated-firstmeasure-20260923`.

One dependency-free library replaces native date, time and local date/time
popups. Existing inputs retain form values, constraints and event handlers.
Nine PHP entry points load it, and all 58 app manifests declare the dependency.
Channels scheduled messages, reminders and deadlines receive it automatically.
The standalone design preview is `/libraries/date-time-picker/preview.html`.

The frontend/PHP release replaces 13 files in immutable per-role releases,
inheriting each host's verified live baseline. Concurrent Channels, presence,
portal and other workspace edits are excluded. No backend build, database,
environment, topology or worker change is needed. Production is unchanged.

Previous web releases on `do-598520065` and `do-603124965`:
`a3448c00a662f9c604906bc4cb8ded5b26864ea8`.
Previous development compatibility release:
`84ce2d2073a28a370d3e9e42980f4124079dc9c9`.

Evidence: ignored `output/date-time-picker-deploy/`, including live source
inventories, guarded SHA-256 manifests, release receipt, public verification
and the deployed-script browser test. The initial activation attempt rejected
CRLF in the transferred shell helper before any mutation; it was normalized to
LF. Web load-balancer reentry was verified before proceeding to the next node.

Validation before activation: focused Chrome behavior tests, TypeScript check,
JavaScript syntax, PHP lint locally and in all three staged releases. Browser
coverage includes form serialization/events, cancellation, focus management,
range/step/required validation, leap dates, second/fractional precision,
12/24-hour locales, dynamic fields, modal dialogs and mobile viewport bounds.

Rollback: inspect for intervening releases, then restore the prior symlink and
restart the appropriate development web/legacy service and PHP-FPM, one host at
a time. Verify readiness, load-balancer return and outbound development
isolation. No migrations need reversal. The historical development autoscale
image limitation remains; this release does not change the pool template.

Final verification: all 13 release file hashes matched on both web nodes and
compatibility. Both web instances returned healthy through the public load
balancer with development isolation enforced. All four publicly served library,
manifest and preview asset hashes matched the picker commit. The browser suite
passed again using JavaScript fetched from dev.1m8.ai, and the actual hosted
preview passed interactions for date, time and combined modes.

A concurrent Equipment rollout advanced both web nodes to
`8099f33af373ecf3ac9788079c25bef0f8485a38`, inheriting this picker release. All
picker hashes were verified again on those newer baselines; they were preserved,
not rolled back. Compatibility remains on `9d1c687`. Rollback after this point
must account for that newer Equipment release. The worker is unchanged.

Authenticated Channels accounts and physical mobile devices were not exercised;
the shared control was verified through synthetic app-like dialogs and the live
preview, without sending messages or modifying application records.
