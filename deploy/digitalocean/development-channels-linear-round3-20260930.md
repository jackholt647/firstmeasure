# Channels follow-ups, round 3 — September 30, 2026

Livia reopened PLA-24, PLA-21 and PLA-20 with additional feedback. Implementation ran in parallel; commits, development rollout, verification and **Done in Dev** transitions ran sequentially in that order. Each status persisted after a full reload. The full-project reload after the last deployment showed three Done in Dev, ten Completed and no open issues; scope remained thirteen. The [previous release record](development-channels-linear-followups-20260930.md) remains historical evidence. Production was not activated.

## Changes

| Issue | Immutable commit | Behavior |
| --- | --- | --- |
| PLA-24 | `2dff66c7ecd96b4f4882046773ec4ac0ffeed763` | Opening a visible, focused channel acknowledges its bounded loaded sequence, including replies hidden behind root rows, without posting. Successful reads update matching caches and refresh authoritative sidebar counts. |
| PLA-21 | `11798338b00583099e2ba2650c9c770145981045` | Prefix plus Space starts lists; Enter continues/splits, empty Enter exits/outdents, Tab/Shift+Tab nest/outdent. Selected rich text conversion, shortcuts and undo work in main/thread composers and editing. |
| PLA-20 | `45b3b1f2c336d616805c45ab8539426ea2b72a67` | The reminder-only layout removes the gap below Custom time in both dropdown states and makes the year bold. Shared-picker defaults stay unchanged. |

Read acknowledgments capture the channel and maximum observed sequence. Hidden/unfocused views, mobile Back, failed reads, switches and later unseen arrivals retain unread state. Focus/visibility/host activation resumes pending reads; destruction removes listeners. Thread-detail read markers remain independent.

Lists preserve bold/link content and exclude decimal/URL/code/quote/table boundaries. Immediate Backspace/Undo reverses automatic formatting while retaining the literal prefix and live caret; ordinary content undo/redo stays native. Shift+Enter continues the list, including empty items, as explicitly requested earlier. Normal Enter adds Docs-style continuation/exit. References: [Google Docs lists](https://support.google.com/docs/answer/3300615?hl=en), [automatic lists and reversal](https://workspaceupdates.googleblog.com/2014/09/automated-lists-backspace-to-undo.html).

Only owned patches and cache versions entered runtime overlays. PLA-24/PLA-21 change Channels UI; PLA-20 changes its reminder mount and opt-in shared-picker CSS. Committed regression fixtures are excluded from runtime payloads. Unrelated dirty/staged work and compatibility manifest topology were preserved.

## Validation

- PLA-24: actual native browser UI with isolated real API/store passed clear-on-open reply/mention badges, reload persistence, focused realtime, hidden/unfocused/mobile views, failed-read retry and held acknowledgments across switches/later arrivals. Independent rerun passed. Exact source passed TypeScript, frontend syntax and browser/API checks.
- PLA-21: exact source passed syntax and eighteen expanded native editing groups plus prior immediate Shift+Enter/caret/main/thread cases. Clean owned-patch checks also passed mounted mentions and rich paste/list regressions.
- PLA-20: exact source passed frontend/picker/fixture syntax, native desktop 1366×768/mobile 390×844 reminders, and fourteen shared compatibility groups across 58 app manifests. Closed/open gap measured effectively zero on both viewports; year weight is 700. Exact-time saving, validation, focus and failed-save retry remain covered.
- Hosted list/reminder fixtures passed after their releases and together on the final release. The hosted unread browser/API fixture passed on final assets. All three serving roles passed owned source/cache hashes, local readiness and development isolation. Public readiness samples observed both web instances at the final release.
- Earlier notification source and all five compiled outputs still match on all four roles. Worker file/runtime verification passed; frontend changes did not restart it.

Fixtures use isolated data; hosted runs fetch deployed assets without posting customer messages or creating customer reminders. They do not claim Livia's account/session was exercised. Available test organizations did not expose Channels; flags/access were not widened.

The older generic shared-picker test expects Apply after date-only Enter already applied/closed the picker. That failure reproduced on the unchanged baseline. The ignored compatibility fixture corrects only this inherited expectation and records template/adapted hashes and path adaptation. The unchanged generic script is not claimed green.

## Development activation and rollback

The main and pool web hosts run `45b3b1f2c336d616805c45ab8539426ea2b72a67` under `/opt/firstmeasure/releases/`. Compatibility runs that release under `/opt/firstmeasure/releases-root-archive/`. Worker remains `538fa1dcf08061c322fd55ff90ea13cee1fcdf28` under `/opt/firstmeasure/releases/`.

Staging reused reviewed same-device hardlink clones on main web/compatibility, detaching changed files and metadata before writes, with measured byte/inode guards retaining at least 1 GiB free. Pool used its ordinary clone. No releases, retention rules or mounts changed. Activation retained baseline/hash checks, atomic links, scoped rollback, readiness and public-traffic gates.

Use each release's `channels-release.json` with the existing atomic-switch/restart/readiness workflow. Serving-role predecessors are `11798338b00583099e2ba2650c9c770145981045` for PLA-20, `2dff66c7ecd96b4f4882046773ec4ac0ffeed763` for PLA-21, and `84016fbfd8208fcb7b1f42edc4e96e2a035fc4d7` for PLA-24. Compatibility predecessors use the root archive; others use `/opt/firstmeasure/releases/`. Re-audit before later rollback to preserve subsequent unrelated work.

Ignored evidence under `output/channels-linear-20260930/` includes issue folders `pla24-round3`, `pla21-round3`, `pla20-round3`, exact validation folders in `final-checks`, and final combined hosted/readiness/notification-preservation/Linear evidence in `round3`. Manifests retain predecessor paths, payload hashes and staging/activation/runtime results.
