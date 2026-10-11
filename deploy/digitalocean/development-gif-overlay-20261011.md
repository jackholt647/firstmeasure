# GIF creator overlay — October 11, 2026

Source commit `72f465c4e206b09e08823cd44ac0b61028f637e7` hides the creator
profile badge that the bundled GIPHY grid shows over some GIFs on hover.
The shared picker passes `hideAttribution: true` to the SDK's grid renderer.
GIF clicks still select the GIF; the separate Powered by GIPHY footer remains.
Channels, Feed and widget catalog callers use the same picker. Import versions
were advanced so refreshed clients load the change.

Existing live Feed composer differences were preserved in canonical source
by `fd577b4c` before changing the Channels import. That baseline was compared
byte-for-byte with the previously reviewed live Channels file.

## Validation and rollout

The six existing picker browser checks passed locally. An additional manual
browser check using the actual bundled GIPHY SDK and creator-bearing fixtures
confirmed that hovering produces no attribution badge or profile link, the
footer remains, and clicking still selects the GIF. This check used a temporary
copy of the existing browser harness rather than a new permanent test suite.
GIPHY responses and selections are fixtures, with no live messages sent.

All six picker checks and the creator-bearing hover check passed against the
final hosted dev assets. All three frontend roles and the public endpoint passed
readiness, development isolation and exact asset-hash verification.

The concurrent Project contact-priority update `1f9110a9` retained the overlay
fix on web and pool. Its symlink switch occurred during pool verification, so
the activation guard stopped our rollout without rolling back the newer work.
Reviewed renderer/runtime differences matched the newer canonical commit.
Compatibility was then staged from that newer baseline and activated as
`1f9110a94b7e197c26936062de44f50d378393e7`. All four final assets match that commit.

| Role | Final verified path |
| --- | --- |
| Web | `/opt/firstmeasure/releases-gif-overlay-1791757470/project-contact-priority-1f9110a9-fm-dev-web-598520065` |
| Pool | `/opt/firstmeasure/releases-gif-overlay-1791757575/project-contact-priority-1f9110a9-r2-fm-dev-web-603124965` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases-gif-overlay-1791757747/1f9110a94b7e197c26936062de44f50d378393e7` |

Web and pool retained release health ID `72f465c4`; compatibility reports
`1f9110a9`. Audit records, exact hashes and scripts are stored under ignored
`output/gif-overlay-20261011/`.

The rollout overlays four committed browser files onto audited copies of each
current development release, preserving other work. Staging checks include
source hashes, syntax and Linux TypeScript; activation checks prior-release
identity, readiness and enforced development isolation. No production changes.

For rollback, inspect the latest release and restore only these four assets
from the reviewed `062ca96f` deployment baseline (equivalent to `fd577b4c` for
these files), preserving subsequent work. Verify hover/selection behavior,
hosted file hashes and readiness after activation.
