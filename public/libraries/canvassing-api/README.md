# Canvassing API Browser Library

Use `libraries/canvassing-api/canvassing-api.js` for all browser calls to `/v1/canvassing`.

The whole Canvassing surface is gated by app flag `canvassing.app`. Platform UI should check `PlatformAPI.appFlags.has('canvassing', 'app')` before rendering canvassing tabs or settings. The Canvassing API also rejects direct calls when the org flag is off. Branch setting `canvassing.enabled` is customer-visible and only matters after the app flag is enabled.

Backend code: `public/v1/canvassing/api.ts`.

Current surface:

- `CanvassingAPI.settings.get(orgId, branchId)` reads/creates branch canvassing settings and returns status labels already paired with raw ids.
- `CanvassingAPI.settings.save(orgId, branchId, data)` replaces branch canvassing settings.
- `CanvassingAPI.users.list(orgId, branchId)` lists canvassing-role users for managers.
- `CanvassingAPI.users.create(orgId, branchId, user)` adds/invites a canvasser or canvassing manager.
- `CanvassingAPI.pins.list(orgId, branchId)` returns lightweight pins plus settings.
- `CanvassingAPI.pins.create(orgId, branchId, pin)` creates a pin.
- `CanvassingAPI.pins.patch(orgId, branchId, pinId, patch)` updates a pin/status/history.
- `CanvassingAPI.pins.remove(orgId, branchId, pinId)` soft-deletes a pin.
- `CanvassingAPI.pins.promote(orgId, branchId, pinId, leadPatch)` converts a pin into a Platform lead.
- `CanvassingAPI.geocode.reverse(lat, lng)` calls the server-side OpenStreetMap/Nominatim reverse-geocode proxy.

Pin writes require:

```js
{
  coordinates: { lat, lng },
  status_id: "follow_up",
  address: "optional",
  contact: { name: "", phone: "", email: "" },
  notes: ""
}
```

Promoting a pin is the only path that should create a Platform project from canvassing:

```js
await CanvassingAPI.pins.promote(orgId, branchId, pinId, {
  summary: "Canvasser spoke with homeowner."
});
```

Do not create canvassing projects directly with `PlatformAPI.projects.save()`. Use `promote()` so the Canvassing API can update the pin and call the generic Platform lead creation code.

Standalone app notes:

- `apps/canvassing/` is the standalone wrapper and uses both `PlatformAPI` and `CanvassingAPI`.
- Shared map/pin/manager UI lives in `libraries/canvassing-app/canvassing-app.js`.
- Login/signup/logout are `PlatformAPI.auth.*` calls.
- Standalone signup creates a normal Platform org/user with roles `["canvasser", "canvassing_manager"]`.
- Manager user creation should use:

```js
await CanvassingAPI.users.create(orgId, branchId, {
  name: "Door Rep",
  email: "rep@example.com",
  role: "canvasser",
  password: "optional temporary password"
});
```

If no password is sent, the backend stores the user as invited/pending; invite email delivery is not implemented yet.
