# Development signup sandbox workspace repair — September 24, 2026

The "Instant full org (dev)" signup instance authenticated successfully but
`/portal/` timed out at "Loading your workspace." The portal initially threw
while formatting a missing terminology key when no tab was available. Commit
`6a58230d9d194b02da0af2d0685d323352e32e70` makes that empty key safe.

The underlying reason no tab was available was a truncated PHP response. The
development release did not contain the tracked `external-apps/registry.php`.
For orgs with expanded platform access, `public/portal/index.php` required that
file halfway through its script list. PHP emitted a fatal error after returning
the first part of the page, so none of the portal app bundles registered.

Commit `2e15300977cae157b0b4118b425c2a0026b9b05e` keeps rendering the
portal if the optional registry is absent and logs the missing registry. The
development release also restores the tracked `external-apps/` files and
`external-apps.json`, so the configured GEO app remains available. It was
staged from the prior exact development release with only these files added.
The final payload SHA-256 was
`b0fe86fc22aba581cbd15a710f68d0888a6c10a215a82b6a3e0c8956d49e9a73`.

Both development web nodes now point to the final release and report its exact
ID from `/v1/health/ready`, with development data and all readiness checks
healthy. PHP lint passed. In Chrome, the existing generated test org opened
`/portal/?tab=viewer`, cleared its loading cover, rendered 17 sidebar apps
including GEO, and displayed the My Projects workspace. Production was not
changed. The development autoscale image still needs this release before a
new replacement node can serve it.

Rollback target: `6a58230d9d194b02da0af2d0685d323352e32e70` on each web
node. That release retains the missing-registry failure for expanded-access
organizations.
