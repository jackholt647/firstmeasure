# Production replacement-node release delivery

September 9, 2026: **prepared and tested; not installed or enabled in production**.
No database resize, restart, autoscale-template change, signing-key creation or
production release-channel publication was performed during preparation.
1M8-173 remains unresolved until a real new node boots the intended release.

## Capacity observed on September 9

Read-only PostgreSQL sample at 17:12 UTC and the DigitalOcean dashboard at about
17:14 UTC agree on the production cluster `db-pgsql-sfo3-95368`
(`71e32034-d0fe-4fa9-9e3c-40d8d43c905c`). The worker's actual database hostname
was matched to this cluster; the development database was not used.

| Resource | Observed production state |
| --- | --- |
| Compute | Basic shared CPU, 2 vCPU / 4 GB RAM |
| Disk allocation | 80 GiB SSD |
| Storage autoscaling | Enabled; add 10 GiB per node at 80% utilization |
| Database data | 9,479,157,439 bytes (about 8.83 GiB); excludes other databases, WAL and OS usage |
| Cluster disk chart, preceding hour | 18.72–18.95% used |
| CPU chart, preceding hour | 48.60–65.19% |
| Memory chart, preceding hour | 56.85–64.03% |
| Load-average chart, preceding hour | 2.21–4.44; do not equate this directly with percent CPU |
| Connections | `max_connections=100`, 3 superuser-reserved; dashboard application limit 97 |
| FirstMeasure connections | 49: 48 idle and one active audit query |
| Cluster activity rows | 62, including 13 whose details are hidden from the application role; not all are necessarily client connections |
| Waiting locks / transactions older than 60 seconds | 0 / 0 in the sample |
| Database standby | None; primary only |

The provider inventory was also rechecked: production has six active web nodes,
an autoscale range of 6–8, and approximately 12.83% CPU / 39.27% RAM pool
utilization at the later dashboard sample. Those are web-pool metrics, not DB
metrics. The six public IPs still match the September 9 release inventory.

Storage growth is already automatic. CPU, RAM and connection capacity do not
increase merely because the web pool adds nodes. This is not an immediate
capacity incident, nor proof of unlimited order throughput. Track peak CPU,
query latency, lock waits, pool wait times and orders/queue arrival rates.
The snapshot is not a load test. The primary-only configuration also leaves an
availability gap independent of the stale-code issue.

At eight processes per web node and one pooled connection per process, six web
nodes can use 48 connections, eight can use 64, and an overlapping six-plus-six
template replacement can use **96 before worker, compatibility and provider
connections**. That overlap exceeds the current safe budget despite normal load
being healthy. Dedicated heartbeat connections must also be included.

Use `check-database-budget.py` before increasing the web maximum or replacing a
template. For example, using a conservative 23 connections for non-web clients
and 10 spare usable slots: normal 6 nodes estimates 71/97, maximum 8 estimates
87/97, and 6+6 overlap estimates 119/97 (fails). These are planning assumptions,
not measured future demand. Recalculate from fresh inventory and runtime limits.
At maximum 8+8 overlap the same budget requires at least 161 usable connections.
Do not simply increase PostgreSQL max_connections without reviewing memory.

For long-term scaling, evaluate a larger/dedicated database tier and a standby
using observed peak workload. A transaction pooler needs separate compatibility
testing: the platform heartbeat uses session advisory locks and must retain a
direct/session-pinned connection. No automatic compute resize has been enabled.

Sources: [DigitalOcean database resizing and storage autoscaling](https://docs.digitalocean.com/products/databases/postgresql/how-to/resize/),
[connection pools](https://docs.digitalocean.com/products/databases/postgresql/how-to/manage-connection-pools/),
[autoscale template replacement behavior](https://docs.digitalocean.com/products/droplets/concepts/autoscale-pools/).

## Release contract

Every authorized production web release uses one reviewed Linux x64 runtime
archive, including compiled code and locked production dependencies. Secrets,
runtime databases, storage trees and local workspace artifacts are excluded.
`release-artifact.py package` selects source paths from the requested Git commit
but reads the reviewed Linux staging tree, preserving reconciled migration fixes.
It is **not** a source-baseline reconciliation tool. Complete that review and
Linux runtime tests first. Never package an active release directory: packaging
writes a local `.release-artifact.json` receipt into the supplied staging tree.

`prepare-web-release.sh` packages and publishes the build in one command, before
the existing one-node-at-a-time activation workflow. The publisher:

1. Stores the archive in the existing private production Space under
   `production/_releases/v1/artifacts/<sha256>.tar.gz`.
2. Reads it back and checks size/SHA-256 before publishing the target.
3. Signs the manifest with a controller-only Ed25519 key and writes `web.json`.
   Booting nodes verify against a locally pinned public key. Possession of the
   ordinary application Spaces credential alone cannot forge a new signed build.
4. Preserves the previous signed manifest under `history/` for explicit rollback.

This never adds a public code endpoint or modifies the environment-file endpoint.
No SSH private key is distributed. Signed manifests contain no arbitrary URL;
downloads stay on the verified Spaces HTTPS endpoint from runtime configuration.
All publishing goes through the compatibility controller's `flock`. The expected
previous SHA is an operator concurrency guard, not a distributed compare/swap;
do not run a second publisher on another host. Restrict access to the signing key.

The updated `activate-release.sh` checks the signed channel and local artifact
receipt **before** switching a production web symlink or restarting its service.
Missing/mismatched channel access fails the deployment. Explicit development
deployments and compatibility/worker releases retain their existing role behavior.
Use the new activation script, not copies in historical release directories.
Git pushes still run CI only; publishing to production requires release authorization.

The new-node helper verifies signature, size, checksum, archive paths and release
identity, installs into a new directory and switches `current` while the web
service is stopped. Corrupt/missing code fails closed. It performs no SQL,
database migration or customer operation and does not start/restart services.
Old running hosts are not polled or automatically restarted by this mechanism.

## One-time activation still required

Do not change production pool user-data merely to try this helper. DigitalOcean
replaces the fleet on a droplet-template update, with overlapping capacity.

1. Review the reconciled Linux build and run an isolated new-node rehearsal.
2. Generate a dedicated Ed25519 release-signing key on the designated controller
   with private file permissions. Keep `/etc/firstmeasure/release-signing-private.pem`
   there; provision only `release-signing-public.pem` on web nodes and the base
   image. This is separate from all SSH and API credentials. No keys exist yet
   as a result of this preparation.
3. Pin these deployment helpers into the base image outside the replaceable app
   tree. Adapt the existing production bootstrap to call
   `bootstrap-web-release.sh` **after** fetching its environment overlay and
   **before** browser setup and the first web-service start. Disable automatic
   startup of the image's stale web service until bootstrap succeeds; an image
   that briefly joins the load balancer before cloud-init runs is unacceptable.
   Integrate a boot dependency for subsequent reboots as well, without a
   cloud-final/systemctl-start ordering cycle. That image integration has not
   yet been implemented or rehearsed.
4. Retain production HTTPS proxy forwarding, PHP routing, provider configuration,
   instance identity, browser installation, heartbeat/job isolation and drain
   behavior. Do not replay migration gates or historical patches onto new code.
5. Publish a tested initial channel using the one controller, then boot a
   candidate excluded from the public load-balancer backend tag. Verify exact
   `release_id`, private artifact/signature failures, browser/PDF behavior and
   application workflow compatibility. Keep its database connection use bounded.
6. Resolve full replacement overlap capacity and obtain the coordinated rollout
   authorization within the user's uptime constraint. Only then update the pool
   template and verify a genuinely newly provisioned pool member.

After that one-time change, routine releases update the signed code channel, not
the DigitalOcean template. Check the channel identity alongside each release.
Changes to OS/browser prerequisites or bootstrap code still require their own
reviewed template/image update.

## Commands after one-time provisioning

On the designated compatibility controller, using an already built/tested stage:

```bash
sudo bash /trusted/deploy/prepare-web-release.sh \
  /reviewed/repository /reviewed/linux-stage FULL_COMMIT_SHA \
  /private/output/release.tar.gz PREVIOUS_ARTIFACT_SHA256
```

Use `none` only for initial channel creation. This command is an authorized
production publication, because newly booting nodes can consume it immediately.
Deliver the same archive/manifest to existing web nodes, install with
`release-artifact.py install`, and use the new `activate-release.sh` sequentially
with the existing load-balancer drain/readiness checks. Do not rebuild per node.

For deliberate rollback, the controller republishes the retained previous
manifest/archive against the current SHA before rolling hosts back. If a single
node's activation fails and the existing activator restores its prior symlink,
halt the rollout and reconcile the channel on the controller; a single-node
rollback does not automatically roll back the global channel. Do not claim the
whole fleet is reconciled until all identities agree.

## Verification performed

Seven Node behavioral tests cover publication/readback, checksum failures,
stale promotions, rollback history and signature forgery. Python tests validate
archive packaging/installation, secret/path rejection, tampering, conflicting releases
and that a failed release-channel check leaves the old symlink untouched.
Transport tests use in-memory storage; they do not prove actual Spaces delivery.
Archive/activation tests and shell syntax ran on the separate dev sync host;
the Node tests ran locally. CI runs both sets on Linux. No production signing,
upload, bootstrap or replacement-node test has been performed yet.
