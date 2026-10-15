# Development: group Settings search by destination

Source commits: `e35015030ae18a611ad9e5212927e5a248e61cd6` and
`884f594d29c1c2d3defdff2d42a4aa2b255d61c5`, pushed to
`codex/settings-grouping-20261015`.

## Behavior

Search groups all matching entries by settings category and nested view before
applying the result limit. The strongest hit retains the group's score and focus
target. A known nested-page label names the destination; up to two other matching
labels appear in the existing secondary line, with +N for the remainder. Equivalent
singular/plural labels count once. Global search shares the same grouped results.
A specific query still focuses its best matching control without changing its value.

Missing view metadata is resolved only when an indexed label has an unambiguous
known view. Owners may register their existing route resolver with the shared
search engine. People uses viewFor, so aliases and unavailable-view fallback routes
are grouped exactly as its page mounts them, without a second routing table.
People also listens to the platform route event while already active; formerly a
search could update the URL without switching the visible People tab. The listener
is removed when that instance is destroyed.

## Validation

25 tests pass: destination grouping, plural duplicates, alias/fallback resolution,
ranking, specific control focus, availability, keyboard dropdown behavior, mobile
layout, live indexing, performance, and active People route changes/cleanup.
The generated index is rebuilt from both the isolated canonical source and each
verified development library tree, preserving newer deployed settings modules.

Status: verified live on dev.1m8.ai, release `884f594d29c1c2d3defdff2d42a4aa2b255d61c5`, on all three development roles. Hosted desktop/mobile checks confirm one Users destination with a compact match summary, unique destination keys, correct navigation and no browser errors. Existing hosted smoke checks also confirm specific report-control focus and availability filtering.

## Deployment

The immutable development overlay changes six runtime assets: search engine,
index, settings shell, People settings host, global-search adapter and the bundle
cache versions for the two changed modules. Prior release on all three hosts:
`779a211b1a534c8c71481eaf51c6f80982acabe4`. Unrelated live source is preserved by
three-way merge; the manifest replay changes only those two cache versions. The
index is regenerated from audited sources. Baseline hashes, syntax, readiness and
development isolation are checked per role. Production is unchanged.

Audit, manifests and browser evidence: `output/settings-grouping-20261015`.
