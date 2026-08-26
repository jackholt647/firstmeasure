# V1 Lead Intake API

The Lead Intake API is mounted at `/v1/lead-intake`.

It owns embeddable website forms and public form submissions. This includes appointment forms, generic submit/intake forms, instant estimate forms, and future website-embedded custom forms.

## Ownership

- Lead Intake owns form definitions and form-specific intake settings.
- Platform owns the CRM records created by submissions: projects, project contacts, and notifications.
- Email owns inbound/outbound email transport and parsing only.

Form definitions are stored in the Platform branch module:

```text
branch_data/{branchId}/lead_intake.json
```

The shape is intentionally schema-light:

```json
{
  "schema_version": 1,
  "enabled": true,
  "project_stage_id": "new_lead",
  "notification_target_role_ids": ["inside_sales", "sales_appointments"],
  "forms": []
}
```

Each form may use `mode` values such as `appointment`, `call`, `submit_form`, or `instant_estimate`. Future custom form modes should also be stored here rather than under the Email API.

## Routes

- `GET /v1/lead-intake/organizations/:orgId/branch/:branchId/settings`
- `PATCH /v1/lead-intake/organizations/:orgId/branch/:branchId/settings`
- `GET /v1/lead-intake/organizations/:orgId/branch/:branchId/forms`
- `PUT /v1/lead-intake/organizations/:orgId/branch/:branchId/forms`
- `GET /v1/lead-intake/public/forms/:formId`
- `GET /v1/lead-intake/public/forms/:formId/availability?date=YYYY-MM-DD`
- `POST /v1/lead-intake/public/forms/:formId/solar-preview`
- `POST /v1/lead-intake/public/forms/:formId/submit`
- `POST /v1/lead-intake/organizations/:orgId/branch/:branchId/forms/:formId/instant-estimate-preview`

Public submissions call `createPlatformLead(orgId, input)` from `platform/api.ts`. Do not duplicate project contact or notification creation inside lead-intake.

## Instant Estimates

Instant estimate forms use `mode: "instant_estimate"` and submit through the same public Lead Intake endpoint:

```text
POST /v1/lead-intake/public/forms/:formId/submit
```

The submission path:

1. Reads the form's `estimate` settings and question pages.
2. Calls the Google Solar API server-side. The key is resolved from the central `private/provider-keys.json` credential file (with environment variables retained only as a compatibility fallback).
3. Falls back to `estimate.default_sqft` when Solar data or a key is unavailable.
4. Creates the Platform lead with `project_data.instant_estimate`.
5. Sends the customer estimate through the Email-owned outbound helper.

The Platform settings preview uses the authenticated `instant-estimate-preview` route. It should call Solar for the entered property and show real measured roof area/range. Do not reintroduce mock roof-area preview math in the frontend.

The public address step uses `solar-preview` to render a 2D top-down RGB Solar layer with the Solar mask overlay. Keep Google API keys on the server; browser embeds should only receive rendered preview data. Do not add `google_api_key` or similar fields to Lead Intake public requests/responses.

Lead Intake decides when and what to send. Email owns delivery only. Do not expose a public arbitrary-send email route from form submissions.

Email delivery uses Postmark through `email/outbound.ts`. Configure one of:

- `POSTMARK_SERVER_TOKEN`
- `POSTMARK_API_TOKEN`
- `FIRSTMEASURE_POSTMARK_TOKEN`
- `storage/secrets/pm_server_token.txt`

Set `EMAIL_OUTBOUND_DISABLED=1` for tests or local probes that should never send real email.

## Migration

Older appointment/call forms were stored at:

```text
branch_data/{branchId}/lead_import.json
data.website_forms[]
```

`ensureLeadIntakeSettings()` migrates those forms into `lead_intake.json` and removes `website_forms` from the Email-owned `lead_import` module. The legacy `/v1/email/public/forms/*` endpoints delegate to this API for compatibility only.

New code should use:

- Browser management client: `public/libraries/lead-intake-api/lead-intake-api.js`
- Public embed: `public/libraries/lead-embed/firstmate-lead-embed.js`
