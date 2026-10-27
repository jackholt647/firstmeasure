# Live layer: frontend changes on dev.1m8.ai the moment they are saved

The **instant iteration system**. A browser file saved in a checkout running `live-sync` is served by dev.1m8.ai within about a second, to
everyone, and every open dev page swaps it in: stylesheets and images in place, anything else by reloading only
the frame that ran it. No rollout, no restart. Server code (`public/v1/**`), PHP and HTML pages still need a
rollout. Development only: production has no layer, no receiver and no channel.

The [frontend bridge](frontend-bridge.md) is the private variant: one person's Chrome, files from their own
machine. The live layer is shared: whatever the syncing checkouts hold is what dev serves.

## Quick start (any agent)

Use it for fast iteration and feedback on quick, predominantly frontend changes. AGENTS.md ("Live frontend
iteration on dev") has the rules; in short:

```
# in your own clean checkout at the canonical tip (session worktree, or ~/code/firstmeasure on the droplet)
node tools/live-layer/live-sync.mjs            # leave running in the background
#   ... edit files under public/ (not public/v1); each save is live on dev.1m8.ai within ~1 s
node tools/live-layer/live-sync.mjs status     # what is live, owned by which checkout, what needs a rollout
node tools/live-layer/live-sync.mjs clear      # take this checkout's files out (stop live-sync first)
```

- **Access.** The restricted key `~/.ssh/fm_live_ed25519` is on Jack's PC (`C:\Users\jackh\.ssh\fm_live_ed25519`,
  public half `.pub` beside it) and on the droplet. It can only run the receiver. To work from another machine,
  copy that pair into its `~/.ssh/`, or create a key there and authorize it: copy
  `tools/live-layer/fm-live-receive.py` and `install-web.sh` to dev web and run
  `install-web.sh fm-live-receive.py "<its .pub line>"` as root (adds the key; keeps the others).
- **Options.** `--root <checkout>`, `--base <ref>` (default the canonical branch), `--source <name>` (who owns
  the files; default `<host>:<checkout path>`), `--jump dev-sync-droplet` if the machine cannot reach dev web's
  SSH directly, `--key`, `--target` (default `fmlive@143.198.68.11`).
- **Finish.** Commit, roll out to dev and integrate into canonical as usual; the layer retires the files.

## Parts

### Rollout preflight: preserve the served version

Before a rollout changes any browser file, inspect `live-sync.mjs status` and
the live manifest for **every changed path**, including recent `retired` entries.
The immutable release alone is not the current frontend source: a live overlay
may contain additional user changes. Capture and merge the active served file
onto the release payload, or reconcile its owner checkout if it was retired as
`conflict`. Recheck the live hashes immediately before activation; stop and
reconcile if an owner edited them while the release was being prepared.

`conflict` means the release changed under an overlay. It does **not** mean the
overlay's behavior was incorporated. The timer removes that overlay to avoid
mixing incompatible code, which can expose an older UI. A successful health
check or released-file hash does not verify preservation. Verify the affected
workflow and commit the recovered source and regression test before finishing.

The October 26 mobile ordering regression occurred because a rollout included
the release's project-request script but omitted its live overlay. The map
overlay survived while its host callbacks disappeared. See the
[recovery record](../../deploy/digitalocean/development-mobile-order-recovery-20261026.md).

| Where | What |
|---|---|
| `tools/live-layer/live-sync.mjs` | Runs beside a checkout (droplet or PC). Sends every changed browser file to the receiver; `status` lists the layer, `clear` takes files out. |
| `tools/live-layer/fm-live-receive.py` | On dev web, the forced command of the `fmlive` SSH key. Owns `/opt/firstmeasure/live`. |
| `tools/live-layer/install-web.sh` | Sets up dev web: the `fmlive` user, the receiver, the check timer and NGINX, and authorizes one machine's key per run. |
| `public/v1/platform/live_assets.ts` | The `live-assets` channel on the platform stream: `hello` with the layer's files, `changed` on each write. |
| `public/libraries/platform-realtime/platform-realtime.js` | On dev.1m8.ai only, watches `live-assets` beside `presence:online` (one connection). |
| `public/libraries/live-assets/live-assets.js` | Applies changes to the page and its project frames. Loaded on first use. |

## How a save reaches the page

1. `live-sync` lists the browser files that differ from the **base** (the merge-base of `HEAD` and the canonical
   branch; committed or not, plus untracked files) exactly as the bridge classifies them: anything under
   `public/` except `v1/`, `storage/`, `.php` and `.html`, with a static type.
2. It sends them over one persistent SSH session (`fmlive@<dev web>`, key `~/.ssh/fm_live_ed25519`, which can only
   run the receiver) as one batch, with each file's hash and the hash of its base version. Line endings are
   folded for text before hashing, everywhere.
3. The receiver writes each file to `/opt/firstmeasure/live/public/<path>` and rewrites `manifest.json` once
   per batch (atomic renames, under a lock).
4. NGINX serves `location /` from the live folder first (`no-cache`, header `X-FirstMate-Live: 1`) and falls
   back to the release. PHP is never served from it.
5. The web service watches `manifest.json` and sends `changed { gen, files: [{ path, sha|null }] }` on the
   `live-assets` channel of every connected page.
6. The page swaps changed stylesheet `<link>`s and `<img>`s in place, and a script's injected `<style>` when the
   edit touched only that CSS (the template's `${...}` values are kept; the swap survives the app's re-renders).
   For anything else a frame loaded it
   refetches those URLs past the browser cache and reloads that frame (the whole page only when the page itself
   ran it). A small "Live: …" pill shows what changed. On connect (`hello`) a frame that ran a cached older copy
   of a layer file reloads once.

## What keeps it honest

- **It never reverts someone's release.** A file is accepted only while the release's copy is still the base it
  was edited from (or already the new bytes). Otherwise the receiver refuses it (`dev-differs`; update the
  checkout) and drops any live copy (`conflict`).
- **A rollout ends it by itself.** `fm-live-check.timer` runs the receiver's `check` every 20 seconds (and the
  sync every 15): a file the release now has is retired as `released`; one the release changed underneath is
  retired as `conflict`. Pages are not reloaded for a released file (same bytes).
- **Git is the record.** Everything live comes from the droplet's checkout. Commit and roll out as usual to make
  it permanent; until then it is dev-only state that a `git status` on the droplet shows.
- A file put back to its base leaves the layer (`reverted`). Stopping `live-sync` leaves the layer as it is.
- **Several checkouts can share it.** Each file records the checkout that put it live (`source`). A sync replaces
  or removes only its own files; another checkout's save of the same file is refused (`owned-by-other`) until
  the owner's copy leaves the layer or someone runs `live-sync.mjs clear <path>` (a forced remove).

## Running it

See the quick start. On the droplet the checkout is `/home/dev/code/firstmeasure`, Node is in
`~/.local/node/bin`, and a sync runs under `setsid nohup` (log `~/.local/state/live-sync.log`; it does not come back
after a reboot). Check a change the way the frontend czar does, or from any dev page's
console: `FirstMateLiveAssets.files()`. `curl -sI https://dev.1m8.ai/<path>` shows `X-FirstMate-Live: 1` for a
file served from the layer.

On dev web, `sudo -u fmlive /usr/local/bin/fm-live-receive list` prints the manifest; deleting
`/opt/firstmeasure/live/public` and `manifest.json` empties the layer.

## Limits

- One shared layer: everyone on dev sees every live file. Two checkouts editing the same file take turns (the
  first one's copy stays until it leaves the layer).
- Only the web role serves it. A second web node would need the layer too (or the receiver on each).
- Scripts guarded against running twice cannot be hot-swapped, so scripts reload their frame.
- Copy changes still need new language keys (the catalog's English overrides inline text).
