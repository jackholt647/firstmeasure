# Channels reopened Linear fixes — September 30, 2026

Livia reopened PLA-24, PLA-21 and PLA-20. Each was implemented, independently reviewed, deployed to `dev.1m8.ai`, verified, and then marked **Done in Dev**, in that order. The final Channels project refresh showed these three Done in Dev and the other ten Completed, with no Not Started issues. Production was not activated.

## Changes and immutable commits

| Issue | Commit | Corrected behavior |
| --- | --- | --- |
| PLA-24 | `538fa1dcf08061c322fd55ff90ea13cee1fcdf28` | Thread replies reach the notification bell through a Channels-owned reply preference, including organizations without the Messaging app. |
| PLA-21 | `4b52f6b3b73f40826bbc4134d673dc9168d7280c` | Shift+Enter continues numbered and bullet lists immediately, including empty toolbar lists, typed `1.` after soft line breaks, and repeated empty items. |
| PLA-20 | `84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` | The reminder dialog has a styled Custom time dropdown with centered hour/minute inputs, exact-time entry and past-time validation. |

The earlier notification fix persisted reply records but used a notification lane that did not produce a visible bell alert under the normal message defaults. The catalog also depended on the Messaging app. The new `channel_replies` preference belongs to Channels. Author/following-participant replies use it once per recipient branch; mere mentions retain their existing preferences. Thread/channel mute, fresh authorization, removed definitions and organization locks remain enforced. First observation of the new definition inherits legacy Off/Silent choices even when an older saved personal configuration lacks the definition. Existing occurrences are not replayed. Feed and organizations without Channels retain their prior routing.

The list fix handles native caret boundaries and newline text nodes that the previous tests missed. It preserves rich content and blank lines around the converted numbered line, excludes quotes/code/tables, and does not capture a caret outside a filled list. Main compose, thread compose and actual message editing use the same behavior.

The reminder dropdown is an explicit `customTimeDropdown` option on the Channels reminder mount. Shared pickers retain their existing default controls and Scheduling's date-only Enter behavior. The reminder still opens directly to the calendar with quarter-hour slots and rejects invalid/past custom times. Only owned deltas were committed and overlaid onto each live role; unrelated working and staged changes, and the compatibility manifest's existing topology, were preserved.

## Validation

- PLA-24: three real API/UI end-to-end cases, including producer → delivery → the actual notification panel's bell/unread state; old personal/company configurations, conflicting legacy Off/Silent, explicit reply override, locks/removal, mentions, mute, branch deduplication and revoked root access. Independent review reran the three cases. Eleven shared notification regressions and TypeScript checks passed.
- Exact notification commit: TypeScript, frontend syntax, Channels agent, membership activity, author/branch API routing, SSE mute, notification defaults/delivery, and a separate visible-reply end-to-end test all passed. Evidence: `output/channels-linear-20260930/final-checks/exact-538fa1dcf080-4488ab7b/` and `output/pla24-exact-visible.log`.
- Exact list commit: frontend syntax and the persistent native browser fixture passed, covering immediate markers, empty-list caret variants, rich/blank-line boundaries, decimal exclusions, main/thread sending and editing. Prior paste and mentions regressions also passed. Hosted assets passed the same native fixture after the list deployment and again after the reminder deployment.
- Exact reminder commit: desktop 1366 and mobile 390 native browser tests passed, including keyboard dropdown focus, retained expansion after rerender, centered/font-consistent fields, exact-time saving, invalid/past values and save-error retry. Independent clean-asset review and hosted-asset runs passed.
- Shared picker compatibility checks passed all fourteen groups and the **58** app manifests present in the exact committed source. The repository's older generic fixture waits for an Apply button after date-only Enter has already applied and closed the picker; that failure reproduced on the unchanged baseline. The ignored compatibility fixture corrects only that inherited expectation. Its path adaptation and hashes are recorded in the exact validation summary; the canonical generic test was not altered or claimed green.

Final native fixture scripts are `public/v1/scripts/channels-list-continuation-e2e.mjs` and `public/v1/scripts/channels-reminder-e2e.mjs`. Their API is isolated; hosted runs fetch deployed assets without posting customer messages. The notification API/UI fixture is also isolated. Live verification checks deployed source/compiled hashes, running release identities, local readiness and development outbound safety; it does not claim an external push was sent to Livia.

## Deployment and rollback

All roles started on Scheduling release `5f7cff24fcd55ca3e823af106267de78ecbb2841`. Notifications updated five TypeScript files and their five compiled outputs across web, worker, compatibility and pool. The list and reminder releases updated only their owned frontend assets/cache versions on the three serving roles; the worker was not restarted for frontend-only changes.

| Role | Final active release | Final path |
| --- | --- | --- |
| Main web | `84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` | `/opt/firstmeasure/releases/84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` |
| Compatibility | `84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` | `/opt/firstmeasure/releases-root-archive/84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` |
| Pool web | `84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` | `/opt/firstmeasure/releases/84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` |
| Worker | `538fa1dcf08061c322fd55ff90ea13cee1fcdf28` | `/opt/firstmeasure/releases/538fa1dcf08061c322fd55ff90ea13cee1fcdf28` |

Initial staging stopped before activation: main web had about 2.23 GiB free, and the compatibility release volume had zero free inodes. Compatibility's active baseline already resolved to the root archive, so hardlinking it across to the mounted volume also failed. Reviewed staging used same-device hardlink clones for main web and compatibility, detaching every changed file and release metadata before writes. Measured directory/inode/overlay guards retained at least 1 GiB free. Compatibility staged beside its existing active baseline in the root archive. No historical releases, mounts, retention policy or rollback copies were removed; the incomplete volume staging folder remains inactive and untouched. Worker/pool reused their successfully staged notification payloads.

Activation retained baseline/hash checks, worker running-job checks, atomic current-link switches, runtime readiness, development session/environment/outbound isolation and automatic scoped rollback on failure. Each web activation waited for public traffic before proceeding. Final readiness samples observed both public web instances at the final release. The notification source and all compiled outputs still matched on all four roles after both frontend rollouts.

Use each release's `channels-release.json` and its recorded `previous_path` with the existing atomic-switch/restart/readiness workflow. To undo PLA-20, the three serving roles' predecessor is `4b52f6b3b73f40826bbc4134d673dc9168d7280c`; to undo PLA-21, their predecessor is `538fa1dcf08061c322fd55ff90ea13cee1fcdf28`. To undo PLA-24, all four roles' predecessor is `5f7cff24fcd55ca3e823af106267de78ecbb2841`. Compatibility predecessors remain in `/opt/firstmeasure/releases-root-archive/`; the others use `/opt/firstmeasure/releases/`. Re-audit active source before rollback if another release has superseded these commits; do not discard unrelated later changes.

Ignored evidence under `output/channels-linear-20260930/` includes per-issue manifests, predecessor paths, activation/runtime logs, deployed source/compiled hashes, public readiness samples, exact validation summaries, hosted browser screenshots and the final Linear snapshot/screenshot.
