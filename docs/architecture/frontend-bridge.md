# Frontend bridge: local browser code on dev.1m8.ai

Iterate on browser code (libraries, apps, tutorials' players and widgets, CSS) against the real dev site and its
real data, without a rollout per change. You edit files in your own checkout; Chrome runs exactly those files on
dev.1m8.ai and everything else stays dev's. When it is right, you commit and roll out as usual.

A Claude Code session can drive the whole loop (the **frontend czar**, `.claude/skills/frontend-czar/SKILL.md`):
it edits the files, the page reloads, and it checks the result through the same bridge (evaluate in the page,
read the console, take a screenshot).

## Parts

| Where | What |
|---|---|
| `tools/frontend-bridge/bridge.mjs` | `serve` (the bridge, one per checkout) and the client commands. Node 20+, git, no packages. |
| `tools/frontend-bridge/extension/` | The Chrome extension (Manifest V3), "FirstMate Dev Bridge". Acts on `https://dev.1m8.ai/*` only. |
| `tools/frontend-bridge/package.mjs` | Writes `output/frontend-bridge/firstmate-dev-bridge-<version>.zip` and the same folder unpacked. |
| `tests/frontend-bridge.test.mjs` | What is served, the copy rewrite, the live channel and the control endpoint. |

Nothing on the server: dev serves what it always served. No library or backend code knows about the bridge.

## How a file gets from your checkout into the page

1. `bridge.mjs serve --root <checkout>` lists the files changed since the **base**: the merge-base of `HEAD` and
   the canonical branch (`--base`, default `codex/consolidated-firstmeasure-20260923`), committed or not, plus
   untracked files. So your commits on a worktree branch stay served until they are on dev.
2. Of those, a **browser file** is anything under `public/` except `public/v1/**`, `public/storage/**`, `.php` and
   `.html`, with a static type (js, mjs, css, json, svg, images, fonts, media). It is **overridden** only when its
   content (line endings ignored) differs from what `https://dev.1m8.ai/<path>` serves now; a file already
   identical on dev is left alone, so a rollout ends its override by itself.
3. The bridge copies each override to `<extension folder>/overrides/<rev>/<path>` (rev = content hash). Relative
   and root-relative references inside a copied file (CSS `url()` and `@import`; JS `import … from`, `import()`,
   side-effect imports, `import.meta.url`) are rewritten to absolute dev URLs, because the copy is served from
   `chrome-extension://…`; those absolute URLs go through the same redirects, so overridden siblings load too.
4. The extension holds a WebSocket to the bridge (`ws://127.0.0.1:5747/ext`). On each state it installs one
   session redirect rule per override: `^https://dev\.1m8\.ai/<path>(\?.*)?$` (any `?v=`), for requests the
   dev site makes (`initiatorDomains: dev.1m8.ai`), to `/overrides/<rev>/<path>` in the extension. Pages and
   project-window frames are covered alike; documents (`main_frame`, `sub_frame`) never are.
5. Then it refreshes the dev tabs for what changed: a stylesheet `<link>` is swapped in place in every frame
   (page state kept); anything else reloads the tab (or, with auto reload off, the pill turns amber).

**Why files go through the extension's folder and not a local server.** Chrome's Local Network Access stops a
public site from loading anything from loopback (`127.0.0.1`), including a request an extension redirected there,
and granting the site the permission does not lift it for redirects (checked on Chrome 156). An unpacked
extension's files are read from disk on each request, so a file the bridge writes is served at once as an
extension resource (`web_accessible_resources: overrides/*`, for dev.1m8.ai only).

The bridge finds the folder Chrome loaded the extension from in each local Chrome profile's `Secure Preferences`
(`extensions.settings.<id>.path`), and looks again whenever the extension connects. `--extension <folder>` sets
it. The extension checks every override is in its own folder before redirecting; a missing one is reported
(popup, `status`) and dev's file is used.

## Page commands

`node tools/frontend-bridge/bridge.mjs <command>` talks to the running bridge, which sends it to the extension:

| Command | Does |
|---|---|
| `status` | Base, extension, each override (served how often, and a warning when dev's copy differs from your base), files already identical on dev, and changed files that need a rollout (server code, PHP and HTML pages). |
| `tabs` | The open dev.1m8.ai tabs. Commands use the active one unless `--tab <id>`. |
| `eval "<js>"` | Runs in the page's own world, as an expression or (if that does not parse) statements with `return`; awaits; returns JSON-safe data (elements summarised, cycles cut). `--frame <url part>` picks a frame, e.g. `--frame projectWindow`; `--all-frames`; `--file`; stdin with `-`. |
| `console` | The last messages and errors per frame, recorded from document start (`page-console.js`), `--level error|warn|info|log`, `--clear`. Includes resources that failed to load. |
| `reload`, `navigate <path>` | Within dev.1m8.ai only. |
| `screenshot [--out f.png]` | The visible tab as PNG. Needs "Allow screenshots" once in the popup (Chrome requires access to all sites for a capture); brings the tab to the front of its window. |
| `pause`, `resume`, `refresh` | Stop serving overrides (the page gets dev's files on its next load), start again, or re-read dev's copies now. |

## Trust and safety

- The extension acts only on `https://dev.1m8.ai/*`; the bridge refuses any other site. Production is never
  touched.
- Only the extension opens the live channel: the bridge accepts the WebSocket only from
  `Origin: chrome-extension://jfaopkielgkjkgomhmgdhldpogfdjohm` (the ID is fixed by the manifest's `key`), which
  a web page cannot send. The control endpoint takes a random token from the bridge's state file
  (`%TEMP%/firstmate-frontend-bridge-<port>.json`) and refuses any request that carries an `Origin`.
- The bridge listens on `127.0.0.1` only and serves no files over HTTP.
- `eval` runs as the signed-in person on dev, like typing in DevTools. The commands are for the person at this
  machine and the sessions they run.
- Redirect rules are session rules: they end with the browser, are cleared when the bridge stops, and are cleared
  within 30 seconds when it disappears.
- The pill and its panel are `data-fmr-ignore`, so session replay leaves them out.

## Limits

- Server code (`public/v1/**`), PHP and static HTML pages, and anything a page's HTML inlines need a rollout.
  `status` lists them. Guided experience **definitions** (steps, targets, eligibility) are server data; their copy
  can be edited live from the dev console's Guided experiences section (guided-experiences.md, "Development"), their players and widgets
  (`public/libraries/guided-experiences/*`) through the bridge.
- A script served from the extension is cross-origin to the page: `window.onerror` sees "Script error." for its
  exceptions. DevTools and `console` still show them (the console recorder keeps `console.error` text).
- A reload loses in-page state that is not in the URL or on the server (an open project window, for example).
  Stylesheet `<link>` changes keep it. A library that guards against running twice cannot be hot-swapped, so JS
  always reloads.
- Workers created from an overridden URL, and code that reads its own location from `Error().stack`, see the
  extension address.
- Copy changes need new language keys (the catalog's English overrides inline text).
- Two bridges on one machine need different `--port`s and the popup's port set to match; Chrome talks to one.
