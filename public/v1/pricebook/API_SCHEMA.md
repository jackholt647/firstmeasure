# Pricebook API Schema Blueprint

## Goal

Build a price book API in `public/v1/pricebook` that mounts under the platform API at `/v1/platform/pricebook` and owns:

- price book creation
- cloning from a default template
- catalog persistence
- item CRUD
- asset persistence
- list/query operations

without directly depending on:

- organizations storage
- users storage
- PHP sessions
- `firstmeasure`
- portal frontend files

The API accepts opaque org/user references when callers provide them, but never performs live cross-system lookups.

## Storage Layout

```text
<storage_root>/
  pricebooks/
    <pricebook_id>/
      manifest.json
      catalog.json
      assets/
        <asset_id>_<file_name>
      manifest_backups/
```

## Canonical Manifest Schema

```json
{
  "schema_version": 1,
  "id": "pb_123",
  "status": "active",
  "name": "Acme Roofing Price Book",
  "description": "Default org catalog",
  "currency": "USD",
  "locale": "en-US",
  "revision": 3,
  "template_ref": { "key": "default", "version": 1 },
  "organization_ref": { "id": "org_123" },
  "owner_ref": { "id": "user_123", "email": "owner@example.com", "name": "Owner" },
  "timestamps": {
    "created_at": "2026-04-07 18:24:11",
    "updated_at": "2026-04-07 18:31:42",
    "archived_at": null
  },
  "counts": { "items": 31, "assets": 2 },
  "metadata": {}
}
```

## Canonical Catalog Schema

```json
{
  "taxonomy": {
    "categories": [{ "value": "misc", "label": "Miscellaneous" }],
    "units": [{ "value": "sq", "label": "Per Square" }],
    "measurement_fields": [{ "key": "roofSquares", "label": "Roof Squares (Total)" }],
    "manufacturers": [{ "value": "gaf", "label": "GAF" }],
    "segments": [{ "value": "sloped", "label": "Sloped" }]
  },
  "items": [],
  "assets": [],
  "settings": {},
  "metadata": {}
}
```

## Item Schema

```json
{
  "id": "gaf_hd",
  "code": "SHINGLE_GAF_HD",
  "name": "GAF Timberline HDZ",
  "category": "shingle_roofs",
  "manufacturer": "gaf",
  "segment": "all",
  "unit": "sq",
  "unitPrice": 398,
  "formulaConfig": {
    "tokens": [{ "type": "measurement", "value": "shingleSquares" }],
    "includeWaste": true
  },
  "autoAdd": false,
  "description": "Architectural laminate shingle",
  "images": [{ "asset_id": "asset_abc123", "role": "primary", "alt": "GAF Timberline HDZ" }],
  "options": [
    {
      "id": "color",
      "label": "Color",
      "input_type": "single_select",
      "required": false,
      "values": [
        { "id": "charcoal", "label": "Charcoal" },
        { "id": "weathered_wood", "label": "Weathered Wood", "price_adjustment": { "type": "unit_delta", "amount": 12 } }
      ]
    }
  ],
  "sort_order": 120,
  "status": "active",
  "metadata": {}
}
```

## Asset Schema

```json
{
  "id": "asset_abc123",
  "file_name": "timberline-hdz.png",
  "stored_name": "asset_abc123_timberline-hdz.png",
  "content_type": "image/png",
  "size": 48291,
  "kind": "image",
  "label": "Primary product image",
  "alt_text": "Timberline HDZ bundle photo",
  "created_at": "2026-04-07T18:28:02.511Z",
  "updated_at": "2026-04-07T18:28:02.511Z",
  "metadata": {}
}
```

## Revision Strategy

Mutating endpoints may receive `expected_revision`.

If the provided revision does not match the stored manifest revision, the API returns `409 revision_conflict`.

## Implemented Endpoints

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

## Intended Frontend Linkage Later

This module is intentionally independent from the org system, but the intended integration point is:

```json
{
  "id": "org_123",
  "name": "Acme Roofing",
  "pricebook_id": "pb_123"
}
```

Suggested flow later:

1. Portal loads org.
2. If `pricebook_id` exists, portal loads `/v1/platform/pricebook/pricebooks/:id`.
3. If not, portal creates one from template `default`.
4. Portal saves returned `pricebook_id` back to the org system.

The `pricebook` API never performs that linkage itself.
