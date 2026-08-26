# v1 Node Host

This is the shared Node host for modular `/v1/*` APIs.

## Current Mounted APIs

- `/v1/firstmeasure`

## Purpose

Each API can keep its own code in its own folder, while this host is the thin routing layer that mounts them under `/v1/<name>`.

## Commands

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run check
npm.cmd run build
```

## Production restart and preflight

`npm start` is the production deployment entry point. Its automatic `prestart` phase:

1. loads deployment settings from the project-root `.env` and `public/v1/.env` without printing secrets;
2. runs a read-only storage and credential preflight;
3. runs `npm ci --include=dev` only when `package-lock.json` changed or required packages are missing;
4. compiles TypeScript;
5. verifies TLS connections for both PostgreSQL users; and
6. starts the server, waits for the guarded project import, and requires `/v1/firstmeasure/ping` to become healthy.

The service must use `public/v1` as its working directory and invoke `npm start`. Storage, `.env`, `private/`, and the DigitalOcean CA certificate are persistent deployment data and must not be deleted or replaced by a source upload. Run `npm run preflight` at any time for the same non-destructive checks.

## Production Concurrency

`npm start` runs the compiled server in HTTP cluster mode by default. It starts up to 8 Fastify worker processes automatically, so normal `/v1/*` requests can spread across CPUs without overcommitting memory.

Set `V1_WEB_WORKERS` to tune this:

```powershell
$env:V1_WEB_WORKERS = "8"
npm.cmd start
```

Use `V1_WEB_WORKERS=0` or `1` for a single HTTP process. `FIRSTMEASURE_JOB_WORKERS` is separate; it controls the FirstMeasure background job queue, not HTTP request concurrency.

When `FIRSTMEASURE_DATABASE_MODE=sqlite`, the server caps the HTTP cluster at
one supervised worker even if `V1_WEB_WORKERS` is higher. SQLite is a shared
writable file and the per-process mutation queues cannot safely coordinate
multiple HTTP writers. The primary still replaces that worker after a crash or
missed heartbeat. Enable PostgreSQL before raising the HTTP worker count above
one.

The cluster primary expects a heartbeat from every HTTP worker, replaces workers
whose event loops stop responding, and backs off repeated restarts. A crash storm
exits the primary so systemd can rebuild the entire process tree. The production
launcher also probes `/v1/firstmeasure/ping` continuously and exits nonzero after
three consecutive failures. Install `deploy/systemd/firstmate-v1-resilience.conf`
as a drop-in for the HTTP unit (the worker deployment script does this
automatically) so a full-process exit is always restarted.

PostgreSQL distributed locks use short lease-table queries rather than holding
an application-pool connection for the duration of the protected operation.
This is required when `POSTGRES_POOL_MAX=1`: QA claims, report releases, and PDF
sync jobs can safely perform nested database work without self-deadlocking the
worker's only application connection.

## FirstMeasure PostgreSQL

When `FIRSTMEASURE_DATABASE_MODE=postgres`, server startup automatically creates or upgrades the PostgreSQL schema and imports every project `manifest.json` before accepting traffic. The import is resumable, content-validated, protected by a database-wide migration lock, and refuses an empty production cutover by default. JSON project files remain as best-effort recovery mirrors after PostgreSQL becomes authoritative.

Production settings:

```text
FIRSTMEASURE_DATABASE_MODE=postgres
DATABASE_URL=postgresql://firstmeasure_app:...@private-host:25060/firstmeasure?sslmode=require
DATABASE_ADMIN_URL=postgresql://doadmin:...@private-host:25060/firstmeasure?sslmode=require
DATABASE_CA_CERT_PATH=/absolute/path/to/digitalocean-ca-certificate.crt
POSTGRES_POOL_MAX=4
POSTGRES_AUTO_MIGRATE=true
POSTGRES_MIGRATION_BATCH_SIZE=500
POSTGRES_ALLOW_EMPTY_IMPORT=false
```

Port `3101` remains the production default for compatibility with the existing Nginx proxy. Local launchers explicitly set `3111` when needed.

Both URLs must select the `firstmeasure` database. `DATABASE_ADMIN_URL` is used only to grant the application user the initial database/schema permissions and can be removed after the first successful startup. Do not commit either URL or the certificate to source control.

The normal server startup performs migration automatically. A deployment can run `npm run firstmeasure:postgres:verify` after startup to print a secret-free database identity, project count, and migration status. PostgreSQL tests use an isolated database supplied through `TEST_POSTGRES_URL`:

```powershell
npm run test:firstmeasure:sqlite
$env:TEST_POSTGRES_URL = "postgresql://.../firstmeasure_test"
$env:FIRSTMEASURE_POSTGRES_TEST_PROJECTS = "50000"
npm run test:firstmeasure:postgres
```

## Local Test URLs

- `http://127.0.0.1:3111/v1`
- `http://127.0.0.1:3111/v1/firstmeasure/ping`
- `http://127.0.0.1:3111/v1/firstmeasure/echo`
- `http://127.0.0.1:3111/v1/test-client.html`
