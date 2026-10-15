# Development: editor dev controls and exterior reset — October 15, 2026

Source: `d2ccc2383d3c576b9302b5f362fc46c469b99bfb`, committed on the local canonical branch and published as `codex/editor-dev-controls-20261015`. The remote canonical branch has independent concurrent history; no force push or unrelated reconciliation was performed.

Advanced settings beside the grade controls now has Show Dev Controls. It defaults off and remembers the last choice in browser local storage across projects and sessions. General and Speed remain; the AI tab is no longer created or mounted. Hidden dev controls stop Speed collection.

Clear exterior model in the same settings asks for confirmation, removes exterior geometry and grade, and leaves the roof and its roof trim intact. Wall mode remains ready for a new From Roof operation. The clear is a full undo item, supports redo, and records a local clear timestamp so older saved exterior metadata cannot silently resurrect it before the next project save.

Validation: 85 focused profiler/browser and wall-mode tests pass against the immutable source candidate. Checks include default visibility, both persisted preference values across reloads, General/Speed behavior, absence of AI mounting, profiler suspension, cancellation of clear, preservation of roof data, stale saved-project restoration, undo/redo and regeneration. Evidence: `output/dev-controls-20261015/immutable-tests.txt`.

Development-only frontend activation verified on primary web, compatibility and web pool. Only `wall_mode.js` and `exterior_performance.js` were overlaid onto each role's exact predecessor. All predecessors were `1c9312523184e09363f92423cb55e73f82ec9b11`. The frontend release is `d2ccc2383d3c576b9302b5f362fc46c469b99bfb`; backend processes and backend release `1c9312523184e09363f92423cb55e73f82ec9b11` were preserved. Every role passes owned-file hashes, readiness, development session isolation and outbound restrictions. Public HTTPS serves both expected hashes at dev.1m8.ai. No production activation or customer project edits were performed.

The deployment waited for a concurrent development backend rollout to finish before auditing and activating. PHP reload reported an existing unit-file-on-disk warning on compatibility; no systemd configuration was changed, and readiness passed afterward.

Deployment evidence and exact predecessor paths: `output/dev-controls-20261015/manifest.json`, `verified-deployment.json`, and `http-verification.json`. Guarded rollback must first verify that current still points to this frontend release, restore that role's recorded predecessor, reload PHP and recheck readiness; never overwrite a later deployment.
