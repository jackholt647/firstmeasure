# Payments, expenses, and receipt evidence

This module owns project income, payouts, projected/actual expenses, receipt evidence, and the accounting view consumed by the project Money app. Scope resource lists remain the source of projected material, labor, and equipment costs; the payments API supplies actual-cost overrides, supplemental expenses, receipt attribution, and project-wide rollups.

## Expense model

Every active scope resource list becomes an expense target with a stable key:

- `scope_resource_list:<list id>` for material, labor, and equipment lists.
- `supplemental_expense:<expense id>` for unplanned or small purchases that do not belong in scope.

Each target retains its projected amount. An actual override never destroys the projection. The summary exposes `projected_cents`, `actual_cents`, `current_cents`, and `variance_cents`, so the UI can make actual cost primary while retaining the original estimate beneath it.

Applied receipts create edges between their attributed targets. The summary computes connected components across those edges. If one receipt covers A+B and a second covers B+C, A+B+C are one group. The group actual is the sum of each receipt exactly once; projected list rows stay visible and no unsupported allocation across the lists is invented.

The summary always includes global projected/current/variance totals and resource-type rollups. For a mixed receipt group, an actual cannot be honestly assigned back to individual resource types, so resource-level current totals intentionally omit that ambiguous allocation while the global group remains correct.

## Labor projection

Labor uses the canonical workforce resource-group and organization-connection records. Direct member compensation takes precedence over group compensation, matching workforce behavior.

- Piece rate is projected per labor scope line item.
- Hourly compensation is projected per member from the list's estimated hours or member-specific hours.
- Salary is omitted by default. A labor list can opt into expense conversion, using an explicit hourly-equivalent rate or salary-period hours.
- Mixed teams can produce piece-rate, hourly, and converted-salary sub-items at the same time.
- Empty compensation categories are omitted instead of returning display rows with zero amounts.

Salary components can store `hours_per_period` and `hourly_equivalent_rate_cents`. If neither is set, standard period-hour defaults are used for the estimate. These are projections only and can later be replaced by actual cost or receipt evidence.

## Receipt lifecycle

1. A client uploads a new file, or references an existing library media ID.
2. The original file is saved in the project library before extraction.
3. A receipt record stores the file hash, uploader identity, exact upload time, server network context, proxy geolocation headers, browser-reported context, project associations, and an append-only extraction-attempt history.
4. Extraction returns normalized structured data. The original model result is retained separately from user overrides.
5. The API suggests one or more expense targets using a bounded closest-total search.
6. A user reviews the editable title, total, purchase date/time, and target selection, then applies the receipt.
7. Applying overlapping receipts changes grouping; it does not mutate source scope lists or erase projections.

Receipt records may be `processing`, `needs_review`, `ready`, `applied`, or `void`. Voiding excludes a receipt from expense totals without deleting its original evidence.

Receipt writes use optimistic revisions. A stale review cannot overwrite a newer attribution, and voided evidence cannot be edited, re-extracted, or silently returned to an active state.

## Extraction and formats

Automatic extraction uses the OpenAI Responses API with a strict JSON schema and `store: false`. The configurable model default is `gpt-5.6-luna`. The schema captures:

- document type, title, vendor, invoice/receipt number, and project reference;
- purchase date, time, timezone, raw printed timestamp, and due date;
- currency, subtotal, tax, shipping, discount, tip, total, amount paid, and balance due;
- payment method/last four, lean line-item data, confidence, and notes.

The original is always retained, even when automatic extraction is unavailable or fails.

| Input | Extraction path |
| --- | --- |
| JPEG, PNG, WebP | Direct visual input |
| GIF, TIFF, AVIF, BMP, HEIC, HEIF | Bounded server conversion to a high-quality first-page JPEG, then visual input |
| PDF | Native file input, preserving document text and page imagery |
| DOC/DOCX, ODT, RTF, Pages, PPT/PPTX and related office files | Native file input |
| XLS/XLSX and related spreadsheet formats, CSV/TSV/IIF | Native file input |
| TXT, Markdown, JSON, XML, HTML, EML, YAML, logs and related text files | Native file input, with deterministic text fallback |
| Unknown or files at/above the extraction limit | Original retained; manual review required |

Receipt uploads are limited to just under 50 MB and exactly one file per request. Conversion is capped at 40 megapixels. Multi-page image containers retain the complete original but currently extract their first page and return a warning. MIME is inferred from known magic bytes where possible rather than trusting only the browser-supplied content type. Rich Office formats are accepted natively, but because native extraction may omit embedded imagery or visual layout, they carry a verification warning; PDF is preferred when document layout is accounting-significant.

Credit memos preserve an explicit `credit` direction and signed total in extraction data. They are not allowed to reduce project expenses until a dedicated credit-allocation workflow confirms the accounting treatment. Likewise, non-USD documents remain reviewable but cannot be applied to a USD project as if no conversion were required.

## API surface

All endpoints require platform authentication; mutations require CSRF and project-management permission.

- `GET /v1/payments/organizations/:orgId/projects/:projectId/expense-summary`
- `POST /v1/payments/organizations/:orgId/projects/:projectId/expenses`
- `PATCH /v1/payments/organizations/:orgId/projects/:projectId/expenses/:expenseId`
- `PUT /v1/payments/organizations/:orgId/projects/:projectId/expense-actual`
- `GET|POST /v1/payments/organizations/:orgId/projects/:projectId/receipts`
- `GET|POST /v1/payments/organizations/:orgId/receipts` for association-based field, workforce, and future inventory ingestion
- `GET|PATCH|DELETE /v1/payments/organizations/:orgId/receipts/:receiptId`
- `GET /v1/payments/organizations/:orgId/receipts/:receiptId/audit`
- `GET /v1/payments/organizations/:orgId/receipts/:receiptId/file`
- `POST /v1/payments/organizations/:orgId/receipts/:receiptId/apply`
- `POST /v1/payments/organizations/:orgId/receipts/:receiptId/extract`

Uploads accept `multipart/form-data` for browser clients and JSON with `file_base64` or an authorized `media_id` for API clients. `Idempotency-Key` serializes ordinary retry calls, returns the existing receipt, and rejects reuse with a different payload. A retry also resumes an idempotent receipt left in `processing` beyond `RECEIPT_PROCESSING_STALE_MS`. SHA-256 duplicate hints are recorded separately, but identical files are not silently discarded because a legitimate document can be associated more than once.

The generic upload contract accepts typed associations and an owner (`project`, `resource_group`, `organization_connection`, `organization_user`, `inventory`, `inventory_location`, or `organization`). It uses the same storage, extraction, evidence, and audit path as the project Money UI. Field-application users may upload for themselves and active resource-group memberships without receiving project-management authority.

The receipt file endpoint forces attachment disposition, disables MIME sniffing, and uses private/no-store caching. Untrusted forwarded IP headers are labelled as such; socket-derived request IP remains separate. Browser geolocation is collected only when the user has already granted permission. Normal receipt DTOs omit IP/GPS, full uploader identity, idempotency keys, model usage, and internal metadata; those fields are available only from the company-settings-protected audit endpoint.

Document revisions and receipt idempotency are serialized within the API process, and the server defaults to one web worker while the filesystem store is active. Before setting `V1_WEB_WORKERS` above `0` or running multiple API processes, move the idempotency claim and document compare-and-swap operations to a shared transactional store with a unique constraint.

Payables can carry `expense_target_keys`. A payout linked to a tracked list remains visible as money owed/paid but is not added to that list's projection a second time. An unlinked payable is explicitly treated as an additional projected cost.

## Configuration

```env
OPENAI_API_KEY=
OPENAI_RECEIPT_MODEL=gpt-5.6-luna
OPENAI_RECEIPT_TIMEOUT_MS=45000
RECEIPT_PROCESSING_STALE_MS=600000
```

Without `OPENAI_API_KEY`, text-like files use the deterministic fallback and every other format remains available for manual review. This is also the expected test configuration.

## Verification

`npm run test:payments` covers income/payment behavior plus mixed hourly/salary/piece-rate labor, salary exclusion, projected-versus-actual supplements, receipt extraction fallback, uploader/location audit data, project-library attachment, secure original download, and transitive overlapping-receipt grouping.
