# Dev lanes and the dev push router

Status: agreed design (2026-10-27); in service since the cutover of 2026-10-27 (canonical `0c374e3c`: every dev role rebuilt from git; proven with concurrent submissions, a rejected conflict and a live overlay surviving a release). The old-script refusal (`fm-release guard on`) waits for the coordinator. Development (dev.1m8.ai) only;
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

The router's own repository on the dev sync droplet,
`dev-sync-droplet:/home/dev/router/firstmeasure.git`, is the source of truth
for canonical, the lane branches, the live shadow branches and the queue.
`submit.mjs` adds it to a checkout as the remote `devpush`. GitHub
(`origin`) is a backup mirror: after every submission `submit.mjs` starts
`tools/dev-push/mirror.mjs` in the background, which pushes the router's
branches to GitHub with the PC's own login and is never waited for. The
droplet holds no GitHub credential.

1. Commit on your own branch, in your own worktree or clone (Codex or Claude),
   rebased on the lane tip: `git fetch devpush && git rebase
   devpush/<lane branch>`.
2. `node tools/dev-push/submit.mjs [--lane platform|measure-internal] [--title ...]
   [--regression[=all]] [--wait]` pushes a *submission commit* to
   `refs/heads/queue/<lane>/<agent>-<slug>` in the router's repository. It has
   the same tree as `HEAD`, exactly one parent (`HEAD`, your work) and the
   manifest (lane, agent, title, regression, session, lane tip seen) as its
   message; the router merges the parent, so manifests never reach a lane
   branch. The lane is picked from the changed paths when `--lane` is omitted;
   a submission spanning two code lanes is refused. Submitting the same slug
   again replaces the queued entry. `<agent>` is the Claude or Codex session id
   (`DEV_PUSH_AGENT` overrides).
3. The router answers in its status document: `queued`, `merging`, `testing`,
   `rolling-out`, `live <release>`, or `rejected <reason>` (`conflict`,
   `gate-failed`, `out-of-lane`, `policy`, `deploy-failed`,
   `unrelated-history`) with the conflicting files or the failing check's
   output, what to do next, and the time each stage took. `--wait` blocks until
   `live` or `rejected` (exit 0 / 1). `submit.mjs status [--mine]`,
   `submit.mjs wait [<slug>]` and `submit.mjs withdraw [<slug>]` do what they
   say.

The repository's hook accepts only queue refs from agents; everything else is
moved by the router (locally, `DEV_PUSH_ROUTER=1`). A push of canonical or a
lane branch is refused with a pointer to `submit.mjs`.

Status document (v1): `https://dev.1m8.ai/__dev-push/status.json`, also
`/opt/firstmeasure/dev-push/status.json` on dev web (for the dev console's
server route) and `~/dev-push/state/status.json` on the droplet. It holds the
router (`paused`, version), each lane (`state`, `tip`, current `release`,
`batch`, `note`), the last 200 submissions and the last 50 releases (with
per-stage `timings` in ms).

Agents never push canonical or a lane branch, never SSH to activate a release,
never write a per-task rollout script and never commit a rollout record
(`deploy/digitalocean/development-*.md`; the router refuses them).

### Checks: always on, or opt-in regression

Jack's rule: a check runs on every submission only if its whole run takes a
second or two. Anything with a real time or CPU cost is **opt-in regression**:
`submit.mjs --regression` (the suites the changed areas map to;
`--regression=all` for every suite) or `submit.mjs regression [--all]`, which
runs them on the server without shipping. It runs once, on the server, never on
a PC; agents do not run suites locally first. Ask for it only when you suspect
a bug, when Jack asks, or when the work behind the submission took about 20
minutes or more. Browser files (`public/` outside `public/v1`, not PHP or HTML),
templates and live overlays get no checks beyond a syntax parse of changed
JavaScript; a live save gets none at all.

Measured on the droplet (2 vCPU, 2026-10-27):

| Check | Time | When |
|---|---|---|
| Dependencies when `package-lock.json` and Node are unchanged (hash + link) | 0.02 s | always (when needed) |
| `npm ci`, cold | 10 s | only when the lockfile or Node changed |
| `node --check` of a changed script | 0.03 s per file | always |
| Per-file transpile of a changed `.ts` | 0.3 s per file | always (platform) |
| `php -l` of changed PHP (on a dev host, the droplet has no PHP) | < 1 s | always |
| Type check (`npm run check`, `tsc --noEmit`) | 51 s full; 57 s incremental after a one-file change | regression |
| Release `dist` (per-file transpile, cached by content) | seconds; 0 s when `public/v1` is unchanged | every platform release |
| Each suite AGENTS.md names under "Run ... for changes here" | 0.3 s to 50 s each (table below) | regression, except those under 2 s |
| Measure editor `dev/*.test.cjs` | ~100 s on a 22-core PC, much longer on the droplet | regression |

Suites under two seconds on the droplet run whenever a change maps to them;
every other suite is regression only. The list is `ALWAYS` in
`tools/dev-push/lanes/platform/test-map.mjs` (re-measure with
`tools/dev-push/router/measure.sh` on the droplet).

| Suite (droplet, one at a time) | Time | Exit | Runs |
|---|---|---|---|
| `tests/route-access.test.ts` | 7.2 s | fails on the droplet | regression |
| `tests/document-as-sent-editing.test.ts` | 11.0 s | ok | regression |
| `tests/app-experience.test.ts` | 11.4 s | ok | regression |
| `tests/app-experience-registry.test.ts` | 0.3 s | ok | always |
| `tests/access-gates.test.ts` | 49.7 s | ok | regression |
| `tests/contacts-store.test.ts` | 3.4 s | ok | regression |
| `tests/contact-merge.test.ts` | 5.4 s | ok | regression |
| `tests/lead-receive.test.ts` | 4.6 s | ok | regression |
| `tests/new-leads.test.ts` | 6.5 s | ok | regression |
| `tests/project-entry.test.ts` | 0.5 s | ok | always |
| `tests/publication-measurement-schemas.test.ts` | 2.9 s | ok | regression |
| `tests/crm-views.test.ts` | 13.2 s | ok | regression |
| `tests/crm-rescission.test.ts` | 0.5 s | ok | always |
| `tests/labor-completion.test.ts` | 5.7 s | ok | regression |
| `tests/labor-pay-sheets.test.ts` | 4.3 s | ok | regression |
| `tests/pay-rules.test.ts` | 8.1 s | ok | regression |
| `tests/pay-sources.test.ts` | 9.1 s | ok | regression |
| `tests/labor-commitments.test.ts` | 6.7 s | ok | regression |
| `tests/assignee-base.test.ts` | 6.2 s | ok | regression |
| `tests/assignee-roster.test.ts` | 0.7 s | ok | always |
| `tests/assignee-base-store.test.ts` | 2.9 s | ok | regression |
| `tests/branches.test.ts` | 5.7 s | ok | regression |
| `tests/organization-structure.test.ts` | 2.7 s | ok | regression |
| `tests/work-requirements.test.ts` | 7.0 s | ok | regression |
| `tests/project-history.test.ts` | 4.1 s | ok | regression |
| `tests/documents-versions.test.ts` | 16.6 s | fails on the droplet | regression |
| `tests/document-signing.test.ts` | 10.5 s | fails on the droplet | regression |
| `tests/schedule-events.test.ts` | 0.5 s | ok | always |
| `tests/scheduling-event-writes.test.ts` | 46.7 s | fails on the droplet | regression |
| `tests/automation-contracts.test.ts` | 16.6 s | ok | regression |
| `tests/agent-how-to-index.test.ts` | 8.1 s | ok | regression |
| `tests/guided-experiences.test.ts` | 3.2 s | ok | regression |
| `tests/guided-experiences-dev.test.ts` | 3.2 s | ok | regression |
| `tests/pricebook-roofing-setup.test.ts` | 4.9 s | ok | regression |
| `tests/guided-tab-tours.test.ts` | 3.3 s | ok | regression |
| `tests/realtime-single-stream.test.ts` | 11.6 s | fails on the droplet | regression |
| `tests/session-replay.test.ts` | 13.3 s | ok | regression |
| `tests/session-replay-archive.test.ts` | 7.6 s | ok | regression |
| `tests/session-replay-agent-access.test.ts` | 7.0 s | ok | regression |
| `tests/forms-api.test.ts` | 34.4 s | ok | regression |
| `tests/view-presence-client.test.mjs` | 0.8 s | ok | always |
| `npm run test:payments` | 149.8 s | fails on the droplet | regression |
| `npm run test:publication` | 185.5 s | fails on the droplet | regression |
| `localization-catalogs --check` | 6.8 s | fails on the droplet | regression |
| `root tests/live-layer.test.mjs` | 2.6 s | ok | regression |
| `root tests/frontend-bridge.test.mjs` | 1.6 s | ok | always |

A suite marked "fails on the droplet" also fails on canonical there (no Chrome, no PHP, or a
pre-existing failure); the router does not count a failure the lane tip already has.

## The router

`tools/dev-push/router/` on the dev sync droplet, user `dev`, state in
`~/dev-push` (`repo.git` working clone, `state/`, `cache/`, `builds/`, `app/` =
the router's own code); its repository is `/home/dev/router/firstmeasure.git`
(`router/install-repo.sh`). Cron starts it every minute unless the running one
holds its lock (`router/install-droplet.sh`; the account has no lingering
systemd session), so a reboot costs at most a minute. A platform release that changes
`tools/dev-push/` moves the router's code to that release and restarts it; if the new
code will not start, `router/install-droplet.sh update <good sha>` puts it back.

Each lane runs its own loop; inside a lane, submissions are taken in submission
order, up to `batchMax` at a time (`router/router.mjs`):

1. Reject what cannot go: work sharing no history with the lane, touching a
   path another lane owns (`lib/common.mjs` `LANES`), or adding a rollout
   record. Work already in the lane is marked live.
2. Merge each onto the lane tip (`--no-ff`, one merge commit per submission). A
   conflict rejects that submission with its files; the rest continue.
3. Checks on the merged tree. On failure the batch is bisected so only a
   submission that fails on its own is rejected; a failure the lane tip itself
   already has is not the submitter's (the tip is re-run for just those checks).
4. Platform only: merge the live overlays (below).
5. Check the lane branch has not moved, deploy (the lane module), fast-forward
   the lane branch to the released commit, record the release
   (`state/releases/<id>.json`, the status document), retire the queue refs.
   If the branch cannot be advanced, the lane holds until it can, so the next
   release cannot drop this one's work.

Every stage is timed (queue wait, merge, each check, dependencies, dist, tree
build, transfer and activation per role, public readiness, push) into the
release record and each submission's status entry; `submit.mjs --wait` prints
them.

A deploy that fails for a single submission and rolls back rejects it
(`deploy-failed`); any other deploy failure pauses the lane with the reason in
its `note`, keeps the queue, and waits for a person
(`node tools/dev-push/router/server.mjs resume <lane>`). Regression runs
(`queue/regression/*`) are taken one at a time beside the lanes and end
`passed` or `failed`; they never ship. Diagnostics that touch no queue:
`server.mjs gate <ref> --changed a,b`, `server.mjs build <ref>`,
`server.mjs stage <ref>` (build and stage on every role, no activation),
`server.mjs release [<lane>]` (deploy the lane tip as it stands), `server.mjs
once [<lane>]`, `server.mjs pause|resume <lane>`.

### Platform lane

`lanes/platform/lane.mjs`. **Release:** one immutable tree per lane commit:
`git archive` of the merged commit, `public/v1/dist` (every TypeScript file
transpiled on its own, as dev has always shipped, cached by content and by the
`public/v1` tree), `public/v1/node_modules` (cached per lockfile and Node
version), `release.env` (`RELEASE_ID` = the release directory name: the commit,
or `<commit>-dp` beside a directory of that name made by the old tooling;
`RELEASE_COMMIT`; `DEV_PUSH_RELEASE`; and
`FIRSTMEASURE_EDITOR_RUNTIME_ROOT`, which points every role's PDF runtime at
the measure-internal lane). Nothing comes from a host's current files. Every
file's sha256 goes in a manifest whose digest is the release's full-tree hash.

**Activation:** the same tree goes to web, worker and legacy at once
(`router/hosts.mjs`): `rsync` into `<releases root>/<release>.staging` (owned
by `firstmeasure` like every release before it; unchanged files hard-linked to
the running release), `fm-release finish` checks the staged tree is exactly the
manifest and carries the running release's runtime data (`public/storage`,
`public/v1/storage`), changed PHP is linted on legacy (`fm-release check`), then
`fm-release activate` runs on every role together: switch `current`, restart
the role's services (web; worker, platform worker, payment browser; legacy)
and reload PHP, wait for readiness (the old deploy script's checks), and
finally `https://dev.1m8.ai/v1/health/ready` must report the release twice. Any
role not ready rolls every role back. Old release directories are pruned
(newest 10 and anything under 3 days kept).

**Hosts belong to the router.** `tools/dev-push/host/fm-release.py` is
installed as `/usr/local/sbin/fm-release` on each role (`host/install.sh`); the
router's key is in root's `authorized_keys` with
`restrict,command="/usr/local/sbin/fm-release ssh"`, so it can upload into a
staging directory and run fm-release, nothing else. After the re-baseline
`fm-release guard on` seals `/opt/firstmeasure` (only fm-release switches
`current`; the old per-task scripts fail at their first upload) and shows
every SSH client a banner naming `submit.mjs`.

### Adding a lane

A lane is `tools/dev-push/lanes/<lane>/lane.mjs` plus an entry in `LANES`
(`lib/common.mjs`: its branch and the paths it owns). The module default-exports
`{ name, branch, batchMax, owns(path), gates({ dir, sha, baseSha, changed,
tests, regression, only, log }) -> { ok, failures: [{ id, output }] }, deploy({ dir, sha,
releaseId, previous, hosts, log }) -> { ok, roles } | { ok: false, error,
rolledBack }, current({ hosts }) }`. `dir` is a clean worktree of the merged
commit. `hosts` (`router/hosts.mjs`) stages a tree on a role
(`stage(role, { lane, sha, dir, manifest, releases })`), activates, rolls back
and reports status; a lane other than `platform` switches
`/opt/firstmeasure/lanes/<lane>/current` with its releases in
`/opt/firstmeasure/lanes/<lane>/releases`. Lane modules hold no keys or host
addresses.

## Live layer bake-down

The receiver on dev web keeps every accepted save's bytes in a journal, records
the release each edit was made against, and **parks** an overlay whose file a
release changed under it instead of dropping it (dev serves the release copy
meanwhile). Before every platform batch the router exports the layer
(`router/live.mjs`) and commits each owner's overlays to
`refs/heads/live/<owner>` (one commit per file, parented on the release the
edit was made against and dated by the save, so an unchanged layer yields the
same commits), then merges those branches into the batch after the queued
work. A parked overlay triggers a release on its own; live ones ride along
with the next one. A clean merge needs no model; a conflict goes to a
reviewing model (Claude Code on the droplet, editing only the conflicted
regions); if that fails, or the overlay fails the gates, the release goes out
without it and the overlay stays live or parked, listed in
`state/live-problems.json` and the lane's `note`. After the release the
receiver is told which bytes it now has; those retire as `released`. An owner
who keeps editing after their save was released continues on top of the
release without updating their checkout.

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
otherwise. Both return flat `timings` (ms per step, `transfer:<role>`,
`activate:<role>`) for the release record.
`current({ hosts })` reports each role. On web and worker the release is not
served: their Node reads `editor_scripts/pdf.js` and `pdf_standalone.js`
(`pdf_runtime.ts`) and the Google key in `editor.php` (`forms/solar.ts`) from
it, through `FIRSTMEASURE_EDITOR_RUNTIME_ROOT=/opt/firstmeasure/lanes/measure-internal/current/public/measure/internal`
in the router's `release.env`. Both fall back to the platform copy when the
path is missing; `pdf_runtime.ts` reads the files at each render, so a lane
switch needs no restart.

**Shipping from any branch** (`ship.mjs`). Editor work is often committed on
canonical, whose history the lane branch does not have; the router would merge
that history onto the lane. So `ship.mjs` builds the lane commit itself
(`laneCommit`): a commit on the lane tip that changes only lane paths ships as
is; otherwise `git merge-tree` merges it with the lane tip, from the newest
commit in the source's history whose lane paths equal the lane tip's (else the
source a lane commit last recorded, else the usual merge base), and a new
single-parent commit on the tip takes only `public/measure/internal` and `dev`
from the result. A second edit of the same lines, or a revert, therefore
arrives as a change, and other paths stay as on the lane (they ship on
`platform`). A conflict in a lane path is refused. The commit goes to the
router with the router's own `submit.mjs` (this checkout's, or canonical's read
from the router repository), run in a temporary worktree whose index matches
the commit with every file marked skip-worktree, so nothing is checked out and
it works from a checkout that does not have the router's tools. Measured on
2026-10-28 from the shared checkout: 28-35 s from command to live (router
batch about 12 s).

**Direct, emergencies only** (`FM_LANE_DIRECT=1 ship.mjs`, which calls
`deploy(sha, { cwd, log, host })`; the router owns the lane's hosts):

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

After a live direct deploy `lane/measure-internal` on the router's remote
(`devpush`) is fast-forwarded (`--force-with-lease`); a refused push rolls the
host back. One direct deploy at a time (host `flock`).

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
