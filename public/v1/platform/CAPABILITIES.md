# Capability Registry

Every org-level app, feature flag, setting, and user-grantable permission is a
node in one dependency graph: the capability registry. The registry is the
single source of truth for:

- what can be turned on/off per organization (`kind: "app" | "feature" | "setting"`)
- which permission keys exist, what they mean, and which app they belong to
  (`kind: "permission"`)
- dependency rules between all of the above (`parent` and `requires`)
- the Features & Apps settings tab, presets, and the permission-set UI —
  all of which render **directly from the registry**. Adding a node here makes
  it appear everywhere automatically; no UI changes are needed.

## Files

| File | Role |
| --- | --- |
| `capabilities.ts` | Types, registration, boot validation, solver, value storage, presets |
| `capability_defs.ts` | Built-in node declarations (the full catalog) |
| `app_flags.ts` | Legacy compatibility layer derived from the registry |
| `auth.ts` (`can`, `requireCapability`) | The unified gate |

## Adding a capability

Declare it in `capability_defs.ts` (or call `registerCapabilities()` from your
module before the API boots):

```ts
registerCapabilities([{
  key: "myapp.cool_feature",       // two-segment group.flag key (storage shape)
  kind: "feature",
  parent: "apps.myapp",            // child of: off when the parent is off
  requires: ["platform.scheduling"], // cross-cutting deps (non-ancestor nodes)
  label: "Cool Feature",
  description: "What it does.",
  default: false
}]);
```

The registry validates at import time: unknown `parent`/`requires` targets,
duplicate keys, dependency cycles, malformed keys, and permission nodes without
`permission_key`/`access` all **throw at server boot** (and in every test run),
so an invalid graph can never resolve inconsistently at request time.

### Node kinds

- **app** — a top-level product surface. Set `runtime_app_id` to the embeddable
  app id it gates; the app runtime hides that app when the node is off.
  Top-level nodes also declare `category` — the section they render under in
  the Features & Apps tab (section order follows registration order).
- **feature** — an org-level boolean nested under an app/feature.
- **setting** — a tuning value (`boolean`, `number`, or `select`). Use
  `category` to group top-level settings in the UI.
- **permission** — a user-grantable action. Declares `permission_key` (the
  string checked by `hasPermission`) and `access: "read" | "write"`. Permission
  nodes are not stored per org; their parent chain determines org availability
  and roles/overrides determine the user grant.

### Discoverability & the add-apps catalog

App nodes (`kind: "app"`) may declare `discoverable: false` to be excluded
from the org-facing **add-apps catalog** — the sidebar's More Apps menu and
the Manage My Apps view under Settings → Features & Apps. The catalog
(`Portal.appCatalog` in `portal/scripts/core.js`) lists every discoverable app
node; apps whose capability currently resolves off show as *addable* and open
a detail modal with an "Add to Platform" action that enables the node plus any
off parents/`requires`. Use `discoverable: false` for deprecated apps
(`platform.proposals`), system surfaces (`apps.billing`), and beta apps that
an org may have enabled but should not self-serve.

This is a separate axis from enablement: the capability value controls whether
the org *has* the app; `discoverable` controls whether the org is *offered*
it. Apps that need configuration after being added can register a setup
workflow with `Portal.appSetup.register('<capability key>', handler)` — it
runs instead of the default jump-to-tab hand-off after "Add to Platform".

### parent vs requires

Both resolve identically (a node is effective only when every edge target is
effective; reasons read `requires <key>`). They differ in meaning and UI:
`parent` is a child relationship (nested in the settings tree, "sub-feature"),
`requires` is a cross-cutting dependency (shown as a linked chip).

## Gating code

Server — one call, org + user in a single check:

```ts
import { can, requireCapability } from "../platform/auth.js";
if (!(await can(ctx, "permission.manage_projects"))) throw forbidden(...);
// or declaratively on a route:
await requirePlatformAuth(request, { orgId, capability: "platform.proposals" });
```

Client:

```js
Portal.can("platform.proposals")           // org has it (and user may act, for permission nodes)
Portal.capabilities.value("platform.free_storage_gb", 1)
Portal.capabilities.reason("platform.materials") // "requires platform.pricebook" | null
```

Legacy calls keep working — `isAppFlagEnabled(orgId, "platform", "proposals")`
and `Portal.appFlags.has('platform','proposals')` resolve through the same
registry and the same stored document (`global.json` → `data.app_flags`).

### Gating an app surface (portal tab / project modal app)

Portal tabs and project-modal apps are gated through the manifest: add your
app id to the `appCapabilities` map in
`public/libraries/apps/firstmate-apps-manifest.js`. The embeddable runtime
(`capabilityAllowsApp` in `firstmate-embeddable-apps.js`) hides the surface
whenever the mapped capability resolves off — live, no reload. Settings
sub-tabs are gated in `settings/company.js` with `appFlag(group, flag)`
alongside the permission check (see `canPayroll`, `canCrm`, `canCrews`).
Server APIs use the `capability:` option on `requirePlatformAuth` (see
`training/api.ts`, `payroll/api.ts` for the pattern).

## Presets

A preset is a complete org configuration (flat `key -> value` map). Built-ins
live in `builtinCapabilityPresets()`; custom presets are stored in
`{platformStorageRoot}/config/capability_presets.json` and managed from the
settings tab or the `/organizations/:orgId/capabilities/presets` endpoints.
Applying a preset turns every boolean node not named by the preset **off** and
resets unnamed value nodes to their defaults. The signup preset
(`capability_signup_preset.json`) shapes every newly registered organization;
the legacy operator file `app_flag_defaults.json` still wins when present.

Preset saves are validated by the solver. Dependency violations do not block
storage (the solver keeps unsatisfied nodes off at resolve time) but they are
reported so the UI can surface them.

## Permission sets

Permission sets are the existing workforce access roles
(`workforce_access_roles`). The registry's permission nodes drive the
permission-set UI (grouping by app, read/write badges, org availability), and
`resolveAccessProfile()` continues to compute effective per-user permissions
from `access_role_ids` + `permission_overrides` (individual overrides always
win over the set).
