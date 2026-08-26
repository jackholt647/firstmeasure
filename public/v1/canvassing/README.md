# Canvassing API

Backend: `public/v1/canvassing/api.ts`, mounted at `/v1/canvassing`.

Browser client: `public/libraries/canvassing-api/canvassing-api.js`, exposed as `window.CanvassingAPI`.

Purpose: store fast, lightweight canvassing pins separately from Platform projects. A pin is not a lead/project until it is promoted. Promotion calls the shared Platform lead creator, which creates the customer/project/notification trio through the same path used by email imports and future website forms.

Storage:

```text
v1/storage/canvassing/
  organizations/{orgId}/branches/{branchId}/pins/{pinId}.json
```

Branch settings are not stored in the canvassing storage folder. They live as a Platform branch module:

```text
v1/storage/platform/organizations/{orgId}/branch_data/{branchId}/canvassing.json
```

Default settings shape:

```json
{
  "enabled": true,
  "canvasser_role_id": "canvasser",
  "default_status_id": "new",
  "lead_stage_id": "new_lead",
  "statuses": [
    { "id": "new", "color": "#2563eb", "order": 10, "lead_eligible": true },
    { "id": "no_answer", "color": "#f59e0b", "order": 20, "lead_eligible": false },
    { "id": "follow_up", "color": "#8b5cf6", "order": 40, "lead_eligible": true },
    { "id": "appointment_set", "color": "#16a34a", "order": 50, "lead_eligible": true },
    { "id": "lead_created", "color": "#0f766e", "order": 60, "lead_eligible": false }
  ],
  "labels": {
    "pin_statuses": {
      "new": "New",
      "no_answer": "No Answer",
      "follow_up": "Follow Up"
    }
  }
}
```

Variable labels are paired by the API/library. Frontend code should render `status.label`, not raw status ids.

Pin shape:

```json
{
  "id": "pin_...",
  "organization_id": "org_...",
  "branch_id": "default",
  "coordinates": { "lat": 47.61, "lng": -122.33 },
  "status_id": "follow_up",
  "status_label": "Follow Up",
  "status_history": [{ "status_id": "follow_up", "actor": { "user_id": "user_..." }, "at": "..." }],
  "address": "22 Canvas Court",
  "contact": { "name": "Casey Canvas", "phone": "555-300-4000", "phones": ["555-300-4000"] },
  "notes": "Interested in a roof quote.",
  "platform_project_id": "",
  "created_by": { "user_id": "user_..." }
}
```

Routes:

- `GET /organizations/:orgId/branch/:branchId/settings`
- `PUT /organizations/:orgId/branch/:branchId/settings`
- `GET /organizations/:orgId/branch/:branchId/users`
- `POST /organizations/:orgId/branch/:branchId/users`
- `GET /organizations/:orgId/branch/:branchId/pins`
- `POST /organizations/:orgId/branch/:branchId/pins`
- `GET /organizations/:orgId/branch/:branchId/pins/:pinId`
- `PATCH /organizations/:orgId/branch/:branchId/pins/:pinId`
- `DELETE /organizations/:orgId/branch/:branchId/pins/:pinId`
- `POST /organizations/:orgId/branch/:branchId/pins/:pinId/promote`
- `GET /geocode/reverse?lat=...&lng=...`

`promote` updates the pin to `status_id = lead_created`, stores `platform_project_id`, and returns `{ pin, project, customer, notification }`.

## Standalone Canvassing App

Standalone web app wrapper: `public/apps/canvassing/`.

Shared mobile map/pin/manager UI: `public/libraries/canvassing-app/canvassing-app.js`.

It is intentionally not guarded by PHP session redirects. It uses `PlatformAPI.auth.session/login/register/logout` directly and relies on the V1 HttpOnly Platform session cookie.

Signup creates a normal Platform organization and org user, but with canvassing-oriented defaults:

```js
membership: {
  role: "owner",
  roles: ["canvasser", "canvassing_manager"],
  permissions: { "*": true, manage_canvassing: true, manage_company_users: true }
}
```

The user experience may say "standalone canvassing", but the data model is still an org + branch. This is deliberate so standalone canvassing can later grow into the full Platform without migration.

Canvassing user management:

- `GET /organizations/:orgId/branch/:branchId/users`: manager-only list of org users with canvassing roles.
- `POST /organizations/:orgId/branch/:branchId/users`: manager-only add/invite canvasser or canvassing manager.

Supported user roles:

- `canvasser`: can use the canvassing app.
- `canvassing_manager`: can use the app and access the manager view/user management.

If `password` is supplied when adding a user, the identity can log in immediately. If omitted, the user is stored with `status = invited` and `invite_pending = true`; actual email delivery and invite acceptance are intentionally not wired yet.
