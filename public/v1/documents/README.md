# Documents module (`/v1/documents`)

Backend of the FirstMate document engine (see `docs/document-engine-spec.md`
and `docs/document-engine-contracts.md` §3). Templates, themes, instances,
snapshots, outputs, PDF rendering, and ingestion for every "designed surface"
(proposal, invoice, change order, contract, work order, generic).

The shared format library `public/libraries/doc-model/firstmate-doc-model.js`
(`FMDocModel`, loaded via `createRequire` in `schemas.ts`) is the single source
of truth for the DocModel shape, expressions, override patches, theme tokens,
and validation — nothing in this module reimplements it.

## Files

| File | Responsibility |
|---|---|
| `schemas.ts` | zod schemas for all API bodies; loads + re-exports `FMDocModel` |
| `storage.ts` | CRUD over `document_templates`, `document_template_versions`, `documents`, `document_snapshots`, `document_events`, `document_themes` (+ `document_theme_versions`); immutable version rows with sha256 checksums, `current_version` pointers, `expected_version` conflicts; `document_events` mirrored into `emitWorkEvent` |
| `types/registry.ts` | `registerDocumentType` + built-ins (proposal, invoice, change_order, contract, work_order, generic) |
| `widgets/registry.ts` | `registerDocumentWidgetResolver` + `resolveDocumentWidgetData` (results keyed by node id; failures/unknowns → `null`, never throw) |
| `widgets/builtins.ts` | Server resolvers: `doc.line_items` (reuses `proposals/scope.ts` pricing math), `doc.payment_schedule`, `doc.pay_now`, `doc.photo`, `doc.photo_grid`, `doc.measurement_report`, `doc.signature`, `doc.qr` |
| `service.ts` | Lifecycle: create/issue (param resolution order per contract), resolve (overrides → bindings → widget data → theme tokens), snapshots (frozen data + `public_token`), outputs (evidence capture, status recomputed via `requiredOutputsSatisfied`), events |
| `pdf.ts` | Playwright pipeline generalized from `proposals/pdf.ts` (`renderDocumentPdf({ html, paper })`, waits for `window.__fmdocReady`) + pdf-lib fallback |
| `render.ts` | `buildRenderHarnessHtml` — inlines doc-model/doc-renderer/doc-widgets sources + payload JSON, boots `FMDocRenderer` in static mode; clear error if the renderer libraries are not built yet |
| `ingestion.ts` | v1 upload pipeline: media store → `source:"uploaded"` instance in `needs_review`; `registerDocumentExtractor` hook (LLM pass not wired yet), filename/type heuristic fallback |
| `seeds.ts` | `ensureDefaultDocumentAssets(orgId)` — seeds Margin/Triangles/Clean themes (page-master chrome ports the legacy PROPOSAL_THEMES CSS) + proposal/invoice/change-order templates; upgrades by `preset_revision` like scope templates |
| `api.ts` | `registerDocumentsApi(app)` — all routes below; proposals-style auth (`requirePlatformAuth`, CSRF), `view_projects` for reads/instance writes, `manage_company_settings` for template/theme writes; public routes token-only |

## Routes

```
GET  /organizations/:orgId/templates?document_type=&status=      (lazy-seeds presets)
POST /organizations/:orgId/templates
GET|PATCH|DELETE /organizations/:orgId/templates/:templateId
GET  /organizations/:orgId/templates/:templateId/versions[/:version]
POST /organizations/:orgId/templates/:templateId/publish          { definition, expected_version }
                     — same family for /themes —
GET  /organizations/:orgId/catalog                                { widgets, types, themes, fonts }
GET|POST /organizations/:orgId/projects/:projectId/documents
GET|PATCH|DELETE /organizations/:orgId/documents/:documentId
POST /organizations/:orgId/documents/:documentId/resolve          { resolved_definition, widget_data, theme, theme_vars }
POST /organizations/:orgId/documents/:documentId/issue|send|snapshots
GET  /organizations/:orgId/documents/:documentId/snapshots|events
POST|GET /organizations/:orgId/documents/:documentId/pdf
POST /organizations/:orgId/documents/:documentId/outputs/:key
POST /organizations/:orgId/documents/ingest                       (base64 JSON body)
GET  /public/:token          POST /public/:token/view
POST /public/:token/outputs/:key                 GET /public/:token/pdf
POST /public/:token/pricing                      { checkout: { payment_method } }
```

## Conditional pricing (spec §10.4) + option groups (§10.3)

Scope/line item rows may carry `condition` (expression), `expires_at` (ISO;
sugar for `AND now < expires_at`), `pricing: { formula }`, `badge`, and
`discount: true`. **Formulas evaluate to CENTS** (rounded, may be negative)
and override `amount_cents`.

Resolution scope adds `checkout` (`{ payment_method: "card"|"ach"|null,
processing_fee_percent: 3 }` via `options.checkout` / the `/resolve` body) and
an extended `doc` entity (`sent_at`, `first_viewed_at`, `last_viewed_at`,
`signed_at`, `expires_at`, `valid_days`) so `days_since(doc.sent_at)` works.

Evaluation order is two-pass: (1) non-conditional base rows price normally and
their top-level sum becomes `rows_subtotal_cents`; (2) conditional/formula rows
evaluate against the pricing scope + `rows_subtotal_cents` (aliased
`computed.subtotal_cents`), so percent formulas reference the base subtotal and
never each other. Effective amounts (0 when excluded) are written onto the
enriched tree so seeded `sum(params.scope_items[].amount_cents)` computed
chains stay correct. The flat projection (`scope_rows`/`line_rows`) drops
excluded rows; a parallel `conditional_rows`/`line_conditional_rows` inventory
keeps every condition-bearing row + expression + `included` state for
client-side re-evaluation (frozen but reactive).

`params.proposal_options[n]` enrich the same way, gaining `rows` +
`total_cents` per option; recording `outputs.option_choice` write-through
derives `params.scope_items` from the chosen option (options stay intact).

`POST /public/:token/pricing` re-evaluates the snapshot's rows/totals under a
checkout state server-side (`{ rows, conditional_rows, totals }`); the mock
deposit/payment path recomputes its amount through the same evaluation —
client totals are never trusted.

## Integration (owned by the main session)

- Add the collections to `platform/storage.ts` COLLECTIONS:
  `document_templates`, `document_template_versions`, `document_themes`,
  `document_theme_versions`, `documents`, `document_snapshots`, `document_events`.
- Mount in `src/app.ts`: `app.register(registerDocumentsApi, { prefix: "/v1/documents" })`.
- Register `document.*` event names in `work/events.ts` and the
  `documents.issue.v1` automation in `work/automations/builtins.ts`.
- Build `public/libraries/doc-renderer` + `doc-widgets`; until they exist, PDF
  generation degrades to the typed pdf-lib fallback.
