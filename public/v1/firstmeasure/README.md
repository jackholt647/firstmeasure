# FirstMeasure API Module

This folder is the modular source area for the `/v1/firstmeasure` API.

It is not its own standalone Node app anymore.

## What Lives Here

- [api.ts](./api.ts): the route registration entrypoint mounted by the shared `v1` host
- [API_SCHEMA.md](./API_SCHEMA.md): the current schema and endpoint blueprint
- [storage.ts](./storage.ts): folder-backed project persistence for manifests, metadata, PDFs, XML, and artifacts
- [pdf.ts](./pdf.ts): the lightweight placeholder/server PDF renderer still used by the legacy assemble/render endpoints
- [pdf_runtime.ts](./pdf_runtime.ts): the API-owned browser-runtime PDF renderer used by the production batch PDF generation path
- [xml.ts](./xml.ts): XML assembly helpers

## Runtime Ownership

The actual Node runtime, shared dependencies, and build scripts live at:

- [public/v1](../)

That means there should only be one active `node_modules`, one `package.json`, and one running host process for `/v1/*` APIs unless we deliberately split a heavy API out later.

## Implemented Endpoint Groups

- `GET /v1/firstmeasure`
- `GET /v1/firstmeasure/ping`
- `POST /v1/firstmeasure/echo`
- `GET /v1/firstmeasure/projects`
- `POST /v1/firstmeasure/projects`
- `POST /v1/firstmeasure/projects/query`
- `GET /v1/firstmeasure/projects/:id`
- `PATCH /v1/firstmeasure/projects/:id`
- `POST /v1/firstmeasure/projects/:id/status`
- `GET|PUT /v1/firstmeasure/projects/:id/app-metadata`
- `GET|PUT /v1/firstmeasure/projects/:id/pdf-state`
- `GET|PUT /v1/firstmeasure/projects/:id/branding-defaults`
- `GET|POST /v1/firstmeasure/projects/:id/artifacts`
- `GET /v1/firstmeasure/projects/:id/artifacts/:name`
- `POST /v1/firstmeasure/queue/status`
- `POST /v1/firstmeasure/queue/claim-next`
- `POST /v1/firstmeasure/queue/admin/overview`
- `POST /v1/firstmeasure/projects/:id/queue/reserve`
- `POST /v1/firstmeasure/projects/:id/queue/release-reservation`
- `POST /v1/firstmeasure/projects/:id/queue/release-assignment`
- `GET /v1/firstmeasure/apple-key`
- `POST /v1/firstmeasure/apple-key`
- `POST /v1/firstmeasure/apple-key/ingest`

Apple key writes accept an optional positive integer `tile_version`. When it is omitted, the currently stored tile version is preserved, so key-only clients and older extensions remain compatible.
- `GET /v1/firstmeasure/projects/:id/pdf`
- `POST /v1/firstmeasure/projects/:id/pdfs/generate`
- `POST /v1/firstmeasure/projects/:id/pdfs/generate/server`
- `POST /v1/firstmeasure/projects/:id/pdfs/sync`
- `GET /v1/firstmeasure/projects/:id/pdfs/sync/:jobId`
- `POST /v1/firstmeasure/projects/:id/pdfs/sync/:jobId/client-checksums`
- `GET /v1/firstmeasure/projects/:id/pdfs/runtime`
- `GET /v1/firstmeasure/pdf-runtime/manifest`
- `GET /v1/firstmeasure/pdf-runtime/blank`
- `GET /v1/firstmeasure/pdf-runtime/assets/:asset`
- `POST /v1/firstmeasure/projects/:id/pdf/assemble`
- `GET /v1/firstmeasure/projects/:id/xml`
- `POST /v1/firstmeasure/projects/:id/xml/assemble`
- `POST /v1/firstmeasure/projects/:id/render/report`
- `POST /v1/firstmeasure/projects/:id/render/pages`
- `POST /v1/firstmeasure/projects/:id/render/page`
- `POST /v1/firstmeasure/render/report`
- `POST /v1/firstmeasure/render/page`
- `POST /v1/firstmeasure/projects/:id/process/imagery`
- `POST /v1/firstmeasure/projects/:id/process/mask`
- `POST /v1/firstmeasure/projects/:id/process/insights`

## Current Implementation Notes

- In PostgreSQL mode, PostgreSQL is authoritative for project manifests, list/search indexes, queue state, jobs, and locks. Files under `public/v1/storage/firstmeasure/projects` remain artifact storage and best-effort JSON recovery mirrors.
- Server startup automatically imports existing project JSON into PostgreSQL with validation and a migration lock. `npm run firstmeasure:reindex` remains available for a deliberate disk-to-database rebuild; SQLite remains the default local fallback when PostgreSQL is not configured.
- Project list/query endpoints now default to a recent activity window instead of dumping the entire project table; callers can pass `activity_start`, `activity_end`, `activity_fields`, or `include_all=true`.
- A browser-based developer console can be enabled with `DEV_CONSOLE_USERNAME`, `DEV_CONSOLE_PASSWORD`, and optionally `DEV_CONSOLE_PATH` plus `DEV_CONSOLE_SESSION_SECRET`.
- Stored PDF and XML fetch endpoints do not regenerate files.
- XML endpoints now accept an optional `format` selector. Supported request values currently normalize to `roofplan`, `esx`, `applicad`, or `firstmeasure`.
- XML requests default to `roofplan`.
- `roofplan` returns the canonical stored `model_data.xml`.
- `esx` returns a dedicated `.esx` geometry export derived from the stored Roofplan model.
- `applicad` returns a dedicated AppliCad `.rxf` geometry export derived from the stored Roofplan model.
- `firstmeasure` returns the internal generated XML document.
- The report model is now generic: use one report endpoint and vary `branding` plus optional `prepared_for` to create internal or customer-facing variants.
- Branding resolution now follows the contract: request override, then project defaults, then renderer defaults.
- Projects now store `include_gutter_measurements` as a simple request flag instead of a gutter profile object.
- Queue flow now has API-owned endpoints for worker queue status, next-in-queue claiming, reservation, and overview using explicit actor payloads.
- Apple key storage now has API-owned endpoints and its own self-contained store under the FirstMeasure storage root.
- The processing endpoints are implemented and call the external imagery/solar providers.
- `POST /projects/:id/pdfs/generate` is the production PDF path and now renders through the API-owned browser runtime package exposed under `/pdf-runtime/*`.
- Interactive editor and QA rendering uses the same API-owned jsPDF asset locally. `POST /projects/:id/pdfs/sync` saves the exact versioned snapshot, durably queues server rendering, and immediately returns a job id. Clients register their local SHA-256 values with that job, the server persists the comparison, and a mismatch triggers one clean server regeneration. The status endpoint returns only compact job/checksum metadata, never the generated PDF bytes.
- QA and manager approval acknowledge after the decision and delivery job are durably queued. The delivery job waits for the referenced PDF sync job, then sends the stored report asynchronously.
- The older assemble/render endpoints still use the lightweight placeholder renderer in `pdf.ts` and should be treated as legacy until they are migrated onto the shared runtime or replaced with a pure server renderer.
Frontend browser client:
- `public/libraries/firstmeasure-api/firstmeasure-api.js` creates `window.FirstMeasureAPI`.
- Client docs: `public/libraries/firstmeasure-api/README.md`.

Backend API implementation:
- `public/v1/firstmeasure/api.ts` registers `/v1/firstmeasure`.
- Related processing/storage modules live in `public/v1/firstmeasure/*.ts`.

FirstMeasure owns measurement/report processing, report artifacts, instant reports, editor/PDF state, and queue operations. Platform-owned organization/customer/project data belongs to `public/v1/platform` and `window.PlatformAPI`.
