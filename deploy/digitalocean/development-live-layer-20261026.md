# Development: live layer (2026-10-26)

Browser files saved in the dev sync droplet's checkout are served by dev.1m8.ai at once and swapped into every
open dev page. Design and operation: [docs/architecture/live-layer.md](../../docs/architecture/live-layer.md).
Development only; production is unchanged.

## Release

`d74f3b9914ed13fd477557701fd7681c18f87cfd` (canonical `codex/consolidated-firstmeasure-20260923`) on the
development worker, legacy and web (pool down). Files: `public/v1/platform/live_assets.ts` (new),
`public/v1/platform/api.ts` (registers `watch=live-assets`), `public/libraries/platform-realtime/platform-realtime.js`
(watches it on dev.1m8.ai only), `public/libraries/live-assets/live-assets.js` (new),
`public/libraries/apps/firstmate-apps-manifest.js` (realtime client version `20261026-live-layer`). Tooling:
`output/live-layer-20261026/` in the session worktree. `verify` passed on all three roles; readiness reports the
release.

## Host changes (outside releases)

Dev web (`143.198.68.11`, `fm-dev-web-598520065`), by `tools/live-layer/install-web.sh`:

- System user `fmlive` (password locked, home `/var/lib/fmlive`); its only authorized key is the droplet's
  `~/.ssh/fm_live_ed25519`, restricted to `command="/usr/local/bin/fm-live-receive serve"`.
- `/usr/local/bin/fm-live-receive` (from `tools/live-layer/fm-live-receive.py`); `/opt/firstmeasure/live` owned by
  `fmlive`.
- `fm-live-check.timer` (every 20 s) retires layer files a release now has or changed.
- NGINX `sites-available/firstmeasure-development`: `location /` now serves `/opt/firstmeasure/live/public` first
  (`no-cache`, `X-FirstMate-Live: 1`) and falls back to `@release`, the previous `try_files`. Backup beside it:
  `firstmeasure-development.before-live-layer`. Restore it and `systemctl reload nginx` to remove the layer.

Dev sync droplet (`dev` account): Node v22.23.2 in `~/.local/node` (nodejs.org, checksum verified; PATH in
`.bashrc`), key `~/.ssh/fm_live_ed25519`, checkout `~/code/firstmeasure` on branch `live/dev`, and
`live-sync.mjs` running under `setsid nohup` (log `~/.local/state/live-sync.log`). It does not restart after a
droplet reboot; start it again from the checkout.

## Verified

From the droplet, in Jack's open dev tab (phone layout, My Projects):

- A CSS rule appended to `libraries/development-tools/development-tools.css` showed in the page about 0.6 s after
  the save, without a reload (screenshot); the receiver wrote it in 79 ms; `curl -I` showed `X-FirstMate-Live: 1`.
- A comment appended to `libraries/live-assets/live-assets.js` reloaded the tab within about 1.9 s; the page then
  served the new copy; no console errors.
- `git checkout` of both files removed them from the layer (`reverted`); the stylesheet swapped back, the layer
  listed 0 files and the header was gone.
- The restricted key ran nothing but the receiver.

`tests/live-layer.test.mjs`, `public/v1/tests/live-assets.test.ts` and `platform-realtime-client.test.mjs` pass;
`tsc --noEmit` is clean. `realtime-single-stream.test.ts` fails on `v1/src/server.ts` (an `Accept:
text/event-stream` check from 33acbd4a), as it did before this release.

## Follow-ups the same evening

- `ea798ec4` (tooling and instructions, no release): several checkouts share the layer, each file owned by the
  checkout that put it live (`owned-by-other`, `live-sync.mjs clear`); this PC got its own restricted key
  (`C:\Users\jackh\.ssh\fm_live_ed25519`), authorized beside the droplet's; the receiver on dev web was updated;
  AGENTS.md tells agents to use the instant iteration system for fast frontend iteration.
- Release `ea3ae136` (`public/libraries/live-assets/live-assets.js` only) on development legacy and web:
  - A page compares the copy its browser cached (`force-cache`), not a fresh download, so a release copy cached
    under its `?v=` URL for up to an hour is noticed and the frame reloads once.
  - A script edit that only changes the CSS it injects swaps that `<style>` in place (the template's `${...}`
    values kept; re-renders that write the old CSS back are corrected before paint); anything else reloads.
  - Verified in Jack's tab before release, through the layer from this PC: the My Projects map tray's border and
    title colour changed green to blue in about 0.4 s with no reload and held through a forced re-render; the
    demo revert also applied in place. Both fixes were served by the layer until this release retired them.
