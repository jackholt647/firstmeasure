# Pricebook API Module

This folder is the modular source area for the `/v1/platform/pricebook` API.

It follows the same host/module structure as `firstmeasure`, but it is a separate API with its own storage, routes, schema, and defaults.

## What Lives Here

- [api.ts](./api.ts): route registration mounted by the shared `v1` host
- [API_SCHEMA.md](./API_SCHEMA.md): schema and endpoint blueprint for the module
- [constants.ts](./constants.ts): schema-level enums and defaults
- [default_template.ts](./default_template.ts): bundled API-owned default template catalog
- [schemas.ts](./schemas.ts): request validation schemas
- [storage.ts](./storage.ts): folder-backed pricebook persistence and asset management

## Runtime Ownership

The runtime, dependencies, and build scripts live at:

- [public/v1](../)

That means this module is mounted into the shared host and does not run as its own separate Node application.

## Implemented Endpoint Groups

- `GET /v1/platform/pricebook`
- `GET /v1/platform/pricebook/ping`
- `POST /v1/platform/pricebook/echo`
- `GET /v1/platform/pricebook/templates`
- `GET /v1/platform/pricebook/templates/:key`
- `GET /v1/platform/pricebook/pricebooks`
- `POST /v1/platform/pricebook/pricebooks`
- `POST /v1/platform/pricebook/pricebooks/query`
- `GET /v1/platform/pricebook/pricebooks/:id`
- `PATCH /v1/platform/pricebook/pricebooks/:id`
- `POST /v1/platform/pricebook/pricebooks/:id/clone`
- `GET /v1/platform/pricebook/pricebooks/:id/catalog`
- `PUT /v1/platform/pricebook/pricebooks/:id/catalog`
- `POST /v1/platform/pricebook/pricebooks/:id/items`
- `PATCH /v1/platform/pricebook/pricebooks/:id/items/:itemId`
- `DELETE /v1/platform/pricebook/pricebooks/:id/items/:itemId`
- `GET /v1/platform/pricebook/pricebooks/:id/assets`
- `POST /v1/platform/pricebook/pricebooks/:id/assets`
- `GET /v1/platform/pricebook/pricebooks/:id/assets/:assetId`
- `DELETE /v1/platform/pricebook/pricebooks/:id/assets/:assetId`

## Current Implementation Notes

- Storage is file-backed under `public/v1/storage/pricebook/pricebooks`.
- Every new price book is cloned from the bundled default template in this module.
- Images and other attachments are stored as API-owned assets inside the price book folder.
- The API supports item options, including informational options and price-affecting option values.
- The API is intentionally not wired into the portal yet. That integration can happen later by storing a `pricebook_id` on the org payload in the existing organization system.
