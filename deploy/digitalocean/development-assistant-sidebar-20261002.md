# Assistant conversation sidebar — October 2, 2026

Source commit: `a8467b0f07a6940b624da6a9e360e4c5b788bce9` on the canonical branch.

Full workspace conversations default closed and open/close through the upper-left history icon. The global Agents left column retains its existing visibility handling. Full-screen resizing no longer forces history open or hides the toggle.

## Development delivery

Only `public/libraries/platform-assistant/platform-assistant.js` was overlaid onto the individually verified development web and pool baselines. Worker, compatibility, production, configuration and topology were outside this rollout. Staging and activation used baseline and hash guards, development isolation checks and rollback protection.

A concurrent rollout changed the pool baseline during staging; the guard stopped delivery and it was re-audited against `23a2ddd79a0ecc532696b143140cf970dd662b0d`. The web baseline was `face301551db403c65ba3c7b277a6985a7bd58b7`. Both roles successfully activated the sidebar release. A subsequent concurrent web rollout selected `23a2ddd79a0ecc532696b143140cf970dd662b0d` while preserving the exact sidebar asset. Final verification found web on that release and pool on `a8467b0f07a6940b624da6a9e360e4c5b788bce9`, both healthy with development outbound isolation enforced.

Both current nodes and the public asset match SHA-256 `7f4cab1703a349e2ca2712f90778dbba89927a2e31868c244d5c09100e1018af`. Release IDs alone do not describe the concurrent combined contents; inspect the retained receipts and hashes.

## Verification and rollback

Assistant frontend syntax checks and 97 tests passed. A browser fixture using scripts fetched from dev.1m8.ai verified the asset hash, default-closed history, upper-left toggle, desktop/mobile opening and closing, and global sidebar mount/unmount behavior.

Operational manifests, baseline snapshots, browser fixture and final per-node verification are retained in ignored `output/assistant-sidebar-20261002/`. Before rollback, inspect current releases and later changes. Prefer a scoped reverse delta in a new release when newer work exists; restoring an old entire release could discard concurrent changes. No database or configuration changes are involved.
