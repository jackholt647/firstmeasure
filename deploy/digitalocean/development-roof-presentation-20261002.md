# Report controls, roof appearance and selected aerial — October 2, 2026

Source release `1ae9b783ad8a08af8a645580108e93765c64114c` was deployed to the development web, compatibility and
pool roles. No worker, production, data or permission changes are included.

The Instant dev report option now sits immediately above Gutters and uses the
same addon row and switch styling. Its separate action and earlier empty slot
are removed; the normal report-order action submits the explicitly selected
option. Development access and matching-address requirements remain unchanged.

The roof viewer has independent Texture and Colored lines toggles, both enabled
initially, and an open line key. Without texture, roof faces remain visible in
translucent light gray. Textured faces are opaque with optional colored edges.
Face-local texture coordinates keep shingle courses perpendicular to downslope
and measure their spacing on the actual pitched surface, including rotated roofs.

Only the frozen `pdf_state.solarImg` used by the PDF is shown as Aerial view.
The misleading historical field name does not imply a solar provider; the editor
puts whichever selected and cropped top view it rendered in that field. Alternate
provider artifacts are excluded. Reports without that saved image do not substitute
an unverified aerial. Customer reference photos and videos remain in the library.

## Verification

Five focused browser/host tests passed: ordering entry and explicit opt-in,
reorder confirmation and credit denial, WebGL rendering and independent controls,
legend defaults, responsive gallery and disposal, pitched/rotated UV coordinates,
and report-only aerial selection. The viewer makes no write requests.
JavaScript syntax checks passed. Local and dev-served control screenshots verify
matching 48px option rows at 320px width without overflow. Browser rendering used
fixture report data; this is not an authenticated end-to-end check of a particular
customer report.

All serving roles passed deployed file hash, readiness, runtime identity and
enforced development-isolation checks. Payloads used reviewed three-way overlays
on each role's live baseline to preserve concurrent work.

## Rollback

Previous role releases:
- web: `8f3bc4926da1c24c709d917b350ec85828eb6cba`
- legacy: `4ae69418523989bc8f25c1d2fcb9ef184a85575c`
- pool: `4ae69418523989bc8f25c1d2fcb9ef184a85575c`

Confirm the role still runs this release before restoring its installed
`channels-release.json` previous_path, restarting the development service and
reloading PHP-FPM. Recheck readiness and isolation. Do not edit hardlinked releases
in place. The historical development autoscale replacement-image limitation remains.
Ignored `output/roof-presentation-20261002/` holds inventories, source selection,
payloads, screenshots and rollout scripts.
