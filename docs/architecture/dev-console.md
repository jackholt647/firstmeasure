# Dev console

Development only. One tray on the right edge of every development page holds every
development control. On a desktop it never covers the app: the page is **docked** beside
it, like Chrome's docked devtools (below). It opens and closes, folds to a 20 px strip
down the right edge (which also takes its 20 px), its width is dragged from its left
edge, and **Expand** widens it to 60% of the window. On a phone it covers the page as a
full-width tray, and folds to a 20 px tab in the middle of the edge so it clears the top
bar and search; the portal's ⋯ sheet also has a **Dev console** entry. It remembers open
or folded, expanded, the section and the width in this browser (`localStorage` key
`fm-dev-console`; a convenience, read and written in `try`/`catch`).

## Docking

`dock.js` makes the page behave as a window narrower by the console's width (or the
folded strip's 20 px), within the page's own document:

- `<body>` is fixed to the remaining width with layout containment, so it is the
  containing block for every fixed layer: modals, trays, toasts, guided overlays, the
  sandbox stage overlay, the left sidebar, anything at `right: 0`, and the project window
  (whose frame therefore has the remaining width as its own viewport). The console and
  its strip are mounted on `<html>`, outside `<body>`.
- In every stylesheet the page can read (including ones added later, watched with a
  MutationObserver), width media queries are shifted by the console's width and `vw`
  lengths are rewritten to the remaining width (`--fm-dc-vw`).
- `window.innerWidth`, `document.documentElement.clientWidth`, `matchMedia()` width
  queries and existing `MediaQueryList.matches` answer for the remaining width, and a
  `resize` event fires on every change (folding, opening, dragging, expanding).
- The top layer ignores containing blocks: modal dialogs and their backdrops are kept
  beside the console by CSS; a popover placed from element coordinates lands where its
  element is.

Why not host the app in a frame sized to the remaining width (exact media queries for
free)? A framed app is no longer the page production runs: `window.top`/`window.parent`
checks (the project window, guided experiences, live assets) would change meaning in
development only, the realtime stream and session replay would see a host page, history
would need syncing, and moving an already loaded page into a frame needs a second load or
server routing on every PHP entry point.

Limits: stylesheets from another origin (fonts, icons) are not read; inline `style`
attributes with `vw` keep the full width; a change event on a `MediaQueryList` the page
made before the console loaded follows the real window (its `matches` does not); a page
whose document itself scrolls (the portal does not; marketing pages do) scrolls inside
`<body>` while docked, and its fixed layers scroll with it.

Production never shows it: `/v1/signup-sandbox` answers 404 there and nothing is loaded.

## Who sees it

`GET /v1/signup-sandbox/development/console` (`public/v1/development/console.ts`)
answers the same audience as the guided experience development tools
(`guidedDevAccess`): the development data environment, then a platform administrator
or a sandbox test organization's settings managers. Everyone else gets 403 (401 signed
out) and no tray. The answer lists which sections apply here:

| Field | Section | Applies when |
|---|---|---|
| `test_run` | Test run | the organization is running a sandbox workflow |
| `synthetic_data`, `software_layers` | Synthetic data, Software layers | the organization is a sandbox test organization (their endpoints' own gate) |
| `guided` | Guided experiences | always for this audience (the page must load the guided library) |
| `live` | Live layer | the host has a live layer folder |

Until that endpoint is on a development host, the client pieces the same audience
together from the older answers (`/development`, `/current-instance` and the guided
library's editor flag); `readAccess` in `dev-console.js` says so.

## Sections

`public/libraries/dev-console/dev-console.js` is the shell; each section is a module in
`sections/`, loaded the first time it is opened, with `mount(root, ctx)` and an optional
`{ shown() }` called when it is opened again. Another library adds a section with
`window.FirstMateDevConsole.register({ id, icon, label: [key, English], render })`.

| Section | What | Where it came from |
|---|---|---|
| Test run | the sandbox workflow's stages, the showing one, Open, the workflow builder | the bottom test-run bar (`portal/signup-sandbox/devbar.js` still runs the stages and exposes `window.SignupSandboxRun`) |
| Flags and settings | this test organization's flags, scope flags and settings beside what it started with; flip one, Restore one, or **Restore initial state** (which also replays every Get Started tour and setup); record a start when none was | new; the config library's `/v1/config-library/organizations/:orgId/state` (`PATCH`, `/restore`, `/capture`) |
| Guided experiences | Editing copy, the last field's history, Replay/Restart, Reset me, Reset org | the GX pill and its phone sheet; drawn by `FirstMateGuides.devPanel` |
| Config library | entries by kind, recent changes, edit (checked by the server; Check without saving), revisions and revert, reset this organization's copy | new; the config library's `/v1/config-library/*` ([config library](config-library.md)) |
| Synthetic data | add sample records to a sandbox organization | the Development dropdown |
| Test users | turn users off, Solo one, turn everyone on; never the person using the console | the hidden developer overlay (Ctrl+Alt+Shift+D) |
| Software layers | declared contracts ([development software layers](development-software-layers.md)) | the Development dropdown |
| Live layer | files dev serves ahead of its release, the checkout that put each there, recent retirements | `live-sync.mjs status` ([live layer](live-layer.md)); `GET …/development/console/live` reads the receiver's manifest |
| Dev push queue | each lane's state and last release, each submission's state and why it was rejected, recent releases; "router unavailable" while it reports nothing | new; the router's status file, on the `dev-push` channel (`development/dev-push-status.ts`, which watches `/opt/firstmeasure/dev-push/status.json`); until that channel is on the host, `/__dev-push/status.json` read every 15 s while showing |

Flags and settings and the config library show "not on dev yet" until the config
library's API answers on the host.

## Rules

- Everything the console draws is `data-fmr-ignore` (session replay leaves it out).
- Copy goes through `PlatformLanguage.text('dev-console', 'dc_…', English)`; a reworded
  string gets a new key.
- No stream of its own ([realtime](realtime.md)): Flags and settings refreshes on the
  `org_state.` platform events and the config library on `config_library.` (and reads
  again when opened: edits from other organizations do not reach this page); the Live
  layer section redraws on the `fm:live-assets` window event the live-assets library
  dispatches for each change on the `live-assets` channel. The push queue watches the `dev-push`
  channel, which sends the router's status document whenever the router rewrites it.
- On a phone the tray is above the project window (2147483200) and the sandbox stage
  overlay (z-index 2147483640); on a desktop nothing overlaps it.

## Tests

`public/v1/tests/dev-console.test.ts` (the endpoint),
`tests/guided-experiences-flow-browser.test.mjs` (the guided section, folding,
remembering, the phone tab and More entry, resizing across the project frame) and
`tests/development-layers-browser.test.mjs` (software layers and synthetic data at
desktop and phone widths), `tests/dev-console-dock-browser.test.mjs` (docking: fixed
layers, vw, media queries, matchMedia, innerWidth, a modal, a frame, folded, open,
expanded, and a phone not docked).
