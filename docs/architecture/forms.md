# Forms

Forms are the platform's embeddable intake surface: a company builds a form
from blocks, publishes it, and puts it on any website, a FirstMate site, or a
shareable link. A submission always creates a lead; depending on its blocks it
can also book an appointment and show a calculated price estimate.

Forms are industry-neutral. Nothing in the engine knows about roofing or any
other trade; trade-specific behaviour is seed content (templates and
measurement sources) that an organization edits like anything else.

Code: [`public/v1/forms`](../../public/v1/forms/README.md) (API),
`public/libraries/forms-embed` (public renderer), `public/libraries/forms-api`
(authenticated client), `public/libraries/apps/settings/forms.js` (library and
editor, under Settings → Forms and Leads).

## Model

A form definition is `{ presentation, steps, calculation, settings }`.

- **Steps** are screens. Each holds **blocks**: `contact`, `address`, `text`,
  `paragraph`, `number`, `select`, `multi_select`, `boolean`, `date`,
  `appointment`, `property_measurement`, `consent`, `content`.
- A block that collects a value has a `param`, its answer key. Blocks and steps
  can be shown conditionally with `visible_when` over earlier answers.
- **Calculation** is optional. `pricing` mode is a declarative price table
  (a quantity taken from an answer or measurement, priced options, percentage
  adjustments). `code` mode is author-written JavaScript.
- **Settings** hold what happens on submission: who is notified, the
  confirmation email, a tracking key.

There are no form "types". Appointment, estimate and contact forms are
templates that arrange the same blocks. A new kind of form is a new template; a
new capability is a new block kind (register it in `forms/contracts.ts`, render
it in the embed, add it to the editor's block editor).

## Forms are document modules

Publishing compiles the definition into a **workflow document module**
(`forms/compile.ts`) and stores it content-addressed through the document
module store:

| Form | Module |
| --- | --- |
| Answers | `inputSchema`, and the `answers` read export |
| Blocks and steps | `workflow` (the document workflow definition contract; blocks are workflow item kinds) |
| Calculation, with its price table inlined | `source` |
| Estimate | `outputSchema`, and the `estimate` read export |

So a published form — questions and pricing together — is one immutable
version. Editing a live form changes only the draft; visitors keep the last
published version until the draft is published again.

When a submission produces an estimate and the organization has Documents
enabled, the submission is also recorded on the new project as a **frozen
instance** of that module version, with the answers as inputs and the estimate
as its evaluated output. Staff see it with the project's other workflow
instances, and it can feed documents through the normal `document-modules`
provider.

Form block kinds are registered in the shared workflow item-kind registry on a
`forms` surface, so they validate inside module workflows without appearing in
the document workflow editor.

## Calculations on anonymous requests

A public submission runs tenant-authored code, so the boundary is deliberately
narrow:

- The calculation runs in the existing document-module sandbox (QuickJS in a
  worker, bounded time and memory), **evaluate-only**.
- Its broker exposes **no** data reads and **no** actions. The only inputs are
  the validated answers and the parameters inlined at publish time. A form
  calculation cannot reach organization data or cause an effect.
- Output must match the estimate contract in `forms/contracts.ts`
  (`{ currency, low, high, options?, quantity?, adjustments?, disclaimer? }`).

This is why form calculations declare no publication bindings. Reading live
organization data (for example pricebook items) from a public calculation would
need a new anonymous execution kind in the publication layer; that is a
separate design decision and is not implemented.

## Measurements

A `property_measurement` block names a **measurement source**
(`forms/sources.ts`) that turns the visitor's address into typed values. The
first source, `solar_roof`, measures roof area and steepness from imagery. Its
values land under the block's `param` (for example
`measurement.roof_area_sqft`), where pricing and conditions read them like any
other answer.

The measurement shown to the visitor is HMAC-signed and returned with the
submission, so pricing uses exactly what the visitor saw without a second
provider call. Client-supplied values are ignored; an invalid or missing token
makes the server measure again, and an unavailable measurement falls back to the
pricing's typical size. Provider keys never leave the server.

## Appointments

The `appointment` block selects one of the organization's **appointment types**
(the presets in Settings → Scheduling). Duration, arrival window, departments,
staffing and working hours all come from that type; the block adds only
web-facing limits (minimum notice, how far ahead to book).

- Availability calls `previewAppointment`, the engine behind staff booking,
  planned against the address the visitor entered.
- Submission re-checks the slot, creates the lead, then calls
  `bookPlannedAppointment`: the same writer staff use. The result is a real
  scheduled event with assignees, customer visibility, confirmation and the
  `project.event_scheduled` work event.
- If the slot is taken before submission, the visitor is asked to choose again
  and no lead is created. If booking fails after the lead exists, the lead is
  kept and marked with the requested time for staff to confirm.

Multi-day and recurring appointment types cannot be booked from a form.

## Public surface

| Route | Purpose |
| --- | --- |
| `GET /v1/forms/public/:key` | The published form: presentation and blocks only |
| `GET /v1/forms/public/:key/availability` | Open times for an appointment block |
| `POST /v1/forms/public/:key/measurement` | Measure and preview a property |
| `POST /v1/forms/public/:key/submit` | Validate, price, create the lead, book |

- The **key** encodes the organization and form, so a request resolves in one
  read, and carries a secret segment. Resetting it revokes every embed and link.
- Every public route is rate limited per visitor and per form; the measurement
  route, which reaches a metered provider, is the tightest.
- Limits key on the visitor's address: the right-most public entry of
  `X-Forwarded-For` when the request arrives through our own proxies.
- Submissions carry a client id that the embed keeps across retries. The lead
  and the booking get identities derived from it, so a retry after a lost
  response resolves to the same lead and appointment instead of repeating them.
- A honeypot field drops bots silently; the server re-validates every answer
  against the published definition and discards answers to hidden blocks. A
  "show when" rule may only depend on an earlier block, so browser and server
  always agree on what is shown; publishing rejects forward references.
- A calculation that fails (nothing measurable, no matching option, a timeout)
  never fails the submission: the lead is created with `estimate_error` and the
  visitor is told pricing will follow.
- The confirmation email goes to an address the visitor typed, so it carries
  only company-authored text and computed values. The visitor's name is used in
  the greeting only when it is plainly a name.
- Responses never include project or staff data. Scheduling configuration,
  notification roles and field mappings never leave the server.

## Where answers go

- A lead via `createPlatformLead` (`source: "web_form"`), with the answers,
  estimate and source page under `form_submission`. Lead routing and
  automations key on `project.created` as for any lead.
- A `form_submissions` record, listed in the form's Submissions tab.
- Blocks with `maps_to` write the project's declared custom fields through the
  `custom-fields.project.write` action.
- `lead.form.submitted`, and `lead.instant_estimate.generated` when priced.
- A confirmation email to the visitor when the form enables it.

Follow-ups (email, field mapping, the module instance) run after the visitor's
confirmation is returned and never fail the submission.

## Authoring

The editor autosaves the draft, and renders the real public embed beside it as a
live preview running the unsaved draft through authenticated preview routes
(`/v1/forms/organizations/:orgId/preview/*`). Submitting in the preview prices
the answers and creates nothing.

The **Form Builder agent** (`forms/agent.ts`, agent id `forms`) follows the
document designer's contract: the editor sends the open draft with each message,
the agent stages a complete validated replacement with `update_form`, and the
editor applies it to the draft. It can check its own pricing with
`test_estimate`. It cannot save or publish.

## Capabilities

`platform.website_embed_import` enables forms. The `lead_forms.*` flags gate
blocks, not form types: `appointment_form` for the appointment block,
`instant_estimate` for pricing and measurement, `contact_form` for forms that
use neither. Authoring requires `manage_company_settings`.

## Verification

From `public/v1`:

- `npm run test:forms` — API behaviour, including booking, pricing, the module
  instance, capability gating and rate limits.
- `npm run test:forms:browser` — the embed and editor in Chrome against the
  real API, with only the assistant's model call replaced. Set
  `FORMS_SCREENSHOT_DIR` to keep screenshots.
- `npm run test:forms:frontend` — syntax checks for the browser files.
