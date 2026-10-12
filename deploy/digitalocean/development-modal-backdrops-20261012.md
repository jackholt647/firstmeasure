# Shared modal backdrops — October 12, 2026

The shared window library now owns modal backdrop styling. Modal windows receive
a backdrop when their app has not supplied an overlay. Existing app-owned window
overlays, registered Portal modals, native HTML dialogs and legacy translucent
viewport overlays use the same 8px blur with a light tint. Only the foremost
viewport overlay in each document draws the effect; native dialogs suppress
lower backdrops. Small menus and popovers retain their own styling. Project
iframes keep the outer page blur and apply the same effect over their workspace
when a child dialog opens. App content, routing and dismissal remain app-owned.

Dimming is the fallback for unsupported CSS, reduced-transparency preferences,
refused major-caveat-free WebGL contexts and recognized software renderers.
The graphics probe is conservative and cannot prove CSS acceleration. The
shared `FirstMateWindows.backdrops.setEffect('auto' | 'blur' | 'dim')` override
is persisted and propagated to embedded workspaces. Explicit blur still honors
CSS support and reduced transparency. Floating/docked/minimized/hidden windows
release their backdrop, and destruction removes manager-owned layers.

Validation: three new browser regressions cover nested managed/legacy/native
dialogs, native opening order, small popovers, iframe effects, reduced transparency,
the refused-graphics fallback and backdrop lifetime with preserved drafts.
All five window-manager tests and all five window-shell tests pass (13 total).
The Overview layout check failed once during concurrent browser tests and passed
both alone and in the complete window-shell rerun. The rendered nested fixture
was inspected. No signed-in hosted project flow was exercised.

Source commit `a0c91c414f0a13a234a806b0c497193e780c9473` is pushed to
`codex/consolidated-firstmeasure-20260923`. Concurrent remote work was preserved
by cherry-picking the owned three-file change into an isolated checkout based
on the remote canonical branch. The shared checkout's unrelated edits and staged
files were preserved.

Development-only deployment overlays the committed
`public/libraries/window-manager/window-manager.js` onto each freshly audited
live baseline using immutable hardlink releases. Unchanged source, compiled
backend, dependencies, configuration and data remain from that role's baseline.
No worker deployment is needed for this browser-only change.

| Role | Previous release | Activated release directory |
| --- | --- | --- |
| Web | `060ea41ebb1d4db0a1d1ab55b37adf4f06b8817f` | `/opt/firstmeasure/releases/a0c91c414f0a13a234a806b0c497193e780c9473` |
| Pool | `060ea41ebb1d4db0a1d1ab55b37adf4f06b8817f` | `/opt/firstmeasure/releases/a0c91c414f0a13a234a806b0c497193e780c9473` |
| Compatibility | `b178dae7c2e35fda5e3c5942828df0eff680fbfe` | `/mnt/firstmeasure_dev_releases/releases/a0c91c414f0a13a234a806b0c497193e780c9473` |

The compatibility baseline changed after initial staging; the activation guard
rejected the stale stage. It was re-audited and rebuilt from the newer baseline
before activation. Initial process/current-path differences were audited against
backend source and compiled output; the processes and release identities aligned
before final activation. All three roles passed final file hashes, exact runtime
release identity, readiness and enforced development isolation. The public
`dev.1m8.ai` library checksum matches the committed file:
`e92ecbf5100ef152cc53f5245e918dece73a7fafbd7bbf272275bd89c39fc3d9`.

Manifests, captured baselines, payloads, scripts and public verification are
retained in ignored `output/modal-backdrops-20261012/`. Rollback can restore each
recorded previous directory and restart its development service and reload
PHP-FPM while this release remains current; after intervening deployments,
reverse only the window-library patch. Production was not changed.
