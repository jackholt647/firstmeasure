---
name: frontend-czar
description: Iterate live on FirstMate browser code (libraries, apps, tutorial players, CSS) running on dev.1m8.ai through the frontend bridge and the FirstMate Dev Bridge Chrome extension; edit, see it in the page, check it, commit and roll out when the user is happy. Use when asked to act as the frontend czar, to change what a dev.1m8.ai page looks like or does in real time, or to start the bridge.
---

# Frontend czar

You change FirstMate's browser code while the user watches it run on https://dev.1m8.ai in their Chrome. The
bridge serves your checkout's changed browser files to that Chrome; the page reloads (or swaps CSS) on every
save. Read `docs/architecture/frontend-bridge.md` once, and the architecture doc AGENTS.md names for the area
you touch (guided experiences, forms, app experience, realtime, ...).

## Start

1. Work in your own checkout, never the shared one (other sessions' uncommitted edits would be served too).
   In a session worktree that is clean, bring it to the canonical tip:
   `git merge --ff-only codex/consolidated-firstmeasure-20260923` (or `git reset --hard` to it when the branch has
   no commits of its own). Junction `public/v1/node_modules` from the shared checkout only if you need tests.
2. Start the bridge in the background (Bash `run_in_background`):
   `node tools/frontend-bridge/bridge.mjs serve --root .`
   If port 5747 is taken by another czar, use `--port 5748` and ask the user to set that port in the popup.
3. `node tools/frontend-bridge/bridge.mjs status` until it says "Extension connected" with a dev tab. If not, ask
   the user to load the extension (`output/frontend-bridge/firstmate-dev-bridge-<version>` in the canonical
   checkout, chrome://extensions > Developer mode > Load unpacked) and open dev.1m8.ai. `status` must show 0
   overrides before you edit; if it shows files you did not change, stop and fix the checkout.

## Loop

- Edit files under `public/` (not `public/v1`). Each save reloads the dev tab; CSS `<link>` files swap in place.
- Check the result yourself before telling the user:
  - `node tools/frontend-bridge/bridge.mjs eval "document.querySelector('.x')?.textContent"`
    (`--frame projectWindow` for the project window; statements with `return` work; `--file` for long code)
  - `node tools/frontend-bridge/bridge.mjs console --level warn`
  - `node tools/frontend-bridge/bridge.mjs screenshot --out <scratchpad>/shot.png`, then Read the PNG
  - `status` shows each override was served after your save ("served Nx, last 3s ago").
- To reproduce a state after a reload, drive the page with `eval` (click, open a project), or use Claude in Chrome
  tools if they are connected. Never click a final Build/Save/Send in someone's real org while checking.
- A `dev-differs` warning in `status` means your base is older than dev for that file: update the checkout
  before going on, or the override reverts other people's work on dev for the user.
- Changes to `public/v1/**`, PHP or HTML pages are listed under "needs a dev rollout": tell the user they will not
  appear until shipped. Guided experience steps and targets are server definitions; copy is editable live
  with the GX pill.
- Keep a running list in your replies of what changed, file by file. Git is the record (`git diff --stat`,
  `git status`).

## Commit and ship (only when the user says they are happy)

1. Re-read the diff, run the tests AGENTS.md names for the area (through the heavy-commands lock if heavy), bump
   the `versionedBundle(...)` string in `firstmate-apps-manifest.js` for each changed app bundle, and use new
   language keys for changed copy.
2. Commit on your branch with a clear message, then follow DEPLOYMENT.md and the dev rollout tooling for a
   browser-only release (legacy, web, pool) and integrate into the canonical branch.
3. After the rollout, `status` shows those files "Already identical on dev": the bridge stops serving them on its
   own. Stop the bridge (Ctrl+C or end the background task) when the session ends.
