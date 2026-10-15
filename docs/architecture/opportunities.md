# Leads, opportunities and intake

There are two records: a **contact** ([contacts](contacts.md)) and a
**project**. There is no lead record, no lead project type and no lead status.

- An **opportunity** is a work plan whose scope template carries the built-in
  `sales` category. It belongs to a project.
- A **lead** is a contact linked to a project with an open opportunity and no
  won one. A **customer** is a contact with at least one won opportunity.
  Both are derived; neither is stored.

Every business rule below is configuration with a default. The platform does
not decide when a sale is won, how many sales plans may run, or what starts
production; scope templates and settings do, and each industry's default scope
set picks the starting answer.

## Scope categories

Scope templates carry `category_ids` (zero or more) from the organization's
`scope_categories` catalog (branch module, default branch). The catalog is
edited like the contact tag catalog: stable ids, renameable labels, enable and
disable. `sales` is built in and cannot be removed or disabled; its label comes
from terminology. `production` is an ordinary default category. `kind` is
removed. The Project Scopes settings groups are views over categories.

The platform reads one fact from categories: a plan whose template has `sales`
is an opportunity. Another category may be blessed the same way when an app
needs it.

## Opportunity outcome

Sales plans carry `outcome` (`open`, `won`, `lost`), `outcome_at`,
`lost_reason`. Outcome is set only by automation actions bound in the scope:

- `sales.markWon.v1` — the plan is won. Sets the project's `sold_at` when the
  project has none.
- `sales.markLost.v1` (`input.reason`) — the plan is lost.
- `sales.reopen.v1` (`input.reason`) — back to open.

They are ordinary catalog actions and can be bound to any trigger. The default
sales pipeline binds `markWon` to the signature node and starts production on
the same trigger. A sales plan that completes or is canceled while still open is
shown as closed without an outcome and raises a warning; nothing assumes it won.

`sold_at` means the time the project's first opportunity was won. Stats and pay
rules that earn on `sold_at` follow each organization's definition.

The number of open opportunities a project may have at once is the
`max_open_opportunities` setting of the intake routing module (default 1). The
engine refuses to start a sales plan beyond it.

## Intake

Every source is an adapter that produces one `LeadSubmission`:

```ts
{ source: {kind, provider, external_id, source_id, connection_id},
  branch_id, contacts: [{name, kind, emails, phones, role}], address,
  title, summary, provider_fields, consent, received_at }
```

Sources: website forms, inbound email, Connections webhooks and polling,
`leads.import`, live chat, canvassing, the published `leads.create` action and
contact file import (which stops after step 3). Each calls `receiveLead`
(`leads/receive.ts`):

1. Claim the delivery in `lead_deliveries` (existing idempotency; a retry
   returns the first result).
2. Validate and normalize contact points.
3. For each contact: match, then use or create ([contacts](contacts.md)).
4. Create the project, link the contacts, record `lead_source` on it, and start
   the sales plan chosen by intake routing.
5. Record consent given in the submission.
6. Emit `lead.received` and `project.created`. Who is notified is an
   organization rule, not code.

Triage is a view, not a state: opportunities still in their plan's first stage,
plus open duplicate suggestions. Dismissing a submission marks its opportunity
lost with reason `not_an_opportunity`.

## Project merge

`mergeProjects(org, survivorId, mergedId, choices)`:

- Moves contact links, messages, calls, documents, proposals, media, to-dos and
  events through project reference adapters, recorded like a contact merge.
- Keeps both `lead_source` records on the survivor (`lead_sources[]`) and both
  owners' assignments.
- Closes the merged project's open work plans with reason `merged`; plans are
  not spliced.
- Marks the merged project `merged_into`. It is kept.
- A project with accepted documents, payments or finalized work may be merged
  only with `merge_committed_projects`; otherwise it can only be linked as
  related.

Likely duplicate opportunities are two open opportunities whose projects share a
contact and a sales template; they are listed with duplicate contacts.

## Removed

`project_type: "lead"`, `lead_status`, `workflow_state: "contact_only"`,
`createPlatformLead`, `internal/crm` (legacy sales portal backend) and its lead
database. Call lists, dispositions and Gmail import move to platform stores over
contacts and opportunities before the legacy code is deleted.

Validation: `tests/lead-receive.test.ts`, `tests/opportunity-outcome.test.ts`,
`tests/project-merge.test.ts`, `tests/scope-categories.test.ts`,
`tests/automation-contracts.test.ts`, `npm run test:publication`.
