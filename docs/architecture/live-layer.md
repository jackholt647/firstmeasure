# Live layer: frontend changes on dev.1m8.ai the moment they are saved

A browser file saved in the checkout on the dev sync droplet is served by dev.1m8.ai within about a second, to
everyone, and every open dev page swaps it in: stylesheets and images in place, anything else by reloading only
the frame that ran it. No rollout, no restart. Server code (`public/v1/**`), PHP and HTML pages still need a
rollout. Development only: production has no layer, no receiver and no channel.

The [frontend bridge](frontend-bridge.md) is the private variant: one person's Chrome, files from their own
machine. The live layer is shared: whatever the droplet's checkout holds is what dev serves.

## Parts

| Where | What |
|---|---|
| `tools/live-layer/live-sync.mjs` | Runs beside the checkout on the droplet. Sends every changed browser file to the receiver; `status` lists the layer. |
| `tools/live-layer/fm-live-receive.py` | On dev web, the forced command of the `fmlive` SSH key. Owns `/opt/firstmeasure/live`. |
| `tools/live-layer/install-web.sh` | Sets up dev web: the `fmlive` user, the receiver, the check timer and NGINX. Run as root once. |
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
6. The page swaps changed stylesheet `<link>`s and `<img>`s in place; for anything else a frame loaded it
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

## Running it

On the droplet, in the checkout (`/home/dev/code/firstmeasure`):

```
node tools/live-layer/live-sync.mjs            # serve: watch and send; leave running
node tools/live-layer/live-sync.mjs status     # what is live, what is not, what needs a rollout
```

Node is in `~/.local/node/bin` there. Check a change the way the frontend czar does, or from any dev page's
console: `FirstMateLiveAssets.files()`. `curl -sI https://dev.1m8.ai/<path>` shows `X-FirstMate-Live: 1` for a
file served from the layer.

On dev web, `sudo -u fmlive /usr/local/bin/fm-live-receive list` prints the manifest; deleting
`/opt/firstmeasure/live/public` and `manifest.json` empties the layer.

## Limits

- One shared layer: two people editing the same file on the droplet see each other's saves. Only one checkout
  should run `live-sync`.
- Only the web role serves it. A second web node would need the layer too (or the receiver on each).
- Scripts guarded against running twice cannot be hot-swapped, so scripts reload their frame.
- Copy changes still need new language keys (the catalog's English overrides inline text).
