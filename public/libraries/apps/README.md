# FirstMate App Packages

This directory contains embeddable FirstMate app packages. New reusable product surfaces should live here instead of `public/portal/scripts`.

## Runtime

Apps are discovered, registered, and mounted through:

```text
public/libraries/app-runtime/firstmate-embeddable-apps.js
public/libraries/app-runtime/firstmate-app-context.js
```

The canonical package manifest is:

```text
public/libraries/apps/firstmate-apps-manifest.js
```

The manifest records app ids, package folders, surfaces, context requirements, and bundle paths. Concrete package files still own their real rendering and registration behavior.

Independent-load smoke coverage lives at:

```text
public/libraries/apps/smoke/independent-load.html
```

That page loads each manifest app in a fresh iframe with only its declared dependencies plus a smoke host/context. A new app is not considered segmented until it passes there.

## Package Layout

Use one top-level package folder per product surface or tightly related app family:

```text
public/libraries/apps/photos/
public/libraries/apps/proposals/
public/libraries/apps/settings/
public/libraries/apps/scheduling/
```

Multiple app variants can live in the same package when they share domain code:

```text
public/libraries/apps/photos/feed.js
public/libraries/apps/photos/project.js
```

## Portal Scripts Boundary

`public/portal/scripts` is now reserved for the portal host shell:

```text
core.js
topbar.js
project_viewer.js
dev_overlay.js
```

Do not add new app bodies to `public/portal/scripts`. Put them in this directory and register embeddable apps with `FirstMateEmbeddableApps.registerApp` or the portal convenience wrapper `Portal.apps.registerPortalApp`. The portal shell discovers `portal_tab` apps from the embeddable runtime; apps must not register themselves through the shell tab renderer. Project modal apps are discovered through the same runtime and must not use a separate tab registry.

## Current Packages

- `projects/viewer.js`: My Projects portal tab.
- `photos/feed.js`: global/project-filtered photo feed tab.
- `photos/project.js`: project modal photos app.
- `proposals/project.js`: project modal proposals app.
- `materials/project.js`: project modal materials app and left workflow panel.
- `project-map/app.js`: project map pane app.
- `customer-portal/project.js`: project customer portal pane app.
- `project-schedule/panel.js`: project schedule pane app.
- `measurements/project.js`: project measurements/report-results pane app.
- `firstmeasure/order/app.js`: FirstMeasure report-order workflow for the project modal left region.
- `project-request/app.js`: project modal host, route/open/close orchestration, and project workspace host services.
- `scheduling/app.js`: Scheduling portal tab.
- `calls/app.js`: Calls portal tab.
- `canvassing/app.js`: Canvassing portal tab.
- `settings/company.js`: Settings portal tab.
- `billing/app.js`: billing modal/service app.
- `help/app.js`: ambient support/help widget.
- `onboarding/wizard.js`: onboarding modal app.
- `promo-inject/app.js`: credit promotion ambient/modal app.
- `referrals/app.js`: referrals ambient/modal app.
- `pricebook/bridge.js`: pricebook service bridge.
- `tutorial/app.js`: dormant tutorial ambient app.

## Project Modal Panes

Photos, proposals, materials, map, customer portal, schedule, and measurements are native `FirstMateEmbeddableApps` project modal apps. The FirstMeasure order workflow is also an app, mounted into the project modal's `left` region. The project modal renders right-side tabs and left-region apps from `FirstMateEmbeddableApps.listApps({ surface: 'project_modal', ... })` instead of a hard-coded pane list or separate registry.

Project-only panes may call `project-request/app.js` through the explicit `projectWorkspace` host services for shared modal services such as the active project, feature/pricing gates, route synchronization, autosave, and report-order submission state. App-specific rendering/state belongs in the app package: map pins in `project-map`, portal media state in `customer-portal`, scheduling drafts in `project-schedule`, and measurement assets/tabs in `measurements`. A host-service dependency must be named and intentional, never an accidental sibling-app dependency.
