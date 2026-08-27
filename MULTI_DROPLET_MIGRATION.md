# Multi-Droplet Migration

This migration is additive. The existing production Droplet stays online while
a private replacement pool is built, loaded, tested, and finally placed behind
the live hostname.

## Target architecture

```text
Internet
   |
DigitalOcean Regional Load Balancer
   |
   +-- web Droplet 1 --+
   +-- web Droplet 2 --+---- Managed PostgreSQL
   +-- autoscaled web --+          |
                                  records, sessions, locks and jobs
Fixed worker Droplet(s) -----------+
   |
Private DigitalOcean Space
   project PDFs, imagery, uploads and generated artifacts

Fixed private legacy service
   CRM SQLite, old internal PHP state and tutorials during the transition
```

The load balancer selects only nodes whose `/v1/health/ready` endpoint returns
HTTP 200. `/v1/health/live` proves that Node is running but does not prove its
critical PostgreSQL and Spaces dependencies are available. The fixed legacy
service is reported as a degraded readiness warning rather than removing every
QA/customer node from service when only CRM or an older internal tool is down.

Web Droplets are replaceable and contain no authoritative data. Background
workers use durable PostgreSQL job leases and deploy separately from the
autoscaled web pool. A worker must not disappear because low web traffic causes
the pool to scale down. The low-volume legacy role is fixed until its remaining
CRM/tutorial stores are separately converted; autoscaled nodes proxy those
routes and never open the legacy SQLite files.

Development and production use separate PostgreSQL databases, private Space
buckets, legacy volumes, session secrets, and deployment configuration. Data
may be cloned one-way from an immutable production snapshot into either target.
Development data is never promoted into production; only tested application
releases follow that direction.

## Compatibility contract

The defaults remain compatible with the current single Droplet:

- `DEPLOYMENT_TOPOLOGY=single`
- the existing SQLite or PostgreSQL database setting
- `FIRSTMEASURE_ARTIFACT_STORAGE=local`
- no rolling-drain delay

Cluster nodes use:

- `DEPLOYMENT_TOPOLOGY=cluster`
- `FIRSTMEASURE_DATABASE_MODE=postgres`
- `FIRSTMEASURE_ARTIFACT_STORAGE=spaces`
- one identical `PLATFORM_SESSION_SECRET` on every node
- one release identifier in `RELEASE_ID`
- a unique `INSTANCE_ID`, preferably the Droplet ID
- `CLUSTER_NODE_ROLE=web`, `worker`, or `legacy`
- a private `LEGACY_SERVICE_URL` and shared `LEGACY_PROXY_SECRET` on web nodes

Cluster mode refuses SQLite and local FirstMeasure artifact storage. This is a
safety check, not a claim that every legacy filesystem store has been migrated.

## Conversion status

| State | Target | Status |
| --- | --- | --- |
| FirstMeasure manifests and QA queue | PostgreSQL | Implemented |
| Job queue, leases and distributed locks | PostgreSQL | Implemented |
| Internal user index | PostgreSQL | Implemented |
| Internal operational documents | PostgreSQL | Implemented for new writes; legacy import remains |
| Project artifacts | Private Spaces | Backend and migration command implemented |
| Platform identities, organizations and sessions | PostgreSQL | Implemented and cross-node tested |
| Platform, material, payment and generic documents | PostgreSQL | Implemented |
| Platform media | PostgreSQL metadata + private Spaces bytes | Implemented and cross-node tested |
| Multipart PDF synchronization chunks | Private Spaces | Implemented |
| Google 3D tile working sets | Private Spaces | Implemented |
| Weather, code reports, pricebooks, rush state, keys and canvassing pins | PostgreSQL/Spaces | Implemented |
| Gmail mailbox state and Apple Maps key/audit state | PostgreSQL | Implemented and included in migration verification |
| Diagnostics capacity history | PostgreSQL, aggregated across instances | Implemented |
| CRM leads/referrals SQLite and old PHP/tutorial state | Fixed legacy service | Isolated; does not block web scaling |

Do not direct public traffic at two nodes until both migration verifications and
the cluster integration test pass without sticky sessions.

## Data migration order

1. Create managed PostgreSQL in the same VPC and region as the pool.
2. Create a private Space with a limited application access key.
3. Start one replacement web Droplet with no public load-balancer traffic.
4. Import PostgreSQL data from a snapshot of current storage.
5. Dry-run the complete clone inventory from the restored read-only snapshot:

   ```bash
   npm run cluster:clone:sync -- \
     --source-storage-root /mnt/firstmeasure-snapshots/SNAPSHOT_ID/v1/storage \
     --source-id SNAPSHOT_ID --target-environment development \
     --profile development-clone --verify
   ```

6. Import PostgreSQL state and incrementally upload and verify artifacts:

   ```bash
   npm run cluster:clone:sync -- \
     --source-storage-root /mnt/firstmeasure-snapshots/SNAPSHOT_ID/v1/storage \
     --source-id SNAPSHOT_ID --target-environment development \
     --profile development-clone --apply --verify \
     --confirm-read-only-source --concurrency 4
   ```

7. Reconcile again immediately before cutover for newly created data.
8. Exercise the private load balancer with one node and then two nodes while
   deliberately alternating requests.
9. Lower DNS TTL, freeze only the final mutation window, perform the final
   incremental copy, and point the live hostname at the load balancer.
10. Keep the old Droplet intact and read-only until the rollback window closes.

The environment-guarded clone command and read-only volume mount procedure are
documented in `deploy/digitalocean/CLONE_RUNBOOK.md`. Artifact refreshes retain
a durable fingerprint ledger and upload only new or changed objects. Missing
source objects are reported but are never deleted automatically.

## Deployments without downtime

Build one immutable release from a Git commit. New Droplets obtain that same
release through cloud-init or an image; they do not run independent `git pull`
deployments. Replace or restart one node at a time:

1. SIGTERM marks the node as draining;
2. readiness returns 503 so the load balancer removes it;
3. active requests finish during `ROLLING_DRAIN_MS`;
4. install and start the new release;
5. wait for readiness, then continue to the next node.

Schema changes must remain compatible with the previous and next application
versions during the rolling window. Destructive cleanup belongs in a later
release.

## DigitalOcean configuration

- Use an autoscale-pool tag as the Regional Load Balancer backend selector.
- Configure an HTTP health check on `/v1/health/ready`.
- Start with a fixed pool of one, then two, before enabling utilization scaling.
- Keep web and worker roles in separate pools or fixed Droplets.
- Permit database access only over the VPC.
- Keep the Space private and enable object versioning plus a separate backup.

References:

- https://docs.digitalocean.com/products/droplets/how-to/use-autoscale-pools/
- https://docs.digitalocean.com/products/networking/load-balancers/details/features/
- https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/

## Local cluster testing

Local development remains single-process and local-file by default. The checked-
in cluster environment runs two Node web containers, two PHP-FPM containers,
one worker, one private legacy service, PostgreSQL, MinIO, and NGINX. It logs in
through node A, reads through node B, crosses nodes for media bytes, renders the
PHP portal, and confirms the load balancer exercises both web instances.

From `public/v1`:

```bash
npm run cluster:local:up
npm run cluster:local:verify
npm run cluster:local:down
```

Use `cluster:local:reset` only when intentionally deleting the local PostgreSQL,
MinIO, and legacy test volumes. Production setup and rolling-release details are
in `deploy/digitalocean/README.md`.
