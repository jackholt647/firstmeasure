# FirstMeasure API Schema Blueprint

## Current Implementation Note

The live `firstmeasure` module has now moved to a single-report contract:

- use one report endpoint instead of separate full-vs-summary report types
- vary `branding` and optional `prepared_for` data per request to produce internal or customer-facing versions
- store one default saved report at `Report.pdf`
- use `include_gutter_measurements` as the current project-level gutter request flag
- queue status, next-in-queue claiming, reservation, and overview now belong in the API module
- Apple access key storage now belongs in the API module

The rest of this blueprint remains useful background, but where it conflicts with the live implementation, the single-report contract is the current direction.

## Goal

Build a standalone measurement API in `public/v1/firstmeasure` that owns:

- project creation and storage
- project state updates
- asset persistence
- index/search/list operations
- PDF generation and retrieval

without directly depending on:

- `users/`
- `organizations/`
- PHP session auth
- Stripe / credits / refunds
- other internal PHP modules

The API should be self-contained and only accept deliberate, explicit crossover from outside systems.

---

## Short Answer

Yes, most of the current project system can be represented cleanly inside a standalone API with low crossover.

The main constraint is not storage. Storage is already mostly self-contained.

The main constraint is runtime context:

- `_projects.php` mixes project storage with auth, org lookup, queue staffing, billing, email, and management workflow.
- `_project_index.php` is already close to the shape we want.
- `editor_scripts/pdf_standalone.js` and `editor_scripts/pdf.js` can drive server-side PDF generation, but the current PDF runtime is browser-style JavaScript and should be executed in a headless browser worker, not rewritten into pure PHP.

---

## What Is Already Self-Contained

A real project folder already contains almost everything needed for a standalone API:

- `manifest.json`
- `app_metadata.json`
- `pdf_state.json`
- `insights.json`
- imagery like `google.png`, `azure.png`
- raster/height artifacts like `dsm.tif`, `mask.tif`, `rgb.tif`
- `model_data.xml`
- generated PDFs like `Report.pdf` and `Summary.pdf`

That means the new API can own the project as a folder-backed resource with a SQLite index.

---

## Current Dependency Split

### Can Be Fully Owned By FirstMeasure

- project folder creation
- manifest persistence
- app metadata persistence
- PDF snapshot persistence
- asset upload/write/delete
- report upload/write
- summary upload/write
- status transitions as a plain state machine
- SQLite indexing and search
- project artifact discovery
- Google Solar / imagery fetches, if API keys are configured locally
- mask / heightmap refresh
- server-side PDF generation

### Can Be Owned If Caller Supplies Context Explicitly

- actor identity
- actor role list
- team id
- org id
- branding
- report settings
- customer-facing permissions
- QA / manager actions
- queue reservations

For these, the API should never query users or orgs directly. The caller must pass the needed context in the request.

### Should Stay Outside The Standalone API

- login / sessions
- user lookup
- org lookup
- billing / credits / Stripe
- refund decisions
- email delivery policy
- employee online/offline presence
- staffing heuristics that depend on live user records

These can still integrate with FirstMeasure, but only through explicit requests or callbacks.

---

## Biggest Crossover To Remove

The current `load` flow pulls org branding and report settings live from the org store so `pdf_standalone.js` can generate branded output.

That live lookup should be removed.

Instead, branding should be passed in deliberately by the caller:

1. the frontend calls the organizations system first
2. the frontend passes branding into FirstMeasure when creating a project and/or rendering PDFs
3. FirstMeasure stores or uses only the branding payload it was explicitly given

This keeps PDF generation self-contained and prevents FirstMeasure from ever needing to query org data directly.

---

## Recommended Storage Model

Use a folder-per-project model plus a SQLite index.

## Compatibility-First Project Layout

This keeps migration easy because it matches the current disk shape closely.

```text
<storage_root>/
  projects/
    <project_id>/
      manifest.json
      app_metadata.json
      pdf_state.json
      branding_defaults.json
      insights.json
      model_data.xml
      model_data.generated.xml
      google.png
      azure.png
      apple.png
      dsm.tif
      mask.tif
      rgb.tif
      Report.pdf
      Summary.pdf
      qa_assets/
      manifest_backups/
```

## Recommended Storage Roots

- API code: `public/v1/firstmeasure`
- project storage: configurable path, ideally not directly public
- index DB: configurable path, owned only by the API

If needed for migration, the first implementation can point to the existing `public/measure/internal/saves` tree.

---

## Canonical Project Schema

The API should treat `manifest.json` as the canonical project record and use other files as attached artifacts.

## `manifest.json`

```json
{
  "schema_version": 1,
  "id": "md5-or-uuid",
  "status": "queued",
  "project_type": "residential",
  "address": "8915 196th St SW, Edmonds, WA 98026, USA",
  "components": {},
  "lat": 47.8221942,
  "lng": -122.354517,
  "pins": [],
  "gutter_profile": {
    "enabled": false,
    "style": null,
    "size": null,
    "color": null,
    "notes": null
  },
  "radius_meters": 30,
  "complexity": 3,
  "is_custom_pin": true,
  "is_filler": false,
  "is_vip": false,
  "is_expedited": false,
  "owner_ref": {
    "id": "jack@1m8.ai",
    "email": "jack@1m8.ai",
    "name": "Jack"
  },
  "organization_ref": {
    "id": null
  },
  "team_ref": {
    "id": "default"
  },
  "resident": {
    "name": "",
    "email": "",
    "phone": ""
  },
  "issuer": {
    "name": "",
    "email": ""
  },
  "cc_emails": [],
  "tech_notes": null,
  "amount_charged": 0,
  "timestamps": {
    "created_at": "2026-03-27 23:21:11",
    "queued_at": "2026-03-27 23:21:11",
    "processed_at": null,
    "started_at": null,
    "uploaded_at": null,
    "completed_at": null,
    "rejected_at": null,
    "updated_at": "2026-03-27 23:21:11"
  },
  "workflow": {
    "assigned_to": null,
    "reserved_to": null,
    "qa_claim": null,
    "qa_history": [],
    "work_history": []
  },
  "audit": {
    "manager_audit_status": null,
    "manager_audit_note": null,
    "manager_audit_annotations": null
  },
  "delivery": {
    "email_events": [],
    "report_sent_at": null
  },
  "artifacts": {
    "has_insights": false,
    "has_pdf_state": false,
    "has_report_pdf": false,
    "has_summary_pdf": false,
    "has_model_data": false,
    "has_google_image": false,
    "has_mask_tif": false,
    "has_dsm_tif": false
  }
}
```

## Notes On This Schema

- `owner_ref`, `organization_ref`, and `team_ref` are opaque references, not relational joins.
- `workflow` remains valid even without a user database.
- `artifacts` should be treated as derived/cacheable fields and can be repaired from disk.
- `timestamps.updated_at` should be API-owned.

---

## `branding_defaults.json`

This is optional project-level default branding provided by the caller.

```json
{
  "source": "caller_defaults",
  "captured_at": "2026-04-01T09:00:00Z",
  "branding": {
    "full": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    },
    "summary": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    }
  }
}
```

This should not be treated as an org record. It is just the default branding packet the caller wants associated with the project.

If no branding defaults exist, PDFs should render with the existing non-branded fallback behavior.

## Branding Strategy

Branding should be explicit and PDF-type specific.

Recommended model:

- `branding.full` for the main report PDF
- `branding.summary` for the summary PDF
- each type may specify its own `logo_url`, `primary_color`, and `secondary_color`

This matches the current split between full and summary PDFs and lets the frontend choose exactly what to send.

## Branding Resolution Order

For each requested PDF type:

1. use per-request branding override if provided
2. else use project-level `branding_defaults.json`
3. else use current built-in PDF defaults

This gives you a fully optional override path while keeping the API independent.

If no branding snapshot exists, PDF generation should still work with defaults.

---

## `app_metadata.json`

This is editor/runtime metadata, not the canonical project record.

Observed top-level keys today:

- `imageWidth`
- `imageHeight`
- `viewConfigs`
- `currentViewId`
- `geminiPrompt`
- `geometry`
- `hasQuadCrop`
- `viewRotation`
- `pdfConfig`
- `layer_config`
- `uiState`

Recommendation:

- keep this as an opaque document
- version it separately
- do not make list/search depend on it

---

## `pdf_state.json`

This is the canonical PDF/render snapshot.

Observed top-level keys today:

- `snapshotVersion`
- `savedAt`
- `folderId`
- `address`
- `center`
- `dims`
- `radiusMeters`
- `geometry`
- `report`
- `facesData`
- `cropRegion`
- `displayCrop`
- `solarImg`
- `ventImg`
- `wireframes`
- `quadImage`
- `structures`
- `customLabels`
- `manualTotalFacets`
- `manualWastePct`
- `manualLayerFacets`
- `ventSettings`
- `structureSettings`
- `elevationSettings`
- `brandingOverrides`
- `imageSettings`
- `editorCropPadding`
- `excludedSignatures`
- `finalizeChecklist`
- `finalizeSources`
- `finalizeSourcesConfirmed`

Recommendation:

- treat this as a versioned render snapshot
- require it for server-side PDF generation
- allow the API to validate only minimal required keys
- avoid normalizing this too early

## PDF Page Model

The API should support both full-document rendering and page-fragment rendering.

Recommended canonical page keys:

- `cover`
- `top_view`
- `elevations`
- `facets_3d`
- `pitch`
- `area`
- `layers`
- `structures`
- `project_summary`
- `materials`
- `ventilation`
- `gutters`
- `notes`

Notes:

- `layers` may expand to multiple pages depending on project data
- `structures` may expand to multiple pages depending on project data
- `materials` may expand to multiple pages depending on project data
- single-page fragment endpoints should still use the canonical key even if the underlying renderer expands it

---

## PDF Display Configuration

The current customer summary behavior is driven by org-side report settings.

In the new API, those settings should be passed in explicitly by the caller for each render request.

Recommended render config shape:

```json
{
  "page_config": {
    "cover_show_customer": true,
    "cover_show_squares": true,
    "cover_show_waste": true,
    "cover_show_breakdown": true,
    "cover_show_pitch": true,
    "cover_show_facets": true,
    "page_top_view": true,
    "page_elevations": true,
    "page_3d": true,
    "page_pitch": true,
    "page_area": true,
    "page_layers": true,
    "page_summary": true,
    "page_materials": true,
    "page_ventilation": true,
    "page_gutters": true,
    "page_notes": true
  }
}
```

Rules:

- the caller may send these for summary PDFs
- the API should not fetch these rules from organizations
- if omitted, the API can use built-in defaults
- if `pages` are explicitly requested, `pages` should take precedence over broad toggle fields

---

## SQLite Index Schema

`_project_index.php` is already close, but the standalone API should extend it slightly.

## Recommended `projects` Table

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  status TEXT,
  project_type TEXT,
  address TEXT,
  owner_id TEXT,
  owner_email TEXT,
  org_id TEXT,
  team_id TEXT,
  assigned_to_id TEXT,
  reserved_to_id TEXT,
  qa_claimed_by_id TEXT,
  is_filler INTEGER,
  is_vip INTEGER,
  is_expedited INTEGER,
  complexity INTEGER,
  created_at INTEGER,
  queued_at INTEGER,
  processed_at INTEGER,
  started_at INTEGER,
  uploaded_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER,
  manifest_mtime INTEGER,
  has_google_image INTEGER,
  has_pdf_state INTEGER,
  has_report_pdf INTEGER,
  has_summary_pdf INTEGER,
  has_model_data INTEGER,
  has_mask_tif INTEGER,
  has_dsm_tif INTEGER,
  storage_path TEXT
);
```

## Optional `project_events` Table

Useful if you want filterable audit history without constantly opening manifests.

```sql
CREATE TABLE project_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  created_at INTEGER NOT NULL,
  payload_json TEXT
);
```

---

## Endpoint Surface

The new API should be resource-oriented instead of action-string-oriented.

## Core Project Endpoints

- `POST /projects`
  - create a project
  - may optionally kick off imagery / insight processing
  - may include `gutter_profile`
  - may include project-level `branding_defaults`

- `GET /projects/{id}`
  - return manifest + artifact summary + branding defaults + app metadata summary

- `PATCH /projects/{id}`
  - update manifest fields

- `POST /projects/query`
  - list/search/filter projects from the SQLite index

- `POST /projects/{id}/status`
  - controlled status transition endpoint

## Artifact Endpoints

- `PUT /projects/{id}/app-metadata`
- `GET /projects/{id}/app-metadata`
- `PUT /projects/{id}/pdf-state`
- `GET /projects/{id}/pdf-state`
- `PUT /projects/{id}/branding-defaults`
- `GET /projects/{id}/branding-defaults`
- `POST /projects/{id}/artifacts`
  - generic file upload with artifact type
- `GET /projects/{id}/artifacts`
  - list stored files
- `GET /projects/{id}/artifacts/{name}`
  - stream/download a file

## Document Fetch Endpoints

These should be more explicit than the generic artifact endpoints because PDFs and XML have special fetch behavior.

- `GET /projects/{id}/pdfs/{type}`
  - fetch stored PDF by default
  - `type` is typically `report` or `summary`

- `POST /projects/{id}/pdfs/{type}/assemble`
  - generate a customized PDF instead of returning the stored one

- `GET /projects/{id}/xml`
  - fetch stored XML by default

- `POST /projects/{id}/xml/assemble`
  - generate or assemble a customized XML output instead of returning the stored one

## Render Endpoints

- `POST /projects/{id}/render/pdf`
  - generate full PDF from saved `pdf_state.json`

- `POST /projects/{id}/render/pdfs`
  - generate full + summary in one request

- `POST /projects/{id}/render/pages`
  - generate one or more selected pages as a PDF fragment bundle

- `POST /projects/{id}/render/page`
  - generate a single selected page as its own PDF

- `POST /render/pdf`
  - generate a PDF from inline snapshot payload without a saved project

- `POST /render/page`
  - generate a single selected page from inline snapshot payload without a saved project

## Processing Endpoints

- `POST /projects/{id}/process/imagery`
- `POST /projects/{id}/process/mask`
- `POST /projects/{id}/process/insights`

These let you keep Google-dependent work inside the API without mixing it into basic CRUD.

---

## Request Context Contract

Because the API must not read users or orgs directly, all actor context should be explicit.

## Suggested Request Context Shape

```json
{
  "actor": {
    "id": "jack@1m8.ai",
    "email": "jack@1m8.ai",
    "name": "Jack",
    "roles": ["admin", "qa"],
    "team_id": "default",
    "organization_id": null
  }
}
```

Rules:

- FirstMeasure records this context.
- FirstMeasure does not verify it against user files.
- The caller is responsible for authenticating the actor before calling the API.

---

## PDF Generation Contract

## Recommended Input

`POST /projects/{id}/render/pdfs`

```json
{
  "modes": ["full", "summary"],
  "page_config": {
    "page_top_view": true,
    "page_elevations": true,
    "page_3d": true,
    "page_pitch": true,
    "page_area": true,
    "page_layers": true,
    "page_summary": true,
    "page_materials": true,
    "page_ventilation": true,
    "page_gutters": true,
    "page_notes": true
  },
  "branding": {
    "full": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    },
    "summary": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    }
  },
  "apply_branding_to_full": false,
  "persist_files": true,
  "update_status": true
}
```

All branding fields should be optional.

If only `branding.summary` is provided, then only the summary PDF is branded.

If only `branding.full` is provided, then only the full PDF is branded.

If neither is provided, the API falls back to stored defaults and then to built-in defaults.

## Selected Page Rendering Contract

`POST /projects/{id}/render/pages`

```json
{
  "mode": "summary",
  "pages": [
    {
      "key": "ventilation",
      "page_number": 8,
      "show_page_number": true
    },
    {
      "key": "gutters",
      "page_number": 9,
      "show_page_number": true
    },
    {
      "key": "notes",
      "show_page_number": false
    }
  ],
  "page_config": {
    "page_ventilation": true,
    "page_gutters": true,
    "page_notes": true
  },
  "branding": {
    "summary": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    }
  },
  "persist_files": false
}
```

Rules:

- `pages` defines the exact output order
- each page entry may optionally include `page_number`
- if `show_page_number` is `false`, the fragment should render without a page number
- if `page_number` is omitted, the fragment should render without forced numbering unless the caller requests auto numbering
- `persist_files` should usually be `false` for page fragments unless you later want archival behavior

## Single Page Rendering Example

`POST /projects/{id}/render/page`

```json
{
  "mode": "summary",
  "page": {
    "key": "gutters",
    "page_number": 9,
    "show_page_number": true
  },
  "branding": {
    "summary": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    }
  }
}
```

This allows requests such as:

- give me only the gutter page
- give me the gutter page labeled as page 9
- give me the gutter page with no page number so I can assemble my own PDF later

## Page Numbering Strategy

Recommended behavior:

- whole-document render endpoints use normal sequential numbering
- page-fragment endpoints default to no page number unless explicitly requested
- page-fragment endpoints may accept an explicit `page_number`
- page-fragment endpoints may later support `page_label` if you want non-numeric page marks

This keeps fragments flexible for later composition workflows.

## PDF Fetch Behavior

Stored-file fetch should be the default behavior.

Recommended rules:

- `GET /projects/{id}/pdfs/report` returns the existing stored report PDF by default
- `GET /projects/{id}/pdfs/summary` returns the existing stored summary PDF by default
- callers should only trigger regeneration/custom assembly when they explicitly use the assembly endpoint

This matches the expected production flow:

1. the PDF is usually generated once when the project is completed
2. most downstream consumers fetch the already-generated file
3. custom assembly is an explicit opt-in path

Example:

```text
GET /projects/{id}/pdfs/report
```

Optional explicit source parameter if you want it for clarity:

```text
GET /projects/{id}/pdfs/report?source=stored
```

If you support a query parameter here, `stored` should be the default.

## Customized PDF Assembly

`POST /projects/{id}/pdfs/report/assemble`

```json
{
  "source": "custom",
  "mode": "full",
  "page_config": {
    "page_ventilation": true,
    "page_gutters": true
  },
  "pages": [
    {
      "key": "gutters",
      "page_number": 9,
      "show_page_number": true
    }
  ],
  "branding": {
    "full": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    }
  },
  "persist_files": false
}
```

This should return a regenerated/customized PDF and should not overwrite the stored default unless explicitly requested.

## XML Fetch And Assembly

XML should follow the same pattern as PDFs.

Recommended rules:

- `GET /projects/{id}/xml` returns the stored XML file by default
- custom XML output should use a separate assembly endpoint
- stored XML fetches should be the common path
- regenerated/custom XML should be explicit and opt-in
- `format` is optional and defaults to `roofplan`
- current accepted format aliases normalize into `roofplan`, `esx`, `applicad`, or `firstmeasure`
- `roofplan` returns the stored `model_data.xml`
- `esx` returns a dedicated `.esx` export derived from the stored Roofplan geometry
- `applicad` returns a dedicated `.rxf` export derived from the stored Roofplan geometry
- `firstmeasure` returns the generated internal XML document

Example stored fetch:

```text
GET /projects/{id}/xml
```

Optional explicit source parameter:

```text
GET /projects/{id}/xml?source=stored
```

Example format selection:

```text
GET /projects/{id}/xml?format=esx
```

Recommended stored file convention:

- original or canonical saved XML: `model_data.xml`
- optional assembled/generated variant: `model_data.generated.xml`

## Customized XML Assembly

`POST /projects/{id}/xml/assemble`

```json
{
  "source": "custom",
  "format": "roofplan",
  "options": {
    "include_gutters": true,
    "include_measurements": true
  },
  "persist_files": false
}
```

Recommended behavior:

- assemble from the current project state
- return the XML payload directly
- do not overwrite `model_data.xml` unless explicitly requested
- if persistence is needed, store the generated variant separately from the canonical stored XML

## Shared Stored-Vs-Custom Rule

For both PDFs and XML:

- stored fetch is the default
- custom assembly is a separate explicit path
- default fetches should not trigger regeneration
- regeneration/customization should happen only when the caller deliberately asks for it

## Project Creation Contract Additions

`POST /projects`

```json
{
  "address": "8915 196th St SW, Edmonds, WA 98026, USA",
  "project_type": "residential",
  "pins": [],
  "gutter_profile": {
    "enabled": true,
    "style": "k-style",
    "size": "5in",
    "color": "white",
    "notes": "Save only for now"
  },
  "branding_defaults": {
    "full": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    },
    "summary": {
      "logo_url": "https://...",
      "primary_color": "#AA2211",
      "secondary_color": "#552211"
    }
  }
}
```

For now, `gutter_profile` is persistence-only data. It does not need to affect calculations yet.

## Server-Side PDF Runtime Recommendation

Do not port the current PDF logic into pure PHP.

The current runtime in `editor_scripts/pdf.js` depends heavily on:

- `window`
- `document`
- `canvas`
- `Image`
- browser fetch/image loading

So the best design is:

1. PHP API receives the request
2. PHP loads `pdf_state.json` and `branding_defaults.json`
3. PHP hands the job to a headless browser worker
4. the worker loads a small HTML harness that imports the existing PDF scripts
5. the worker returns PDF bytes
6. PHP stores `Report.pdf` / `Summary.pdf` and updates project state

This keeps the PDF logic close to the current implementation and avoids a risky rewrite.

---

## Minimal Crossover Rules

To keep the API genuinely standalone:

- no direct includes of `_users.php`
- no direct includes of `_organizations.php`
- no session-based permission checks
- no reading from `users/` to infer org/team
- no live org branding lookup during `load` or PDF generation
- no Stripe/refund side effects
- no email sending inside core project save flows

If outside systems need to react, use:

- explicit caller-supplied context
- outbound webhooks
- async jobs
- separate integration endpoints

---

## What Can Be Moved Over First

## Phase 1

- project storage
- manifest backup/save
- app metadata save/load
- pdf state save/load
- artifact upload/download
- index/search/list

## Phase 2

- status transitions
- imagery / insights processing
- mask generation
- report persistence

## Phase 3

- headless server-side PDF generation
- optional QA/manager workflow endpoints using caller-supplied actor context

## Phase 4

- integration hooks back to portal auth/billing/email, if still needed

---

## Recommended Implementation Boundary

The cleanest shape is:

- FirstMeasure owns project data and render jobs
- the portal owns identity, billing, org settings, and policy
- the portal passes only the context FirstMeasure needs for a specific call

That gives you very little required crossover while still preserving the existing project behavior.

---

## Practical Conclusion

This is feasible without much crossover if we do three things:

1. treat org/user/team references as opaque stored values, not live joins
2. snapshot branding/report settings onto the project instead of reading orgs live
3. run PDF generation in a headless browser worker instead of trying to recreate `pdf.js` in PHP

If we follow that boundary, the standalone API can own the majority of what `_projects.php` and `_project_index.php` are doing today.
