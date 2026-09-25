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

## Missing presentation style hotfix

The first live Brand Kit load exposed a nullable `branchModules.get` result:
organizations without a saved `presentation_style` module returned `null`, and
Doc Studio attempted to read `.data` from it. Source hotfix
`5685b86f214d81018aab92e312c1b3111b4a885e` treats absent branch and
style responses as empty data, including the blank-document font path. Its
regression test executes the loader with null responses and checks Montserrat
and palette defaults. The Studio bundle token was bumped so existing browsers
fetch the correction.

The web nodes and compatibility had concurrently advanced to
`b94be726b407047814b819de0cf935d49fce4e5b`. The hotfix cloned that
serving release and replaced only `studio.js`, the scoped app-manifest token,
and `release.env`. Compatibility used hardlinks for unchanged files to fit its
remaining disk capacity; changed files and the marker have separate inodes.
All three roles report hotfix release `5685b86` with readiness, development
data, and outbound isolation. Thirteen public readiness checks reached both
web nodes (8 and 5), and the served Studio and app-manifest bytes match the
staged overlay. Rollback is the same as above, using `b94be726` as the prior
release on all three roles.

A concurrent development release subsequently advanced both web nodes to
`4c059e5558a20ca09cacebfc17e66ed6ebf4c51a`. Read-only checks confirmed
that both serving scripts still contain the null guard and the bumped Studio
bundle token. Both web nodes returned exact `4c059e5` readiness with enforced
development isolation; a subsequent 38-request public sample reached both
instances (37 and 1). Compatibility retained the hotfix release during that
check.

## Shared Brand Kit controls and automatic saving

Source commit `b45ab00ea0c6aee0b5a70bc8144eb37a28bfd730` moved the
Company Information palette, logo, and font controls into one shared Brand Kit
library consumed by Company Settings and Doc Studio. Brand Kit edits now save
automatically in both locations; Doc Studio no longer has a Brand Kit Save
button. The existing Company Save button still handles the other company
information fields.

The development overlay was rebased onto the actual serving files before
activation. Both web nodes previously served `4c059e5558a20ca09cacebfc17e66ed6ebf4c51a`;
compatibility served `5685b86f214d81018aab92e312c1b3111b4a885e`.
The web Company Settings file had concurrent assistant and billing changes,
which were retained. Stray earlier Brand Kit fragments in the Users and
Billing markup were removed from the web overlay. Only Studio, Company
Settings, the app manifest, portal entry, the two new shared-library files,
and `release.env` changed in each immutable release. Compatibility used
hardlinks for unchanged files and distinct inodes for changed files.

JavaScript syntax and PHP lint passed for both overlays. A local visual
fixture confirmed that Company Settings and Doc Studio render the same
palette, logo, and font cards. Each development service passed exact-release
readiness with development data and outbound isolation after activation.
Six public readiness requests reached both web instances, all reporting
`b45ab00`. The public Brand Kit JavaScript and CSS, Studio, Company Settings,
and app-manifest files matched the staged SHA-256 hashes.

Rollback: restore web nodes to `4c059e5` and compatibility to `5685b86`,
restart the applicable web or legacy service and PHP-FPM, then check exact
readiness and development isolation. The autoscale image has not been
updated; replacement nodes need this verified UI overlay before serving it.
