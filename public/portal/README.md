# Portal Development Guide

This portal is built around embeddable apps. A reusable UI surface should be an app package under `public/libraries/apps`, then mounted by a host such as the portal sidebar, project modal, settings page, standalone page, or another app.

The project modal is only one host. Do not treat embeddable apps as project-only unless the app truly requires a project context.

## Start Here

- `EMBEDDABLE_APPS_ARCHITECTURE.md`: full architecture rules, host/surface terminology, app lifecycle, extension points, settings, and testing expectations.
- `../libraries/apps/README.md`: package layout, current app inventory, and project modal pane ownership.
- `../libraries/apps/firstmate-apps-manifest.js`: canonical manifest for shipped app packages and their dependencies.
- `../libraries/app-runtime/firstmate-embeddable-apps.js`: runtime registry, dependency loading, context creation, mount/unmount lifecycle, hooks, stores, and diagnostics.
- `../libraries/app-runtime/firstmate-app-context.js`: standalone and smoke-test context helpers.

## Current Architecture Status

The portal and project modal app loading paths are on the embeddable app architecture. New work should not add transitional adapters, alternate tab registries, or hard-coded project modal pane lists.

Some older domain code may still expose compatibility names or data fallbacks for external APIs and historical records. That is separate from the app-loading architecture.

## Where Code Belongs

- `public/libraries/apps/<package>/`: embeddable app packages and package-owned UI.
- `public/libraries/<domain>-api/`: reusable API clients or data modules that are not themselves apps.
- `public/libraries/app-runtime/`: shared runtime primitives used by apps and hosts.
- `public/portal/scripts/`: portal host shell only, such as navigation, topbar, project viewer shell services, overlays, and host orchestration.
- `public/portal/index.php`: script inclusion order and server-rendered portal shell.

Do not add new product app bodies to `public/portal/scripts`. Put the app in `public/libraries/apps`, include its bundle from `index.php` when needed, and register it through the embeddable runtime.

## Adding Or Changing An App

1. Create or update a package under `public/libraries/apps/<package>/`.
2. Register the app with `FirstMateEmbeddableApps.registerApp`.
3. For portal sidebar tabs, use `Portal.apps.registerPortalApp`, which registers a `portal_tab` app with the runtime.
4. Add or update the app manifest entry in `../libraries/apps/firstmate-apps-manifest.js`.
5. Declare required surfaces, regions, context, dependencies, settings keys, and extension hooks.
6. Keep app-specific rendering and state inside the app package.
7. Use explicit host services for shared shell behavior. Do not reach into sibling app internals.
8. Verify the app through the independent-load smoke harness and an in-browser portal flow.

## Project Modal Rules

Project modal right-side panes are normal embeddable apps with `surface: 'project_modal'` and `region: 'main'`.

The FirstMeasure order workflow is also an app. It mounts in the project modal left region through `surface: 'project_modal'` and `region: 'left'`.

The project modal host lives in `../libraries/apps/project-request/app.js`. It owns modal open/close behavior, project hydration, route synchronization, shared project workspace services, and mounting apps into left/main regions. It should not own the inner UI for photos, proposals, maps, customer portal, scheduling, measurements, or FirstMeasure ordering.

## APIs, Settings, And Feature Gates

Package-owned API calls can live inside the package when they are only used by that app family. Shared API clients should live in a top-level `public/libraries/<domain>-api` library.

App settings should be declared and read through the app/runtime context. Customer-facing settings, internal organization settings, and feature gates should be named explicitly so hosts and future patches can distinguish them.

Feature flags decide whether capabilities are available. Settings provide app configuration, including non-boolean or mutually exclusive options.

## Extensions And Patches

Vertical/customer-specific behavior should be implemented as runtime hooks, extensions, settings, or separate app packages with explicit dependencies. Patches should load after their base app and should not modify base app files unless the behavior is truly universal.

Avoid implicit load-order coupling. If one app or patch requires another, declare that dependency in the manifest or app registration.

## Testing Before Calling Work Done

Run syntax checks for changed JavaScript files.

Run the independent app smoke harness:

```text
http://127.0.0.1:<port>/libraries/apps/smoke/independent-load.html?autorun=1
```

Then verify the real browser workflows affected by the change. For project modal work, test at least:

- Opening a project from My Projects.
- Opening a project from Photos.
- Switching every project modal tab.
- Closing and reopening the modal.
- Any left-region workflow affected by the change.

The app architecture is only considered healthy when apps can load independently with their declared dependencies and still work correctly inside their real host.
