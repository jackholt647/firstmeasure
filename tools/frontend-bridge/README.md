# FirstMate frontend bridge

Runs the browser files you change in a checkout on https://dev.1m8.ai, live, through the FirstMate Dev Bridge
Chrome extension. Design, limits and safety: [docs/architecture/frontend-bridge.md](../../docs/architecture/frontend-bridge.md).
For a Claude Code session driving it: `.claude/skills/frontend-czar/SKILL.md`.

1. `node tools/frontend-bridge/package.mjs` writes `output/frontend-bridge/firstmate-dev-bridge-<version>/` (and a
   zip). In Chrome: chrome://extensions > Developer mode > Load unpacked > that folder. Pin it.
2. In your own checkout: `node tools/frontend-bridge/bridge.mjs serve --root .`
3. Open dev.1m8.ai. Edit a file under `public/libraries/`; the page reloads with it. The blue "Local code" pill
   (bottom right) lists what is local.

`node tools/frontend-bridge/bridge.mjs help` lists the page commands (status, eval, console, screenshot, ...).
After changing the extension, run the package script again and press the reload button on its card in
chrome://extensions.
