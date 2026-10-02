# Development platform widgets — October 2, 2026

Source release: `a1d965d72131e26744b0fa918767fad01364441f`. Activated on development web, compatibility, pool and worker. Public readiness reports this release with development isolation enforced; all eleven changed public library assets matched the staged role hashes.

Scope now owns a stacked widget viewer with Lists & measurements, 3D roof, Aerial view, Measurements, Lists, Materials and Labor. The existing list controls remain in the Scope leaf adapters. Reports uses the same responsive viewer with a 1200px container breakpoint. Reusable instances support content sizing, independent configuration/state, visibility, resize and disposal.

The platform registry and typed publications expose widget discovery and authorized presentation to human-initiated agents. Shared agent chat and the global assistant mount references with fresh reads; cross-organization references and unavailable versions are rejected. The document registry has an adapter preserving its original binding and pagination contract. See [widget architecture](../../docs/architecture/platform-widgets.md).

## Validation

- TypeScript check passed.
- Publication suite: 50 passed, one PostgreSQL integration test skipped.
- Focused browser and scope tests: 12 passed, including independent projects, filtering, content-sized composites, responsive selection, assistant reopening, late-response disposal, live Scope controls and roof holes/textures.
- Separate browser probe rendered the roof inside the shared viewer, verified no nested media selector, exercised texture controls and verified canvas cleanup.
- Role staging checked JS/PHP syntax, exact transpiled output and Linux TypeScript compilation. Activation verifies role readiness, release hashes and enforced development isolation. Worker activation checks there are no running measurement jobs.

## Baselines and rollback

| Role | Previous release |
| --- | --- |
| web | `3213c066946fb353f60c2bcba4bde98b7094ad10` |
| legacy | `3213c066946fb353f60c2bcba4bde98b7094ad10` |
| pool | `3213c066946fb353f60c2bcba4bde98b7094ad10` |
| worker | `8f3bc4926da1c24c709d917b350ec85828eb6cba` |

The deployment uses per-role three-way overlays against inspected live files, retaining unrelated deployed differences. The compatibility server had an older shared-left Scope implementation; its module was reconciled to the content-owned sidebar already present in its project host. Its unrelated note icon was retained. Manifest cache-version and assistant-open conflicts were reviewed individually. Worker includes the shared catalog JSON and pure scope resolver required by backend publication bootstrap.

Rollback restores each role's recorded previous symlink and restarts its own development service, then verifies readiness/isolation. Reload PHP for web/compatibility asset changes. Do not substitute one role's baseline for another. Production was not changed.
