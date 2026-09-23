# Development permissions and shared agents release — September 23, 2026

## Source and scope

- `7138ad6b609eaf8f5c4af4da6f56057703eeabe2` adds the permission bundles,
  expanded role grants, legacy FirstMeasure compatibility, shared agent
  publication gateway and architecture guide.
- `a66efdc91fcfe8bb5ae8bec6ce9d3a700f0a4fa2` normalizes line endings in
  backend action fingerprints. This corrects a real cross-node replay conflict:
  equivalent package manifests with different CRLF/LF bytes previously yielded
  different implementation IDs and a `409 action_idempotency_conflict` on
  replay. A focused regression verifies equivalent line endings and detects an
  actual code change.
- The permission catalog covers the built-in published API/agent surface: 80
  actions and 33 data exports, with a named business permission or an explicit
  subject-access decision for each. Existing application HTTP routes continue
  their own authorization. Their full migration to the new business permission
  names is **not** complete; this release does not assert that every legacy
  endpoint uses the publication registry.

The seven production FirstMeasure permission keys and existing users remain on
their legacy authorization behavior while `platform.expanded_access` is off.
No existing organization was bulk-migrated or enabled by this deployment.

## Build and validation

The exact `a66efdc` committed source was built on the development Linux worker.
`npm run check` passed; `npm run test:publication` passed 47 tests with one
PostgreSQL-specific skip. The earlier `7138ad6` source also passed the focused
workforce, channels-agent, statistics, communications and publication suites.
The assistant suite's six subtests passed, but its process hung during teardown,
so the whole suite is not recorded as passing.

The staged runtime archive has SHA-256
`4efb108351841f7fd7498c9a90935a73d3be1136d6074aa9657507851fbb29a5`
and 22,286 files. The development role activation guard checked runtime
identity, development data environment, outbound isolation and readiness.
The autoscaled node was staged from the exact Git source archive and this same
compiled runtime, with a verified archive checksum before activation.

## Activation and live checks

| Role | Serving instance | Verified release |
|---|---|---|
| Compatibility | original fixed role | `a66efdc91fcfe8bb5ae8bec6ce9d3a700f0a4fa2` |
| Worker | original fixed role | `a66efdc91fcfe8bb5ae8bec6ce9d3a700f0a4fa2` |
| Web pool | `do-598520065` | `a66efdc91fcfe8bb5ae8bec6ce9d3a700f0a4fa2` |
| Web pool | `do-603124965` | `a66efdc91fcfe8bb5ae8bec6ce9d3a700f0a4fa2` |

The two web nodes independently calculated the same backend fingerprint:
`9ff39b807cb9f8cc52672e9986c316902799944ea3192b219141830fd6d5e7a3`.
Authenticated smoke runs from **each** web node through `dev.1m8.ai` passed
catalog discovery, typed dataset action/replay, live and frozen document
bindings, durable module execution, native document generation, revoked-author
replay rejection, tenant isolation and CSRF. Each run deleted its disposable
organization, identity, session and records. Public unauthenticated action POSTs
returned the expected `400`, with no intermittent route `404` after updating
the second node. Production was not changed.

## Autoscale image remains an operational risk

The development autoscale pool still uses its historical snapshot
`244484489` and startup script described in
[DEV_AUTOSCALING_CAPACITY.md](DEV_AUTOSCALING_CAPACITY.md). That image contains
`capacity-r1-20260907-web`. This deployment updated the **two current serving
nodes**, not the DigitalOcean pool template. Scaling or replacement can create
another old node and reintroduce missing routes or mismatched action IDs.
Before relying on the pool for durable future deployment, publish a private,
checksum-verified release bootstrap or updated development-only image and
verify a newly provisioned node. Inventory every active pool member after a
scale event. Do not apply this image or configuration to production.

The fixed roles previously served `1291c36f5f38012dad495c6d998e8db5695081f5`;
the second pool node previously served `7138ad6b609eaf8f5c4af4da6f56057703eeabe2`.
If a rollback is needed, coordinate **all** serving nodes and worker/compatibility
roles to one compatible release. Reverting only one web node recreates the
cross-node replay conflict.
