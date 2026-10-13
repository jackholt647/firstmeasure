# Labor providers, crews, commitments and delivery

## Words

Use these words in product copy, documentation and new code. Older names remain
in stored data and are listed so they can be recognised, not copied.

| Word | Meaning | Older names in code and storage |
|---|---|---|
| **Labor provider** | Anyone work can be committed to: a person, an in-house crew, or a subcontractor. Equipment is never one. | "work resource" (`work_resource_ref` on lists and events), "assignable subject" (`workforce/assignability.ts`), "subject" (compensation profiles, pay sheets), "resource group" for the in-house crew kind, "organization connection" for a subcontractor |
| **Crew** | A unit inside a labor provider that does one job at a time. A subcontractor may have several; an in-house crew usually is its own single unit. | — |
| **Pay sheet** | How one labor provider is paid, as data evaluated against a job. See [pay sheets](pay-sheets.md). | "compensation profile" is the older, per-person pay record that payroll reads |
| **Commitment** | A frozen copy of a labor list as it was handed to its provider. | — |
| **Delivery** | How a commitment reaches its provider. | — |

A provider's three types are `organization_user`, `resource_group` and
`organization_connection`. Do not rename the stored `work_resource_ref`; new
records and published data say `provider`.

## Crews inside a provider

`labor_provider_crews` (`labor/commitments.ts`) holds crews. Each belongs to one
provider and may sit under another crew of the same provider through
`parent_crew_id`; a cycle is refused. A list is committed either to the provider
as a whole or to one of its crews.

## Commitment

`commitLaborList` freezes a labor list that is assigned and not empty: its lines
with rates and totals, the provider, the chosen crew, the provider's pay sheet
revision, the list's schedule and a note. Editing the list afterwards never
changes a commitment. Committing again writes the next revision and marks the
previous one `superseded`. `releaseCommitment` marks one `released` when the work
is finished or taken back.

A committed list emits `labor.list.committed`, and `labor.list.delivered` once
it has reached the provider, so organization rules and scope automations can
react.

## Delivery

Each provider has a delivery method, chosen in `labor_delivery_settings` or
defaulted: people, in-house crews and subcontractors whose organization is
linked are shared with; an unlinked subcontractor is emailed a work order.

- `share` — the commitment is the provider's inside FirstMate. Nothing is sent.
- `work_order_email` — a work order is emailed from the project. With no
  address the delivery needs attention; it is never reported delivered.
- `custom` — the provider's own delivery code runs in the document-module
  sandbox. It receives the commitment, the recipient and the rendered work
  order, can read and invoke nothing, and returns steps from a fixed set:
  `todo`, `email`, `share`. The platform carries the steps out. With no code of
  its own a provider gets `DEFAULT_CUSTOM_DELIVERY`, which creates a to-do asking
  someone to deliver the work by hand.

A delivery ends `delivered`, `pending` (only to-dos were created: someone still
has to send the work) or `needs_attention` (a step failed or could not run). To
add a kind of step, add it to `DeliveryStep` and to the dispatcher; do not let
delivery code call actions directly.

## Availability

Availability is worked out from commitments and nothing else
(`providerAvailability`). Every crew with no crews under it does one job at a
time; a provider with no crews is itself one such unit. Capacity is the number of
units; each `committed` commitment uses one. Work committed to the provider as a
whole, or to a crew that has crews under it, uses a unit without naming which and
is reported as `unplaced`. More commitments than units is `over_committed` and is
reported, not prevented. Dates are carried on each commitment's `schedule` for a
scheduler to use; this view does not reason about dates.

## Published

- `labor-commitments.project` — commitments on a project. `labor-commitments.settings` — delivery methods.
- `labor-providers.crews` and `labor-providers.availability` (arguments `type`, `id`).
- Actions `labor.list.commit`, `labor.commitment.release` (`manage_projects`);
  `labor.delivery-setting.save`, `labor.crew.save`, `labor.crew.archive`
  (`manage_company_settings`).
- HTTP under `/v1/materials/organizations/:orgId/`: `lists/:listId/commit`,
  `projects/:projectId/labor-commitments`, `labor-commitments/:id/release`,
  `labor-delivery-settings`, `labor-providers/:type/:id`, `labor-crews`.

## Not built

The interface for any of this; sharing a commitment into a linked
organization's own account; a rendered work order document (the email carries a
table); payouts and actuals against a commitment; scheduling against
availability; equipment a crew brings covering a job's equipment needs.

Run `tests/labor-commitments.test.ts` for changes here.
