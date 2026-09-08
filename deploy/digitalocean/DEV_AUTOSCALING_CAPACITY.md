# Verified development autoscaling configuration

This records the September 7, 2026 capacity deployment. It applies only to
`dev.1m8.ai`. Do not apply this image or configuration to production, prerelease,
the replacement-production pool, or the unrelated `dev-sync-droplet` host.

## Current deployment

| Component | Verified configuration |
|---|---|
| Web pool | `firstmeasure-development-web-autoscale-r1`, ID `c33263f5-a09f-4774-904b-e955e09be037` |
| Pool image | Private snapshot `244484489`, plus `dev-autoscale-bootstrap-r1.sh` startup script |
| Pool bounds | 2–4 instances; CPU target 60%, memory target 70%, cooldown 5 minutes |
| Each web instance | 4 Premium Intel shared vCPUs, 8 GB RAM, 240 GB disk; two Node HTTP processes |
| Database pool | Maximum four connections per application process |
| Web background jobs | Zero; platform heartbeat disabled on web nodes |
| PHP | Sixteen maximum PHP-FPM children |
| Worker | Original `596237501`, four explicit job slots, 6 GiB service memory cap |
| Compatibility | Original `596237571`; owns remaining legacy state and platform heartbeat |
| Load balancer | `d8b9b51e-1c09-4ab2-975b-e06e9df86794`, selects only `firstmeasure-development-autoscale-r1` |
| Private network | Development VPC `c5c5508f-d028-4991-a686-60ecea1a679b`, `10.124.16.0/20` |

The generic README's initial eight-process/one-connection sizing is not the
configuration measured in this campaign. Increasing web-process or node counts
also increases the potential PostgreSQL connection total. The development
database currently has a 100-connection limit, including reserved connections.

The snapshot contains the actual deployed `capacity-r1-20260907-web` release,
verified with a full 16,782-file manifest. It was not built from the dirty local
worktree. Its private development configuration and network guard make it a
development artifact, not a production image to promote directly.

## Startup and removal

`dev-autoscale-identity-r1.sh` validates the private network and derives the
application identity from metadata. `dev-autoscale-bootstrap-r1.sh` additionally
sets a short OS hostname, because generated pool names exceed Linux's hostname
limit. Keep this startup script with the snapshot when reproducing the pool.

`dev-autoscale-web-r1.service` orders the application after NGINX, PHP-FPM,
networking and identity initialization. On shutdown the application withdraws
readiness and drains for 40 seconds. `KillMode=mixed` lets the main process
coordinate its children; the service stop limit is 55 seconds. Keep the existing
service user and filesystem hardening. Do not remove hardening to repair runtime
provisioning problems.

Observed provider scaling on September 7 was **2 → 3 → 2**, with no manual size
change. Added instance `598524955` passed the full release/identity/isolation
verification and 270 shared-session checks. Its removal provided a 40.004-second
drain and 93/93 successful authenticated checks. One public readiness 503
overlapped that drain; application requests and PDF jobs had zero failures.
The configured maximum is four; this event did not exercise four simultaneous
instances. CPU stimulus establishes the scaling mechanism, not user capacity.

## Capacity evidence and repeatability

The canonical result is `outputs/dev-autoscale-image-20260907.md`, backed by
`outputs/dev-autoscale-image-evidence-20260907/`. The original failed runs remain
in their evidence directories. A systemd exit code alone is not a test pass:
inspect final endpoint counters, stage boundaries, PDF reconciliation and
independent fleet/database telemetry.

The completed 85-minute soak sustained 100 users with 12 report bundles/minute
and 200 users with 24/minute. All 1,560 bundles completed on their first attempt.
One connection-level failure among 152,897 requests keeps the strict soak result
false. The instrumented follow-up completed 24,019 requests with zero failures
and no PDF arrivals; it did not reproduce or explain the original failure.
Both results must remain visible when deciding production readiness.

The named test helpers and plan use immutable campaign tags. **Do not rerun a
tag with existing logs/checkpoints or duplicate an active systemd generator.**
Reconcile every recorded enqueue attempt against durable job state before any
new batch. Private session and fixture files stay on the development hosts with
mode 0600 and must not be copied into reports or images.

During the soak, original web A (`24.199.99.148`) is outside the LB and hosts the
interactive and PDF-arrival generators. The bounded Windows fleet supervisor
samples the original four hosts and every verified serving pool node. Its
heartbeat expires after 90 seconds; stale or unsafe supervision stops admission.
Any newly added node must be inventoried and verified before adding it to the
monitor registry. Use independent host/service telemetry, not the old proxied
internal diagnostics, for resource claims.

Interactive traffic uses synthetic read workflows with randomized think time.
Report arrivals use the real editor PDF endpoint and fixed 12/24-per-minute
clocks, render 8- and 48-facet synthetic roofs, and verify persisted main and
summary artifacts. Synthetic reports remain held and uncharged; the campaign
does not deliver reports or call paid measurement providers.

## Production promotion still needs separate verification

Before production approval, assemble a reproducible release that includes the
curated capacity fixes, previous selective development fixes, and the two
concurrent database indexes. Review its diff and reproduce its build and tests
from a clean source state. Never promote the entire dirty worktree or copy the
development database, Space, session keys or image configuration into production.

The capacity campaign does not establish concurrent drafting-save behavior,
end-to-end ordering/provider processing, or delivery throughput. Validate those
workflows with isolated synthetic data and appropriate test integrations.
Verify the production-specific connection budget, worker concurrency, PDF
runtime, observability, backup restoration and failure recovery separately.
Web autoscaling does not scale the worker, compatibility service or database.

Follow `CLONE_RUNBOOK.md` for the one-way data migration rehearsal and final
source delta, including database counts and object/legacy-state verification.
Record the cutover and rollback triggers and the treatment of writes accepted
after cutover. No production deployment or cutover is authorized by this
development capacity campaign.
