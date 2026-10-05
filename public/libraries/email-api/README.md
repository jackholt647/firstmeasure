# Email API Browser Library

Use `libraries/email-api/email-api.js` for all browser calls to `/v1/email`.

Current surface:

- `EmailAPI.leadImport.get(orgId, branchId)` reads or creates the branch inbound lead email.
- `EmailAPI.leadImport.patch(orgId, branchId, patch)` updates lead import settings.
- `EmailAPI.leadImport.regenerate(orgId, branchId)` rotates the branch inbound lead email.
- `EmailAPI.inbound.postmark(payload, { token })` is a local/test helper for posting a Postmark-shaped inbound payload.

Do not put OpenAI keys or webhook tokens in frontend code. Production Postmark delivery should call `/v1/email/inbound/postmark` directly from Postmark/server infrastructure. The browser helper is only for local testing/admin tooling.

Website forms are not part of this client. They live in the Forms API at `/v1/forms`; use `window.FormsAPI` (`public/libraries/forms-api/forms-api.js`).

Visibility is app-flag gated. Platform UI should only show email inbox settings when `platform.lead_import` and `email.inbound_lead_import` are enabled.
