# Development layered-roof generation — September 22, 2026

Release: `11b13e0e444c7af901381bcf4e6e67e8017f80d8`
Baseline: `af30bfaac0af4d5605a5c00524ebc75c25be1aa5`
Branch: `codex/dev-roof-layers-20260922`

User authorized local and development fixes and regeneration of the saved full-house model. Production was not changed.

Four browser engine assets changed: `wall_geometry.js`, `base_geometry.js`, `wall_chimneys.js`, and `wall_mode.js`. See [construction details](../../dev/ROOF_LAYER_GENERATION.md). The primary workspace retains the same changes; unrelated local modifications were excluded from the release.

The release was staged from the verified active baseline, preserving 24,126 other public files on web/compatibility and 24,140 on the worker. All three development roles activated successfully. PHP-FPM was refreshed on both PHP-serving roles. Service readiness, development identity, full-house owner configuration, and enforced outbound isolation passed. All four public asset checksums matched the release. The isolated release worktree passes all 807 selected regression tests.

During browser verification, saving undo history returned HTTP 500 and large imagery/resource downloads were truncated. The development web host's `/var/lib/nginx/body` and `/var/lib/nginx/proxy` directories were owned by `nobody` with mode 700 while its configured/running NGINX workers run as `www-data`. Restored owner `www-data` recursively on those two temporary-directory trees, preserving modes and groups, and verified worker write access. The compatibility host already had the correct owner. No authentication, network isolation, or storage permissions were broadened.

Operational caution: NGINX configuration checks must use the actual worker user. Testing a temporary configuration without its `user www-data;` directive can change temporary-directory ownership to the binary's default account. Verify cache/body ownership against the running worker after such checks.

Browser verification completed on the requested dev editor project. Ran From Roof, inspected opaque geometry and the roof-hidden interior, saved, reloaded, and regenerated with the restored DSM. The final saved state uses Auto with the 24-inch default, 95 sources, and 85 composed panels (60 faces shown by the editor). A read-only server-state check confirms zero ground-contact gaps, zero ground shafts under the roof-mounted turrets/interior chimney details, all four small lower roofs with ground-supported walls, and height-map inference on both exterior chimneys. The saved undo history artifact is present. Six existing flashing-without-upper-roof notices remain for measured runs; the erroneous outside-ground warnings are gone.

Rollback: the prior immutable release is retained at `/opt/firstmeasure/releases/af30bfaac0af4d5605a5c00524ebc75c25be1aa5`. Restore that symlink and restart each development role if required; refresh PHP-FPM on web and compatibility too. The project rebuild remains undoable and the pre-change metadata snapshot was retained locally outside Git. Keep the corrected NGINX temporary-directory ownership during any rollback.
