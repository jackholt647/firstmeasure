# Dev lanes and the dev push router

Status: agreed design (2026-10-27); router, platform lane and live bake-down built in `tools/dev-push/` (cutover pending). Development (dev.1m8.ai) only;
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
   any machine), rebased on the lane tip (`git fetch origin && git rebase
   origin/<lane branch>`).
2. `node tools/dev-push/submit.mjs [--lane platform|measure-internal] [--title ...]
   [--tests a,b] [--wait]` pushes a *submission commit* to
   `refs/heads/queue/<lane>/<agent>-<slug>` on origin. It has the same tree as
   `HEAD`, exactly one parent (`HEAD`, your work) and the manifest (lane, agent,
   title, tests, session, lane tip seen) as its message; the router merges the
   parent, so manifests never reach a lane branch. The lane is picked from the
   changed paths when `--lane` is omitted; a submission spanning two code lanes
   is refused. Submitting the same slug again replaces the queued entry.
   `<agent>` is the Claude or Codex session id (`DEV_PUSH_AGENT` overrides).
3. The router answers in its status document: `queued`, `merging`, `testing`,
   `rolling-out`, `live <release>`, or `rejected <reason>` (`conflict`,
   `gate-failed`, `out-of-lane`, `deploy-failed`, `unrelated-history`) with the
   conflicting files or the failing gate's output. `--wait` blocks until `live`
   or `rejected` (exit 0 / 1); `submit.mjs status [--mine]`, `submit.mjs wait
   [<slug>]` and `submit.mjs withdraw [<slug>]` do what they say.

Status document (v1): `https://dev.1m8.ai/__dev-push/status.json`, also
`/opt/firstmeasure/dev-push/status.json` on dev web (for the dev console's
server route) and `~/dev-push/state/status.json` on the droplet. It holds the
router (`paused`, version), each lane (`state`, `tip`, current `release`,
`batch`, `note`), the last 200 submissions and the last 50 releases.

Agents never push canonical or a lane branch directly, never SSH to activate a
release, never write a per-task rollout script and never commit a rollout
record to canonical. Rejected? Rebase onto the lane tip and submit again.

## The router

`tools/dev-push/router/` on the dev sync droplet, user `dev`, state in
`~/dev-push` (`repo.git` bare clone, `state/`, `cache/`, `builds/`, `app/` = the
router's own code). Cron starts it every minute unless the running one holds
its lock (`router/install-droplet.sh`; the account has no lingering systemd
session), so a reboot costs at most a minute. It fetches over HTTPS and pushes
with its own deploy key (`~/.ssh/dev_push_router_ed25519`, write access to this
repository only).

Each lane runs its own loop; inside a lane, submissions are taken in submission
order, up to `batchMax` at a time (`router/router.mjs`):

1. Reject what cannot go: work sharing no history with the lane, or touching a
   path another lane owns (`lib/common.mjs` `LANES`). Work already in the lane
   is marked live.
2. Merge each onto the lane tip (`--no-ff`, one merge commit per submission). A
   conflict rejects that submission with its files; the rest continue.
3. Gates on the merged tree. On failure the batch is bisected so only a
   submission that fails on its own is rejected; a failure the lane tip itself
   already has is not the submitter's (the tip is re-run for just those gates).
4. Platform only: merge the live overlays (below).
5. Check the lane branch has not moved, deploy (the lane module), fast-forward
   the lane branch to the released commit, record the release
   (`state/releases/<id>.json`, the status document), retire the queue refs.

A deploy that fails for a single submission and rolls back rejects it
(`deploy-failed`); any other deploy failure pauses the lane with the reason in
its `note`, keeps the queue, and waits for a person
(`node tools/dev-push/router/server.mjs resume <lane>`). Diagnostics that touch
no queue: `server.mjs gate <ref> --changed a,b`, `server.mjs build <ref>`;
also `server.mjs once [<lane>]` and `server.mjs pause <lane>`.

### Platform lane

`lanes/platform/lane.mjs`. **Gates:** a full `tsc -p tsconfig.json` build of
`public/v1` (type check and the `dist` that ships, cached per git tree),
`node --check` on changed browser scripts, and the tests the changed paths map
to (`lanes/platform/test-map.mjs`, kept in step with AGENTS.md; test files
that changed and tests named with `--tests` run too; at most 40). Tests that
need a browser are skipped on the droplet (no Chromium; run them before you
submit) and PHP is not linted there. A typical gate takes about two minutes.

**Release:** one immutable tree per lane commit: `git archive` of the merged
commit, `public/v1/dist` from the gate's build, `public/v1/node_modules` from
`npm ci` (cached per `package-lock.json`), `release.env`
(`RELEASE_ID`/`RELEASE_COMMIT` = the commit, `DEV_PUSH_RELEASE` = the router's
release id). Nothing comes from a host's current files. Every file's sha256
goes in a manifest whose digest is the release's full-tree hash.

**Activation:** the same tree goes to web, worker and legacy at once
(`router/hosts.mjs`): `rsync` into `<releases root>/<commit>.staging`
(unchanged files hard-linked to the running release), `fm-release finish`
checks the staged tree is exactly the manifest and carries the running
release's runtime data (`public/storage`, `public/v1/storage`), then
`fm-release activate` runs on every role together: switch `current`, restart
the role's services (web; worker, platform worker, payment browser; legacy)
and reload PHP, wait for readiness (the old deploy script's checks), and
finally `https://dev.1m8.ai/v1/health/ready` must report the commit twice. Any
role not ready rolls every role back. Old release directories are pruned
(newest 10 and anything under 3 days kept).

**Hosts belong to the router.** `tools/dev-push/host/fm-release.py` is
installed as `/usr/local/sbin/fm-release` on each role (`host/install.sh`); the
router's key is in root's `authorized_keys` with
`restrict,command="/usr/local/sbin/fm-release ssh"`, so it can upload into a
staging directory and run fm-release, nothing else. After the re-baseline,
`/opt/firstmeasure` is immutable (`fm-release seal on`): only fm-release
switches `current`, and the old per-task scripts fail at their first upload.

### Adding a lane

A lane is `tools/dev-push/lanes/<lane>/lane.mjs` plus an entry in `LANES`
(`lib/common.mjs`: its branch and the paths it owns). The module default-exports
`{ name, branch, batchMax, owns(path), gates({ dir, sha, baseSha, changed,
tests, only, log }) -> { ok, failures: [{ id, output }] }, deploy({ dir, sha,
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

Served from `/opt/firstmeasure/lanes/measure-internal/current` on dev legacy.
The lane release mirrors the `public/` layout so the editor's relative includes
(`__DIR__ . '/../../portal/...'`, `'/../../v1/storage/...'`) resolve into the
platform release through symlinks; the platform release's own copy of those
paths is not served on dev while the lane is active. Responses carry
`X-FirstMate-Lane: measure-internal <sha>`. The lane branch and canonical are
merged into each other on request when work is quiet; they rarely overlap
(since Oct 1, a handful of commits also touched `public/v1/firstmeasure`,
`public/libraries/apps` or `public/v1/platform`; those parts ship on
`platform`).

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
