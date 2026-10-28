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
  Cannot reach: production (no key, VPC or secret), dev host shells, DigitalOcean's API. Never copy cluster
  keys, DigitalOcean tokens or production secrets here.
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

## Shipping to dev (never production)
- Commit, `git fetch devpush && git rebase devpush/codex/consolidated-firstmeasure-20260923`, then
  `node tools/dev-push/submit.mjs --wait` (the router picks the lane: platform, measure-internal, ...).
- Fast frontend loop: `node tools/live-layer/live-sync.mjs` in a clean checkout; saves under `public/` are live
  on dev.1m8.ai in about a second, for everyone. Commit and submit when done.
- Repo rules are in the checkout's AGENTS.md. Read it before changing anything.

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
