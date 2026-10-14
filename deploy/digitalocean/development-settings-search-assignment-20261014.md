# Development: automatic Settings search and assignment dropdown

## Source

Settings search implementation: `5f31152360ce75de5ecf9632cbb48bddb94e0532`.
Toggle-label focus follow-up: `8c62f0abc9d2493101aae30ac7b2b71bba94c06a`.
Assignment picker: `d0ddb28afe8f1ab7de10c01438359cc29455da4c`.
Pushed to `codex/settings-search-engine-20261014`. The shared remote canonical
branch has concurrent divergent history; no force push or broad source reconciliation
was performed in the dirty canonical checkout.

## Behavior

Settings search derives its catalogue from UI source labels, headings, tooltips and
accessible descriptions, then observes rendered settings for runtime additions.
It supports prefixes, accent normalization, longer-word typos, section availability,
and navigation/focus without changing values. Global search retains these matches.
See [the search architecture](../../docs/architecture/settings-search.md).

The canonical committed index has 934 entries across 28 categories. Development
has additional Phone and Feed modules already deployed by other work. The rollout
regenerates its index from each audited live library tree with the six-file search
overlay: 1,108 entries across 29 categories, preserving those modules. This is a
source-generated build artifact, not a manually backfilled catalogue. Arbitrary
runtime-generated controls still require rendering before they can be indexed.

Initial assignment and the later Assigned to dropdown now share one work-overlap
filter and ranking. An assignee with zero overlap is omitted even when currently
assigned. With no required work, a pay sheet is required. Complete estimates rank
first, then other pay sheets, then eligible capability-only assignees, with price
and name ordering. Unassigned remains available. The assignment popup is 560px
wide, bounded by the viewport, and scrolls within the available space above or below
its trigger. Other popovers retain their sizing.

## Validation

- 16 search engine, navigation, privacy, availability, performance and dropdown tests pass.
- 6 assignment browser tests pass against both the working source and isolated
  committed source, including 44 eligible choices and 320px/390px mobile viewports.
- 26 assignee base/store/roster, requirements and commitment tests pass.
- Related report preview and settings-pane visibility tests pass.
- Existing FirstMeasure personal-preferences browser test still expects a removed
  Save button; that unrelated autosave expectation fails and was not changed here.
- Hosted search verification uses a synthetic development-only account and checks
  report search/focus and disabled-app exclusion; no customer settings are edited.

Repeated hosted testing caught a live toggle grid replacing an indexed control with
a heading. The follow-up uses the toggle itself as the label container, excludes its
label span from separate heading entries, and tests focus after live extraction.

## Rollout

Status: verified on all three development web hosts. Final active release:
`8c62f0abc9d2493101aae30ac7b2b71bba94c06a`. Public asset hashes match the release
manifests; the served assignment module passes all six browser tests. Repeated
hosted search checks pass after live rendering, with no browser errors.
See [the rollout manifest](settings-search-assignment-20261014-manifest.json).

Release assets and baseline hashes are recorded in the ignored task output folders
`output/settings-search-engine-20261014` and `output/assignment-picker-20261014`.
Each release is an immutable overlay of the verified live development baseline,
with only owned runtime files replaced. Baseline drift stops activation. Runtime
readiness, development data isolation and enforced outbound safety are checked.
Production is unchanged.
