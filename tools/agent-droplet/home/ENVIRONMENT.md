# Where you are running: the agent droplet fm-agents-1

Every agent tool on this machine (Claude Code, Codex, Antigravity) loads this file. It is
`/srv/agents/ENVIRONMENT.md`; the source is `tools/agent-droplet/home/ENVIRONMENT.md` in the FirstMeasure repo,
and the full reference is `docs/architecture/agent-droplet.md` there.

## FIRST RULE: never change files in the main clone
`/srv/agents/work/firstmeasure` is shared: the router branches every worker from it, and Jack opens sessions in
it. Read and look around there freely. Before you change any file, make your own worktree and work only there:

    git -C /srv/agents/work/firstmeasure fetch devpush
    git -C /srv/agents/work/firstmeasure worktree add -b claude/<slug> /srv/agents/work/<slug> devpush/codex/consolidated-firstmeasure-20260923
    cd /srv/agents/work/<slug> && fm-deps

(Codex: `codex/<slug>`, Antigravity: `agy/<slug>`.) Never edit, commit, reset, stash, pull or switch branches
in the main clone.

## The machine
- DigitalOcean droplet `fm-agents-1`, 67.205.145.222, NYC1: 8 dedicated vCPU, 32 GB RAM, Ubuntu 24.04. You are
  user `agent` (passwordless sudo). It is not Jack's PC; Jack watches from his PC.
- Disks: `/` 100 GB for the system; `/srv/agents` 500 GB for all work. Checkouts live in `/srv/agents/work`
  (`~/code`); the main clone is `/srv/agents/work/firstmeasure` (canonical branch). After making a worktree run
  `fm-deps` in it (links node_modules to a shared build).
- Can reach: GitHub, the dev push router (submit only), dev web's live layer, the internet.
  Root shells on the dev hosts with `fm-dev-host` (section below). Cannot reach: production (no key, VPC or
  secret), DigitalOcean's API. Never copy cluster keys, DigitalOcean tokens or production secrets here.
- `~/reference/synthesizer.js` (private to `agent`) is Jack's helper with model-provider API keys and call
  functions (Luna among them); use it to call those providers. Never print its keys or copy them anywhere:
  no commit, log, experiment, message or other file.

## Jack's PC and browsers
- Jack's PC home folder (`C:\Users\jackh`) is at `/mnt/jack-pc` while his tunnel is up (`sudo fm-jack-pc-mount
  status`). It disappears when his PC sleeps; do not depend on it for unattended work.
- Jack's own Chrome (signed in to his accounts: DigitalOcean, Google, GoDaddy, ...): Claude Code reaches it
  through the Claude in Chrome extension, as on his PC. Codex reaches Chrome only through the Codex app's Chrome
  plugin on his PC, not from the CLI. Antigravity's browser agent uses the Chrome on the machine it runs on.
  Prefer Jack's Chrome for anything that is his account.
- The droplet's own Chrome: a desktop (XFCE) that Jack opens with Chrome Remote Desktop, where he signs in
  logins agents use often. While that desktop runs, it listens for DevTools on 127.0.0.1:9222
  (Playwright `connectOverCDP`). Headless tests use Playwright's Chromium.

## How Jack starts each tool here
- Claude Code: desktop app, SSH session to `agent@67.205.145.222` (PC alias `fm-agents`).
- Codex: Codex app, Settings > Connections > SSH host `fm-agents`; or `ssh fm-agents` then `codex`.
- Antigravity: `ssh fm-agents` then `agy`; or the droplet's `agy remote-control` daemon, picked in his
  Antigravity app; or the Antigravity app on the droplet's desktop.

## Signed in on dev.1m8.ai (for testing)
- There is a dev test login: organization "Agent Test Co (fm-agents-1)", the sandbox "Instant full org"
  (every app on, demo data). `fm-dev-login` signs in and writes a Playwright storageState to
  `/srv/agents/secrets/dev-storage-state.json`; `fm-dev-login --check` also opens /portal/ headless to prove it.
  In Playwright: `browser.newContext({ storageState: "/srv/agents/secrets/dev-storage-state.json" })`
  (Chromium: `/srv/agents/cache/ms-playwright/chromium-*/chrome-linux64/chrome`). Sessions expire: re-run it.
- For work that changes a lot of data, make your own org: `fm-dev-login --new-org "<label>"` (its login and
  state go to `/srv/agents/secrets/dev-test-orgs/`). Other agents share the main org; don't delete their data.
- The login itself is `/srv/agents/secrets/dev-test-login.json`. Never print, commit or post it. Dev only.

## Changing defaults: the config library (dev)
- Templates, guided setups and their copy, flag defaults and presets, the scope library, terminology and every
  other default are data in the config library on dev, not code. Change them with
  `node tools/config-library/cli.mjs` (get, check, put, history, revert); a save is live on dev.1m8.ai within a
  second, with no commit, submit or rollout. Read the checkout's AGENTS.md section "Defaults are data".
- This machine already holds its dev key: `~/.config/firstmate/config-library-key` (mode 600, labelled
  `agents:fm-agents-1`); the CLI reads it by itself. Never ask anyone for a key, and never print, copy or commit it.
  If it is missing or revoked, run `sh tools/config-library/enroll.sh agents:fm-agents-1` from a checkout (it signs
  with `~/.ssh/fm_config_library_ed25519` and writes a fresh key). Dev only: production has no keys.

## Dev is down? Fix the hosts yourself (dev only)
- `fm-dev-host web|legacy|worker|sync [command]` opens a root shell (or runs one command) on a development host;
  `fm-dev-host list` shows them. `web` is whichever pool node is primary right now (read from the dev push router),
  so pool swaps never strand you. Key `~/.ssh/fm_devops_ed25519`: authorized on dev hosts only; never print or
  copy it, and never try it on anything else.
- Where things run: dev.1m8.ai -> load balancer `firstmeasure-development-lb` -> the autoscale web pool (1-2 nodes,
  replaced at any time). `/measure/internal/` and other PHP are proxied to `legacy`
  (firstmeasure-development-compatibility, private 10.124.16.5), whose PHP calls Node at
  `FIRSTMEASURE_API_BASE` (`/etc/php/8.3/fpm/pool.d/zz-firstmeasure-development-api.conf`). The `worker` runs
  automations. Logs: nginx `/var/log/nginx/`, PHP-FPM `/var/log/php8.3-fpm.log`, Node `journalctl`.
- `sync` is the dev sync droplet as user `dev` (not root): the dev push router lives in `~/dev-push` (state and
  `router.log` in `~/dev-push/state`, its git repo in `~/router/firstmeasure.git`). If shipping to dev is stuck,
  look there; fix it, don't route around it.
- You may diagnose and fix dev host configuration and services (nginx, PHP-FPM, env, restarts) without asking
  anyone: when dev is down, fixing it is your job, not a question for Jack. Keep a `.bak-<date>` of any file you
  change, prove the fix (the page loads with `fm-dev-login`'s state), and put the same change in the repo copy
  under `deploy/digitalocean/` with your commit. Never point anything at a web node's IP: nodes are replaced; use
  https://dev.1m8.ai.
- Still not yours: production (never), the pool's image, template, size or user data, droplets, the load
  balancer, firewalls and DNS (ask Jack), and releases (ship code only through the dev push router; never copy
  code onto a host by hand). Example: 2026-10-28 every editor page returned 503 "Staff access could not be
  verified" because the legacy PHP still called a retired web node's IP; the fix was one line in that conf.

## Shipping to dev (never production)
- Commit, `git fetch devpush && git rebase devpush/codex/consolidated-firstmeasure-20260923`, then
  `node tools/dev-push/submit.mjs --wait` (the router picks the lane: platform, measure-internal, ...).
- Fast frontend loop: `node tools/live-layer/live-sync.mjs` in a clean checkout; saves under `public/` are live
  on dev.1m8.ai in about a second, for everyone. Commit and submit when done.
- Repo rules are in the checkout's AGENTS.md. Read it before changing anything.

## FirstMate Tracker (tracker.1m8.ai): change and deploy it
- Separate repo: shared bare repo `/srv/agents/repos/firstmate-screen-recorder.git` (Jack's PC pushes there too),
  app in `tracker/`. Its `master` is what's deployable. The clone `/srv/agents/work/firstmate-tracker` is shared like
  the main clone: read there, but work in your own worktree:

      git -C /srv/agents/work/firstmate-tracker pull -q --ff-only
      git -C /srv/agents/work/firstmate-tracker worktree add -b tracker/<slug> /srv/agents/work/tracker-<slug> origin/master
      cd /srv/agents/work/tracker-<slug>     # change, test (cd tracker && npm install && node scripts/test-api.mjs), commit
      git fetch origin && git rebase origin/master && git push origin HEAD:master
      bash tracker/deploy/deploy-from-git.sh            # deploys origin/master; health-checked, rolls back by itself
      bash tracker/deploy/deploy-from-git.sh status     # live revision and health; also: history, rollback [tag]

- There is no staging: tracker.1m8.ai is the only instance and Jack uses it all day. Each deploy builds beside the
  live one, backs up the database, needs /healthz three times through Caddy and otherwise rolls back. Still: deploy
  only what you tested, and check the site after.
- The ssh alias `tracker-deploy` (key `~/.ssh/fm_tracker_deploy_ed25519`, never print or copy it) can only run
  deploy / rollback / status / history on the FirstLook droplet: no shell there, no FirstLook app or data. It can't
  deploy a change to `tracker/docker-compose.yml` (Jack must), and it won't replace a folder copy Jack deployed from
  his PC (uncommitted work) for 6 hours. Details: `tracker/README.md`, "Deploy".
- The tracker's routers, runner and titler run here from `~/.firstmate/` (`router.mjs`, `runner.mjs`, `titler.mjs`)
  as systemd user units `tracker-router@general`, `tracker-router@bugs`, `tracker-runner`, `tracker-titler`. They are
  not part of the deploy: copy the committed file in (keep a `.bak-<date>`), `systemctl --user restart <unit>`,
  check `journalctl --user -u <unit> -n 20`.

## Experiments
- `fm-experiment run <name> <port> -- <command>` (or `add <name> <port>` for something already running) serves
  https://<name>.experimental.1m8.ai with HTTPS and noindex. Listen on 127.0.0.1. Index:
  https://index.experimental.1m8.ai/. https://experimental.1m8.ai itself is the GEO experiment
  (`/srv/agents/experiments/geo`, service `firstmate-experiments`), with the game at `/workspace/game/`.

## Disk
- If `/srv/agents/status/disk-warning.txt` exists, a disk is over 80 %: free space before large work.
- Nightly at 04:15 UTC, logs older than 7 days and finished checkouts are deleted. A checkout is finished when it
  was untouched 12 h with nothing uncommitted and every commit pushed. Push your branch; put `.fm-keep` in a
  checkout to keep it.
