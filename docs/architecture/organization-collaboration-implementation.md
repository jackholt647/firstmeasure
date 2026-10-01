# Organization collaboration implementation

Development implementation for the September 30, 2026 request. Production activation is not authorized. The development rollout record will identify the immutable release and verification results.

## Ownership and authorization

Projects and every source resource remain owned by one organization. `public/v1/collaboration` adds SQL-backed organization connections, separate local relationship profiles, access grants, account-bound invitations, work engagements, audit records and a durable event outbox. Existing organization endpoints remain closed to external users. Recipient context is never replaced with an owner's privileged context.

Every external read and write reloads membership, explicit permissions, application capabilities, both organizations' privacy settings, connection state, grant expiration, audience and operation restrictions. Recipient administrators can narrow a grant to local members. Owner denials apply even when recipients exclude a denial-bearing grant from their local audience. Ordered organization locks serialize policy changes against effects. Ending a connection revokes its grants; a new invitation is required to reconnect and old grants stay revoked.

There is no organization directory or search endpoint. Invitations use random 256-bit tokens stored as hashes, expiration and revocation. Email-targeted invitations require the matching verified account; untargeted links require the inviter to approve the claiming organization. Individual invitations bind both account and accepting organization and do not create an organization partnership. Login/signup continuation captures the token in session storage before analytics and removes it from the URL. QR codes contain the same invitation URL.

Names and emails may be disclosed for authorized participants; phones are private by default. Organizations can disable collaboration entirely, separately disable sending/receiving/connections, and restrict resource types. No counterpart roster is published. Source identity references remain in server audit evidence; rendered foreign participants use policy-filtered projections.

## Application behavior

The Partners app contains connections, invitations, inbound and outbound shares, work engagements, partner documents, online payments, external payment records and privacy controls. Terminology maps Partners/Partner to construction-specific terms such as Subcontractors/Subcontractor. Contacts remain local records linked to the accepted organization; partner classification adds a partner tag. Workforce organization connections supply the existing crew-like resource reference. Contact projections use deterministic identifiers and a durable repair queue.

Projects, Contacts and Channels show separate shared-resource lists with direction and organization filters and visible owner/counterpart labels. Received resources open the authenticated sharing workspace. Sharing supports selected scalar fields, action grants, explicit child selections, expiry and future-content choices. Access to an issued document always names its immutable revision; future revisions do not inherit access.

Supported adapters:

- Projects: selected details; conditional title/description edits; selected photos, normalized uploads/downloads without EXIF; shared notes; selected manual work transitions and schedule rescheduling using the existing revision/lock/conflict rules.
- Contacts: selected contact fields, including explicit email/phone field grants.
- Channels: selected history or messages created after sharing, text participation, account-qualified attribution; private-audience and deleted messages excluded. Message retries do not duplicate messages or workflow events.
- Documents: issued revision selection, retained PDF, assigned verified-account signatures through the existing review/consent/challenge/receipt engine, explicitly selected primitive response fields. Preparing a revision in Partners creates its PDF with initial email and SMS off. Existing document completion workflows remain authoritative.
- Media: explicit file sharing; receipt and partner-document permission checks apply in addition to sharing authorization.
- Invoices: selected financial projection; merchant approval and enabled-rail checks; provider-hosted payment intake; server-calculated quotes; durable payment claim and invoice-specific accounting allocation. The worker polls known pending processor payments without issuing another charge. Unknown processor outcomes and interrupted accounting remain flagged for reconciliation, never blindly retried.

Work engagements are separate from sharing. The partner accepts an offer before an assignment-derived grant is created. Closing an engagement revokes only its own grant. Partner document registers hold licenses, certificates, other PDFs/images, expiry and payment terms. Offline payments are payer-side records with optional receipt evidence; they do not assert that the issuer received funds or settle the issuer's invoice.

## Workflows and context

Typed `collaboration.resource` and `collaboration.resources` providers run in the receiving organization's publication context. Frozen imports reauthorize current fields and grants. Published actions cover project details, notes, messages, work, schedules and revocation, reusing the same domain adapters. Document issuing uses the existing published document action with separate PDF preparation and delivery choices. No raw collections, foreign WorkContext, organization credentials or arbitrary source API proxies are published.

Reference-only collaboration events enter the existing idempotent Work event ledger through an outbox. Recipient event delivery rechecks policy and connection state. Individual account-only shares do not broadcast activity to an unrelated receiving organization workflow. Signing outbox delivery and workflow execution occur after authorized mutations commit. The dedicated platform-worker entry point registers separate event, contact repair and payment reconciliation tasks. The current development topology executes the fallback maintenance loop in the compatibility API processes; public web replicas keep heartbeats disabled.

## Limits to carry into testing

External access is restricted to the explicit adapters above. It is not general access to every legacy project editor, financial ledger, channel attachment/huddle, module, or arbitrary document widget. Accepted engagements can be scheduled explicitly as an organization-connection crew resource using the native scheduling writer and its existing policy checks. Partner-local crew delegation is not implemented. Organization-wide standing grants, counterpart user directories, and bulk export are not implemented. Resource pickers still enumerate source-owned metadata before paginating and need further optimization for very large single organizations. The new workspace uses English strings; only Partner terminology overrides are integrated. Previously downloaded files cannot be recalled.

The implementation is not yet the entire requested system. These limitations must not be presented as completed features. See the [development rollout record](../../deploy/digitalocean/development-organization-collaboration-20260930.md) for hosted acceptance, active artifacts and rollback.

## Verification

- PostgreSQL integration: 8 tests pass for organization isolation, conditional edits, denials and recipient audience ceilings, identity-bound invitations, photo exclusions/privacy revocation, invitation races/replay, engagement lifecycle, mock payments/idempotency, real signing review/receipt flow, and shared-channel visibility/idempotency.
- Publication suite: 49 passed; its PostgreSQL test was run separately against disposable embedded PostgreSQL and passed.
- Browser harness: escaped external content, grant editor, shared note creation, and invitation continuation across login pass.
- Existing scheduling and Work integration: 25 tests passed.
- TypeScript checks have passed during development; repeat against each staged Linux role before activation.
- Payment tests use the simulator. No live card charge was performed.
- Final hosted acceptance passed using deployed files with zero browser errors: invitation continuation and consent, owner approval, selected project fields, shared notes, Projects list filtering/hide-show and revocation. All 20 generated collaboration events were delivered.

Preserve unrelated workspace changes, particularly Contacts, Feedback, app manifest, project chrome and Work. The release snapshot is assembled from owned hunks using a temporary Git index; each role overlays its existing immutable live baseline.
