# Platform API Browser Client

`platform-api.js` is the single frontend client for `/v1/platform`.

Frontend library location: `public/libraries/platform-api/platform-api.js`.
Backend API implementation: `public/v1/platform/api.ts`, with storage helpers in `public/v1/platform/storage.ts`.
Scheduling/terminology helper library: `public/libraries/platform-scheduling/platform-scheduling.js`.
Celebration effects library: `public/libraries/platform-celebrations/platform-celebrations.js`.

Load it before app scripts that need Platform-owned data:

```html
<script src="../libraries/platform-api/platform-api.js"></script>
```

It creates `window.PlatformAPI`:

- `PlatformAPI.configure({ baseUrl })`: override the Platform API base URL.
- `PlatformAPI.url(path)`: build a URL under `/v1/platform`.
- `PlatformAPI.request(path, options)`: JSON request wrapper with consistent errors.
- `PlatformAPI.auth`: first-party web session helpers. `login()` and `register()` set an HttpOnly Platform session cookie; `session()` reads the current API session; `logout()` revokes it.
- `PlatformAPI.identities`: identity helpers for authenticated account/profile operations.
- `PlatformAPI.orgs`: organization/global helpers.
- `PlatformAPI.notifications`: notification list/create/user-state helpers.
- `PlatformAPI.actionItems`: action item list/create/status/user-state helpers.
- `PlatformAPI.branches`: branch and branch module helpers.
- `PlatformAPI.branches.triggers`: branch trigger config and manual event emission helpers.
- `PlatformAPI.documents`: generic schema-light helpers for `projects`, `users`, `branch`, `notifications`, and `action_items`.
- `PlatformAPI.projects`, `users`: org collection helpers.
- `PlatformAPI.media`: media metadata, file URL, thumbnail URL, and normalized media reference helpers.
- `PlatformAPI.media.upload(orgId, file, options)`: multipart upload through `/organizations/:orgId/media`.
- `PlatformAPI.mediaFields`: helpers for storing media references and markup layers inside any document.
- `PlatformAPI.projectMedia`: convenience helpers for project photo references and photo markup.
- `PlatformAPI.branchModules`: thin convenience wrapper returning the module object.
- `PlatformAPI.appFlags`: hidden rollout gate helpers. Load once with `appFlags.load(orgId)`, then check `appFlags.has(group, flag)`.

## App Flags

Use app flags for controlled rollouts where customers should not see unfinished or closed-beta features:

```js
await PlatformAPI.appFlags.load(orgId);
if (PlatformAPI.appFlags.has('canvassing', 'app')) {
  // Render canvassing UI.
}
```

Backend endpoint: `GET /v1/platform/organizations/:orgId/app-flags`. It returns only enabled capability names grouped by API. It is not a customer-facing editor and should not be rendered as a settings list.

Current lead gates:

- `platform.lead_import`
- `email.inbound_lead_import`
- `platform.website_embed_import`
- `canvassing.app`

Frontend code should hide tabs/settings when their app flag is off. The relevant V1 API must also gate direct calls server-side.

Media uploads preserve the original file and create image renditions in the media folder. For raster images, thumbnails are generated automatically for large images using the backend defaults: `thumb_160`, `thumb_320`, and `thumb_640` as WebP. A large image is currently any image with a max dimension of at least `1024px`. Compression settings are optional and can be supplied per upload:

```js
await PlatformAPI.media.upload(orgId, file, {
  ownerType: 'project',
  ownerId: projectId,
  slot: 'photos',
  collection: 'projects',
  thumbnails: { enabled: true, sizes: [160, 320, 640], quality: 78, format: 'webp' },
  compression: { enabled: true, maxWidth: 2400, quality: 82, format: 'webp' },
  markup: { layers: [{ id: 'markup_default', data: {} }] }
});
```

Original files are never mutated. Compression creates a derived display variant such as `display_2400` when the uploaded image is larger than the requested max width. Set `thumbnails: false` or `compression: false` to disable either processing step. Markup can be included at upload time or saved later with `PlatformAPI.media.saveMarkup(orgId, mediaId, layerId, data, metadata)`.

Frontend Platform code should not hardcode `/v1/platform` or build Platform API fetches directly. Add any new Platform-owned data calls here first, then consume the method from `platform/`.

Scheduling UI should also load `PlatformScheduling` from `public/libraries/platform-scheduling/platform-scheduling.js`. That library uses this API client to load branch `scheduling` and `variable_mappings` modules, normalize user roles, normalize project events, attach branch labels, and check availability. Do not reimplement branch terminology mapping or required/allowed role availability inside page scripts.

Trigger-worthy actions should use API routes that emit Platform triggers. For scheduling, use:

```js
await PlatformAPI.projects.scheduleEvent(orgId, projectId, event, { branchId });
```

That calls `POST /organizations/:orgId/projects/:projectId/events`, saves the event on the project, and emits `project.event_scheduled` server-side. Do not save `project.events` directly when the action should fire triggers.

Notification UI should prefer `public/libraries/platform-notifications/platform-notifications.js`, which wraps `PlatformAPI.notifications`. The API stores notification records centrally and user state on the org user record.

Action item UI should prefer `public/libraries/platform-action-items/platform-action-items.js`, which wraps `PlatformAPI.actionItems` and lets frontend libraries register kind handlers. The API stores action item records centrally and per-user UI state on the org user record.

Celebration effects should use `public/libraries/platform-celebrations/platform-celebrations.js`. Backend triggers create lightweight `kind: "celebration"` notifications; the notifications helper consumes them, calls `PlatformCelebrations`, shows any `celebration.text` toast, marks them completed, and hides them from the bell list. New visible notifications use `PlatformCelebrations.indicator()` for the short alert tone. Branch setting `project_configuration.celebrations_mode` accepts `on`, `small_only`, or `off`.

Requests use `credentials: 'include'` so the browser sends the HttpOnly Platform session cookie. Mutating requests automatically copy the readable CSRF cookie into `X-Platform-CSRF`; UI code should not handle the session secret directly.

## Schema-Light Document Fields

Core collection documents store arbitrary JSON in `document.data`. During development, do not add a new server schema for every new variable. Use the generic helpers:

```js
await PlatformAPI.documents.setField(
  orgId,
  'projects',
  projectId,
  'end_date',
  '2026-06-01'
);

await PlatformAPI.projects.setField(orgId, projectId, 'proposal.status', 'draft');
```

Top-level fields use `PATCH`. Dot-path fields fetch the document, update the nested key, and save the full `data` object because the backend merge is intentionally shallow.

Useful helpers:

- `PlatformAPI.documents.getData(orgId, collection, id)`: returns only `document.data`.
- `PlatformAPI.documents.setField(orgId, collection, id, field, value, metadata?)`: sets one arbitrary field.
- `PlatformAPI.documents.patchFields(orgId, collection, id, fields, metadata?)`: sets several arbitrary fields.
- `PlatformAPI.documents.removeField(orgId, collection, id, field, metadata?)`: removes a field.
- Collection aliases such as `PlatformAPI.projects.setField(...)` delegate to the same generic implementation.

## Generic File Fields

Do not create a bespoke endpoint for every new file field. Use `uploadFieldFile()`:

```js
const result = await PlatformAPI.documents.uploadFieldFile(
  orgId,
  'projects',
  projectId,
  'supplier_materials_pdf',
  file,
  {
    mode: 'single',
    compression: false,
    thumbnails: false,
    referenceMetadata: { label: 'Supplier materials' }
  }
);
```

This performs two operations:

1. Uploads the file through `/organizations/:orgId/media`.
2. Saves a normalized media reference onto `project.data.supplier_materials_pdf`.

Reference shape:

```js
{
  kind: 'media_reference',
  media_id: 'media_...',
  variant: 'original',
  field: 'supplier_materials_pdf',
  owner: { collection: 'projects', id: projectId, field: 'supplier_materials_pdf' },
  file_name: 'materials.pdf',
  content_type: 'application/pdf',
  size_bytes: 12345,
  variants: ['original'],
  metadata: {},
  uploaded_at: '...',
  updated_at: '...'
}
```

For repeatable file fields, use `mode: 'append'`; for a list that should be replaced with just the new upload, use `mode: 'replace_list'`.

Fetch/use saved references with:

```js
const project = await PlatformAPI.documents.getData(orgId, 'projects', projectId);
const ref = PlatformAPI.documents.fieldFileReference(project, 'supplier_materials_pdf');
const url = PlatformAPI.media.fileUrlFromReference(orgId, ref);
```

Images use the same system. If thumbnails/compression are not disabled, image uploads may produce variants such as `thumb_320` and `display_2400`; PDFs and other files simply store the original unless future processors are added.
