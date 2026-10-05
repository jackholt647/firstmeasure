# Connected roofing fixtures and visible unassigned projects — October 5, 2026

Development release: `bccb945f7d609caf9134eaa35ed8d8c06fd035e6`.

## Behavior

The development header's 1x batch now creates 24 contacts and 16 residential
roofing projects with contact identities, addresses, scope notes, values,
measurement datasets and actual pipeline work plans. Projects occupy the
organization's configured stages. Create-only IDs preserve edits; retries can
finish attaching a missing plan without resetting an existing plan's stage.
Fixture work nodes have no automation bindings or external effects.

A new Users toggle adds six fictional employee profiles with job titles. These
are display fixtures without credentials or access-role grants. Company-wide
resources use stable IDs across batches: six users, four equipment units and two
shared channels (`team`, `field-operations`). Equipment totals count physical
units, excluding type and yard records. The amount multiplier grows customers,
projects and conversations, not fleets or duplicate shared spaces.

Communication adds two discussion threads to each shared channel and to two
project channels per batch, authored by the sample employees. Project channels
use the canonical project-channel service. Channel membership includes the tester
and sample authors. No messages are sent through email/SMS transports. Turning
Channels off prevents channel creation; Communication can still add messages to
existing channels. No old fixture data is deleted.

The project viewer derives a selectable **No board** group for accessible
projects absent from board cards, and **No stage** for cards absent from board
columns. Stages, List and Tiles can expose these projects. Search/draft/sharing
filters remain authoritative; board cards now intersect the visible project set.
No-board and no-stage placeholders are not writable workflow stages.

## Verification

The generator integration test exercises isolation, permissions, CSRF, all-category
batches, independent toggles, idempotent retries and batch scaling. Across three
batches it verifies 48 projects on real boards, 72 contacts with distinct emails,
six users, four equipment units and two shared channels, with conversations in
six project channels. The focused view regression verifies missing-board/stage
coverage, filter intersection and no mutation of board records.

`npm run check` passed. Candidate browser tests found old unassigned projects in
Stages, List and Tiles. Immutable Linux release payloads passed type checks and
syntax checks on all four development roles. Evidence and guarded release
manifests are in `output/development-company-20261005`.

## Maintenance

`public/v1/development/roofing-company.ts` owns the company scenario. The development
orchestrator retains selection/authorization/lease handling. Legacy sandbox sample
fixtures remain separate. Extend relationships and invariants in integration tests
when changing quantities or adding a company type. Existing release source and
configuration were retained through narrow overlays; production is unchanged.

## Hosted acceptance

Fresh Instant Full Org `Roofing Company - Connected Test` (`org_ac032e9558d20b4b`)
passed the live 1x browser/API test: 24 contacts, 16 projects, six employees,
four equipment units, six events, 16 material lists, four draft estimates,
two shared channels and two project conversations containing 24 messages.
All sixteen projects rendered across four Sales stages and in the List view.
Channel messages resolved named employee authors. A retry added zero duplicate
projects, equipment, shared channels or messages. Existing unassigned projects
also passed the hosted Stages/List/Tiles test.

Final verification checked all owned source and compiled hashes against each
active development process. The concurrent web release `16c7bd83b35309f277a602ab4f5377551fbd3160`
retained these files. A transient 503 during rollout delayed the fresh-org test;
the successful run verified the service after recovery. No runtime configuration
or production changes were made by this task.
