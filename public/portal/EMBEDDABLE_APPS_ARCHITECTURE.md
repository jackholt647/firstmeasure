# Embeddable Apps Architecture

## Purpose

FirstMate product UI is organized as embeddable apps: reusable browser-loaded modules that can mount in the portal sidebar, the project modal, settings pages, standalone pages, nested app regions, and future customer-specific surfaces.

Do not call these "project apps" unless an app is truly project-only. The project modal is only one host.

## Core Terms

- **Embeddable app**: a reusable module registered with `FirstMateEmbeddableApps`.
- **Host**: a shell that provides DOM roots, context, services, navigation, and permissions.
- **Surface**: where an app is mounted, such as `portal_tab`, `project_modal`, `settings_page`, `modal`, `ambient`, or `service`.
- **Region**: a named host slot such as `main`, `left`, `toolbar`, `overlay`, or `status`.
- **Host services**: explicit functions passed through `context.host`, `context.projectWorkspace`, or `context.services`.

## Runtime Files

```text
public/libraries/app-runtime/firstmate-embeddable-apps.js
public/libraries/app-runtime/firstmate-app-context.js
public/libraries/apps/firstmate-apps-manifest.js
public/libraries/apps/
```

`firstmate-embeddable-apps.js` owns app registration, manifests, dependency loading, context creation, extension hooks, stores, mount/unmount lifecycle, and diagnostics.

`firstmate-app-context.js` owns standalone/smoke context helpers. It is not a project-modal registry.

`firstmate-apps-manifest.js` is the canonical package manifest. Package files own their rendering and runtime registration.

The manifest also owns app eligibility and presentation policy. Hosts must ask
the runtime for eligible apps; individual tabs must not decide whether to
inject themselves.

## Registration

Apps register with `FirstMateEmbeddableApps.registerApp`.

Portal sidebar apps may use the convenience wrapper:

```js
window.Portal.apps.registerPortalApp({
  id: 'portal.viewer',
  tabId: 'viewer',
  title: 'My Projects',
  icon: 'fa-folder-open',
  surfaces: ['portal_tab'],
  regions: ['main'],
  mount(root, context) {}
});
```

Project modal apps register directly:

```js
window.FirstMateEmbeddableApps.registerApp({
  id: 'project.photos',
  kind: 'project_modal_app',
  label: 'Photos',
  surfaces: ['project_modal'],
  regions: ['main'],
  requiresContext: ['project'],
  panelHtml(){ return '<div id="rPhotoGallery"></div>'; },
  mount(context) {}
});
```

Left-region workflows are also apps:

```js
window.FirstMateEmbeddableApps.registerApp({
  id: 'firstmeasure.order',
  kind: 'project_modal_region_app',
  surfaces: ['project_modal'],
  regions: ['left'],
  panelHtml(context) {},
  mount(context) {}
});
```

Do not add a second tab registry. Do not add new app bodies to `public/portal/scripts`.

## Hosts

`public/portal/scripts/core.js` is the portal shell host. It discovers `portal_tab` apps from the runtime and renders sidebar links/panels. It does not own app content.

`public/libraries/apps/project-request/app.js` is the project modal host. It owns:

- modal open/close and route restoration,
- project workspace context,
- project save/autosave coordination,
- FirstMeasure order submission services,
- region placement for `left`, `main`, and `overlay`.

It does not own right-side tab app content. It discovers modal apps through:

```js
FirstMateEmbeddableApps.listApps({ surface: 'project_modal', project, host });
```

## Current App Packages

- `projects/viewer.js`: My Projects portal app.
- `photos/feed.js`: Photo Feed portal app.
- `photos/project.js`: project Photos modal app.
- `proposals/project.js`: project Proposals modal app.
- `project-map/app.js`: project Map modal app.
- `customer-portal/project.js`: project Customer Portal modal app.
- `project-schedule/panel.js`: project Schedule modal app.
- `measurements/project.js`: project Measurements modal app.
- `materials/project.js`: project Materials modal app and left workflow panel.
- `firstmeasure/order/app.js`: FirstMeasure order workflow for the project modal left region.
- `project-request/app.js`: project modal host and FirstMeasure order submission host services.
- `scheduling/app.js`: Scheduling portal app.
- `calls/app.js`: Calls portal app.
- `canvassing/app.js`: Canvassing portal app.
- `settings/company.js`: Settings portal app.
- `crew/app.js`: Crew global and project apps.
- `billing/app.js`: billing modal/service app.
- `help/app.js`: ambient support/help app.
- `onboarding/wizard.js`: onboarding modal app.
- `promo-inject/app.js`: promotion ambient/modal app.
- `referrals/app.js`: referrals ambient/modal app.
- `pricebook/bridge.js`: pricebook service app.
- `tutorial/app.js`: dormant tutorial ambient app.

## Context Contract

Every mounted app receives a normalized context:

```js
{
  appId,
  surface,
  chrome,
  roots,
  root,
  mainRoot,
  leftRoot,
  overlayRoot,
  entityType,
  entityId,
  project,
  projectId,
  customer,
  customerId,
  orgId,
  branchId,
  route,
  params,
  host,
  projectWorkspace,
  store,
  services,
  featureFlags,
  permissions,
  applicationAccess,
  appEntitlements,
  roleIds,
  device,
  presentation,
  layout
}
```

Apps should use `context.store`, `context.host`, `context.projectWorkspace`, and named `context.services` entries. A dependency on host services must be explicit and app-specific.

## Regions

Hosts declare available roots. Apps declare supported regions.

- `main`: primary app body.
- `left`: project modal left workflow/sidebar region.
- `toolbar`: app-specific controls.
- `overlay`: modals, viewers, signing, media pickers.
- `status`: status/footer regions.

The project modal currently mounts:

- `firstmeasure.order` into `left`.
- `project.map`, `project.photos`, `project.customer_portal`, `project.schedule`, `project.proposal`, `project.materials`, and `project.measurements` into right-side `main` tab panels.

## Dependencies And Extensions

Apps declare hard dependencies with `dependencies` and optional relationships with `optionalDependencies`.

Customer-specific or vertical-specific behavior should usually be an extension:

```js
FirstMateEmbeddableApps.registerExtension({
  id: 'electrician.photos.schedule_patch',
  targets: ['project.photos', 'project.schedule'],
  dependencies: ['project.photos', 'project.schedule'],
  surfaces: ['project_modal'],
  hooks: {
    transformContext(context){ return context; },
    transformRenderModel(model, context){ return model; }
  }
});
```

Load order is:

1. runtime,
2. manifest,
3. app packages and dependencies,
4. host context,
5. base app mount,
6. extensions/hooks.

Feature flags describe organization capabilities and rollout state. Access
roles describe data/action permissions. App entitlements describe whether a
view is relevant enough to inject. These are deliberately separate: a Super
Administrator may have unrestricted data permissions while inheriting a
hidden Clock In view.

An app manifest may constrain `applicationsAny`, permissions, roles, user
types, devices, or feature flags. The resolved entitlement can then override
visibility, parameters, layout, and the default home app. Both `listApps()` and
direct `mount()` enforce the same policy.

Project-modal presentation supports per-app left-column and mobile navigation
rules. Crew project apps use no left region, icon-only tabs on mobile, and an
always-fullscreen mobile modal without a redundant fullscreen control.

## Crew Apps

`crew/app.js` owns the field experience. Its global apps are Today, Schedule,
Receipts, and Payouts. Schedule uses the shared `platform-schedule-view`
calendar for List, Day, short-range, Week, and Month views; Crew intentionally
does not receive the routing view. Calendar queries use the assigned-work facade
in `public/v1/workforce/crew_api.ts`. The portal's global search uses the shared
Crew assignment scope before matching projects or contacts. Its project apps are
Overview, Materials, Payouts, Payments,
Change Orders, and Checklist. Field users never receive the general project-
management API as a shortcut.

## Rules For Future Work

1. Register new reusable UI as an embeddable app in `public/libraries/apps`.
2. Use `Portal.apps.registerPortalApp` only for portal sidebar apps.
3. Use `FirstMateEmbeddableApps.registerApp` for modal, settings, ambient, service, and nested apps.
4. Do not add project modal tabs or panels directly to `project-request/app.js`.
5. If an app needs the project modal left side, declare `regions: ['left']` or `regions: ['main', 'left']`.
6. Keep app-specific state inside the app package or its API library.
7. Keep shared project-modal behavior in explicit `projectWorkspace` host services.
8. Do not read or write another app's private state unless the dependency is declared.
9. Route state owned by an app should be namespaced to that app.
10. Every app must be disposable through its mount handle.

## Verification

Independent-load smoke coverage lives at:

```text
public/libraries/apps/smoke/independent-load.html
```

A package is considered properly segmented when it can mount independently with only its declared dependencies and a valid host context.

Browser verification should cover:

- opening the project modal from My Projects,
- opening the project modal from Photo Feed,
- switching Map, Photos, Proposals, Customer Portal, Schedule, and Measurements,
- the FirstMeasure order workflow in the left region,
- closing the modal after app failures,
- portal sidebar apps rendering through `portal_tab` discovery.
