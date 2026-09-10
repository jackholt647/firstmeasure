# FirstMeasure handoff to another computer

Prepared September 10, 2026. Start from `codex/september-8-bugfixes`, not the
older `main` branch. This is a source handoff, not a declaration that every
committed change is deployed or that production matches Git exactly.

## Clone and orient

Install Git and authenticate to GitHub with an account that can access
`jackholt647/firstmeasure`. Use your normal Git credential manager or SSH
authentication; never put a token in a repository URL or a checked-in file.

```sh
git clone --branch codex/september-8-bugfixes https://github.com/jackholt647/firstmeasure.git
cd firstmeasure
git status --short
git log -5 --oneline
```

Read in order:

1. [AGENTS.md](AGENTS.md): workspace preservation and authorization.
2. [DEPLOYMENT.md](DEPLOYMENT.md): architecture, access, rollout, configuration,
   baseline reconciliation, and rollback.
3. [September 9 releases](deploy/digitalocean/releases-20260909.md) and
   [503 incident](deploy/digitalocean/incident-20260909-503.md): recent code and
   host repairs that subsequent releases must preserve.
4. [Replacement releases](deploy/digitalocean/REPLACEMENT_RELEASES.md): prepared
   release-channel guard and outstanding signing/image/new-node provisioning.
5. [Deployment scripts](deploy/digitalocean/README.md): inspect actual scripts
   before use. Historical migration and incident scripts are not setup scripts.

The prepared web activation guard fails if the signed channel is missing or
does not match. Do not bypass it with an older activator. Recheck the outstanding
one-time work before attempting a production web release.

## Local development

Use Node.js 22 or newer, npm, and Python 3 for release-helper tests. The Windows
web launcher also needs PowerShell, PHP with `php-cgi.exe`, and NGINX. PHP
configuration is rendered from `nginx/php.ini.template`. Linux shell release
tests require Bash and Linux filesystem/service semantics.

```powershell
Copy-Item local-stack.config.example.json local-stack.config.json
# Edit phpRoot and nginxRoot to installed tool directories on this computer.
Set-Location public/v1
npm ci
npm run check
Set-Location ../..
.\start-local.ps1
```

Open `http://127.0.0.1:8021/portal/`; stop with `.\stop-local.ps1`.
Read `public/v1/README_NODE.md` and the checked-in environment examples for
the configuration needed by the feature being developed. Use development-only
credentials and data. A source clone contains no customer database, sessions,
provider credentials, or populated local accounts.

For an isolated PostgreSQL/MinIO cluster, install Docker with Compose and use
`npm run cluster:local:up` from `public/v1`; inspect
`deploy/local-cluster/compose.yml` for exposed ports. This is a local test
environment, not a production clone. `cluster:local:reset` deletes its volumes.

Run appropriate tests from `public/v1`; `npm run test:smoke` is the broad suite.
The authoritative CI commands are in `.github/workflows/ci.yml`, including
PostgreSQL integration and Linux release-helper checks.

## Provision SSH access once

The SSH configuration and private keys on the original computer are deliberately
outside Git. Authorization in a conversation cannot substitute for credentials.
On the new computer, create its own SSH key pair using `ssh-keygen -t ed25519`
(choose a new filename; do not overwrite existing keys), then have an already
authorized administrator install **only its public key** for the appropriate
accounts. The jump host and destination both need authorized access. Never
commit, print, copy, or transmit the existing private SSH keys.

Add entries to the new computer's `~/.ssh/config`, substituting the verified
host addresses and the local path to its newly provisioned private key:

```sshconfig
Host dev-sync-droplet
    HostName VERIFIED_JUMP_HOST_IP
    User dev
    IdentityFile ~/.ssh/firstmeasure_this_computer
    IdentitiesOnly yes

Host firstmeasure-compatibility
    HostName VERIFIED_COMPATIBILITY_IP
    User root
    ProxyJump dev-sync-droplet
    IdentityFile ~/.ssh/firstmeasure_this_computer
    IdentitiesOnly yes
```

The original computer's configured jump address on September 10 was
`147.182.178.6`. The documented compatibility address is `144.126.222.110`.
Verify both against current DigitalOcean inventory and verify host-key
fingerprints through a trusted administrator/provider console before first
connection. Do not disable host-key checking. Web-pool IPs change; discover
current members instead of treating historical addresses as permanent.

Read-only access checks after provisioning:

```sh
ssh -T -o BatchMode=yes dev-sync-droplet 'id -un; hostname'
ssh -T -o BatchMode=yes firstmeasure-compatibility 'systemctl is-active firstmeasure-legacy; readlink -f /opt/firstmeasure/current'
```

The jump account is normally `dev`, with project directory `/home/dev/code`.
It is separate from the production cluster and `dev.1m8.ai`. A sync request
requires clear paths/direction and does not imply deletion or mirroring.
For other production roles, use the same verified jump route and an authorized
destination account as described in DEPLOYMENT.md.

DigitalOcean inventory or infrastructure changes also need an authenticated
provider account/tool configured outside Git. Runtime credentials remain under
`/etc/firstmeasure` on the servers. Inspect only necessary allowlisted settings;
do not dump environments or copy production secrets into the clone.

## Make changes, push, and release

Create a task branch from this handoff baseline, preserve existing work, and
commit only reviewed source files:

```sh
git switch -c codex/your-task
# Edit and run the relevant checks.
git diff
git add path/to/reviewed-file
git diff --cached
git commit -m "Describe the change"
git push -u origin HEAD
```

When continuing an existing branch on either computer, fetch and use
`git pull --ff-only` after inspecting status. If histories diverge, reconcile
them explicitly; do not force-push or discard local changes. Push before
switching computers so both can retrieve the same commit.

Git pushes trigger CI only. For deployment, identify the target environment,
review live release identity/configuration, reconcile host-only fixes, test an
exact Linux release in isolated development, and follow DEPLOYMENT.md's staged
installation, drain, activation, verification, and rollback procedure. Production
activation and release-channel publication require user authorization. Honor
authorization already supplied for that work without asking again.

Production is `https://app.1m8.ai`; the former prerelease environment is live
production too. Migration is complete. Do not replay imports, DNS cutovers,
historical load tests, or one-time repair scripts as part of normal setup.

## Context intentionally outside Git

Private recovery notes at the old computer's `.codex/recovery/` paths are
supplementary evidence, not fresh-clone prerequisites. The linked repository
incident/release guides preserve the operational handoff. If a future repair
depends on an unrecorded detail, inspect the live system selectively or ask for
that specific context before acting.

Generated `output/` and `outputs/`, temporary files, caches, local credentials,
and historical untracked experiment/migration scripts on the original machine
are not part of this handoff. The separate `tools/firstmeasure-remote-share`
workspace is also outside this source snapshot. Do not assume those files exist
on a fresh clone or are required for routine application development.

A starting instruction for the next assistant:

> Clone https://github.com/jackholt647/firstmeasure.git on branch
> codex/september-8-bugfixes. Read AGENTS.md, NEW_COMPUTER.md, DEPLOYMENT.md,
> and the linked recent incident/release records. Verify local setup and server
> access, then carry out my requested change. Preserve live repairs and use the
> documented release workflow within the deployment authorization I provide.
