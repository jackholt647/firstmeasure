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


## September 29: horizontal calendar and branded time slots

Source: 3c4a4f125ab22e3045e8341e3835421dac4924c3.
Calendar left, independent touch-scroll time slots right; clicking a slot commits.
Brand primary, readable-primary and on-primary tokens follow the source input,
including company/customer themes scoped below the root. Exact time fields remain
under Custom time. Defaults are 15-minute choices with native constraints.

The browser suite covers side-by-side desktop/mobile geometry, scoped branding,
time scrollability, date-first selection, immediate commit, slot arrow navigation,
precision, validation, events, cancellation and modal focus behavior.

Initial activation was correctly blocked by an intervening development presence
release. Unactivated staged trees were retained under staged suffixes. Final
staging refreshed each live baseline only after verifying unchanged picker assets,
then activated with the normal expected-baseline guard. No unrelated code was
replaced; no database, worker, configuration, topology or production changes.
Evidence: output/date-time-picker-horizontal/ (ignored).

Final rollout: both development web nodes and compatibility run the picker
release, each preserving the previous `1474817f9d7479c0b2c620bed5815a8214d27c28`
presence baseline. All three asset hashes match on all three hosts. Both web
instances returned to load-balancer traffic with development isolation enforced.
Public hashes and the browser suite using deployed JavaScript passed, including
the actual preview's date-then-time selection. Rollback must preserve intervening
releases; use the per-role predecessors in activation-progress.json and the
existing symlink/service workflow. Production remains unchanged.


## September 29: inherit the global app font

Release `298eeb47b31620d987b1d16fae608b1ac98ed4d9` removes the picker’s
hardcoded Inter family. On opening, the shared shadow-root component takes the
page body's computed font family. Its title, calendar, time slots, custom inputs
and footer all use that family; reopening picks up subsequent theme changes.

The one-script delta is verified on both development web nodes and compatibility.
The web predecessor was `46974807d1dcd15950377860e0071a470299dd21`; pool and
compatibility predecessors were `2a56ed8d9762bd618e32471eadd4db37ee0ee2cb`.
Each release inherits its own live baseline, preserving concurrent changes.
Browser behavior checks passed; direct font checks passed locally and against
the deployed script, including changed global fonts on reopening. All per-node
and public asset hashes match, readiness and isolation pass, and both web nodes
returned to public traffic. Evidence: `output/date-time-picker-font/` (ignored).
Rollback must inspect intervening releases before restoring those predecessors
through the existing per-role symlink/service workflow. No database, worker,
configuration, topology or production changes.
