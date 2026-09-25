# Doc Studio Brand Kit (development, 2026-09-25)

Source branch: `codex/doc-studio-brand-kit`. Source/UI release:
`dce04deb83782c5cab61ead3e74157aaa6c6ff49`. The release is active on
both development web nodes (`do-598520065` and `do-603124965`) and the
development compatibility service. Production and the development worker were
not changed.

The Doc Studio Brand Kit tab edits the shared company palette, logo, and new
document font. Company Information also has a Brand Kit section with the same
font control. Saving writes the branch presentation branding and refreshes the
editor. Blank documents and themes inherit that font and palette; existing
template content keeps its own styling. Doc Studio tabs, buttons, editor chrome,
and related controls use the company primary color with readable text.

Deployment used a scoped six-file UI payload. Both web nodes preserved their
serving release `92cf566182c4cf019000671bc298b5ad494f6a6c`; the company
settings and app manifest received only the Brand Kit hunks so concurrent
Forward, assistant, and other deployed changes remained. Compatibility
preserved its serving release `91046fca06b533a381223366db14161ab78779d9`.
The compatibility disk had too little free space for a full release copy, so
its unchanged immutable files were hardlinked into the new release and the six
changed files plus `release.env` were replaced with distinct inodes. Its
original release remained untouched. The deployment payload archives passed
SHA-256 checks, and all changed JavaScript passed syntax checks on each host.

The first web activation caught an old copied `RELEASE_ID` marker and rolled
back to its original release. The marker and exact-release readiness check were
corrected before the successful rollout. All three roles then reported the
new release, readiness, development data, and enforced outbound isolation.
After both web nodes rejoined, 24 public readiness requests reached both
instances (20 and 4 respectively) at the exact release. The public versions
of all six changed assets matched the staged bytes.

Focused UI branding checks passed in the isolated source worktree. The full
UI contract suite contains unrelated existing failures, so the exact live
release and public asset checks are the deployment gate for this scoped change.

Rollback: switch each role's `/opt/firstmeasure/current` symlink to its
previous release above, restart its `firstmeasure-development-web.service` or
`firstmeasure-development-legacy.service` plus `php8.3-fpm.service`, and verify
`http://127.0.0.1:3201/v1/health/ready` reports the previous release and
development isolation. The autoscale image remains historical; replacement
nodes need this verified UI overlay before serving it. The compatibility host
had about 466 MB free after staging and should have its retained releases
reviewed before another full-copy deployment.
