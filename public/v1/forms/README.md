# V1 Forms API

Mounted at `/v1/forms`. Owns form definitions, publishing, the public form
runtime and submissions. Read [the forms architecture](../../../docs/architecture/forms.md)
before changing how forms are modelled, priced, booked or exposed publicly.

## Ownership

- Forms owns definitions, the public runtime and `form_submissions`.
- Platform owns the records a submission creates: projects, contacts,
  notifications (`createPlatformLead`).
- Appointments owns availability and booking (`previewAppointment`,
  `bookPlannedAppointment`). Do not compute slots or write events here.
- Documents owns the module store and sandbox. Forms publishes into it through
  `storeModuleVersion` and runs calculations with `runModuleCode`.
- Email owns delivery. Forms decides when a confirmation is sent.

## Files

| File | Purpose |
| --- | --- |
| `contracts.ts` | Definition schemas, block kinds, conditions, the estimate output contract |
| `templates.ts` | Starting points for new forms, including industry packs |
| `compile.ts` | Definition → workflow document module; the standard estimator source |
| `answers.ts` | Server-side answer validation and visibility |
| `sources.ts` | Measurement source registry and signed measurement tokens |
| `solar.ts` | Google Solar roof measurement and imagery (also used by weather reports) |
| `service.ts` | Authoring, publishing, the public runtime, submission pipeline |
| `assistant.ts` | Forms tools, instructions and form-conversation context for the shared assistant |
| `insights.ts` | Anonymous activity counts and the submissions summary |
| `publication.ts` | The `forms.catalog` export the form widgets are authorized against |
| `api.ts` | Routes and public rate limits |

Storage: organization collections `forms` (draft, published snapshot, embed key),
`form_submissions` and `form_activity` (per-form daily counts).

## Routes

Authenticated (`manage_company_settings`, CSRF on writes), under
`/organizations/:orgId`:

- `GET /context` — templates, block kinds, appointment types, measurement sources.
- `GET|POST /forms`, `GET|PATCH|DELETE /forms/:formId`.
- `POST /forms/:formId/publish`, `/duplicate`, `/rotate-key`.
- `GET /forms/:formId/submissions`, `GET /forms/:formId/insights`.
- `POST /forms/:formId/conversation` — the caller's assistant conversation about
  this form (the editor's AI tab).
- `POST /preview/measurement`, `/preview/availability`, `/preview/submit` — run
  an unsaved draft for the editor's live preview. Nothing is created.

Public, rate limited, no credentials:

- `GET /public/:formKey`
- `GET /public/:formKey/availability?item_id=&date=YYYY-MM-DD&address=`
- `POST /public/:formKey/measurement` `{ item_id, address }`
- `POST /public/:formKey/activity` `{ type: view|start|step, step_id? }`
- `POST /public/:formKey/submit` `{ answers, measurements, submission_id, page_url, referrer }`

`PATCH` saves a draft against the structural schema so work in progress can be
stored. Publishing validates the complete definition and returns
`form_incomplete` with a list of what to finish.

## Rules

- Do not add form "modes". Add a block kind or a template.
- Do not return project, contact or staff data from a public route.
- Do not give the calculation broker reads or actions. See the architecture
  note on anonymous execution.
- Keep provider keys server-side; the browser receives rendered preview data and
  a signed token only.
- `EMAIL_OUTBOUND_DISABLED=1` stops confirmation emails in tests.
  `FORMS_RATE_LIMIT_DISABLED=1` disables public rate limits for test suites
  that submit repeatedly from one address.

## Embedding

```html
<script src="https://app.1m8.ai/libraries/forms-embed/firstmate-forms-embed.js" data-form="FORM_KEY"></script>
```

The script renders where it is placed (or into `data-target`), in a shadow root.
`FirstMateForms.render({ key, target })` does the same programmatically and
returns a controller. The mount element emits `fm-form:ready`, `fm-form:step`
and `fm-form:submitted`. A hosted page for sharing by link is at
`/libraries/forms-embed/form.html?k=FORM_KEY`. FirstMate sites place forms with
the `web.lead_form` widget.
