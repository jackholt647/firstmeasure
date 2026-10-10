# GIF picker loading fix — October 10, 2026

Source commit `d108c3e19050485efa8dd641b45691cb6492db76` fixes the shared
Platform Widgets GIF picker consumed by Channels and Feed.

## Cause and change

On browsers with scrollbars that consume layout width, adding GIF results
narrowed the grid. Its ResizeObserver cleared and rebuilt the grid; removing
the results hid the scrollbar and changed the width again. This repeated
indefinitely, leaving “Loading GIFs…” visible. The initial browser suite hid
scrollbars and missed the failure.

The picker reserves scrollbar space and observes the popover's outer width.
Actual viewport changes still resize the two-column grid. Configuration,
script loading and GIF requests now have a 15-second timeout. Failed script
loads can be retried by reopening; failed searches can be retried by searching
again. Channels and widget renderer imports use a new picker version, and the
widget runtime uses a new renderer version.

## Verification

The regression was reproduced with the bundled GIPHY SDK and a tall result
fixture: repeated grid clearing left no images and the loading message. With
the fix, all 12 images remained mounted. The committed test runs Chrome with
normal scrollbars, checks that the populated grid stays mounted, and confirms
that resizing to a narrow viewport still fits and selects correctly.

Eight focused browser checks cover the scrollbar regression, stalled requests
and configuration recovery, search, selection, dismissal, standalone widgets,
Channels emoji insertion/reactions, Feed adapters, avatar hover and mentions.
Provider responses and messages are isolated fixtures; these tests do not
query the live GIPHY account or send live messages.

## Development rollout

Activated successfully on all three development frontend roles. All eight
browser checks passed locally and against hosted dev assets. Staged JavaScript
syntax and Linux TypeScript checks passed on each role; readiness checks
confirmed development isolation and enforced outbound safety.

| Role | Activation path |
| --- | --- |
| Web | `/opt/firstmeasure/releases-gif-loading-fix-1791669832/d108c3e19050485efa8dd641b45691cb6492db76` |
| Pool | `/opt/firstmeasure/releases-gif-loading-fix-1791669938/d108c3e19050485efa8dd641b45691cb6492db76` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-gif-loading-fix-1791670049/d108c3e19050485efa8dd641b45691cb6492db76` |

A concurrent Feed release `a2cc8473` subsequently superseded web and pool.
Reviewed differences in Channels UI were confined to composer/table changes;
it retained the new picker import. The other three asset hashes matched exactly.
Final per-role and public readiness and asset checks passed. Compatibility still
reported `d108c3e1` at final verification. Hosted browser checks passed again with
the newer Channels asset. Deployment receipts, reviewed hashes, and scripts are
under ignored `output/gif-loading-fix-20261010/`.

Only four browser assets are overlaid on copies of each current dev release:
Channels UI, widget renderers, widget runtime and the shared picker module.
Guards check reviewed baseline hashes, development isolation, committed bytes,
JavaScript syntax, Linux TypeScript checks and the prior active release before
activation. Rollout is sequential across web, pool and compatibility.

For rollback, inspect the current release first and restore these four assets
from source parent `343ea033` onto the latest release. Preserve subsequent
changes and repeat hosted browser, readiness and asset-hash checks. Do not
switch blindly to a prior whole release after other deployments.
