# DigitalOcean cluster deployment

This directory contains the checked-in deployment contract for the replacement
FirstMeasure pool. It does not modify the existing production Droplet.

## Roles

| Role | Scales horizontally | Authoritative state |
| --- | --- | --- |
| Web pool | Yes | None; PostgreSQL and Spaces only |
| Background worker | Independently | PostgreSQL job leases and Spaces |
| Legacy state service | No, initially one | CRM SQLite, old PHP/tutorial files on a persistent volume |
| Regional Load Balancer | Managed | Routes only to ready web nodes |

The legacy service is intentionally private. Web Node APIs proxy
`/v1/internal` and `/v1/communications` to it with a shared secret. Web NGINX
routes the old `/measure/internal`, `/measure/sales`, and IDE PHP endpoints to
the legacy web service. Its Node listener binds to the VPC interface, while the
cloud firewall limits port 3101 to the web-pool tag. This prevents two Droplets from opening the remaining
SQLite databases while allowing all customer and QA traffic to scale out.
If the legacy service is unavailable, readiness reports that dependency as
degraded but keeps PostgreSQL/Spaces-backed QA and customer nodes in service.

## One-time infrastructure

1. Create a VPC-local managed PostgreSQL cluster and separate administrator and
   application users.
2. Create a private Space, application key, object versioning, and backup.
3. Create one fixed legacy Droplet with a persistent volume.
4. Create one fixed worker Droplet (or a worker-only pool that never scales to
   zero).
5. Create a web Droplet image or autoscale-pool template with Node 22, PHP 8.3,
   NGINX, Chromium, and the systemd unit in this directory.
6. Create a Regional Load Balancer using `/v1/health/ready` as its HTTP health
   check. Use the web-pool tag as the backend selector.
7. Restrict PostgreSQL, the legacy API, and the legacy web server to private VPC
   traffic. Only the load balancer should expose public web ports.

Install `/etc/firstmeasure/common.env` and the applicable role file from the
examples. Store them with mode `0600`. Install the relevant systemd unit under
`/etc/systemd/system/`. Create `/var/cache/firstmeasure` for the `firstmeasure`
user. The legacy node additionally needs `/var/lib/firstmeasure-legacy` on its
persistent volume. Install the private provider-key JSON at
`/etc/firstmeasure/provider-keys.json`; the checked-in NGINX configurations
pass that path to PHP, while `common.env` supplies it to Node.

`POSTGRES_AUTO_MIGRATE=false` is the normal steady-state setting. For the first
migration only, run one controlled migration process with `DATABASE_ADMIN_URL`
and `POSTGRES_AUTO_MIGRATE=true`; do not give the autoscaled web template an
administrator database credential.

## Immutable releases

GitHub is the source of truth. CI tests every commit. Produce or check out one
exact commit on a deployment host, transfer that source directory privately to
each Droplet, then prepare it without touching the running process:

```bash
sudo bash deploy/digitalocean/install-release.sh COMMIT_SHA /path/to/release-source
```

The installer runs `npm ci`, the type check, and the production build in a new
`/opt/firstmeasure/releases/COMMIT_SHA` directory. It does not change the
`current` symlink or restart a service. Activation is atomic and automatically
restores the previous symlink if readiness fails:

```bash
sudo bash /opt/firstmeasure/releases/COMMIT_SHA/deploy/digitalocean/activate-release.sh \
  COMMIT_SHA firstmeasure-web.service
```

Deploy web nodes one at a time. Wait for the load balancer to remove the node,
activate the release, verify that its private `/v1/health/ready` returns 200,
then wait for it to rejoin before continuing. Deploy the worker and legacy
roles separately. Database changes must be backward compatible throughout the
rolling window.

## Data-loading rehearsal

Use a snapshot copied to a private migration host. Point the storage-root
environment variables at that snapshot, then run in this order:

```bash
npm run cluster:state:migrate
npm run firstmeasure:artifacts:migrate -- --source-root /snapshot/v1/storage/firstmeasure
```

Those are dry runs. Review counts before applying. The verified run fails on a
missing PostgreSQL record or a missing/truncated object-store upload:

```bash
npm run firstmeasure:postgres:verify
npm run cluster:state:migrate -- --apply --verify --concurrency 4
npm run firstmeasure:artifacts:migrate -- \
  --source-root /snapshot/v1/storage/firstmeasure --apply --verify --concurrency 4
```

Copy the unconverted legacy directories to the legacy persistent volume, not to
web Droplets. Re-run the idempotent database/object migrations immediately
before cutover so data created during the rehearsal is included.

## Capacity settings

Begin with 8 Node HTTP workers per web Droplet and a PostgreSQL pool maximum of
1 per process. Two web Droplets therefore reserve about 16 application
connections, leaving room for the worker, legacy service, migrations, and
database administration. Increase web workers or Droplet count only while the
total connection budget remains below the managed database limit.

Background CPU is controlled only by `FIRSTMEASURE_JOB_WORKERS` on the worker
role. Web and legacy roles are forced to `FIRSTMEASURE_PROCESS_ROLE=web`; they
will not accidentally multiply the job-worker pool.
