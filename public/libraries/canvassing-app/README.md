# Canvassing App UI Library

`libraries/canvassing-app/canvassing-app.js` owns the reusable mobile canvassing interface. It renders the shared map, pin sheet, status legend, pin create/update/promote behavior, and manager/user screen.

It deliberately does **not** own authentication. A host app authenticates with `PlatformAPI`, fetches a Platform session, then mounts this renderer.

Backend/API layers:

- Canvassing API backend: `public/v1/canvassing/api.ts`
- Canvassing API browser client: `public/libraries/canvassing-api/canvassing-api.js`
- Reusable UI renderer: `public/libraries/canvassing-app/canvassing-app.js`
- Standalone wrapper app: `public/apps/canvassing/`

## Usage

Load dependencies first:

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="/libraries/platform-api/platform-api.js"></script>
<script src="/libraries/canvassing-api/canvassing-api.js"></script>
<script src="/libraries/canvassing-app/canvassing-app.js"></script>
```

Mount after authentication:

```js
const session = await PlatformAPI.auth.session();

const app = await FirstMateCanvassingApp.mount({
  root: document.getElementById('app'),
  session,
  platformApi: PlatformAPI,
  canvassingApi: CanvassingAPI,
  branchId: 'default',
  title: 'Canvassing',
  primaryColor: '#d93025',
  onLogout: async () => {
    await PlatformAPI.auth.logout();
    location.reload();
  }
});
```

The returned app instance exposes:

- `destroy()`: removes Leaflet map and clears the root.
- `loadData()`: reloads pins/settings.
- `renderShell()`: re-renders the top-level shell.
- `renderMapView()`: re-renders the map.
- `renderManager()`: re-renders manager stats/users.

## Boundary Rules

- Keep auth/login/signup in wrappers such as `apps/canvassing/app.js`.
- Keep API calls in `CanvassingAPI`; do not make raw `/v1/canvassing` fetches in this renderer.
- Keep Platform lead creation behind `CanvassingAPI.pins.promote()`.
- Keep the map/pin mobile UX here so future Platform mobile shells can reuse it.
- Use app flag `canvassing.app` before showing any host entry point. The API also gates direct calls.

## Session Contract

The renderer expects the same session shape returned by `PlatformAPI.auth.session()`:

```js
{
  authenticated: true,
  organization: { id, name },
  membership: { organization_id, branch_id },
  user: {
    id,
    role,
    roles: [],
    permissions: {}
  }
}
```

Manager UI appears when the user is owner/admin/super_admin, has `manage_company_users`, or has `canvassing_manager` / `canvassing_admin` in `roles`.

## Future Mobile Platform Use

When Platform gets a mobile shell, do not copy the standalone app. Load this same library, pass the already-authenticated Platform session, and mount it into the mobile tab/panel. Wrapper-specific navigation and auth can differ; map/pin/manager behavior should stay here.
