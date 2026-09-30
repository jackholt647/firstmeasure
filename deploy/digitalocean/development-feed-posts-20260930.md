# Development Feed views and posts — September 30, 2026

Source release: `d9e08684f66d1516b38ab4debbab2412ed921d73`
(implementation `c40c8ef9`, navigation follow-up `d9e08684`) on
`codex/consolidated-firstmeasure-20260923`. User authorized implementation and
deployment to `https://dev.1m8.ai`. Production activation was not authorized.

## Behavior

Feed offers List, Small tiles, Large tiles, Mosaic and Posts. Desktop small
tiles use four columns, large tiles two; responsive layouts collapse on mobile.
Mosaic uses varied image proportions, staggered placement and tighter corners,
and includes document/activity cards. Posts bundle uploads into asymmetric
collages with an overflow count, actor profile/name/time and document values.
Upload batches use server batch IDs where present, otherwise a five-minute
author/project bucket. Events and documents also appear as posts.

Comments and reactions reuse Channels messages, attachments, content rendering,
GIFs, reply attribution, editing, deletion/restoration and comment forwarding.
The company Feed is a hidden channel of type `feed`, with no channel membership
or Channels-list entry. Its automated roots and comments do not produce normal
Channels inbox, unread, notification, subscription, broadcast or agent events.
The durable Work event poster attributes roots to the source actor and deduplicates
retries. Older source posts materialize when a user interacts; catalog and lookup
reads do not create records.

Feed view/participation permissions default on for existing members unless
explicitly denied. Each artifact and each thread operation rechecks organization,
project/branch, media privacy and the relevant domain permission. A Feed grant
does not grant access to contracts or financials. Automated roots are immutable;
clients cannot supply their actor or source metadata. The seven production
permission flags remain unchanged.

## Validation

- TypeScript check passed in the workspace and isolated release candidate.
- Feed API tests: 3 passed, covering hidden channels, event deduplication,
  comments/replies/reactions, forwarding/edit/delete/restore, permissions and
  revocation.
- Navigation smoke check: all five layouts and three legacy values survive
  route-schema normalization.
- Browser test: passed desktop and mobile layouts, collage overflow, contract
  value, comments and likes.
- Publication suite: 49 passed; one PostgreSQL-only test skipped locally.
- Broader Channels suite: 35 passed; three bell-notification expectations fail
  identically against the untouched source baseline. These are pre-existing:
  mentions-only inbox, expanded membership/live-presence mentions, and personal
  inbox mentions/DMs/replies/reactions.

## Deployment

All four development roles activated and independently verified at
`d9e08684f66d1516b38ab4debbab2412ed921d73`; each rolled forward from
`4f146f203360f038ab27eecfd5430ff764c5abaa`. Role services are active, deployed
source/compiled hashes match their audited payloads, and public development
readiness reports the new release with outbound isolation enforced.

The served Feed and ChannelsAPI assets match the manifest hashes. A browser test
using those hosted components and controlled API fixtures passed all five views,
mobile width, collage overflow, comments and likes. The served manifest passes
navigation persistence checks for all five views and legacy preferences.
New routes return 401 without authentication. A read-only background authority
check confirmed default view access, explicit view denial and hidden-channel
listing behavior without issuing a session or creating posts/comments. That
account had no eligible media source to sample; media revocation is covered by
the isolated Feed API tests. An authenticated end-to-end portal session was not
available for this verification.

The role-specific payloads overlay only Feed-owned source and matching compiled
JavaScript on the inspected live baseline. Existing worker coverage and legacy
asset versions are preserved. No environment/topology change or bulk database
migration is included. The web candidate resumed after copying the baseline;
resume requires verified file hashes and at least 512 MiB free space, while a
new release copy requires 3 GiB. Historical releases were not deleted. The compatibility release volume had no
free inodes despite 12 GiB free space; its own incomplete candidate was removed
and the verified candidate was staged in the existing
`/opt/firstmeasure/releases-root-archive` area, with a canonical release-path
symlink. Existing mounts and historical releases were preserved.

Each role stores its prior release and deployed file hashes in
`channels-release.json`. Rollback restores the recorded prior symlink, restarts
the role service and (for web/compatibility roles) PHP FPM, then checks development
readiness and outbound isolation. Do not overwrite an intervening release.
