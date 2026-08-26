# Sales App Router

`router.php` is the stable endpoint for custom sales tools. Do not edit it from a custom app. Build front-end apps that call it.

Apps in the folder above this one can call it with the normal logged-in PHP session:

```js
const res = await fetch("sales/router.php?resource=leads&limit=50");
const data = await res.json();
```

## What It Exposes

- Read-only sanitized users: `?resource=users`
- Read-only sanitized organizations: `?resource=organizations`
- Organization credit balance writes: `?resource=organization_credits`
- FirstMeasure API passthrough: `?resource=firstmeasure&path=projects/query`
- Lead/list/import CRM data: `?resource=leads`, `?resource=lead_lists`, `?resource=lead_import_runs`, or `?resource=lead_rows&table=...`
- App-owned files under `sales/storage`: `?resource=storage&path=...`

## Auth

The router uses the existing FirstMate login session. The browser must already be logged in. Writes are same-origin only when the browser sends an `Origin` or `Referer` header.

Customer accounts cannot use this router. Employee accounts can.

## Storage Boundary

Custom apps may read and write only inside:

```text
sales/storage/
```

They should create whatever JSON, CSV, cache, or app state files they need there.

## Best Practice

Use `GET ?resource=meta` and the large header comment in `router.php` as the source of truth for endpoints and payloads.

For lead creates/updates, prefer `POST ?resource=lead_save` because it keeps lead membership and lead entity records synchronized. Use generic table CRUD only when you know exactly which lead table you need.
