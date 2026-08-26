# Proposals V1

The proposals API owns proposal records, immutable customer-facing snapshots, proposal lifecycle events, and generated proposal PDFs. Projects, project contacts, photos, media files, and markup remain Platform-owned and are referenced instead of duplicated.

## Feature Flag

All internal proposal routes require `platform.proposals`. Public proposal snapshot routes stay reachable by token after a proposal is sent so a customer link does not break if the internal rollout flag changes.

## APIs Referenced

- Platform auth: internal routes use Platform sessions, CSRF, and project permissions.
- Platform projects: every proposal is owned by one project through `project_id`; the project keeps lightweight `proposal_ids` and `active_proposal_id` references.
- Platform project contacts: proposals store contact snapshots copied from the project or explicit proposal input. Contact details should be refreshed from the project while the proposal is editable.
- Platform media/photos: project photos and proposal-specific images are referenced by media ids. Generated PDFs are stored back into Platform media with owner type `proposal`.
- Platform media markup: proposal image entries can reference `markup_layer_id` and `frozen_markup_layer_id`; proposals should consume markup layers rather than reimplementing markup storage.
- Customer portal: sent snapshots expose public token routes for portal rendering, view tracking, signing, and PDF download.

Likely next integrations are Email for outbound sending, Pricebook for structured line items, Stripe or another payment system for deposits/payment plans, and Notifications for internal proposal activity.

## Editable Proposal Object

The main `proposal` document is the editable working copy:

```json
{
  "schema_version": 1,
  "id": "proposal_...",
  "organization_id": "org_...",
  "branch_id": "default",
  "project_id": "project_...",
  "title": "Roof Replacement Proposal",
  "status": "draft",
  "contacts": [
    { "role": "customer", "name": "Jane", "email": "jane@example.com", "phone": "555-111-2222" }
  ],
  "editable": {
    "schema_version": 1,
    "title": "Roof Replacement Proposal",
    "theme": {},
    "pages": [],
    "pricing": {},
    "measurements": {},
    "payment": {},
    "signatures": {},
    "variables": {},
    "resources": {
      "project_photo_refs": [],
      "proposal_image_refs": [],
      "markup_refs": []
    },
    "bindings": {
      "refresh_until_status": "sent",
      "project_fields": ["title", "address", "contacts", "project_type", "photos", "measurement", "measurement_project"]
    }
  },
  "resources": {},
  "delivery": {
    "state": "not_sent",
    "send_count": 0,
    "sent_at": "",
    "first_viewed_at": "",
    "last_viewed_at": "",
    "signed_at": "",
    "current_snapshot_id": "",
    "current_public_token": "",
    "recipients": [],
    "include_pdf": true,
    "include_portal": true,
    "has_unpublished_changes": false
  },
  "pdf": {
    "latest_media_id": "",
    "latest_snapshot_id": "",
    "generated_at": "",
    "page_count": 0
  }
}
```

While status is `draft`, editor bindings can refresh project/contact variables such as name, email, phone, address, measurements, and photo references. After a proposal has been sent, edits stay on the editable proposal record and set `delivery.has_unpublished_changes`, but they do not mutate the already sent snapshot.

## Snapshot Object

A `proposal_snapshot` is the locked customer-facing copy:

```json
{
  "schema_version": 1,
  "id": "proposal_snapshot_...",
  "organization_id": "org_...",
  "branch_id": "default",
  "project_id": "project_...",
  "proposal_id": "proposal_...",
  "snapshot_number": 1,
  "reason": "send",
  "title": "Roof Replacement Proposal",
  "status": "sent",
  "source_revision": 3,
  "content": {},
  "resources": {},
  "contacts": [],
  "delivery": {
    "state": "sent",
    "public_token": "..."
  },
  "project_snapshot": {
    "id": "project_...",
    "title": "",
    "address": "",
    "contacts": [],
    "photos": []
  },
  "contact_snapshot": {
    "contacts": [],
    "recipients": []
  },
  "signatures": {},
  "pdf": {},
  "locked": true,
  "locked_at": "2026-06-22T00:00:00.000Z"
}
```

Snapshots are the source of truth for what the customer saw, signed, and downloaded. The customer portal should render snapshots as structured data, not as a raw PDF, so signatures, payment controls, and proposal-specific interactions can be embedded in the portal. PDF generation is still available as a downloadable or printable representation of either the current editable proposal or a locked snapshot.

## Lifecycle

- `draft`: editable working copy, project/customer bindings may refresh.
- `sent`: sending creates a locked snapshot, optional PDF, public token, delivery dates, and a `proposal.sent` event.
- `viewed`: public view events update snapshot/proposal delivery timestamps and add `proposal.viewed`.
- `signed`: public signature locks signature data on the snapshot, updates the proposal status, and adds `proposal.signed`.
- `archived` or `void`: reserved for later workflow controls.

Every write records an event in `proposal_events`. Mutating internal writes support `expected_revision` so the editor can protect against overwriting another tab's changes.

## Routes

- `GET /v1/proposals/organizations/:orgId/projects/:projectId/proposals`
- `POST /v1/proposals/organizations/:orgId/projects/:projectId/proposals`
- `GET /v1/proposals/organizations/:orgId/proposals/:proposalId`
- `PATCH /v1/proposals/organizations/:orgId/proposals/:proposalId`
- `DELETE /v1/proposals/organizations/:orgId/proposals/:proposalId`
- `POST /v1/proposals/organizations/:orgId/proposals/:proposalId/duplicate`
- `GET /v1/proposals/organizations/:orgId/proposals/:proposalId/snapshots`
- `POST /v1/proposals/organizations/:orgId/proposals/:proposalId/snapshots`
- `POST /v1/proposals/organizations/:orgId/proposals/:proposalId/send`
- `POST /v1/proposals/organizations/:orgId/proposals/:proposalId/pdf`
- `GET /v1/proposals/organizations/:orgId/proposals/:proposalId/pdf`
- `GET /v1/proposals/organizations/:orgId/proposals/:proposalId/events`
- `GET /v1/proposals/public/:token`
- `GET /v1/proposals/public/:token/pdf`
- `POST /v1/proposals/public/:token/view`
- `POST /v1/proposals/public/:token/sign`

## Frontend Contract

Browser code should use `window.ProposalsAPI` from `libraries/proposals-api/proposals-api.js`. Internal project UI can list, create, edit, send, duplicate, delete, download, and print through this API once the local-only proposal editor is migrated. Customer portal code should use the public snapshot routes for structured rendering and PDF download.
