# measure-internal dev lane on dev legacy (2026-10-27)

Development only. Design and how it works:
[dev lanes, measure-internal lane](../../docs/architecture/dev-lanes.md#measure-internal-lane).
Tool: `tools/dev-push/lanes/measure-internal/`.

## What changed on the host

Dev legacy (`firstmeasure-development-compatibility`, 137.184.229.145, private
10.124.16.5):

- `/opt/firstmeasure/lanes/measure-internal/` with `releases/<sha>/`,
  `current`, `previous`, `records/`, `nginx-backup/<time>/` (the site file as
  it was before install) and `.lock`.
- `/etc/nginx/conf.d/firstmeasure-lanes.conf` (written by `lane-host.sh`):
  `$fm_public_root` (`/measure/internal/` to the lane, all else to
  `/opt/firstmeasure/current/public`), `$fm_lane_header`, and an http-level
  `add_header X-FirstMate-Lane`.
- `/etc/nginx/sites-available/firstmeasure-development`: `root
  /opt/firstmeasure/current/public;` became `root $fm_public_root;`. Nothing
  else in the site changed. The live site differs from
  `deploy/digitalocean/nginx-development-legacy.conf` (the October 24
  hardening was never applied to dev legacy); the repo file got the same root
  change and the header line.

Dev web is unchanged: it already proxies `/measure/internal/` to dev legacy,
ahead of its live-layer location, and passes the lane header through.

## Switch-over

1. Lane branch `lane/measure-internal` created on origin at canonical
   `490c0b26`.
2. Before the switch the host's 238 editor files were compared with the
   commit: all identical, 76 of them only after folding CRLF (the platform
   release's copies were shipped from a Windows working tree with CRLF). The
   lane serves the commit's bytes (LF), so those 76 files changed bytes but not
   content.
3. Release `490c0b26` built (every file sent, 20 s), then `ship.mjs install`
   at 23:07 UTC. Twelve URLs (editor index, `editor.php`, login, scripts with
   and without `?v=`, a missing file, `unused/`, `portal.php`, `/measure/sales/`,
   `/portal/`) answered with the same status, redirect and body (CRLF folded)
   before and after. Editor responses carry `X-FirstMate-Lane`, platform pages
   do not. In the browser the staff login renders from the lane and editor
   scripts load with the header; the logged-in editor was not opened (no staff
   credentials used).
4. As `www-data`, the lane's `_storage.php` resolves its storage to the
   current platform release's `public/storage/measure/internal`, writable, as
   before.

## Releases shipped

| Release | What | Time |
|---|---|---|
| `490c0b26` | first lane release (canonical tip) | 20 s, gates skipped |
| `1a77ab79` | test: one comment line in `wall_mode.js` | 70 s (gates 54 s) |
| `21aaa092` | its revert | 110 s (gates 80 s) |
| `f1cb38a5` | test 2 from a canonical-based commit; also carried canonical `37adb244` (`wall_face_draft.js`) | 102 s (gates 88 s, 12 files) |
| `3ff42b1d` | revert of test 2; lane editor now equals canonical `37adb244` | 34 s (gates 22 s) |

Gate fixes made during these runs: the extracted test tree now includes the
platform files a test names (`exterior-pdf-layout.test.cjs` reads
`public/v1/firstmeasure/api.ts`), and child `node --test` runs drop
`NODE_TEST_CONTEXT` (under a parent test runner every failure passed).

## Switch back

```bash
node tools/dev-push/lanes/measure-internal/ship.mjs uninstall
```

comments out the `/measure/internal/` map line and reloads nginx; the platform
release's copy is served again. `install` re-enables the lane. To undo the
site change entirely, restore `nginx-backup/<time>/site` and remove the conf.d
file.
