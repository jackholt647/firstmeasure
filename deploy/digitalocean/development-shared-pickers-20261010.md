# Shared GIF and emoji widgets — October 10, 2026

Implemented and activated on development only. Release
`f7b6dd7808b0c547c630f1ceb1445092daad76f4` is published on
`codex/consolidated-firstmeasure-20260923`.

`public/libraries/platform-widgets/pickers.js` owns the GIF and emoji controls,
including their data, styles, search, anchored popovers and lifecycle cleanup.
The catalog renderers and Channels consume this implementation. Channels owns
message delivery and retains thin adapters for existing Feed callers. The
widget controls run without Channels UI; GIF configuration still uses the
authenticated Channels API transport. See the
[picker API notes](../../public/libraries/platform-widgets/README.md).

The GIF control is a compact non-modal popover with search, a two-column grid,
GIPHY attribution, PG filtering and direct selection. It supports Escape,
outside interaction, trigger toggling, keyboard focus and small viewports.

## Source reconciliation

Feature commit `b95e2a26` moves ownership; `118b24c5` verifies Feed compatibility.
The live Channels file also contained Feed composer exports and subsequent
caret/table/formatting/mention fixes from `3323ab8d`. Those were preserved in
`8636e4b2`, then merged with current canonical source in `f7b6dd78`.
Initial stages were rejected when independent development releases changed
their baselines. They were not activated over the newer work.

## Deployment and verification

Only four browser files were overlaid onto audited copies of each current
development release: Channels UI, widget renderers, widget runtime and the new
picker module. Existing files were checked against reviewed pre-change hashes;
all staged files were checked against committed bytes. JavaScript syntax and
Linux TypeScript checks passed on all three roles before activation. Each role
was activated sequentially with prior-release guards and automatic rollback.
The worker, database, configuration and production were not changed.

All three roles initially activated `f7b6dd78` from `3323ab8d`:

| Role | Activation path |
| --- | --- |
| Web | `/opt/firstmeasure/releases-shared-pickers-1791668932/f7b6dd7808b0c547c630f1ceb1445092daad76f4` |
| Pool | `/opt/firstmeasure/releases-shared-pickers-1791669041/f7b6dd7808b0c547c630f1ceb1445092daad76f4` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-shared-pickers-1791669153/f7b6dd7808b0c547c630f1ceb1445092daad76f4` |

Seven browser tests passed locally and using hosted development assets. They
cover standalone widget rendering without Channels, the bundled GIPHY grid,
search, selection, duplicate-send prevention, cleanup, responsive sizing, Feed
adapters, Channels insertion/reactions, user-summary hover and mention flows.
GIF results and messages use isolated browser fixtures; these checks do not
send live messages or query the live GIPHY account.

Final per-role and public checks confirmed readiness and enforced development
isolation. All four hosted file hashes matched the release. A concurrent
`e30e45c9` release superseded web and compatibility during final verification;
both retained the exact four picker assets. Pool still reported `f7b6dd78`.
Receipts, manifests and staging scripts are under ignored
`output/shared-pickers-20261010/`.

Rollback must first inspect current releases. Restore only the four picker
assets from the reviewed `3323ab8d` baseline onto the latest release, retaining
intervening changes; the added module may remain unused. Do not blindly switch
back to an older whole release after independent deployments. Recheck hosted
assets, Channels/Feed pickers, readiness and development isolation.
