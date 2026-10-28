# Agent droplet: where Claude Code and Codex sessions run

Most agent sessions run on a dedicated DigitalOcean droplet, `fm-agents-1`, not on Jack's PC. The desktop app
opens them as SSH sessions; the PC only shows them. The droplet builds, tests and hosts experiments, so server
resources, not the PC's disk, set the limit. It can reach dev, never production.

Setup is code: `tools/agent-droplet/bootstrap.sh` (base system, idempotent) and `tools/agent-droplet/desktop.sh`
(desktop). Edit those files and run them again (`sudo bash bootstrap.sh` from a copy of `tools/agent-droplet`)
rather than changing the droplet by hand.

## What it is

| | |
|---|---|
| Droplet | `fm-agents-1`, id `613331014`, NYC1, Ubuntu 24.04, General Purpose 8 dedicated vCPU / 32 GB / 100 GB SSD |
| Address | `67.205.145.222` (private `10.116.16.2`) |
| Network | its own VPC `fm-agents-vpc` (10.116.16.0/20), not the development or production VPC |
| Firewall | cloud firewall `fm-agents-1-fw`: inbound TCP 22, 80, 443 only; outbound open |
| Storage | volume `fm-agents-data`, 500 GB, mounted at `/srv/agents` |
| Monitoring | metrics agent on; email alerts to `jack@1m8.ai` for CPU > 90 % (10 min), memory > 90 % (10 min), disk > 85 % |
| Cost | $252/mo droplet + $50/mo volume = **$302/mo**. No paid backups: everything worth keeping is in git. |

It replaced the `firstmate-experiments` droplet (SFO3, `64.23.196.15`, $96/mo). On 2026-10-28 its GEO
experiment and game moved here and its two Claude Workspace web UIs were dropped. Jack destroys that droplet.

## Layout

```
/srv/agents/work/firstmeasure     main clone (canonical branch, from GitHub); worktrees go beside it under work/
/srv/agents/home/agent            the agent user's home (~/code -> /srv/agents/work)
~/reference/synthesizer.js        Jack's model-provider helper with API keys (700/600); never print or copy its keys
/srv/agents/cache/npm             shared npm cache (npm_config_cache)
/srv/agents/cache/node_modules    shared node_modules builds (fm-deps)
/srv/agents/cache/ms-playwright   Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH)
/srv/agents/logs                  logs; files older than 7 days are deleted nightly
/srv/agents/experiments           experiment registry and index page
/srv/agents/status/disk.json      disk use, rewritten every 5 minutes
/srv/agents/ENVIRONMENT.md        what every agent tool loads first (below)
/mnt/jack-pc                      Jack's PC home folder, while its tunnel is up
```

Software matches the dev hosts: Node 22, PHP 8.3 (same modules as dev web), git, Codex CLI, Playwright's
Chromium with its system libraries, Caddy, the Antigravity CLI (`agy`) and App, and Google Chrome on the
desktop. The desktop app installs Claude Code itself on the first SSH session.

## What every tool reads

Claude Code, Codex and Antigravity all start from one short file, `/srv/agents/ENVIRONMENT.md` (source:
`tools/agent-droplet/home/ENVIRONMENT.md`): where they are, what they can reach, how to reach Jack's PC and
browser, how to ship, experiments and disk rules. Each tool's global rules file is a symlink to it:
`~/.claude/CLAUDE.md` (Claude Code), `~/.codex/AGENTS.md` (Codex) and `~/.gemini/GEMINI.md` (Antigravity's
global rules, read by its CLI, App and IDE). In a checkout they also read the repository's AGENTS.md. Change the
source file and run `bootstrap.sh`, or install it with `sudo install -m 644 ... /srv/agents/ENVIRONMENT.md`.

## Starting a session there

The SSH details for every tool: host `67.205.145.222`, user `agent`, key `C:\Users\jackh\.ssh\fm_agents_ed25519`.
On the PC, `~/.ssh/config` has the alias `fm-agents`, so `ssh fm-agents` works. Open sessions in
`/srv/agents/work/firstmeasure` or a worktree of it.

| Tool | How Jack starts it | One-time sign-in |
|---|---|---|
| Claude Code (most work) | Desktop app: new SSH session to `fm-agents` | The app installs and signs in Claude Code on the first session |
| Codex (cheap tasks) | Codex app: Settings > Connections > enable SSH host `fm-agents`, pick the folder. Or a terminal: `ssh fm-agents`, `cd ~/code/firstmeasure`, `codex` | In ChatGPT security settings allow device code sign-in, then `ssh fm-agents` and `codex login --device-auth`; open the link it prints and enter the code |
| Antigravity (occasional) | A terminal: `ssh fm-agents`, `cd ~/code/firstmeasure`, `agy`. Or, after `agy remote-control start --name fm-agents-1` once, pick `fm-agents-1` in the instance switcher of his Antigravity app or antigravity.google. Or the Antigravity app on the droplet's desktop (Remote Desktop) | `ssh fm-agents`, `agy`, sign in with Google when it asks. The desktop app signs in separately, inside Remote Desktop |

Antigravity's agent manager (the 2.x App Jack has on the PC) cannot open a folder over SSH; Antigravity IDE (a
separate download) can, with Remote-SSH, but it is not installed on the PC. The CLI and its remote-control
daemon are the supported way. The daemon runs as a systemd user service and starts at boot (`agent` lingers).

After creating a worktree run `fm-deps` in it: it
links each `node_modules` to a shared build keyed by the lockfile, so a new worktree is ready in a second and
twenty worktrees do not hold twenty copies. Treat the shared copy as read-only; to change dependencies, change
`package-lock.json` (it builds a new key) or delete the link and `npm install` a private copy.

The `agent` user has passwordless sudo. Root cannot log in over SSH; password login is off; fail2ban bans
repeated failures; security updates install nightly and reboot at 09:30 UTC when a kernel needs it.

## Shipping from the droplet

The same one way as everywhere ([dev lanes](dev-lanes.md)): commit, rebase on the lane tip, then
`node tools/dev-push/submit.mjs --wait`. The droplet holds a submit-only key for the router's repository on the
dev sync droplet (`~/.ssh/fm_devpush_ed25519`, behind the `dev-sync-droplet` alias in `~/.ssh/config`): it can
push queue refs and read lane tips and status, nothing else. The live layer works as on the PC: the
restricted `~/.ssh/fm_live_ed25519` pair is installed, and `node tools/live-layer/live-sync.mjs` in a clean
checkout makes saves live on dev.1m8.ai ([live layer](live-layer.md)).

The router runs opt-in regression suites (browser ones included) here, not on the dev sync droplet. Its key is in
`agent`'s `authorized_keys` with `from="147.182.178.6",restrict` and the forced command
`~/dev-push-runner/regress.sh` (source `tools/dev-push/runner/regress.sh`). That script fetches `regress/<sha>`
from the router, keeps `node_modules` per lockfile under `~/dev-push-runner/modules` and runs each suite with
Playwright's Chromium (`~/.cache/ms-playwright` links to the shared cache).

The submit key is installed for account `dev` on the dev sync droplet with `from="67.205.145.222",restrict` and
the forced command `~/dev-push/bin/submit-shell` (source `tools/dev-push/router/submit-shell.sh`). It allows
only fetch and push of `/home/dev/router/firstmeasure.git` and reading the router status. The repository's
pre-receive hook accepts only `refs/heads/queue/<lane>/<agent>-<slug>`. The shell sets `DEV_PUSH_NO_MIRROR=1`
(the background GitHub mirror needs a GitHub login the droplet lacks). Queue entries are named from
`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`. Antigravity sets neither, so set `DEV_PUSH_AGENT=agy-<task>`
there, or its entries are all named `agent-fm-agents-1`.

## Browsers

- **Jack's Chrome (preferred for anything Jack is signed in to).** A Claude Code session on the droplet reaches
  Jack's own Chrome on his PC through Claude in Chrome, exactly as a local session does. Use it for
  DigitalOcean, GoDaddy, Google, and anything else that is Jack's account. Codex's equivalent is the Codex
  app's Chrome plugin on the PC (an app feature; the CLI over SSH has none, and whether it serves SSH-host
  threads is untested). Antigravity's browser agent drives Chrome on the machine Antigravity runs on, so on the
  droplet that is the droplet's Chrome.
- **The droplet's Chrome.** For logins agents use often (test accounts, tools), which Jack signs into once over
  Remote Desktop so they stay signed in. It runs in the droplet's desktop session with its own profile
  (`~/.config/chrome-agents`) and DevTools on `127.0.0.1:9222`, so a session on the droplet can drive it with
  Playwright's `connectOverCDP("http://127.0.0.1:9222")`. It runs only while the desktop session is up.
- **Headless.** Playwright's Chromium for tests and screenshots. Signed-in dev pages use the dev test login
  (next section).

## Dev test login

Workers test signed-in flows on dev.1m8.ai without asking anyone. The login is a signup-sandbox test
organization, made from the sandbox's "Instant full org" workflow (`swf_instant_full_org`: every app on,
seeded demo data, dev only). It is organization `org_d4ce8c969203ef87`, "Agent Test Co (fm-agents-1)", and
its owner is a `@signup-sandbox.test` user.

- **Where the login is:** `/srv/agents/secrets/dev-test-login.json` (`base_url`, `email`, `password`,
  `organization_id`), mode 600. It exists only on the droplet; never print, commit or post it.
- **`fm-dev-login`:** signs in through `POST /v1/platform/auth/login` and writes a Playwright storageState to
  `/srv/agents/secrets/dev-storage-state.json`.
  - `--check` also opens `/portal/` headless and confirms `/v1/platform/auth/session`.
  - `--new-org "<label>"` makes a throwaway test org for work that changes a lot of data. Its login and state
    go to `/srv/agents/secrets/dev-test-orgs/`.
  - In Playwright: `browser.newContext({ storageState: "/srv/agents/secrets/dev-storage-state.json" })`.
- **If the shared org breaks or disappears:** run `fm-dev-login --new-org "Agent Test Co (fm-agents-1)"` and
  copy its file over `dev-test-login.json`.

Caveat: dev's signup sandbox lists every test org's login at `GET /v1/signup-sandbox/test-orgs`, because
registration is not gated on dev. This org is therefore no more private than any other dev test org. Keep
real data out of it.

## Its own desktop

XFCE with Google's Chrome Remote Desktop host, as a headless session for `agent` (no display manager; Remote
Desktop starts the session). Jack opens it from <https://remotedesktop.google.com/access> on any device.

Authorizing it is one-time and Jack's:

1. On the PC, open <https://remotedesktop.google.com/headless>, choose **Begin**, **Next**, **Authorize**, and
   copy the command shown under **Debian Linux**.
2. Run `ssh fm-agents` in a terminal on the PC and paste the command (it starts with
   `DISPLAY= /opt/google/chrome-remote-desktop/start-host`). Add ` --name=fm-agents-1` at the end if it is not
   there. The code in it expires a few minutes after it is shown.
3. Type a PIN of at least six digits twice. `fm-agents-1` then shows in Remote Desktop.

## Experimental hosting

Standalone experiments live at `https://<name>.experimental.1m8.ai` until they get their own droplet. Caddy
serves every name with an automatic certificate (issued on the first request, a few seconds), adds
`X-Robots-Tag: noindex, nofollow, noarchive`, and answers `/robots.txt` with `Disallow: /`.

```
fm-experiment add <name> <port> [--desc TEXT]          # serve something already listening on 127.0.0.1:<port>
fm-experiment run <name> <port> [--desc TEXT] -- node server.mjs
                                                        # also keep the command running as service fm-exp-<name>
fm-experiment list | remove <name>
```

Listen on `127.0.0.1` only; the firewall admits 80 and 443 to Caddy and nothing else. `run` sets `PORT`, reads
optional settings from `/srv/agents/experiments/<name>.env`, and logs to `/srv/agents/logs/experiments/<name>.log`.
The index of experiments and whether each answers is <https://index.experimental.1m8.ai/>, rebuilt every two
minutes. `hello` is the test experiment.

`experimental.1m8.ai` itself is the GEO experiment, at the same URLs as on the old host. It is a FirstMate host
snapshot with the GEO external app: `/` redirects to `/portal/?tab=external_geo`, and the portal (PHP) needs
an experimental account. Its parts:

- Code: `/srv/agents/experiments/geo` (`/srv/firstmate` links there), with `host/` (its own git repository),
  `apps/geo` and `operations/`. Its data, SQLite under `host/public/v1/storage`, belongs to the `firstmate`
  user.
- Server: the API is service `firstmate-experiments` (127.0.0.1:3101, secrets in
  `/etc/firstmate-experiments/api.env`, log `/srv/agents/logs/experiments/geo-api.log`). The Caddy site is
  `/etc/caddy/experiments/experimental.caddy`, which also serves the game Sourcebound at `/workspace/game/`
  from `/srv/agents/experiments/game/www` (sources in `game/src`).
- In the repository: the unit and the site file are `tools/agent-droplet/experiments/geo/`.

The old host's `/workspace/` and `/workspace-2/` are gone.

DNS: `1m8.ai` is a DigitalOcean zone in Jack's account (nameservers `ns1-3.digitalocean.com`, no longer
GoDaddy). `experimental` and `*.experimental` are A records to this droplet.

## Jack's PC as a folder

Agents on the droplet can read and write Jack's home folder on the PC at `/mnt/jack-pc` (`C:\Users\jackh`),
mounted with sshfs and readable only by `agent`. The PC is never exposed: it opens a reverse tunnel to the
droplet (`ssh -R 127.0.0.1:2222:127.0.0.1:22` as `jackpc`, a droplet account that can do nothing but listen on
that one loopback port), and the PC's OpenSSH server listens on its own loopback only and allows only SFTP.
`fm-jack-pc-mount.timer` mounts the folder within a minute of the tunnel coming up and unmounts it when the
tunnel drops, so nothing hangs on a dead mount. `sudo fm-jack-pc-mount status` shows both. When the PC sleeps
the folder disappears; do not depend on it for unattended work.

Jack's one-time setup, in PowerShell **as Administrator** on the PC:

```powershell
# 1. OpenSSH Server, listening on loopback only, SFTP only, key only
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd; Stop-Service sshd          # first start writes the default config and host keys
$cfg = "$env:ProgramData\ssh\sshd_config"
(Get-Content $cfg) -replace '^#?ListenAddress 0\.0\.0\.0', 'ListenAddress 127.0.0.1' `
                   -replace '^#?PasswordAuthentication .*', 'PasswordAuthentication no' | Set-Content $cfg
Add-Content $cfg "`r`nMatch User jackh`r`n    ForceCommand internal-sftp`r`n    AllowTcpForwarding no`r`n    PermitTTY no"
# 2. Authorize the droplet's mount key (jackh is an administrator, so it goes in administrators_authorized_keys)
$keys = "$env:ProgramData\ssh\administrators_authorized_keys"
Add-Content $keys 'restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFQBKv/eo7t1cSpaUXI8kVZ6odyZvQXMk4dvprvNobbm fm-agents-1 sshfs to jack-pc'
icacls $keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
# 3. Nothing from the network: the tunnel arrives on loopback
Disable-NetFirewallRule -Name OpenSSH-Server-In-TCP
Set-Service sshd -StartupType Automatic; Start-Service sshd
```

Then, in an ordinary PowerShell (not Administrator), start the tunnel at every logon:

```powershell
$a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.fm-agents\jack-pc-tunnel.ps1`""
$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "FirstMate agent droplet tunnel" -Action $a -Trigger $t -Settings $s
Start-ScheduledTask -TaskName "FirstMate agent droplet tunnel"
```

The script (`tools/agent-droplet/pc/jack-pc-tunnel.ps1`, copied to `%USERPROFILE%\.fm-agents\`) uses the key
`C:\Users\jackh\.ssh\fm_agents_tunnel_ed25519`, reconnects every 15 s when the link drops, and logs to
`%LOCALAPPDATA%\fm-agents-tunnel\tunnel.log`. To stop sharing the PC: `Disable-ScheduledTask` it, or stop sshd.

## Disk

`fm-disk-watch` runs every five minutes. When `/` or `/srv/agents` reaches 80 %, it writes
`/srv/agents/status/disk-warning.txt`, which every login and interactive shell prints in red, broadcasts it to
open terminals once, and logs it (`/srv/agents/logs/disk-watch.log`, journal tag `fm-disk-watch`). The file
goes away when use drops below. `/srv/agents/status/disk.json` always holds the numbers for the dev console,
also at <https://index.experimental.1m8.ai/_status/disk.json>. Test it with
`sudo FM_DISK_THRESHOLD=1 fm-disk-watch`, then `sudo fm-disk-watch` to clear. The threshold is in
`/etc/fm-agents/disk-watch.conf`. DigitalOcean also emails at 85 %.

Every night at 04:15 UTC `fm-agents-cleanup` deletes logs older than 7 days, unused shared `node_modules` builds,
and the working copies of finished sessions. A checkout under `/srv/agents/work` is removed only when nothing in
it changed for 12 hours, no process runs inside it, `git status` is empty (untracked files included), a main
clone has no stash and no linked worktrees, and every commit it holds is on a remote (`origin` or `devpush`). A
`.fm-keep` file protects a checkout for good (the main clone has one). `fm-agents-cleanup --dry-run` shows what
it would do; each run's log is in `/srv/agents/logs/cleanup/`.

Work under `/srv/agents`; `/` (100 GB) is for the system.

## What it can and cannot reach

| Can | Cannot |
|---|---|
| GitHub (public clone of the repository) | Production: no production key, VPC, database or credential is on it |
| The dev push router: queue refs and status only | Any dev host shell: no cluster key, no `dev` account key |
| dev web's live receiver (restricted `fm_live` key) | Production DNS or DigitalOcean API: no token on the droplet |
| Jack's Chrome, through the session's Claude in Chrome | Jack's PC, except the SFTP folder while Jack's tunnel runs |
| The internet (packages, model APIs) | |

Do not copy cluster keys, `id_ed25519_dev_sync`, DigitalOcean tokens or production secrets onto it. Work that
needs them stays with Jack or on the PC.
