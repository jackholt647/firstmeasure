# Action publication

The shared registry is `public/v1/platform/publication/actions.ts`. Business adapters
register once during application bootstrap through `registerDomainActions` and
`registerDatasetActions`. Scope/Work definitions keep their original automation IDs;
their handlers now execute through this registry. Agent tools use a private runtime
adapter; rendering/navigation/report-result helpers stay local to the agent runtime.

## Contract and execution

An action declares an ID, version, implementation identity, domain, input and output
JSON Schemas, effect, permitted execution kinds, access policy, receipt strategy and
handler. Registering a different contract or handler under an existing version in one
process is rejected. Descriptors are copies, not references to mutable registry state.
Use `authorizeAction` when resolving a binding, and `invokeAction` to execute it.
Discovery metadata alone does not authorize invocation.

Invocation validates JSON arguments, checks the principal, organization, target,
application access, permissions, capabilities and resource policy, and rejects writes
or external effects in evaluation mode. Policy runs before cached results are returned.
Handlers receive trusted server context; tenant JSON cannot manufacture a system grant.
System grants list exact operation IDs. No wildcard or null-auth bypass is supported.

The implementation digest includes the backend source/build artifact and package locks,
not only an adapter function's source. This deliberately invalidates frozen references
after any backend artifact change. An unavailable historical implementation fails its
pin check; the registry does not silently replay current code as an old version. Retaining
and routing to historical executable artifacts is a separate deployment responsibility.

## Receipts and failures

Mutating domain and agent actions require an idempotency key. The shared `SqlStore`
uses PostgreSQL in cluster mode and SQLite only in local mode. Atomic unique receipt
claims prevent concurrent duplicate dispatch. Keys are namespaced by organization,
action, version and target; the request digest also includes arguments, implementation
and principal. Reusing a key for a different request is an error.

A successful receipt returns the previous result after fresh authorization. A running,
failed or uncertain operation is never automatically dispatched again. A provider may
have performed an effect before a timeout or database response loss. Reconciliation
must establish its actual outcome; using a new key is not a generic recovery strategy.
The initial API has no automatic operator reconciliation endpoint.

Existing Work handlers retain the engine's event lease and binding receipt. The server-only
`withWorkPublicationContext` bridge lets scope code call declared Work actions using
private host state. Nested calls must supply stable parent-binding plus call-index keys;
these receive their own durable action receipt and distinct handler idempotency identity.
Guest code never receives the host context or its privileged service closures.

## Coverage and extension

The 29 original Work automations retain IDs and explicit legacy input field schemas;
additional legacy properties remain accepted to preserve saved definitions. Their
result contract is JSON rather than a fully enumerated domain result. Agent inputs now
receive server-side schema validation. Legacy agent tools default conservatively to a
command until explicitly classified with publication metadata.

`action-schemas.ts` derives discoverable nested inputs directly from the existing
Zod schemas for equipment meter/maintenance, work transitions/patches, invoice and
payment changes, proposals and document issue. Recursive schema references remain
JSON Schema references. The original Zod validation also runs before a receipt is
claimed, retaining refinements and trimming constraints that JSON Schema cannot
express. Input errors therefore do not create uncertain mutation receipts. Domain
state conflicts after dispatch remain subject to the conservative receipt policy.
The conversion uses the pinned Zod3-compatible `zod-to-json-schema` adapter; migrate
to Zod's native converter with a future Zod4 upgrade, not an incidental schema change.

Intentionally flexible inputs still include document workflow state (template-defined),
custom field values, catalog calculations and stats query expressions. Equipment
checkout, appointment availability/holds and canvassing input remain service-defined
objects pending extraction of their current inline validation into shared schemas.
These are explicit discovery gaps, not claims of fully described contracts.

Domain adapters cover equipment, work, materials, documents, payroll, workforce,
training, channels, websites, catalog calculations, custom-field calculations, invoices,
payment reconciliation/refunds, canvassing pins, media metadata/rename, exterior
pricing, project intake/search, customer portals, appointments, proposals, feedback,
communications, live chat, customer referrals and stats. Coverage is by specific operation, not a claim that every endpoint in these
apps has been migrated. HTTP handlers still call their domain services; new programmable
consumers use these adapters. New service operations must declare adapters explicitly.

Canvassing helpers were extracted into `canvassing/service.ts`. Existing HTTP routes
and adapters share those implementations. Media receipt access and redaction helpers
live in `platform/media_access.ts` and are shared with existing routes. Do not bypass
these helpers with raw storage reads or writes.

Remaining integration work includes richer nested/output schemas, the full report-order
workflow, remaining CRM and communications operations, domain/provider administration,
media upload/markup, field tracking and remaining per-app mutations. Extract business
services when functionality lives inline in a route. Never expose arbitrary collection
writes, raw SQL or an internal HTTP proxy as a substitute for a domain action.

Add behavior tests for permissions and ownership, disabled features, invalid schemas,
live versus pinned identity, concurrent idempotency, uncertain effects and domain
lifecycle gates. Keep UI shells and runtime helpers separate from backend-domain coverage.

## App package mapping

This is an operation inventory, not a declaration of complete endpoint migration.
IDs ending in `.v1` below are existing Work-context-only actions; ordinary authenticated
module/API clients use the domain actions. Agent tool adapters are registered on first
use and are not counted as a complete public catalog. Data publication is tracked separately.

| App package(s) | Published action IDs | Remaining callable coverage |
| --- | --- | --- |
| projects, project-map, project-request, sales, contacts | `projects.search`, `projects.lead.create`, `work.project.projection`, `project.patch.v1`, `project.claim.v1`, `crm.callLists.add.v1`, `crm.callLists.remove.v1` | Contact editing, ownership, archive and richer CRM lifecycle |
| project-schedule, scheduling | `scheduling.availability`, `scheduling.slot.hold`, `scheduling.confirmation.set`, `scheduling.reschedule.review`, `scheduling.createRequirement.v1`, `scheduling.createRequirements.v1`, `scheduling.createPerStructure.v1` | Full event creation/editing/cancellation and resource assignment |
| crew, field_visit | `work.plan.read`, `work.node.transition`, `work.node.patch`, `work.project.projection`, `workforce.users.list`, `work.createTodo.v1` | Crew tracking, attendance and visit-specific mutations |
| checklists | `checklists.initializeFromScope.v1`, `work.node.transition`, `work.node.patch`, `punchlist.request.v1` | Checklist-specific response lifecycle |
| docs, documents, signatures | `documents.instance.read`, `documents.workflow.update`, `documents.instance.issue`, `documents.issue.v1`, `documents.dispatchOnSigned.v1`, `completion.request.v1` | Signature evidence/identity workflows remain specialized; no raw signature mutation |
| customer-portal | `customerPortal.ensure` | Customer-authenticated portal operations remain in existing routes |
| proposals | `proposals.project.list`, `proposals.create`, `proposals.patch`, `proposals.snapshot`, `proposals.send`, `scopes.activateFromProposal.v1` | Acceptance/rejection and full change-order lifecycle |
| pricebook | `pricebook.catalog.validate`, `pricebook.item.resolve` | Catalog administration and published-version lifecycle |
| measurements | `datasets.save`, `datasets.select` | Specialized acquisition/import functions beyond dataset storage |
| firstmeasure/order | `firstmeasure.exteriors.quote` | Full ordering, upload, retry and delivery lifecycle |
| photos, receipts | `media.item.read`, `media.item.rename` | Upload, markup, receipt extraction/review; shared receipt access rules apply |
| equipment | `equipment.fleet.list`, `equipment.unit.history`, `equipment.meter.record`, `equipment.unit.checkOut`, `equipment.unit.checkIn`, `equipment.maintenance.open`, `equipment.maintenance.complete`, `equipment.maintenance.cancel` | Fleet administration and remaining service operations |
| materials | `materials.project.lists`, `materials.list.read`, `materials.order.read`, `materials.initializeFromScope.v1` | Order creation, supplier delivery and inventory mutations |
| invoices, money | `payments.project.summary`, `payments.invoice.create`, `payments.invoice.due`, `payments.invoice.void`, `payments.payment.clear`, `payments.payment.refund`, `payments.ledger.list`, `payments.ensureReceivables.v1`, `payments.reconcileRecognition.v1` | Remaining payment initiation, expense and payable workflows |
| financials | `payments.ledger.list`, `payments.project.summary` | Dedicated financial projection/cash-flow query adapters |
| payroll | `payroll.upcoming.read`, `payroll.reconcileScopeCommissions.v1`, `payroll.commission.post.v1`, `payroll.projectPayees.set.v1`, `payroll.commission.rule.v1`, `payroll.commission.accrue.v1` | Payroll approval/export/provider administration |
| canvassing | `canvassing.pins.list`, `canvassing.pin.save` | Campaign and territory administration |
| channels | `channels.list`, `channels.messages.list`, `channels.message.react` | Posting, channel membership and administration |
| chat | `chat.inbox`, `chat.conversation.claim`, `chat.conversation.release`, `chat.conversation.send` | Remaining conversation administration and visitor-context actions |
| comms | `comms.project.feed`, `comms.project.sendSms`, `comms.project.sendEmail`, `communications.sendSms.v1`, `communications.sendEmail.v1` | Templates, provider configuration and broader recipient management |
| feedback | `feedback.project.request`, `feedback.project.summary`, `feedback.requestReview.v1` | Customer submission remains its existing public-token surface |
| referrals | `referrals.customer.ensure` | Global partner administration intentionally excluded |
| training, training-studio | `training.courses.mine`, `training.course.progress` | Course authoring/publishing and assignments |
| stats | `stats.schema`, `stats.query`, `stats.views.list`, `stats.view.fromPreset` | Dashboard editing/deletion and administrative warehouse controls |
| web-editor | `websites.sites.list`, `websites.page.publish`, `websites.page.discard` | Site/page authoring, domain and deployment administration |
| settings, onboarding, billing | `customFields.defaults.compute`, `customFields.initializeFromScope.v1`, `scopes.activateTemplate.v1`, `scopes.reconcileProjectResources.v1`, `notification.create.v1` are shared supporting functions | Organization configuration, onboarding and subscription operations need dedicated authorized adapters; these shared functions do not constitute coverage |
| help, tutorial, promo-inject | None distinct | Presentation shells; do not fabricate business actions solely to populate a manifest |

Backend publishers can serve several UI packages. A package entry therefore never grants
permission by itself: action policy, enabled application, capability and target checks
still apply. New mutating adapters must use service-level invariants and stable receipts,
not invoke the listed Work-only compatibility handlers outside a trusted Work context.
