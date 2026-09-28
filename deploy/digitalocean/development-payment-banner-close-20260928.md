# Payment setup banner close controls — development, September 28, 2026

The payment onboarding attention source marks its top and sidebar surfaces
`dismissible: false`. The older portal renderer used that server field to hide
the top close button and never rendered a sidebar close button. A session-only
fix had reached development on September 24, but later releases restored the
older banner script. Source commit `563b8be` now carries the fix on the
canonical `codex/consolidated-firstmeasure-20260923` branch. It also preserves
the payment setup action and translated button labels already in development.

Both X controls are rendered whenever their banner is shown. Each hides only
its own surface for the current browser tab session, scoped to organization,
user and banner ID. Polling and reloads retain that session choice. A new
session shows the banner again. The notification surface and the server's
persistent dismissal state are unchanged.

## Development rollout

Only `public/libraries/platform-banners/platform-banners.js` was overlaid on
each node's exact current release. The changed file received a fresh inode;
all other release files were inherited unchanged. `release.env` was updated
for each new immutable release. No database, flags, provider configuration,
worker, compatibility service, or production release was changed.

| Web node | Previous release | Current release |
| --- | --- | --- |
| `do-598520065` | `a042c677003ae9da1e142967d4f3e5d3081257ca` | `b9c820a5919453257ac360e68a001f85d19c6139` |
| `do-603124965` | `291c31d805b356b213892568bf080ac80d3e40da` | `01573d0fc7fc0261b4ba019e013e74c55d2ca5a8` |

The banner script SHA-256 is
`3adf8f28b3bd01d0d3e1d5d6c8d6e1cbbf1649d62b6cf9b8d79dac433d363222`
on both nodes and at `https://dev.1m8.ai/libraries/platform-banners/platform-banners.js`.
Both nodes passed local development readiness with outbound safety enforced.
The public readiness endpoint reported the new primary-node release. JavaScript
syntax and three focused tests passed, including a render check for both close
buttons when the payment banner is server-marked non-dismissible. The rollout
and verification records are in ignored `output/banner-close-20260928/`.

The first activation attempt on the primary node was automatically rolled back:
its staged `release.env` still named the predecessor, so the readiness identity
check rejected it. Both staged releases were repaired before final activation.

For rollback, restore each node's own previous release symlink, restart
`firstmeasure-development-web.service` and `php8.3-fpm.service`, then verify
local readiness. The development autoscale image remains historical; future
replacement nodes must receive this source commit or a later release containing it.
