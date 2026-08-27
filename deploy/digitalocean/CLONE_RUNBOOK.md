# FirstMeasure data clone runbook

This is a one-way data pipeline. Production snapshots may populate the
development or production-candidate targets. Development data is never copied
back into production. Application releases can be promoted from development to
production independently of customer data.

## Permanent environments

Create two isolated targets:

| Target | PostgreSQL database | Private Space | Legacy volume |
| --- | --- | --- | --- |
| Development | `firstmeasure_development` | `private-firstmeasure-development` | `firstmeasure-legacy-development` |
| Production candidate/live | `firstmeasure_production` | `private-firstmeasure-production` | `firstmeasure-legacy-production` |

Use separate application database users, session secrets, Space access keys,
and provider configuration. Install the appropriate `data-*.env.example` as
`/etc/firstmeasure/data-environment.env` on each role.

Do not enable live email, SMS, payment, Gmail synchronization, or webhook
credentials in development. Restrict `dev.1m8.ai` before loading customer data.
The development overlay starts with background job workers disabled. Enable a
small development-only worker count only after sandbox provider credentials and
outbound-message sinks have been verified.

## Snapshot source

An attached DigitalOcean volume is not part of a Droplet backup. Snapshot the
actual production data volume separately, restore that snapshot as a new
volume, attach it to the private migration host, and mount the restored volume
read-only:

```bash
sudo bash deploy/digitalocean/mount-clone-source.sh \
  /dev/disk/by-id/scsi-0DO_Volume_RESTORED_SNAPSHOT \
  /mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID
```

The helper never formats a device and refuses a writable mount. Confirm the
restored layout contains the source `v1/storage` directory before continuing.

### Live legacy server with split root and project storage

The legacy FirstMeasure host keeps SQLite and small application state on its
root disk while `storage/firstmeasure/projects` points to the attached project
volume. Do not use a live Droplet snapshot for this layout: an active SQLite
database is not guaranteed to be consistent in a crash-consistent root-disk
snapshot.

Instead, prepare a self-contained bundle on the attached volume. The helper
copies the smaller filesystem state and uses SQLite's online-backup API for
every live database. It neither stops services nor writes to the source
databases. Run the dry check first, then the applied preparation at idle CPU
and I/O priority:

```bash
source_id="legacy-$(date -u +%Y%m%d-%H%M%S)"

sudo bash deploy/digitalocean/prepare-live-clone-bundle.sh \
  --app-root /var/www/ide/v1 \
  --volume-root /mnt/volume_sfo3_01 \
  --source-id "$source_id"

sudo nice -n 19 ionice -c2 -n7 \
  bash deploy/digitalocean/prepare-live-clone-bundle.sh \
  --app-root /var/www/ide/v1 \
  --volume-root /mnt/volume_sfo3_01 \
  --source-id "$source_id" \
  --apply --confirm-live-source-read
```

After the helper reports success, snapshot the attached volume, restore that
snapshot as a temporary volume on the migration host, and mount it read-only.
The clone source paths are then:

```text
/mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID/firstmeasure-clone-sources/SOURCE_ID/v1/storage
/mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID/firstmeasure-clone-sources/SOURCE_ID/public
```

The bundle's `firstmeasure/projects` symlink is relative, so it resolves to the
same snapshot's `measure/internal/saves` directory after restoration.

## Development rehearsal

Load the development environment and run a dry inventory first:

```bash
set -a
source /etc/firstmeasure/common.env
source /etc/firstmeasure/data-environment.env
set +a

cd /opt/firstmeasure/current/public/v1
npm run cluster:clone:sync:compiled -- \
  --source-storage-root /mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID/v1/storage \
  --source-id VOLUME_SNAPSHOT_ID \
  --target-environment development \
  --profile development-clone \
  --verify
```

Review the inventory and reports. The applied run requires an explicit
read-only-source acknowledgement:

```bash
npm run cluster:clone:sync:compiled -- \
  --source-storage-root /mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID/v1/storage \
  --source-id VOLUME_SNAPSHOT_ID \
  --target-environment development \
  --profile development-clone \
  --apply --verify --confirm-read-only-source --concurrency 4
```

Use `--allow-existing-target` only when intentionally reconciling a newer
snapshot into the same development database. A new or changed artifact is
streamed to Spaces and verified; unchanged artifacts are confirmed by the
remote inventory and durable synchronization ledger and are not uploaded
again. Objects absent from the source are reported as orphans and never
deleted automatically.

Development-clone mode imports identities and password hashes so authorized
staff can test login, but excludes production sessions, API secret-vault
contents, API-key deliveries, Gmail mailbox state, and Apple provider state.

Stage the remaining legacy filesystem state on the development legacy volume:

```bash
sudo bash deploy/digitalocean/sync-legacy-clone.sh \
  --source-storage-root /mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID/v1/storage \
  --source-public-root /mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID/public \
  --source-id VOLUME_SNAPSHOT_ID \
  --target-environment development \
  --target-root /var/lib/firstmeasure-legacy-development \
  --apply --confirm-read-only-source
```

The legacy synchronizer creates an immutable release directory, hard-links
unchanged files from the prior clone where possible, verifies the staged copy,
and atomically switches the `current` symlink. It preserves previous releases
for rollback. Restart only the development legacy service afterward so its
open SQLite handles move to the new release.

## Production-candidate load

Use the production database, Space, and environment file. Production writes
require both the production target and the exact confirmation phrase:

```bash
npm run cluster:clone:sync:compiled -- \
  --source-storage-root /mnt/firstmeasure-snapshots/VOLUME_SNAPSHOT_ID/v1/storage \
  --source-id VOLUME_SNAPSHOT_ID \
  --target-environment production \
  --profile cutover \
  --apply --verify --confirm-read-only-source --concurrency 4 \
  --confirm-production COPY_PRODUCTION_SNAPSHOT_TO_PRODUCTION
```

This confirmation authorizes writes only to the separately marked production
candidate database and production Space prefix. It does not modify the legacy
source server or snapshot.

## Reports and resume state

Each run writes a JSON report and per-step logs under `clone-reports` unless
`--report-directory` selects another location. Artifact fingerprints and
completed transfers are stored in the SQLite file configured by
`FIRSTMEASURE_CLONE_SYNC_STATE_PATH` on the migration host. Preserve this file
between snapshots so subsequent runs remain incremental.

The target PostgreSQL database is stamped in `firstmeasure_data_environment`.
The clone runner refuses a mismatch, and clustered runtime readiness can enforce
the marker with `FIRSTMEASURE_REQUIRE_DATA_ENVIRONMENT_MARKER=true`.
