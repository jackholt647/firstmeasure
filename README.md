# FirstMeasure

## Continue from another computer

The current handoff branch is **`codex/september-8-bugfixes`** (September 10,
2026); `main` is an older baseline. Clone the branch explicitly:

```sh
git clone --branch codex/september-8-bugfixes https://github.com/jackholt647/firstmeasure.git
cd firstmeasure
```

Read [AGENTS.md](AGENTS.md), [NEW_COMPUTER.md](NEW_COMPUTER.md), then
[DEPLOYMENT.md](DEPLOYMENT.md). The new-computer guide covers local setup,
SSH access provisioning, Git pushes, and the authorized release workflow.
GitHub access and server credentials must be provisioned separately; cloning
does not grant server access. A Git push runs CI, not a production deployment.

For production architecture, the Codex development-to-deployment workflow, and
required release checks, start with [DEPLOYMENT.md](DEPLOYMENT.md). Its completed
cutover state supersedes older migration documents' pre-cutover assumptions.

This clone runs independently from FirstMate 2.0.

See [MULTI_DROPLET_MIGRATION.md](MULTI_DROPLET_MIGRATION.md) for historical
horizontal-scaling conversion and cutover context; the migration is complete.
Production role files and immutable rolling-release instructions are in
[deploy/digitalocean/README.md](deploy/digitalocean/README.md).

## Repository scope

This repository contains the standalone FirstMeasure application stack:

- the PHP/web application under `public/`;
- the shared Node API and tests under `public/v1/`;
- browser libraries, portal assets, native clients, NGINX templates, and local launch scripts.

Runtime databases, generated reports, compiled output, dependencies, deployment
archives, machine-specific configuration, and real provider credentials are not
source-controlled. Copy the checked-in example configuration files when setting
up a new machine and supply secrets through local or deployment environment
files.

## Ports

- Web (NGINX + PHP): `http://127.0.0.1:8021`
- Node API: `http://127.0.0.1:3111/v1`
- PHP FastCGI workers: `9084` through `9087`

FirstMate 2.0 keeps its existing `8011`, `3101`, and `9074` through `9077` ports.

## Start and stop

From this folder:

```powershell
.\start-local.ps1
```

Open:

```text
http://127.0.0.1:8021/portal/
```

Stop only the FirstMeasure processes:

```powershell
.\stop-local.ps1
```

Machine-specific executable paths and ports are in `local-stack.config.json`.
That file and all generated runtime state under `.local-runtime` are ignored.

The configured NGINX executable may be shared with the read-only FirstMate
reference checkout. Each stack uses its own generated configuration, PID,
logs, and process ports, so starting or stopping FirstMeasure does not signal
or modify the FirstMate stack.
