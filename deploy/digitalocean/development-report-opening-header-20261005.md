# Report opening chrome and icon clarity — October 5, 2026

Runtime source: `4cf0b4367177770a4afd04a813881c5dc3ead865` (includes `f6eafed9203300d3046cabd07d9fc91a1fc0a359`).

Project opening chrome now sets its mobile mode before insertion and hides desktop identity pills. Shared report-tab descriptors paint the same compact row in the parent loading header, initial child header and loaded report pane. Compact opening tabs do not replay the entrance animation. Loading status occupies the remaining space beneath the actual header instead of covering mobile tabs. The opening tabs remain clickable while the child boots.

Tab order is Map, Summary, Standard Report, Customer Report, then optional Photos. Summary uses a list icon; both report views use PDF icons, with a small user badge on Customer Report. Shared rendering retains accessible labels and tooltips. Asset versions were advanced for cached project/report bundles.

Validation: all eleven report-header, report-entry and window-shell tests pass. The opening-header browser check inspects mobile mode, hidden pills, tab order, equal 32px buttons and close-only controls synchronously before child boot, then clicks tabs while loading. It checks the child initial header matches. Full-style Chrome checks at 414px and 1100px passed with icon-font visual review. Evidence: `output/report-header-opening-20261005/`.

The release overlays five frontend files onto the existing role baselines; backend code, production and worker are unchanged. Existing unrelated live/workspace changes are preserved. The compatibility manifest had older bundle versions; the reviewed conflict updates only the task's project bundle versions. Prior development release on all roles: `ec3371957af56db3b40b98dd6f6a482893439677`. Rollback uses each manifest's previous release path and development service.

Staging initially stopped with only 532 MiB free on the web root filesystem. Six old September 17 exteriors upload archives in `/tmp` are preserved in local `preserved-upload-archives/` with a size/SHA-256 inventory before removal of their temporary server copies. Installed and rollback releases are retained.

Development activation was authorized in the ongoing conversation. All three roles passed final running-release, asset-hash, readiness and isolation checks; public readiness and all five frontend hashes match. Both browser harnesses passed again against the published dev files, including the before-child-boot mobile header and clickable loading tabs. The archive relocation freed 1,499,555,523 bytes and left 2,056,830,976 bytes available before staging; checksums, sizes and open-file checks passed before removing the six temporary copies. Local archives remain available for recovery. No customer records or reports were changed by verification.
