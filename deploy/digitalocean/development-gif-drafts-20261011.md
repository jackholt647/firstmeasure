# GIFs stay in message drafts — October 11, 2026

Feature commit `5bb43bf8` changes GIF selection from immediate delivery to a
removable draft attachment in Channels messages, Channels thread replies and
Feed comments/replies. The existing Feed new-post composer continues to stage
GIFs until Post. Release source is `d31cfa48b3afa20a2a5165315093abffad506ab3`.

## Behavior

Selecting a GIF shows a preview without calling a message/comment creation
endpoint. Send, Reply or Post submits it with the current text and other
attachments. GIF-only drafts can be submitted. Removing the GIF cancels that
attachment; failed sends retain it. Successful sends clear it. Channel GIF
drafts remain scoped to their channel while switching between conversations.
Async send callbacks retain their initiating editor and destination.

The widget's primary callback is `onSelect`; `onSend` remains a compatibility
alias. Picker labels say Attach/Add instead of Send. Creator overlays remain
hidden, and the visible-scrollbar/loading fix remains in place. The widget
catalog still confirms a selected URL without sending a message. Scheduling
is disabled while a Channels GIF is staged; the existing scheduler rejects
GIF-only payloads. Editing existing message text leaves the separate new-message
GIF draft alone. GIF draft persistence across a full page reload is not added.

## Baseline and checks

Canonical Feed was behind the live implementation. Commit `f9c96068` preserves
the current live Feed composer, department/permission/activity features and the
Channels table-selection fix before applying this change. The existing
canonical project-preview attribute was confirmed in that baseline. Deployment
overlays use exact reviewed per-file hashes and preserve the rest of each live
release, including concurrent backend updates.

Nine focused browser checks pass locally: shared picker lifecycle/search/errors,
standalone widgets, Feed compatibility, Channels composer/thread staging,
GIF-only sends, text plus GIF, removal, failed-send retention, channel isolation,
Feed comment/new-post staging, mention flows and avatar hover. The provider,
messages and feed data are fixtures; tests do not send live posts.

## Development activation

Activated on all three development frontend roles. All nine focused browser
checks also passed against hosted dev assets. Final per-role and public checks
confirmed exact hashes for all five files, readiness, development environment
and enforced outbound safety. JavaScript syntax and Linux TypeScript checks
passed on each staged release.

| Role | Initial activation path |
| --- | --- |
| Web | `/opt/firstmeasure/releases-gif-drafts-1791774124/d31cfa48b3afa20a2a5165315093abffad506ab3` |
| Pool | `/opt/firstmeasure/releases-gif-drafts-1791774200/d31cfa48b3afa20a2a5165315093abffad506ab3` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-gif-drafts-1791774385/d31cfa48b3afa20a2a5165315093abffad506ab3` |

Compatibility staging restarted once because a concurrent release changed the
baseline during validation; the stale stage was not activated. A concurrent
`8a4e2ed4` release subsequently superseded web and pool and retained all five
files byte-for-byte. Compatibility reported `d31cfa48` at final verification.
Scripts, audited baselines, committed payload hashes and receipts are under
ignored `output/gif-drafts-20261011/`.

Five browser files are overlaid: Channels UI, Feed, shared pickers, grouped
widget renderers and widget runtime. Staging verifies committed bytes,
JavaScript syntax and Linux TypeScript. Activation checks prior release,
readiness, development environment and enforced outbound safety, with rollback
only if our release is still current. Production is not changed.

Rollback must preserve intervening releases. Restore only these five files from
reviewed source `f9c96068` onto the latest baseline, then repeat readiness,
asset and browser checks. Do not switch blindly to an old whole release.
