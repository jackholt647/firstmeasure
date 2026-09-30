# Channels Livia issue pass — development, September 29, 2026

The first pass covered eleven Livia issues in the Channels Linear project:
PLA-15, PLA-16, PLA-17, PLA-18, PLA-19, PLA-20, PLA-21, PLA-22,
PLA-23, PLA-24 and PLA-26. All eleven received an initial development rollout
and verification. Livia subsequently marked seven issues completed, reopened
PLA-15, PLA-20 and PLA-21, and added PLA-28 and PLA-29. The current scope is
thirteen issues. The initial rollouts below are historical evidence; they do
not imply that a reopened issue has passed its follow-up review. Each issue
is marked **Done in Dev** only after its development rollout and hosted
verification pass.

All thirteen issues are now deployed to development. The final serving source
is `e5c26c451797e6a2dab28256ad70173c9d7a1701` on both web nodes and
compatibility; Channels UI and Tags hashes match the exact verified commit.
The worker retains `ef95bf16` with verified original Channels backend changes.
Hosted behavior checks, owned-file verification, public readiness and enforced
development outbound isolation pass. Refresh an existing development tab to
load the new browser assets.

Source commits are prepared with a separate Git index and selective task
patches. Unrelated staged and working changes are preserved, including the
concurrent project notes content renderer, Contacts, Feedback, and manifest
updates. Per-role immutable overlays retain each live role's unrelated source,
runtime configuration, dependencies, storage and private artifacts.

Release evidence, baseline manifests, selective patches, browser fixtures and
screenshots are in ignored `output/channels-linear-20260929/`.

## Initial rollouts

- PLA-26: `2225af718a31a25f86bbd6b6e0eabf83f30ca7bd` on both serving web
  nodes and compatibility. All Unreads, Activity and Threads links are removed
  from the sidebar. Full and list layout browser checks pass with attention
  enabled, and company-channel discovery still opens. Runtime isolation,
  readiness and owned file hashes pass on every updated role.
- PLA-22: `3759e441ce3c0a3260d38f1727f18f253b35527f`. Removed the composer
  resource-sharing option; hosted composer checks pass with resources enabled.
- PLA-17: `8c95b6583074ab4a4c6052a1bfdaea8fc3c927ac`. Restoring a hidden
  conversation closes the modal after success; errors retain the retry control.
  Hosted success/error checks pass. A concurrent window rollout advanced both
  web nodes to `56c9f869e31ac7bd551a06e0b952d264a3b01c99`; fresh inventory
  confirms the Channels hashes and cache version are preserved, with public
  development readiness and outbound isolation passing on both nodes.
- PLA-18: `b83d78c2b3eb650c310646556af4027dd9109673`. Float microphone
  samples and a silence threshold prevent a green meter at zero input. Hosted
  tests pass for silence, voice, completion reset and explicit reset/cleanup.
- PLA-16: `3e72d34a55981beb6c277a83dea7f5c6c9d20251`. Visibility rows align
  public/private controls to the left with consistent spacing. Hosted desktop
  and mobile checks pass for geometry, default public, keyboard selection and
  the private-channel request payload.
- PLA-19: `c820bfb042d88e055f8a8da59c0380fe396597fb`. Forwarding can select
  eligible company users without an existing DM. No DM is created during
  selection; submission creates or reuses one. Hosted checks cover exclusions,
  retry reuse and duplicate-target suppression.
- PLA-20: `ec8fb93ce2978fbeee437abf431cf0d41c46e1c5`. Reminders mount the
  shared calendar directly. Suggested times use quarter-hours; exact custom
  values remain supported. Compact custom fields sit in the right time rail.
  Hosted desktop/mobile geometry, save, error/retry and cleanup checks pass;
  shared picker regressions preserve standalone formats and step constraints.
- PLA-21: `26757c90731d08c0a700c78268a905dd6e6e95a7`. Shift+Enter continues
  bullet and numbered lists. Hosted checks cover serialized numbering,
  formatting, mid-item splits, nesting, and existing plain-text/quote behavior.
- PLA-23: `d928e8d3dd3f76a59d82bc7e43389c4fd7652455`. Agent typing starts
  when queued, renews during execution and stops after reply/error. Fresh
  channel access and current realtime recipients are rechecked. All serving
  roles and the worker are verified; private events and UI expiry checks pass.
- PLA-15: `39df5bc31957a18d4b66dab7ec09202943d36ae6`. Join/removal activity
  refreshes immediately, and removed members return to Add people. A notice is
  persisted only when DELETE actually removed a membership. Concurrent removal,
  access revocation and rejoin tests pass; hosted UI/SSE behavior and all four
  runtime roles are verified.
- PLA-24: `63538a453309343c5201ac3cb1987e7ecfcd7de4`. Thread authors and
  participants receive reply notifications automatically; persistent Mute/Unmute
  replaces Follow. Participation preserves explicit mute choices. Current
  account/channel/root/reply access and DND/channel mute are checked before
  notifications. Each recipient's current branch is stamped on deterministic
  notification occurrences, including agent replies and mentions. Hosted
  root/reply/pin/reload/error/SSE/draft checks pass, as do exact-commit backend
  checks. Worker staging's transient SSH timeout was retried successfully before
  activation. All four final roles and public web nodes verify development
  isolation and owned hashes/cache versions.

The PLA-22 rollout encountered an intervening assistant-close release while
waiting for public verification. Remaining activation was stopped, both web
nodes were re-inventoried after the other rollout completed, and the overlay
was rebuilt against their new live baselines. Assistant changes are preserved.

## Follow-up review and rollouts

| Issue | Follow-up | Source | Current development status |
| --- | --- | --- | --- |
| PLA-15 | Restore a clearly visible Remove action, fresh membership/permission hydration, and removal across refresh and reopen. | `bf98e11841bc93dbd086caa788ef600415b99320` | Deployed and marked Done in Dev after hosted real API/browser checks. |
| PLA-20 | Reject past custom reminder times, retain inline validation, and center custom numbers. | `3ee5be6a65647653c6c2a782ce31511b7b09ff44` | Deployed and marked Done in Dev after hosted desktop/mobile, future-time and elapsed-clock checks. |
| PLA-21 | Continue toolbar lists and typed numbered prefixes on Shift+Enter in messages, replies and edits. | `2a94fa105ba1a356ca23ff415a53cac19c227eda` | Deployed and marked Done in Dev after full hosted composer and nine expanded audit checks. |
| PLA-29 | Members modal title becomes exactly “Members.” | `63cee883b3600d78fc1f28aa9478b3e3d3ba0b08` | Deployed and marked Done in Dev after hosted title/accessible-name checks. |
| PLA-28 | Align typed/toolbar mentions for channel members, everyone, here and FirstMate; highlight mentions and partial queries red within their text block. | `e5c26c451797e6a2dab28256ad70173c9d7a1701` (includes `37492707` and `f116686e`) | Deployed and marked Done in Dev after hosted picker, red-token, channel/thread/edit and shared-Docs compatibility checks. |

PLA-15 follow-up verification connects Chromium to an isolated real Fastify API,
rather than substituting successful membership mutations. It covers actual
owner and channel-admin payloads, visible and accessible removal controls,
DELETE/readd requests, immediate activity and Add people updates, and repeated
refresh/reopen. Ordinary members still receive no removal control and cannot
remove another member through the API. The last channel manager remains
protected. The fixture cleanup commit `428db274` disables unrelated job workers
before importing the application and closes the application before its stores;
the test passes and exits normally without an inherited worker setting.

The concurrent project-trays rollout at `ef95bf16` advanced the serving
baselines during this work. Source and runtime were re-audited per role, and
follow-up overlays were prepared against those actual baselines to preserve
the tray changes and other unrelated live content.

Compatibility staging encountered inode exhaustion. Recovery removed only this
task's incomplete `bf98e118` staging directory, then deduplicated approximately
23,000 unchanged dependency files between the retained `63538a45` and
`ef95bf16` releases. Files were matched by SHA, mode, owner and modification
time before deduplication; rollback content was preserved. This did not change
source, runtime behavior, topology or purchased capacity.

Future compatibility staging uses `cp -al` for the verified baseline and
detaches each owned file before writing its overlay, so no shared baseline or
rollback inode is modified in place. Source/runtime baseline guards and owned
file verification still apply. No production activation is authorized by this
development workflow.

## Validation and release boundaries

Browser fixtures exercise real UI code with isolated API/device fixtures and
repeat against scripts served by `dev.1m8.ai`; they do not send messages to
customer conversations. Backend tests use temporary isolated stores.

The initial-pass committed source `63538a453309343c5201ac3cb1987e7ecfcd7de4` passes all
eight validation checks: TypeScript, Channels frontend syntax, shared picker
syntax, Channels agent (14 tests), concurrent membership activity (1), focused
thread mute/routing/access API (2), mute/unmute SSE (1), and notification
delivery (4). Backend suites disable unrelated job workers with
`FIRSTMEASURE_JOB_WORKERS=0` for isolation. Archive, dependency junction,
summary and logs are retained in
`final-checks/exact-63538a453309-5392540e/`. No dependencies were installed.

The first complete follow-up source `3749270745bd01dbfb4431f8f7b1d5a2030e154c` passes all thirteen
clean-archive checks: the eight initial checks plus the real API member-removal
browser test, mounted mention/Docs compatibility test, full paste/list browser
script, Tags syntax and expanded list audit. The nine list audit cases include
bare numbered prefixes, decimal-prefix rejection, selection splits, rich
formatting, nesting, main/thread edits and modified Enter sending. Evidence is
in `final-checks/exact-3749270745bd-eb6e2aa7/`. The exact reminder source `3ee5be6`
also passes its original and follow-up browser checks and shared-picker
regressions, in `pla20-r2/exact-3ee5be6/`.

The final mention source `e5c26c451797e6a2dab28256ad70173c9d7a1701` passes the
same thirteen clean-source checks after the pending-query and text-block
refinements. The mounted mention test additionally verifies that bare `@` and
partial queries remain red without selecting recipients, email addresses and
ordinary text remain unhighlighted, and ranges stop at paragraph/list/cell
boundaries while preserving selected multiword names across inline formatting.
Evidence is in `final-checks/exact-e5c26c451797-69e8e950/`.

Read-only backend continuity checks compare nineteen owned methods on four
roles (76 comparisons), including their actual compiled JavaScript. All match
the final source. Agent code also matches the PLA-23 after snapshot and thread
collaboration matches the original PLA-24 deployment receipt. This is source
and compiled-code verification; it does not claim observation of a newly
executed agent job. Evidence is in `output/verify-backend-continuity/`.

Frontend rollouts reload PHP-FPM gracefully after the immutable symlink switch
to refresh OPcache and realpath caches. Node roles restart with their configured
drain behavior; each public web role must return healthy traffic before the
next activation. Baseline and owned-file guards stop activation on intervening
changes so the overlay can be reconciled first.

Three inherited notification bell assertions fail identically on the unchanged
source baseline. Their baseline evidence is retained in
`pla24/baseline-head-tests.log`; their expectations were not weakened.

There are no database migrations, dependency changes, provider configuration
changes or topology changes. Production is not activated. The existing
development autoscale replacement-image limitation remains.

Rollback must account for intervening releases: use the per-role predecessors
stored in each task's release manifest, retain later unrelated changes,
roll one role at a time, and reverify readiness, isolation and owned hashes.
Do not blindly revert a node to a predecessor from an earlier issue.
