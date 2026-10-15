# Development: settings search relevance, October 15

Implementation: `69ba1849bda955b2c7e9756c2c98b41955b2875a` and
`779a211b1a534c8c71481eaf51c6f80982acabe4`, pushed on
`codex/settings-ranking-20261015`. The canonical remote rejected a fast-forward;
its concurrent history and the dirty checkout were preserved without a force push.

## Behavior

Comparable page/tab matches precede fields and headings. Singular/plural English
forms such as user/users are equivalent, and a generic Settings suffix does not
make Phone Settings less relevant than an incidental Phone field. Exact specific
controls still precede broader destinations. Title matches precede category-context
matches, then description/tooltip-only matches. Prefixes and longer-word typos
remain supported. Repeated mentions and app result counts never boost a score.
Available sections and the 40-result limit are unchanged; results are not removed
to promote the preferred destination. No per-app keyword exceptions were added.

## Checks and rollout

21 search ranking, browser, navigation, availability and performance tests pass.
Regression tests cover user/users, specific control intent, tooltip frequency,
large incidental result sets and page suffixes. CI runs the new tests.

Status: verified on web, compatibility and pool hosts at release
`779a211b1a534c8c71481eaf51c6f80982acabe4`. Hosted browser checks confirm Users first for user/users,
Phone Settings first for phone, specific-control relevance, typo support and
unchanged navigation/focus. No browser errors. Public script hashes match the
release manifest.

The one-file runtime overlay changes `public/libraries/apps/settings/search.js`.
The prior development release on all three hosts was
`a561c1984b9c0fa92e0846303f883bd0179ab383`. The deployed index, unrelated frontend
changes, backend implementation, environment and data are preserved. The rollout
uses immutable releases with baseline hashes, per-role readiness and rollback.
Production is unchanged. Local audit and test artifacts are under
`output/settings-ranking-20261015`.
