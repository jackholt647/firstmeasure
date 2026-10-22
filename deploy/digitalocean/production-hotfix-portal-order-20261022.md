# Production hotfix 9398c0ad: portal project saves without expanded access (1M8-231), October 22, 2026

Jack authorized the release.

## Change

Commit `7579af54`, record `9398c0ad`, on top of `c9479381`.

When an organization lacks `platform.expanded_access`, `Portal.ProjectStore`
`saveRemote` and `remove` keep the project in the page and make no platform
write. `Portal.platformExpandedAccess` is now shared from `core.js`. The cause
and the duplicate-order count are in
[development-1m8-231-20261022.md](development-1m8-231-20261022.md).

## Rollout (UTC)

**Build:** archive `7e8593d1…`, verified.

| Time | Role | Result |
| --- | --- | --- |
| 20:48 | Compatibility | Activated in 9 s. |
| ~20:49 | Signed web channel | Published, checked against `d8912d45…` (`c9479381`). |
| 20:50–21:01 | Six web nodes, one at a time | Each drained and activated in about 94 s. Each passed readiness, the asset match and the sandbox 404. |
| — | Worker | Unchanged. |

Public readiness returned `9398c0ad` 10 out of 10 times. Production serves
`project_viewer.js` version `3d6d6827…`, which contains the fix.

## Verification

**Health:** no new errors.

- From 21:01, there were 0 HTTP 500s on the web nodes.
- The ECONNREFUSED 500s just before 20:49 came from the compatibility restart.

**Effect: fixed. The remaining refusals come from tabs opened before the release.**

- At 21:10, a first reading matched refused saves to fixed-script loads by
  client address. That was wrong: several tabs share an address.
- The 1M8-231 session then matched each refused PUT to the page that sent it
  (by user agent, referer, and that page's own `core.js?v=` load). Of 75 refused
  saves between 21:02 and 21:16:
  - 69 came from pages running `core.js` `f9a5162b` (`8c908166`) or `3c708924`
    (`c9479381`);
  - 6 were inferred from the browser's last list-page load (`3c708924`);
  - none came from a page running the fixed `4577d38c` (`9398c0ad`).
- The browser has no other automatic writer of platform projects. Commit
  `3bd94495` adds a test that replays the list page and an order through the
  real scripts. It fails on `8c908166` and `c9479381` and passes on `9398c0ad`.

Refused `PUT …/projects/:id` saves across all six web nodes, per 15 minutes:

| Window (UTC) | Refused saves |
| --- | --- |
| 20:15 | 140 |
| 20:30 | 96 |
| 20:45 (rollout) | 334 |
| 21:00 | 85 |
| 21:15, first 4 minutes | 13 |

An old tab keeps sending these, and showing the error, until the customer
reloads it.

## Rollback

Compatibility and web keep `c9479381`. Republish it (`d8912d45…`) to the
channel before rolling back a web node.
