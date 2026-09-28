# External FirstMate apps

`external-apps.json` is the host's list of optional external project directories.
Relative directories resolve against the registry file's directory. Absolute
Windows and Linux paths are supported. Set `FIRSTMATE_EXTERNAL_APPS_CONFIG` in
the PHP server environment to use a different registry on another machine.

```json
{
  "version": 1,
  "apps": [
    { "id": "example-app", "directory": "/srv/firstmate-labs/example-app", "enabled": true }
  ]
}
```

Each project owns `firstmate-app.json` and `frontend/`. See the GEO directory
for the starting package. IDs use lowercase letters, numbers, and hyphens,
starting with a letter. The registry ID must match the package manifest ID.

The entry script calls `FirstMateExternalApps.define(id, factory)`. The factory
receives `{ assetUrl }` and returns an app implementation with `mount(context)`.
Use `assetUrl('images/example.png')` for further assets; relative URLs resolve
against the portal, not the source directory. Bundle imports into the entry
script or load additional files explicitly through `assetUrl`. CSS URLs also
need explicit gateway URLs. Only files inside `frontend/` with approved static
extensions can be served; dotfiles, traversal, and symlink escapes are rejected.
Never put credentials or private data in `frontend/`.

The portal registers external apps synchronously before boot, using the existing
runtime, management access policy, sidebar placement, and navigation. GEO's app
ID is `portal.external_geo`; its tab is `external_geo`. Visit
`/portal/?tab=external_geo` on your local FirstMate server. Normal session and
management access rules still apply. Registration does not create a new paid
capability or a marketplace install/setup workflow.

Missing/disabled directories, malformed registries/manifests, and missing entry
files are skipped on every page load. Discovery does not build or copy a bundle. A package may be supplied
by an independent deployment or the explicit snapshot described below. If an asset disappears after discovery, it returns 404; a missing factory
is not registered. A synchronous factory failure is contained to that package.
Mount failures show an unavailable message inside the tab. Removing a directory
does not unload JavaScript already running in an open page; reload to rediscover.
External code runs in the portal's JavaScript environment, not a security sandbox.

Keep UI, tests, backend source, and build configuration in the external project.
Only host integration belongs here. New API services are not automatically
executed or publicly routed by this registry. When GEO needs its own backend,
run that service independently and add an explicit same-origin API proxy with
FirstMate session/organization validation. The static gateway never executes
external PHP or server code.

For production, deploy the external project separately and point the PHP
registry at its readable directory. The same gateway works without symlinks or
new NGINX aliases. Ensure PHP can read that location (including any open_basedir
or container mount restrictions). An absent project is simply omitted.

Run host regression coverage with `node --test tests/external-apps.test.mjs`
from the repository root, plus `npm run test:navigation` from `public/v1`.

## Combined FirstMeasure checkout

The combined checkout retains the GEO starter frontend snapshot under
`external-apps/packages/geo`, but the shipped `external-apps.json` has no enabled
packages. GEO is therefore absent from the portal for every organization,
including full-platform organizations. Its original authoring directory remains
independent; see the snapshot's `SOURCE.md` for file hashes. No GEO backend is
provided by its current source. An environment-specific
`FIRSTMATE_EXTERNAL_APPS_CONFIG` can select a different registry. The portal
only renders selected external packages for users with expanded-platform access.
