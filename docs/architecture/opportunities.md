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
removed (an older definition's `kind` is read as a category and dropped on save).
The Project Scopes settings page groups scopes by category and edits the
catalog; intake routing no longer stores groups.

The platform reads one fact from categories: a plan whose template has `sales`
is an opportunity. Another category may be blessed the same way when an app
needs it.

## Opportunity outcome

Sales plans (`work_plans.sales = 1`, set from the template's categories when
the plan is made) carry `outcome` (`open`, `won`, `lost`), `outcome_at` and
`outcome_reason`. Outcome is set only by automation actions bound in the scope,
through `setOpportunityOutcome` (`work/opportunities.ts`):

- `sales.markWon.v1` — the plan is won. Sets the project's `sold_at` when the
  project has none.
- `sales.markLost.v1` (`input.reason`) — the plan is lost.
- `sales.reopen.v1` (`input.reason`) — back to open.

They are ordinary catalog actions and can be bound to any trigger. The built-in
sales presets bind `markWon` to the signature step, beside the binding that
starts production. A lost opportunity's sales scope is stopped, so it cannot be
reopened; start the sales scope again instead. The mark-lost flows (a follow-up
outcome with action `lost`, `POST /projects/:id/lost`) call the same function.
Plans made before categories were backfilled once: a finished pipeline plan
counts as won, one canceled as lost as lost. A sales plan that completes or is canceled while still open is
shown as closed without an outcome and raises a warning; nothing assumes it won.

`sold_at` means the time the project's first opportunity was won. Stats and pay
rules that earn on `sold_at` follow each organization's definition.

The number of open opportunities a project may have at once is the
`max_open_opportunities` setting of the intake routing module (0, the default,
means no limit; the intake router itself starts only one). Starting a sales plan beyond it is refused
(`instantiateScopeTemplateWorkPlan`).

## Intake

Every source builds one `LeadSubmission` (`leads/receive.ts`) and calls
`receiveLead`:

```ts
{ source: {kind, provider, confidence, provider_fields, raw, ...source fields},
  branch_id, project_id?, contacts: [{name, email, phone, phones, role}],
  address, title, summary, project_data?, consent?: {sms, disclosure_text},
  notification? }
```

Sources: website forms, inbound email, Connections webhooks and polling and
`leads.import` (through the `lead_deliveries` ledger in `leads/intake.ts`),
live chat (one lead per conversation), canvassing (one lead per pin), the
manual `POST /leads` route (`manage_projects`, branch-checked, lead fields only)
and the published `projects.lead.create` action. `receiveLead`:

1. Refuses a submission whose `project_id` already exists, so a retry never
   makes a second lead. Each source picks a stable id for its retries.
2. For each contact: an exact email or phone match uses that contact (when
   `auto_attach_exact` is on); otherwise a contact is created. **A lead never
   changes an existing contact**: anyone can type someone else's phone into a
   form, so what the lead said is kept on `lead_source.contacts` instead.
3. Creates the project with `lead_source`, links the contacts (first is
   primary) and starts the sales plan chosen by intake routing.
4. Records an SMS opt-in for each phone when `consent.sms` is set. A form's
   consent block sets it when the block has `sms_opt_in` and is ticked; its
   label is the disclosure.
5. Emits `project.created` and `lead.received`.

The default organization rule that queues a first call runs when a sales plan
starts (`work.plan.started` on a sales plan), so a project created by hand gets
the call as well as one that arrived as a lead.

Contact file import still writes standalone records through the contact bridge
until the Contacts app reads the store (phase 5).

**Not yet moved:** the new-lead notification is still sent by `receiveLead`
(with each source's title and roles) rather than by an organization rule. A
form's `settings.stage_id` is no longer used; intake routing picks the sales
scope.

Triage is a view, not a state: opportunities still in their plan's first stage,
plus open duplicate suggestions. Dismissing a submission marks its opportunity
lost with reason `not_an_opportunity`.

## Project merge

`mergeProjects(org, survivorId, mergedId)` (`projects/merge.ts`) is for one
sale that came in twice:

- The survivor keeps its contacts and gains the merged project's (not as
  primary); the merged project's links are removed.
- The merged project's open plans close with reason `merged`; plans are not
  spliced. A merged opportunity is not counted as unresolved.
- Customer history moves through the project reference adapters: calls,
  conversations and messages, appointment confirmations, documents, proposals,
  calendar events, bookings, payments, materials and media. History that
  belongs to the merged project (its plans and events, channel, posted ledger
  entries, measurement reports) stays; `contacts/references.ts` lists each with
  its reason.
- Both lead sources are kept on the survivor (`lead_sources`), and the merged
  project's schedule items move into the survivor's `events`.
- The merged project is kept and marked `merged_into`; the merge is recorded in
  `contact_merges`.
- A project that is sold (won opportunity or `won_at`), paid (a payment
  transaction) or has finalized work is merged only by someone with
  `merge_committed_projects` (Merge sold projects).

## Removed

`project_type: "lead"`, `lead_status` and `createPlatformLead` are gone. So is
the legacy sales portal (`public/measure/sales`) with its lead database, lead
routes, dialer, lead imports and the generic CRM document routes of
`internal/crm`. Call lists live in `comms/call-lists.ts`, with their admin
routes at `/v1/call-lists` (call outcomes are written to the call list store).
Gmail sync keeps mailboxes but no longer files messages against legacy leads.
`internal/crm/api.ts` now serves only the referral routes at
`/v1/internal/crm/referrals`, which still check no login (audit SEC-1).
`workflow_state: "contact_only"` standalone records remain until the Contacts
app reads the store directly.

Validation: `tests/lead-receive.test.ts`, `tests/opportunity-outcome.test.ts`,
`tests/project-merge.test.ts`, `tests/scope-categories.test.ts`,
`tests/automation-contracts.test.ts`, `npm run test:publication`.
