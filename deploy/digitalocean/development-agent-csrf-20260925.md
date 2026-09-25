# Agent CSRF cookie repair — development, September 25, 2026

Source commit `130ee757da588c199c9a0cef7c4e5b6aac86a4dc` is pushed to
`codex/consolidated-firstmeasure-20260923`. The assistant and centralized
agents browser clients now read the CSRF cookie named by the portal's
`platformSessionCookieName`, with the existing production name as fallback.
They no longer read a stale production cookie when development uses a separate
session name. The server's CSRF requirement was not relaxed.

The two development web nodes had distinct healthy baselines during concurrent
rollouts, so each received an immutable two-file overlay of its own baseline:

| Node | Previous release | CSRF release |
| --- | --- | --- |
| `do-598520065` | `9fe8c07b56488c58e69017c75d74358ad1614f4c` | `58e9795228581e779986d8ab654230ebc0088fbd` |
| `do-603124965` | `8fdcd1ab2cb565474ddd4fdd985e3813b5516daf` | `0650241d63e37841076ca9670f35a93bc7bd4fa3` |

Both staged files passed baseline and target SHA-256 checks plus JavaScript
syntax checks. Each node was activated separately with a guarded rollback and
passed local development readiness with outbound safety enforced. Public
assets matched these SHA-256 values:

- `assistant-api.js`: `e6847b1a81f6608648def69f46b99f7688c12de4e90732de1025b170f067337b`
- `agents-api.js`: `dadca138df96ea15ee743031e56bbb3315ba0fdb720289861b74b384d9912408`

`npm run test:assistant:frontend` passed, including six tests for configured
development cookies, production fallback, and ignoring a different session's
token. `npm run check` passed. In an authenticated live Chrome session, the
assistant accepted a harmless message and replied `OK`; the CSRF error did
not recur. Production was not changed. The development autoscale image remains
historical.

For rollback, restore each node's `/opt/firstmeasure/current` symlink to its
previous release above, restart `firstmeasure-development-web.service` and
`php8.3-fpm.service`, and verify local readiness. Reconcile any later
concurrent release before rollback.
