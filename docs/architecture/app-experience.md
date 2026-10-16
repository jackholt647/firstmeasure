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
  time clock (`time_clock`, passed to the app as `time_clock_enabled`). Whether
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

`tests/access-gates.test.ts` records every route's, export's and action's gate,
and every app's devices and switches, in `tests/access-gates.snapshot.json`.
Accept a deliberate change with `UPDATE_ACCESS_GATES=1`.

## Rules

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
