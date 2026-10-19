# Leads, opportunities and intake

There are two records: a **contact** ([contacts](contacts.md)) and a
**project**. There is no lead record, no lead project type and no lead status.

- Every project runs scopes. A lead that has not been given one yet is a
  **new lead** (see [New leads](#new-leads)).
- An **opportunity** is an open sales question on a project: a new lead, or a
  work plan whose scope template carries the built-in `sales` category.
- A **lead** is a contact linked to a project with an open opportunity and no
  won one. A **customer** is a contact with at least one won opportunity.
  A contact with neither (a vendor, a referring realtor) is just a contact.
  All of these are derived; none is stored.

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

The platform reads two facts from categories: a plan whose template has `sales`
is an opportunity, and a plan whose template has `intake` runs before a
project has a scope ([Intake scopes](#intake-scopes)). Both are built in. A
template cannot carry both. Another category may be blessed the same way when
an app needs it.

## Entry: how a project starts

A project starts in exactly one of two ways, and routing happens only then:

- **`receiveLead`** (`leads/receive.ts`): a lead. Intake routing decides, per
  source, whether it starts a scope or stays unscoped.
- **`createProject`** (`projects/create.ts`): made by hand, by an import or by
  an app. It starts the scope template the write names (`scope_template_id`,
  not stored) or the branch's `manual_template_id` (intake routing; the
  default is the preset **Manual** scope, `manual`). The project routes use
  the same steps: a `PUT` or `POST` that creates a project starts its scope,
  and one whose scope is unavailable is refused (`project_scope_required`).
  The browser's New Project flow does not ask yet, so a project made there
  starts the branch default; Settings > Project Scopes > Advanced sets it.

Nothing else starts an entry scope: opening a project, editing it or adding
a proposal never routes it. `tests/project-entry.test.ts` fails when any
server code other than these two writes a project document that might not
exist yet. Project writes elsewhere pass `mustExist` or an
`expected_revision`. Before this, a project made by hand entered the default
sales scope; set `manual_template_id` to the sales scope to keep that.

## New leads

A project is a **new lead** while it arrived as a lead (`receiveLead`
recorded its `lead_source`), has never had a plan other than an intake plan,
has no project-level outcome (`won_at`, `lost_at`) and was not merged. A
project with no scope that did not arrive as a lead (a FirstMeasure
measurement order, an import) is not a lead; on development in October 2026
almost every project was one of those. It is shown as `lifecycle.new_lead` and counted as an open
opportunity. A missed call from a number nobody knows, a chat or a form that
says nothing about the work all arrive as new leads when routing leaves them
unscoped.

**Calls.** A missed call or voicemail that matched no project goes through
`leadFromMissedCall` (`leads/calls.ts`) with source kind `missed_call`. The
branch's `call_leads` setting (intake routing) decides: a number no contact
has becomes a contact and a lead (`unknown_numbers: "new_lead"`, the
default, or `"log"`); a known contact's call is only logged
(`known_contacts: "log"`, the default, or `"new_lead"`). The call and its
call-back to-do are linked to the new project. Until an organization saves
its own routing, the default rules leave `missed_call` leads unscoped.

A new lead stops being one when:

- **a scope starts on it**: a sales scope carries the opportunity from there;
  a production scope started directly assumes nothing about the sale (its own
  bindings may call `sales.markWon.v1`);
- **it is lost**: `sales.markLost.v1` or the lost flow with a reason (for
  example `not_a_lead` for a wrong number) sets `lost_at`. Lost new leads are
  kept so missed-call and source numbers stay honest; lists hide them by
  default;
- **it is merged** into another project (an existing customer calling from a
  new number: merge the contacts, then the project).

Views: the CRM ([crm](crm.md)) lists, boards and worklists filter on new leads,
and any sales board can show them as a first **New lead** column (the template's
`work_plan.metadata.new_leads_column`). Dropping a new lead on a stage of that
board starts the board's scope on it.

## Intake scopes

A template with the built-in `intake` category is optional pre-scope
behavior: "call, then choose the kind of sale", say. Its plan runs stages,
to-dos, call dispositions and bindings like any other, but:

- it is never on a board (`hide_from_boards`) and not a separate opportunity,
  so its project stays a new lead while it runs;
- it routes with `scopes.activateTemplate.v1`. When any scope that is not
  intake starts on the project, the project's open intake plans complete with
  reason `routed`.

Intake routing points at an intake scope like any other entry scope.

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
   primary) and applies intake routing: the first enabled rule that matches
   the project (`lead_source.kind`, form fields, ...) says `entry: "scope"`
   with a `template_id` or `entry: "unscoped"`; otherwise `default_entry` and
   `default_template_id` decide. Each industry preset picks the default.
4. Records an SMS opt-in for each phone when `consent.sms` is set. A form's
   consent block sets it when the block has `sms_opt_in` and is ticked; its
   label is the disclosure.
5. Emits `project.created` and `lead.received`. `lead.received` carries the
   source's suggested notice (`payload.notice`: `title`, `body`,
   `target_role_ids` such as a form's "Notify these roles"; `notify: false`
   when the source asked for none).

What happens next is organization rules on `lead.received`
(`work/rules.ts`), each editable or switchable off in Automations:

- `platform_notify_new_lead`: notifies the inside sales and appointment
  roles when the source named none; `platform_notify_new_lead_source_roles`
  notifies the source's roles when it named some. Both use the notice's
  title and body (the source's, or "Contact new lead" and the lead's address
  and first contact), and clicking opens the project (`frontend_action`
  `{kind: "open_project", project_id, project_tab}`).
- `platform_queue_new_lead_calls`: adds the lead to the New Leads call list.
- `platform_queue_sales_scope_calls` (on `work.plan.started`): the same call
  for a sales scope started on a project that did not arrive as a lead (no
  `lead_source`), so a lead routed later is not queued twice.

The browser opens a notification only from its `frontend_action`; nothing
guesses from its title. A form's `settings.stage_id` is not used; intake
routing picks the entry.

Triage is a view, not a state: new leads and opportunities still in their
plan's first stage, plus open duplicate suggestions. Dismissing a submission
marks its opportunity lost with reason `not_an_opportunity`.

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
`/v1/internal/crm/referrals`. They are FirstMate staff tools: each needs a
platform session whose email is an active internal user who may manage sales,
and writes need its CSRF token (audit SEC-1, closed). The partner logo route is
the one public route, because referral landing and sign-in pages show it.
There are no `workflow_state: "contact_only"` standalone records; contacts are
records of their own ([contacts](contacts.md)).

Validation: `tests/lead-receive.test.ts`, `tests/new-leads.test.ts`,
`tests/project-entry.test.ts`, `tests/project-scopes-routing.test.ts`,
`tests/opportunity-outcome.test.ts`,
`tests/project-merge.test.ts`, `tests/scope-categories.test.ts`,
`tests/automation-contracts.test.ts`, `npm run test:publication`.
