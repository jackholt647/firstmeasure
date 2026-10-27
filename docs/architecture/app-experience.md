# App experience

Which apps a person has, on which devices, with which options. This is one
system. There is no management application and no field application, and no
office-versus-field distinction anywhere in the platform. A role simply gives
different apps in different places.

Permissions are a separate question. App experience decides whether someone
has an app at all. What they may do inside it is the app's own permissions
([permissions and agents](permissions-and-agents.md)), which the app reads
for itself.

## The parts

| Part | Where | What it is |
|---|---|---|
| Device types | `public/v1/platform/app-experience/devices.ts` | Data. Each type has an id, a label, an icon and the rules a browser uses to sort itself into it. Today: `desktop` and `mobile` (Phone). |
| App registry | `public/v1/platform/app-experience/registry.ts` | Every app a person opens: portal tabs (`portal_tab`), project window views (`project_modal`) and contact window views (`contact_modal`). |
| Resolver | `resolveAppEntitlements` in `public/v1/workforce/access.ts` | Turns the registry, the organization's switches and a person's layers into one entitlement per app. |
| Gate | `requirePlatformAuth({ app })`, `AccessPolicy.app` | A route or published operation that belongs to an app needs that app. |
| Editor | People › App experience (`public/libraries/apps/people/app-grid.js`) | One grid for a role, a group, a department and a person. |

### An app declares

- `devices`: the device types a version of it exists on. A person is never
  shown an app on a device it does not list, and the grid shows that cell as
  absent. Doc Studio, Web Editor and Training Studio are desktop only.
- `capabilities`: the organization switches it belongs to. An app is off for
  everyone while all of its switches are off. It is then left out of the
  catalog, out of every entitlement, and out of the grid. Nobody is asked
  about an app the organization does not use.
- `default_visible`: what a person whose layers say nothing gets.
- `options`: settings of the app that are not permissions, such as Today's
  time clock (`time_clock`, passed to the app as `time_clock_enabled`). Overview
  and Reports have a "Project window tab" option (`tab`, passed as
  `show_as_tab`): off, the person keeps the app (its routes, Overview's map as a
  report order's pin canvas) but it is not a tab; anything asking for it lands
  on the first tab, with Reports' measurements in the project details tray. Whether
  someone clocks in is about how they are paid, not about what they are
  allowed to do.
- `parameter_permissions`: app parameters that carry one of the viewer's
  permissions (`can_upload` from `crew.receipts.upload`). These follow the
  permission and are not App experience.

To add a device type (a tablet, say), add a row to `DEVICE_TYPES` with its
sorting rules, then list it in the `devices` of the apps that have a version
for it. Roles, groups, departments and people can then set it, and nothing
else changes.

To add an app, add it to the registry and register the runtime app with the
same id. `tests/app-experience-registry.test.ts` fails when the
manifest and the registry disagree.

## Resolution

Each app is resolved once per device it exists on. A layer that leaves a
device or option out says nothing, so the layer below decides:

1. The app's `default_visible`, or the option's `default`.
2. Roles. These add up: the person gets the app if any of their roles shows
   it. A role that says nothing about an app contributes the default.
3. Groups (`resource_groups.attributes_json.app_defaults`) and departments
   (`app_defaults` in the department catalog). When any of them says
   something, it decides; any one showing the app is enough.
4. The person's own setting (`app_access_overrides` on the user).
5. A group or department that restricts the app (`restricted: true`) hides
   it on every device. The server also refuses its routes (`hasAppEntitlement`).

Every layer stores the same shape for an app:
`{ visible: { <device type>: boolean }, options: { <key>: boolean }, params, layout }`.
A group or department setting may also carry `restricted`.

An entitlement (`EffectiveAppEntitlement`) carries `visible` per device,
`visible_devices`, `allowed` (shown on at least one device), `option_values`,
the resolved `params` and `layout`, and where each device's answer came from
(`sources`).

Group types do not hold app settings of their own. A group type gives roles
on joining (`member_role_ids`), and those roles bring their apps
([assignee base](assignee-base.md)).

## The browser

### Offered apps

Photos, Documents, Customer Portal and Materials begin as pending offers in new
organizations (`global.data.app_offers`). The configured organization switches
are still the ceiling: an off or commercially unavailable app is not advertised.
Existing organizations without this field retain their current active apps.
The welcome definitions and capability groups live in `app-experience/offers.ts`.
Feed (`platform.photos_feed`) is an independent app: an offered project Photos
app never disables the organization Feed.

Money (its project tab `project.money` and its Financials page
`portal.financials`) and Checklists (`project.checklists`) can also be offered,
but no new organization starts with them (`NEW_ORGANIZATION_APP_OFFERS`). A
signup sandbox configuration names its own offers as data
(`settings.app_offers`, written after the demo content is seeded); the MVP
platform offers both. Offers with the same switches are one app: starting
either Money offer starts both. A welcome may name a `setup` switch (Money:
`platform.money`); Get Started then continues into that switch's required
setup workflow (`Portal.appSetup.run`, mode `post_add`), which for Money starts
with payments onboarding. Its welcome says "Setup required". Once started, an
app whose required setup (its switch's, or the nearest parent switch's, so
Financials follows Money) is not complete shows a "Setup required" pill on its
project tab and left-column link (`Portal.appSetup.pendingFor`, `tab-guides.js`).

`capabilityAccessState` resolves offered discovery and operational capabilities
from the same organization snapshot. Pending capability groups are masked before
dependency resolution, so integrations and dependent features remain off. Exact
offered app IDs join the entitlement catalog, then follow the usual role,
department, group, user and device visibility rules. Their entitlement carries
`offered` and `welcome`. Discovery never grants operational app access.

The embeddable runtime mounts the shared `app-runtime/app-welcome.js`
advertisement while preparing the offered app's bundles in the background. Code
registration does not mount the app or read its operational data. Get Started
activates the app, refreshes guide eligibility before the host redraw, and
crossfades into the mounted app. The explicit start skips the normal setup delay. It has designed HTML
and CSS, real localized copy and a Get Started button; it is not a new guide
engine. Opening it neither records `seen_tabs` nor launches a guide, and New
remains visible regardless of personal seen history.

`POST /v1/platform/organizations/:orgId/app-offers/:appId/start` requires a
verified organization session, CSRF, and an app the caller can see. Anyone with
that visibility can currently activate it; `mayStartOfferedApp` is the single
policy point for later permissions. The writer atomically removes only that
offer and records who started it. It never enables a configured-off switch.
Repeated or concurrent acceptance is harmless. Session/capability refresh then
mounts the real app and lets the existing guided-experience runtime run its setup
or tour. Other sessions see the organization state on their next refresh.

Public signup initializes pending offers; sandbox signup does so after seeding
sample content. Development operators may reset selected welcome screens with
`PUT /v1/platform/organizations/:orgId/app-offers` and `{ apps: [...] }`; this
reset endpoint refuses production. It does not erase any app data.

Tests: `app-offers.test.ts`, `app-experience.test.ts`, and
`app-welcome-browser.test.mjs`.

The session (`GET /v1/platform/auth/session`) returns `app_entitlements` and
`app_experience: { device_types, app_ids }`. The runtime
(`app-runtime/firstmate-embeddable-apps.js`) sorts the browser into one device
type with the same rules and shows an app only where its entitlement says it is
shown on that device. An app the platform declares (`app_ids`) that has no
entitlement is one the organization has off. The apps launcher lists only the
apps the person has on this device. Contact window tabs follow
`contact.projects`, `contact.media` and `contact.docs`.

Manifest entries and app bundles do not declare their own visibility. They
carry no application, device or permission rule for whether they appear.

## The apps overlay

The apps overlay (the advanced app menu) lists what a person can open as an
app: the portal tabs they have on this device (`appLauncherEntries` in
`portal/scripts/core.js`). A registry portal tab is listed unless it says
`launcher: false` (Settings and the Assistant, which have their own controls);
the session sends the listed ids as `app_experience.launcher_app_ids`. Project
and contact window views, trays, banners and promotions are not portal tabs, so
they never appear, and neither does a switch that only turns on other apps. An
app whose organization placement is `hidden` is not offered there either.

Choosing an app opens it. Only when the app's switch declares a `required`
setup workflow whose status is not `complete` does its setup run instead.
Adding apps the organization has off is the separate catalog
(`appCatalogEntries`, the capability nodes of kind `app`), reached from
"Manage apps and features".

An app whose home is elsewhere can still be a page here: Pricebook
(`portal.pricebook`) lives in Settings and its portal tab opens the same
renderer full screen. Its manifest entry says `placement: 'more'` and
`placementWithoutAppsMenu: 'settings'`, so without the apps overlay it is only
in Settings.

## The mobile top bar

On a phone (the portal at 820px or narrower) the bar above search shows the
open app's icon and title. Both come from the app's registry and manifest
entry, the same `icon`, `title` and `terminologyKey` its left-column link
uses (`renderMobileHeader` in `portal/scripts/core.js`), so every portal tab
gets them with no code of its own. An app therefore does not repeat its icon
and title at the top of its content on phones. While it is open, an app may
change what the bar shows:

```js
Portal.mobileHeader?.set('portal.viewer', { title, icon, actions });
Portal.mobileHeader?.clear('portal.viewer');
```

The key is the app id or the tab id. `title` and `icon` replace the registry
values (`icon: ''` shows none), and `actions` is a node of compact icon
buttons shown beside the title. A setting stays with its app and applies
whenever that app is the open one.

The More (⋯) button opens a bottom sheet with every desktop top bar action:
the assistant, To Do, messages, notifications, the phone and development
tools. Each entry is shown exactly when its desktop control is, so a phone and
a desktop offer the same actions, all decided by the organization's switches
(`topbar.todos`, `apps.assistant`, `apps.channels`, the phone's calling
setup) and never by a configuration. A script that adds a top bar action adds
its phone entry as a `.ptb-more-item` in `#mobilePlatformMoreMenu`, naming its
group with `data-more-group` (`work`, `inbox`, or the default `tools`), and
hides it with `hidden` whenever its desktop control is hidden.

Where the More menu opens is the organization's `topbar.phone_menu` setting:
`bottom` (the default) is the sheet, `top` a dropdown at the top right. What
it opens comes from the bottom either way, as the project window's trays do
([project content layout](project-content-layout.md#phone-trays)). Messages,
notifications, To Do and development tools are bottom sheets in the top
layer, one at a time, each with a drag handle, a title with Close, and an
animated open and close. The assistant is the project window's agent bar
(`FirstMateAgentBar` in `project-trays.js`) on the person's main conversation
([global assistant](global-assistant.md#portal-window-and-app-entry)). A
script with another top bar action opens it on a phone with
`Portal.topbar.phoneSheet({ id, label, onClosing, onClosed })`, which returns
the sheet's `body`, `open` and `close`; removing `visible` from a sheet closes
it the same way. Desktop keeps its dropdowns and windows. Run
`tests/mobile-shell-browser.test.mjs` and
`tests/mobile-topbar-trays-browser.test.mjs` for changes here.

## Left-column pins

Whether a whole app sits in the left column is the organization's placement
(`app_placements`, set from the apps overlay's pin by someone who may change
it). An app may also declare views a person can pin on their own as
`subviews` on its manifest entry: `{ id, label, icon, route, requires }`,
where `route` holds the app's route params (My Projects:
`{ projectView: 'map' }`) and `requires.appFlags` lists the app flags the view
needs. A pinned subview is a personal preference, `left_column_pins` on
`/me/preferences`, stored as `"<app id>:<subview id>"`, so it survives reloads
and follows the person to their phone. It shows only while the person has the
app and its flags are on, and opens the app with its route.

`public/libraries/left-column-pins/left-column-pins.js` owns this: the
subview list, the personal pins, the subview links in the left column, the
roll-out of an app's subviews in the apps overlay (hover or focus; a disclosure
button on touch) and dragging. With the advanced app menu on, dragging an
overlay tile, a subview row, or any button marked `data-app-subview="<app
id>:<subview id>"` onto the left column pins it: an app through the same
placement write as its pin, a subview as a personal pin. Every drag has a pin
button that does the same thing from the keyboard. While the apps overlay is
open, a collapsed column that stays collapsed widens slightly so each pin sits
beside its icon. Never special-case an app in the launcher: declare subviews
on the manifest entry.

## The server

`requirePlatformAuth({ app: [...] })` refuses with `app_access_denied` unless
the person has at least one of the named apps on some device. Published data
and actions use `AccessPolicy.app` in the same way (`publication_app_denied`).
A route that belongs to an app names it, so a person who does not have
Canvassing cannot reach the canvassing API. Routes that belong to no single
app (sign-in, notifications, search, the event stream) are gated by sign-in
and their own permission and resource checks.

Without expanded access, nobody has roles. Everyone then gets each app's
default, and app gates pass, which keeps FirstMeasure's original
seven-permission behavior.

Search, presence, receipts and the New button take "works with every project"
from the permissions `view_projects` or `manage_projects` (`seesEveryProject`).
Anyone else sees only the projects they are assigned to.

## Global search

The top bar search offers only result types the organization has. Each source
of results declares, in `public/v1/platform/search/result-types.ts`
(`SEARCH_SOURCES`), the switches it needs and the app its results open; a
source is offered when every switch is on and its app is offered here (switch
on, in the person's app experience, placement not `hidden` or `settings`). A
source that needs data to be worth searching says so (`available`). Scopes are
offered only with expanded access and My Projects on, to someone who may open
Settings › Project Scopes (`manage_company_settings`), and only while more than
one scope template is switched on in the branch: an organization that runs a
single scope never chooses one. `GET /organizations/:orgId/search/types`
returns the offered types and sources; `/search` drops project or contact
results the organization does not have, whatever was asked for, and the top
bar shows filters and runs browser providers only for offered ones. Add a
searchable thing as a source with its requirements; never check an
organization or configuration by name. Project notes are found through their
project, not as channels. Run `tests/global-search-types.test.ts` and
`tests/settings-search-contract.test.mjs` for changes here.

`tests/access-gates.test.ts` records every route's, export's and action's gate,
and every app's devices and switches, in `tests/access-gates.snapshot.json`.
Accept a deliberate change with `UPDATE_ACCESS_GATES=1`.

## Rules

Operations uses the existing `project.materials` app id. Its welcome advertisement
activates the organization offer only after Get Started, then opens the shared
Operations guide. The guide can offer Equipment globally as `portal.equipment`
without activating `apps.equipment`; that sidebar entry retains New until its
Get Started action activates it for the organization. A resource column is
separate from app visibility: initial Operations setup keeps Labor hidden until
configured and Equipment hidden until its capability is active. Existing saved
column settings and existing labor work remain visible.

- Do not add an application id, an office or field flag, or a role
  "application". Show different apps to different roles in App experience.
- Do not hide an app because of a permission. Check the permission in the app
  or its routes.
- Do not declare visibility in a manifest entry or app bundle. Add the app to
  the registry.
- A setting that changes how an app behaves for someone, and that is not
  about what they may do, is an app option. It is not a permission.
- Run `tests/app-experience.test.ts`, `tests/access-gates.test.ts` and
  `tests/app-experience-registry.test.ts` for changes here.
