# Remove GEO from the development platform registry — September 24, 2026

The shipped `external-apps.json` now has an empty `apps` list. The GEO frontend
snapshot remains in the repository, but PHP no longer discovers it, emits its
entry script, or serves its assets through the external-app gateway. The change
applies equally to ordinary and full-platform organizations. No organization
data or capability flags were changed.

Commit `c9bb07c2204098c7e2afbe0c023971034f52aca8` was based on the exact
development web release `295f63e9c0a80368a2a94fdc784b52e26ff85b89`.
Both serving development web nodes were cloned from that release with only
`external-apps.json`, the focused registry test, and registry documentation
overlaid. The payload SHA-256 was
`ccbc1fb817fc25e6a462be9d3117c37f49a8b17a81b7bae071f7f2f423a72002`.
Both nodes reported the new release ID and healthy development readiness.

The external-app regression tests passed (3/3). The navigation suite had four
failures in unrelated Money, Docs, Photos, and settings contracts; no navigation
source was changed in this release. A live Chrome session for the generated
full org showed the My Projects workspace with no GEO entry, script, or tab.
Opening the former `?tab=external_geo` route returned to `?tab=viewer`, and
`/external-apps/asset.php?app=geo&file=app.js` returned HTTP 404. The same
production asset URL returned HTTP 404 before this rollout; production was not
changed.

Rollback target on both development web nodes is
`295f63e9c0a80368a2a94fdc784b52e26ff85b89`. A future replacement web node
needs the new release in its autoscale image to preserve the removal. An
environment-specific `FIRSTMATE_EXTERNAL_APPS_CONFIG` can override the shipped
registry; no such override was found in the development PHP or systemd config.
