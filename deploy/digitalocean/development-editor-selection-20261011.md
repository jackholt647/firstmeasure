# Wall selection, nudging and door trim — October 11, 2026

The captured basement-door geometry reproduced independent failures in shared
editor paths: mixed face selections supplied only sticker vertices to transforms;
support containment could lift existing below-base geometry during horizontal
nudges; standalone empty clicks had no deselection callback; and trim classified
opening boundaries from distant polygon vertices instead of material next to
the selected segment.

Transforms now collect the entire selected face group, including trim boundaries.
Keyboard translations remain exact and reject invalid geometry atomically.
Repeated nudges preserve face selection and move the shared draft sketch nodes.
Mouse containment applies only when the original footprint fits its support.
Empty clicks clear standalone selection, while modifier misses preserve it.
Fallback surface picking ignores hidden objects, ancestors and materials.
Trim probes both sides of each finite run, including holes and notches, so both
door jambs receive inward trim on the first attempt.

The regression fixture contains only the relevant local geometry from the
reported project. Tests exercise face, point and single-trim selection, repeated
one-inch nudges, attached sketch nodes, atomic rejection, both jambs, winding,
empty clicks, hidden picking and undo snapshots. The existing sticker clipboard
contract is preserved.

This rollout also includes the pending Resources viewer change from `0d0ee96a`:
a 336px file pane with two media tile columns. The V no-material default from
`745f994c` remains included. See the companion resource-tiles record for browser
validation and layout details.

Release preparation audits each development role, merges only six editor assets
against its live baseline, and checks exact committed content. It preserves the
concurrent phone release and unrelated workspace changes. Evidence and per-role
rollback paths are in ignored `output/editor-selection-20261011/`. Production is
outside this rollout.

## Validation and release

Release: `7c40900917d67d4b41c235cc037beda9a3f25aed`.
Activated and verified on web, worker, compatibility and web-pool roles.
Each role passed committed-asset hash checks and development readiness.

The exact candidate passed 644 engine checks and five browser/resource checks.

Public verification fetched all six assets from dev.1m8.ai and matched their
SHA-256 hashes to the committed release. Public readiness reported this release,
development data, and enforced outbound isolation.

Rollback baselines (atomic current-link replacement, role service restart and
PHP-FPM reload on PHP-serving roles):

- web: `/opt/firstmeasure/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-web`
- worker: `/opt/firstmeasure/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-worker`
- legacy: `/mnt/firstmeasure_dev_releases/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-compat`
- pool: `/opt/firstmeasure/releases/phone-ca303672e994c86e43bcd1726b2317a5e12d4373-pool`

The baseline directory suffixes differ from their runtime release identity,
`ca303672e994c86e43bcd1726b2317a5e12d4373`. Verify against release.env.
Compatibility releases now use the existing mounted `/opt/firstmeasure/releases`
path; staging was adjusted to remain on that filesystem without changing mounts.
