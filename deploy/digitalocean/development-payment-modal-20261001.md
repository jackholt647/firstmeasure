# Payment modal and redirect comparison — prepared October 1, 2026

Status: implemented and verified locally; **not deployed**. SSH to the configured
development jump host `dev-sync-droplet` repeatedly timed out. No production or
development service was activated.

Direct payment setup entry points (including the banner) now open a hosted
application iframe in a modal through `FirstMatePaymentsSetup.open`. Explicit
assistant setup still mounts the existing streamed Chromium widget; its agent
and dashboard path is unchanged. The own-origin completion page's Close button
closes only the matching modal iframe, with origin and source checks.

Development signup-sandbox organizations get a floating DEV control in the
modal's upper left. Before opening the application, it shows the organization
name/ID, absence or presence of prior payment setup, and bank-account count.
Choose **With redirect** or **Without redirect**. The former sends the existing
custom completion URL in `partner_data.redirect_url`; the latter omits it from
the newly created application. The backend reads the application back from
Forward and returns the persisted redirect value for the recording panel.

Each comparison requires a fresh organization with no existing Forward
business, application or account. Mode overrides require development, Forward
sandbox credentials, signup-sandbox metadata, organization authorization and
CSRF. Existing applications cannot be relabeled as fresh. There is no automatic
bank linking, signing or submission, nor a claim that Forward's redirect timing
has been fixed.

Recording sequence after deployment:
1. Open `/portal/signup-sandbox/` and launch **Instant full org (dev)**.
2. Click the payment setup banner. Record the DEV panel's org and bank status.
3. Choose **With redirect**, expand DEV to record the saved redirect, then
   complete Forward's form and record the destination.
4. Launch a separate fresh Instant full org and repeat **Without redirect**.

Validation: TypeScript check and JavaScript syntax passed. Three targeted tests
passed, covering both modes, provider readback, fresh-org restrictions,
non-sandbox/production rejection, and existing stream authorization. Local
browser fixture checks verified both modal choices, ordinary direct entry,
agent entry and disabled comparison controls for an existing organization.
Live Forward iframe compatibility and recording flow still require hosted
verification after deployment. Preserve unrelated canonical changes and stage
only this task's files; backend and frontend must deploy together.
