# Reference viewer session cache

Source: `797e7ecfec6d6d182d2af7a6a79fb84864fb915a`, October 9, 2026.

## Change

The reference viewer previously cleared the media source and recreated its player whenever the user opened a still or another reference. Each image open also created a new Image and refetched its latest markup; the resource endpoint uses private/no-store responses. This discarded useful video buffers and repeated already-completed image and metadata retrieval.

The viewer now keeps a session-only LRU of decoded images (96 MiB estimated RGBA budget, at most 24 entries), an independent 2 MiB/64-entry immutable-markup cache, and one retained media player. Images used as 3D backgrounds share the viewer cache. Media preloads automatically and retains its position, playback rate and browser-managed buffer across still-image visits. Switching media replaces the retained player. Switching projects clears both caches and releases the player. Failed image loads retry; oversized images are displayed without displacing the smaller cached images. Markup is cloned before editing so cached revisions remain immutable.

No server authorization, storage or response caching policy changed. This does not guarantee offline video seeking: unbuffered ranges and their decoding still incur latency, and browser memory pressure can evict media data. Large real-project seek latency was not benchmarked.

## Verification

- Six cache/catalog tests passed: request coalescing, decoded-byte eviction, entry limits, oversized entries, error retry and project-clear races.
- Exercised the actual viewer in Chrome against a local server that sent private/no-store for every media response.
- Repeated Front/Back image switches, saved-frame jumps, and return-to-video navigation produced one request each for Front.png, Back.png, the immutable markup revision and the four-second fixture video.
- Seeking to 4 seconds, viewing a still and returning preserved the video position. Switching projects caused fresh loads under the new project and discarded the prior cache.
- Evidence: `output/resource-cache-20261009/counts.json`, `browser-proof.png`, deployment manifests and final verification JSON.

## Development rollout

All four development roles passed final file-hash, readiness and development-isolation checks. Compatibility, web and pool were subsequently running `da5da69cbcf888e83bc9e5c92e2257354fead2ae`; this concurrent release retained the exact owned viewer asset. The worker was running the source release above. The obsolete exact-release public-traffic wait was stopped after independently verifying the superseding release's owned file hash; final public HTTP verification also passed. Unrelated source changes were preserved through freshly audited role baselines.

Initial compatibility staging hit the existing 1 GiB reserve guard. Clearing only the 91 MiB disposable `/root/.npm` package-download cache allowed staging without reducing the reserve or deleting current/rollback releases. No production changes.
