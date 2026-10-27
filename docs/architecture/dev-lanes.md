# Dev lanes and the dev push router

Status: agreed design (2026-10-27), being built. Development (dev.1m8.ai) only;
production is a separate scope and nothing here changes how production ships.

## Why

Today every task copies its own `rollout.py`/`deploy.py` into `output/<task>/`
(about 660 copies), three-way merges its files onto whatever each dev host is
currently running, skips the type check, and races other agents: retries, half
activated roles (`output/pdf-copy-20261027/ship.log`), overlays dropped as
`conflict`, and a "record the rollout" commit on canonical for every task.
Agents spend more time shipping than writing. Templates and other configuration
ride the same path although they are data.

## Four lanes

A **lane** is a channel to dev with its own source, its own target and its own
release pointer. Lanes never wait on each other.

| Lane | Owns | Source of truth | Target on dev | Speed |
|---|---|---|---|---|
| `config` | defaults and libraries: flags, presets, tab/app media, guided setups and tutorials, document/workflow/presentation/form templates, scope library, measurement and work dictionaries, rule and terminology defaults, price book setups, sandbox configurations | the platform config library store on dev (data, no git) | read live by every dev web/worker process | instant |
| `live` | browser files under `public/` except `public/v1`, `.php`, `.html` | the saving checkout, shadowed to git (below) | dev web live folder | ~1 s |
| `measure-internal` | `public/measure/internal/**` and its own tests (the editor's `dev/*.test.cjs`) | branch `lane/measure-internal` on origin | dev legacy host only (dev web proxies `/measure/internal/` there) | ~1 min |
| `platform` | everything else | branch `codex/consolidated-firstmeasure-20260923` on origin ("canonical") | all dev roles (web, worker, legacy, pool) | batched, minutes |

Rule of thumb for agents: data that differs per organization is `config`, a
browser file you are tuning is `live`, the measure editor is `measure-internal`,
anything else is `platform`.

## Submitting code (platform and measure-internal)

1. Commit on your own branch, in your own worktree or clone (Codex or Claude,
   any machine).
2. `node tools/dev-push/submit.mjs --lane <platform|measure-internal> [--wait]`
   pushes `HEAD` to `refs/heads/queue/<lane>/<agent>-<slug>` on origin with a
   short manifest (title, tests to run, author session).
3. The router answers on the same ref's status record: `queued`, `merging`,
   `testing`, `rolling-out`, `live <release>`, or `rejected <reason>` with the
   conflicting files or failing gate. `--wait` blocks until one of the last two.

Agents never push canonical or the lane branch directly, never SSH to activate
a release, never write a per-task rollout script and never commit a rollout
record to canonical. Rejected? Rebase onto the lane tip and submit again.

## The router

One always-on process on the dev sync droplet (not a laptop session: local
sessions stop when the PC sleeps). Lanes are processed independently; inside a
lane, submissions are taken in order and may be batched (merge N, gate once,
bisect on failure).

Per batch: merge onto the lane tip (fast, no human) → gates (platform:
`npm run check` plus the tests the changed paths map to; measure-internal: its
`dev/*.test.cjs` and PHP lint) → build one immutable release from the merged
tree, never from a host's current files → activate every role of that lane
together with readiness checks and rollback → advance the lane branch
(fast-forward only) → write the release record outside canonical (router log
and a `dev-releases` record store) → retire queue refs.

Hosts belong to the router. A dev host activates only a release the router
built (activation requires the router's token), so the drift that forced
three-way merges cannot come back. The full-tree hash of every role is recorded
per release.

## Live layer bake-down

Each accepted live save is also committed by the receiver to
`refs/heads/live/<owner>` on top of the base it was edited from. On every
platform release the router merges those shadow branches into the batch: clean
merges go in without a model, real conflicts are handed to a reviewing model,
then the overlay retires as `released`. An overlay is never silently dropped
as `conflict` again.

## measure-internal lane

Built 2026-10-27; setup record:
[development-measure-internal-lane-20261027](../../deploy/digitalocean/development-measure-internal-lane-20261027.md).
Code: `tools/dev-push/lanes/measure-internal/` (`lane.mjs`: the router's lane
module and the direct `deploy(sha)`; `ship.mjs` CLI; `lane-host.sh` host side
of the direct path). Tests:
`tests/dev-lane-measure-internal.test.mjs`.

**Owns** `public/measure/internal/**` (deployed) and `dev/**` (the editor's
tests and tooling; gates only). Anything else in a lane commit is refused and
ships on `platform`: language catalogs (`public/libraries/platform-language`)
for new editor copy, `public/v1/**`, `public/libraries/**`, `public/portal/**`.

**Target.** Dev legacy serves the editor (through the router, dev web also
holds the release for server-rendered PDFs; see below). Dev web proxies `/measure/internal/` there (its
live-layer location never sees those paths). On dev legacy the site's `root` is
`$fm_public_root`, a map in `/etc/nginx/conf.d/firstmeasure-lanes.conf`:
`/measure/internal/...` resolves to
`/opt/firstmeasure/lanes/measure-internal/current/public`, everything else to
`/opt/firstmeasure/current/public`. Every other location (PHP, `try_files`
fallbacks, health) is unchanged. A second map turns `$realpath_root` into the
response header `X-FirstMate-Lane: measure-internal <sha>`.

**Release layout.** `releases/<sha>/public/measure/internal` holds the commit's
files; every sibling (`public/portal`, `public/v1`, `public/includes`,
`public/libraries`, `public/storage`, `public/measure/sales`, ...) is a symlink
into `/opt/firstmeasure/current/public`. PHP gets `SCRIPT_FILENAME` from
`$realpath_root`, so `__DIR__` is the lane release and the editor's relative
includes (`dirname(__DIR__, 2) . '/includes/...'`, `'/../../portal/...'`) and
its storage (`public/storage/measure/internal`) reach the platform release that
is current, exactly as before. Siblings are relinked on every lane deploy; a
new top-level entry in a platform release appears in the lane at its next
deploy (the editor reaches none today). PHP's realpath cache can keep resolving
a sibling to the previous platform release for up to two minutes after a
platform activation.

**Checks and tests.** Every ship runs the quick checks (`quickChecks`):
`php -l` of the changed PHP and `node --check` of the changed JavaScript under
`public/measure/internal` (not `unused/` or `editor_scripts/vendor/`), about
0.3 s for a one-file change. The editor's regression tests (`dev/*.test.cjs`,
835 tests, about 100 s on a 22-core PC and much longer on the 2-CPU droplet,
most of them Playwright) run only when a ship asks (`--regression` or
`--regression=all`, which the router passes to `gates` as `regression`), once, on
the server, never on a laptop (`runRegression`): the tests the change maps to
(changed tests, and tests that name a changed file's basename) or all of them,
each in its own `node --test` process from a `git archive` of the commit (plus
any `public/...` file a selected test names) with `public/v1/node_modules`
linked in. Several editor tests name only the Windows Chrome path; off Windows
the extracted tree gets that relative path as a link to the server's Chromium.
A test that also fails on the live release is reported as known and does not
block; results on a release are cached in `.git/fm-lane-base-results.json`.

**Through the router** (the default export of `lane.mjs`, the router's lane
interface): `gates({ dir, sha, baseSha, regression })` runs the quick checks
(`node --check`; the router host has no php) and, when asked, the regression
tests. `deploy({ dir, sha, hosts })` builds the tree (`buildTree`: the commit's
`public/measure/internal`, every sibling a symlink to
`/opt/firstmeasure/current/public/<name>`), stages it with `hosts.stage` on dev
legacy, web and worker, lints the changed PHP inside the staged release on
legacy (`hosts.check`), activates the three, checks that dev.1m8.ai serves a
changed file with its bytes and the lane header, and rolls every role back
otherwise. Both return `timings` (ms per step and role) for the release record.
`current({ hosts })` reports each role. On web and worker the release is not
served: their Node reads `editor_scripts/pdf.js` and `pdf_standalone.js`
(`pdf_runtime.ts`) and the Google key in `editor.php` (`forms/solar.ts`) from
it, through `FIRSTMEASURE_EDITOR_RUNTIME_ROOT=/opt/firstmeasure/lanes/measure-internal/current/public/measure/internal`
in the router's `release.env`. Both fall back to the platform copy when the
path is missing; `pdf_runtime.ts` reads the files at each render, so a lane
switch needs no restart.

**Direct, until the router owns the lane** (`deploy(sha, { cwd, log, host })`,
called by `ship.mjs`):

1. Read the host status (live lane release, serving lane or platform).
2. Quick checks.
3. Manifest: sha256 of every deployed file from git blobs (`core.autocrlf`
   off, so the commit's bytes, never a working copy or a host file).
4. One SSH stream: a tar with `lane-host.sh`, the manifest and the changed
   files. The host hard-links the live release, writes the changed files,
   deletes what the commit deleted, checks every file against the manifest
   (any mismatch: the client resends every file), lints changed PHP with
   `php -l`, links the siblings, and swaps `current` with a rename.
5. Readiness: a changed static file (or `audio/ding.mp3`) comes back with the
   manifest's bytes and the new lane header; `/measure/internal/`,
   `editor.php` and `backend_login.php` answer with the statuses they had
   before the switch (never 5xx). Otherwise `current` is swapped back.
6. A record is written to `/opt/firstmeasure/lanes/measure-internal/records/`
   and returned. Twelve releases are kept, plus `current` and `previous`.

`ship.mjs` adds the branch step (`laneCommit` in `lane.mjs`). It takes the
editor from any commit: a commit on the lane tip that changes only lane paths
ships as is; otherwise `git merge-tree` merges the commit with the lane tip and
a new single-parent commit on the tip takes only `public/measure/internal` and
`dev` from the result (other paths stay as on the lane; they ship on
`platform`). A conflict in a lane path is refused. After a live deploy
`lane/measure-internal` on origin is fast-forwarded (`--force-with-lease`); a
refused push rolls the host back. One deploy at a time (host `flock`). In a
checkout that has the router's `tools/dev-push/submit.mjs`, `ship.mjs` submits
to the router instead (`FM_LANE_DIRECT=1` forces the direct path).

Measured on 2026-10-27 with the regression tests still in every ship: 34-110 s
from command to live, of which the tests took 22-88 s and the host build and
switch 0.6 s. Without them a direct ship is the SSH round trips plus about a
second.

**Follow mode.** `ship.mjs follow` points `current` at
`releases/platform-follow`, whose `public/` entries (`measure/` included) are
all symlinks into `/opt/firstmeasure/current/public`. nginx is unchanged, but
the bytes and PHP (`__DIR__` resolves into the platform release) are the
platform release's, so platform releases and old per-task rollouts of editor
files show at once. For the hand-over while some sessions still ship editor
files the old way. A later lane deploy never hard-links from, or writes
through, a follow release. Responses carry no lane header in follow mode.

**What reads editor files outside the editor.** `pdf_runtime.ts` and
`forms/solar.ts` (above). `firstmeasure/api.ts` and `queue.ts` read untracked
`config/` and `storage/` under the platform's `measure/internal`, which editor
work does not change.

**Branches.** `lane/measure-internal` started at canonical `490c0b26`. The lane
and canonical are merged into each other on request when work is quiet; until
canonical has a lane commit, a platform release still carries the older editor
files, unserved on dev.

**Switch back** to the platform copy: `node tools/dev-push/lanes/measure-internal/ship.mjs uninstall`
(comments out the `/measure/internal/` line of the map and reloads nginx);
`install` turns the lane on again. `rollback [<sha>]` returns to the previous
(or named) lane release.

Old per-task rollouts that copy editor files into the platform release on dev
legacy still succeed but are not served while the lane is active.

## Config lane

Defaults are data in a platform-level library on dev, versioned with author,
time and revert, validated on save against the registries the running code
publishes (providers, actions, widgets, measurement keys). Code only reads it.
Orgs get copies as today: a default reaches an org that has not changed its
copy; an org that has can be reset to the library from the dev console. Each
test org keeps the flags and settings it started with so the dev console can
restore them in one click. A generated snapshot of the library is checked in
for fresh databases and tests; it is produced from the store, never edited.

## Dev console

One right-side tray over every dev page, folding to a 20 px strip. It holds
every development control: synthetic data, software layers, guided experience
tools (the current GX pill), test-run controls, flags and initial-state
restore, the config library, live-layer status and the router queue. Visible
only to the existing development tools audience on the development data
environment.
