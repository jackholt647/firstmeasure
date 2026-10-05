# Channels Linear follow-up — October 5, 2026

Development-only work for Channels issues PLA-24, PLA-31 and PLA-32. Activation
was authorized in the ongoing conversation; production was not activated.

## Runtime changes

- PLA-24: the Channels header totals unread messages across default, Starred
  and custom sections, while preserving per-channel counts and excluding hidden
  channels and direct messages. Source `192a9a712b6345253411660858acf75dc4f8775c`.
- PLA-31: native checkbox and conversation labels align in Edit Sections at
  desktop and mobile widths; long labels wrap and keyboard/label selection
  remains functional. Source `a2d0018347d8a26d4fbdefd87c5fd547b4623bf3`.
- PLA-32: Channels message and activity alerts use the Messages menu, including
  persisted rows with older Bell preferences. Viewed messages clear without a
  reply. Followed thread replies are included. Business notifications retain
  their bell behavior. The notification list moved into a shared domain view;
  inbox reads recheck recipients, branch, preferences, channel membership and
  message/root visibility. Separate activity occurrences acknowledge their own
  rows so a held older read cannot erase a later huddle or lifecycle notice.
  The existing 14-day personal inbox window is retained; no history replay or
  migration is performed. Archived-channel activity is resolved individually
  for existing authorized members, without exposing the archive directory or
  initializing channels/memberships during an inbox read. Sources
  `d4ae26a7272a27a2e6d444b5a38b2271775fb44d` and
  `76abe6092e508a8bc4ede491bab00b4730da9879`. Final source
  `27926ec287e1331e6cfa981766ae3ec6a4e9a5ba` also routes project activity
  using its related message ID (or no selected message), while acknowledging
  the notification occurrence separately. The activity bridge preserves the
  existing project-note separation flag and caches that flag per inbox request.

## Verification and deployment

PLA-24 exact-commit TypeScript/frontend checks and native UI/API test passed;
independent review also ran the existing read-on-open regression. The hosted
frontend passed again against an isolated API fixture. PLA-31 exact-commit and
hosted desktop/mobile fixtures passed alignment, long-label, native keyboard,
save and reopen checks.

Both frontend releases activated on the web, compatibility and pool roles;
each role's runtime release and owned asset hashes matched, with public
readiness and development isolation checks passing. Each Linear status was
changed only after hosted verification, then reloaded to verify persistence.

PLA-32 exact-commit TypeScript/frontend syntax, Messages native UI/API and
existing clear-on-open tests passed. Independent reviewers verified actual
archived-member access, revocation, no read-side initialization, and the
existing inbox/delivery regressions. The native fixture serializes each
client's local injection calls to avoid overlapping Windows session JSON
rename retries; held-read races remain paused before injection and tested.
The deployed PostgreSQL storage implementation is unchanged.

Final PLA-32 commit passed all 70 Channels/notification regressions, all three
Messages browser/API cases, the existing clear-on-open case, TypeScript,
frontend and JavaScript syntax checks. Independent review confirmed all eight
runtime files and three owned tests match the reviewed source.

Release `27926ec287e1331e6cfa981766ae3ec6a4e9a5ba` activated on web, worker,
compatibility and pool. Runtime releases and source/compiled hashes matched;
six public readiness samples passed with development isolation enforced.
Compiled notification modules imported on all four roles; Channels bell
presentation remained false and business bell presentation remained true.
Twelve unrelated source/assets were compared before and after and remained
identical, including login, regional backend, report UI and orbital intro.
Hosted assets passed all three Messages browser/API cases and the aggregate
unread case against isolated local APIs; the hosted section alignment fixture
also passed at desktop/mobile widths. PLA-32 was marked Done in Dev only after
these checks, with the persisted state reloaded at 2:22:56 PM Chicago time.
The full project rescan then showed scope 15: PLA-24/31/32 Done in Dev,
the other 12 Completed, and no newly added or reopened issues.

Concurrent login, report and orbital intro releases changed earlier baselines.
Guards stopped staging/activation before overwriting those changes, and fresh
audits rebuilt bounded overlays. An earlier public gate for release `76abe609`
timed out after the report release superseded it; its Channels code was
preserved. Final rollback baselines are `ad22be58` on the three web roles and
`76abe609` on worker, with exact paths in the final manifest/remote receipts.

Payloads apply only owned commit deltas over each role's actual live source.
Role-specific manifests and unrelated development code are preserved.
Same-filesystem hardlink clones on web/compatibility/pool detach changed files;
worker staging uses the existing clone policy. Byte/inode guards run before
cloning. Pool restaging hit the 3 GiB full-copy reserve after another release
activated. A fresh audit found 2,558,668,800 bytes free, 22,057,920 free inodes,
3,274 source directories, 27 symlinks and matching source/target filesystems.
The existing measured hardlink path retains its 1 GiB reserve and avoids
copying unchanged release files. Earlier prepared clones remain archived.
Rollback paths are retained in each role's `channels-release.json`.
No cleanup, topology changes or customer verification writes were performed.

Evidence is under `output/channels-linear-20261005/`, including exact-commit
archives/check logs, independent reviews, role inventories/manifests, hosted
browser logs/screenshots and persisted Linear status snapshots.
