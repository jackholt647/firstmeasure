# Shared opening lifecycle and dimmed blur — October 12, 2026

`FirstMateWindows.opening` supplies a paint-first lifecycle for modal and panel
loading. `openModal` shows the native dialog, its opening animation, Close control
and loading status synchronously. `run` applies the lifecycle to an existing
connected panel. Work starts after a real visible paint opportunity, with a
bounded background yield for hidden documents. The API supplies cancellation,
latest-request ownership, structured ready/cancelled/error results, accessible
busy/status/error states and Retry. Removing a target or closing its dialog
aborts the consumer's wait; shared downloads can finish for other consumers.
Native modal registration ensures Escape closes the child before the parent.

The embeddable app runtime uses a loading shell by default while loading app
bundles and dependencies and mounting content. Unmounting or replacing a pending
mount cancels it and cannot publish a stale handle. App contexts receive `signal`
and `isCurrent` for their own asynchronous renderers. Detached staging roots
remain supported. The runtime preserves the existing access-policy evaluation;
these fields grant no additional access. Reduced motion disables opening and
spinner animations.

The blur backdrop now uses the same 58% dark tint as dim-only instead of the
previous 10% tint. Only the foremost overlay in each document draws the effect;
lower overlays and native dialog backdrops stay transparent and unfiltered.
Project iframe backgrounds and the outer page use matching effects over their
separate opaque surfaces. Nested-dialog rendering was inspected and tests verify
that the parent receives neither a second blur nor another dimming layer.

Materials/Order, Materials/Schedule and Documents creation call-site migrations
are deliberately deferred. Their waits before invoking the shared UI remain;
the new lifecycle is the infrastructure for that next pass. Existing retained
app activation callbacks and app-internal reads still own their rendering.

Validation: four opening lifecycle browser tests, three backdrop tests, five
window-manager tests and five window-shell tests passed. Coverage includes
paint-before-load, immediate modal visibility, close/unmount cancellation,
out-of-order results, retry, native Escape stack behavior, retained/detached app
mounting, blur/dim fallbacks, nested native/iframe overlays and window placement.
The Overview layout check failed during parallel browser runs and passed both
alone and in the sequential full window-shell suite. Both changed JS files pass
syntax checks. No signed-in hosted project workflow was exercised.

Source `9d7aab3b259e86bcd4e80fa3e90d6ef8a45e794b` is pushed to the canonical
remote branch. Publication used an isolated Git index to apply only the reviewed
five-file change to the latest remote tree, checking every owned baseline blob;
the shared checkout's unrelated staged and working files were preserved.

Deployment stages immutable two-file overlays of `window-manager.js` and
`firstmate-embeddable-apps.js` onto each freshly audited development baseline.
The newer live window-shell tray implementation is preserved. No backend build,
worker rollout, configuration or data change is needed. Scripts, role baselines,
payload manifests and verification evidence are in ignored
`output/shared-opening-20261012/`.

## Verified deployment

Web, pool and compatibility activated release
`9d7aab3b259e86bcd4e80fa3e90d6ef8a45e794b` over
`ebed7483fb0bf7dfa8cd351c5c07005e4e1b730e`. Web and pool use
`/opt/firstmeasure/releases/`; compatibility uses
`/mnt/firstmeasure_dev_releases/releases/`. Each baseline and candidate directory
is retained. Final checks verify owned file hashes, exact runtime identity,
readiness and enforced development isolation. The public library checksums match
the reviewed committed files:

- Window manager: `e8a70dbe6d2629270c7b5c39c786c15d90b7165b38dc93fc5eea516a1404fe5d`
- App runtime: `10dc9dc87232383c97e47d34995791b28c2d89473d3a7fba4dcf556061aac180`

Rollback can restore the recorded previous directory and restart the applicable
development service and reload PHP-FPM while this release remains current.
After intervening deployments, reverse only these owned patches. Production
was not changed.
