# Contacts

A contact is a person (`human`) or a company (`org`) the organization deals
with. It is a record of its own, with or without projects. Opportunities and
jobs are projects; a project names its contacts by reference. See
[opportunities](opportunities.md) for what makes a contact a lead.

Status: being built on `claude/contacts-opportunities-20261015`. Phases are
listed at the end; this document is the contract each phase is checked against.

## Store

`contacts/store.ts` is an `openSqlStore` store (`id: "contacts"`). Raise its
`schemaVersion` with every table or column change.

| Table | Holds |
|---|---|
| `contacts` | id, kind, name, first/last name, `branch_ids`, tags, time zone, custom-field values, `merged_into`, revision, created/updated |
| `contact_points` | one row per email, phone or address: display value, **normalized value**, label, primary flag, position |
| `contact_links` | which contacts a project has: project id, contact id, role, primary flag, position |
| `contact_merges` | one row per merge: survivor, merged id, actor, what each reference adapter moved |
| `contact_duplicates` | suggested pairs with the evidence and a dismissed flag |

`contact_points (organization_id, kind, normalized)` is the matching index.
Normalization lives in `contacts/normalize.ts` (email lower-case and validated,
phone E.164, address lower-cased and whitespace-folded) and is the only
normalizer; comms matching, intake and import call it.

`contacts/service.ts` is the only writer. Reads never create records.

## References

Everything that points at a contact stores a bare `contact_id`. There is no
`contact_only` project anchor; a typed contact field, a partner relationship or
a shared contact resource still accepts an old `project_id` beside the id and
ignores it. Media for a contact is owned by `{type: "contact", id}`.

`contacts/references.ts` lists what a merge repoints: SQL adapters for the
tables with a `contact_id` or `project_id` column, a walker over document
collections, JSON columns that hold contact references (to-do `contact_refs`,
relationship fields on other contacts) and media owners. Every such table is
either moved by an adapter or listed as kept, with a reason;
`tests/contact-references-coverage.test.ts` fails on a table in neither list.

## Projects and contacts

A project's contacts are its rows in `contact_links`. `project.data.contacts`
is a **read-only projection** written by the contact service whenever a linked
contact or a link changes, the same way `work_projection` is written by Work.
It exists so the many readers of `project.contacts` keep working while they move
to the contacts client; it is never the source of truth. The projected keys are
`contacts`, `contact_id`, `primary_contact_id`, `contact_ids` and the
`customer_*`/`primary_contact_*` name, email and phone.

Contacts are set with `saveProjectContacts(org, projectId, entries)`
(`contacts/records.ts`), over HTTP `PUT /organizations/:orgId/projects/:projectId/contacts`
with `{contacts: [...]}`, in the browser `PlatformAPI.contacts.setProjectContacts`.
The project must exist first. Each entry is a link plus, optionally, fields:

- An entry naming a stored contact (`contact_id` or `id`) links it and applies
  the fields it carries, unless it was copied from an older revision
  (`contact_revision`), which links without changing the contact.
- An entry naming an id that does not exist creates that contact with that id
  (the contact window and media drafts pick the id first).
- An entry without an id uses an exact match when `contacts.auto_attach_exact`
  is on, or creates a contact in the caller's branch.

The links are replaced and every project showing a changed contact gets its
projection. Lead intake (`receiveLead`) and contact merge write links directly.

**A project write never changes contacts** (`guardProjectContacts` in
`platform/storage.ts`, both backends). A write whose `contacts` is anything but
the stored projection, or a copy of it read before a contact changed, is refused
with 400 `project_contacts_read_only`; a whole-document save that re-sends what
it read passes. The projected keys always keep what the contact service wrote,
whatever the writer sent, and a project with no links shows `contacts: []`. In
the browser `PlatformAPI.projects.save`/`patch` leave the projected keys out, and
`Portal.ProjectStore` sends a changed contact list through
`setProjectContacts` (merged per contact and field against the latest list, as
before) and the rest as the project write.

## Matching and duplicates

`findExactMatches(org, points)` returns contacts sharing a normalized email or
phone. An address or a name never makes an exact match.

- Intake with an exact match uses that contact when the organization's
  `contacts.auto_attach_exact` setting is on (default on); otherwise it creates
  a contact.
- Every new contact (not a migration copy) is checked by
  `suggestContactDuplicates`: the same email, the same phone, the same name, or
  the same name and address. Pairs land in `contact_duplicates` as open
  suggestions; a dismissed or merged pair stays that way.
- Two open opportunities for the same contact in the same sales scope are
  suggested as one sale (`kind: "project"`), checked after intake and after a
  contact merge.

Nothing is merged automatically.

## Merge

`mergeContacts(org, survivorId, mergedId, { prefer })` (`contacts/merge.ts`):

1. Refuses a missing or already merged contact, or a merge into itself.
2. Writes the survivor first, so a value the field rules refuse stops the merge
   before anything moves: the survivor's values win, the merged contact fills
   blanks, `prefer` picks a side per field (`name`, `fields.<key>`); points,
   tags and branches are unioned (no branches means every branch).
3. Moves project links, then runs every reference adapter.
4. Marks the merged contact `merged_into = survivor`. It is kept, not deleted;
   `resolveContactId` follows it, so a reference an adapter missed still
   reaches the survivor.
5. Records the merge in `contact_merges` (both records before, and what each
   adapter moved), settles the duplicate pair, refreshes projections and
   publishes `contact.merged`.

There is no undo: references from both contacts are indistinguishable once
moved. Merging contacts never merges their projects; it only lets the
duplicate-sale check see that two projects now share a person.

## Branches

Every contact has `branch_ids` and is limited by the same branch scope as
People data: with more than one branch, a caller sees contacts in their own
branches unless they hold `view_region_branches`/`view_all_branches`. A contact
with no branches is visible in every branch.

## Kinds, tags, fields and media

Unchanged in meaning. Every contact has `contact_kind` and tags from the
organization's `contact_settings` catalog; the built-in `org` tag follows
classification. Default fields (`relationships.employer`, `relationships.spouse`,
`profile_photo`, phone labels) and custom contact fields are stored on the
contact row. Field types `contact`, `human_contact`, `org_contact` now hold a
bare contact id. Contact media uses the artifact pipeline with owner type
`contact`; uploads need `manage_projects` (to become `manage_contacts` when that
permission exists), reads need `view_contacts`.

Photo import is optional and off by default. It accepts embedded vCard photos
or mapped HTTPS URLs, pins a public IPv4 DNS result, rejects private networks,
and bounds size, time and decoding. A failed photo leaves its contact intact.

## Publication

- Data: `contacts.records` (text, kind and tag query; cursor paged),
  `contacts.record`, `contacts.duplicates`, `contacts.settings`,
  `contacts.options`.
- Actions: `contacts.create`, `contacts.update`, `contacts.link_project`,
  `contacts.merge`, `projects.merge`, `contacts.settings.save`. Routes add
  duplicate listing and dismissal.
- Realtime facts: `contact.created`, `contact.updated`, `contact.merged`.

## Frontend

`PlatformAPI.contacts` is the browser client: `list`/`listAll`, `get`,
`create`, `update`, `match`, `merge`, `duplicates`, `dismissDuplicate`,
`setProjectContacts`, `mergeProjects`, `media`. The Contacts app lists the
store and attaches each person's projects from the projection. Contact media is
owned by the contact alone.

The contact window (`apps/contacts/modal.js`) saves with `contacts.create` and
`contacts.update` and never writes a project; a new project for a contact is
created and then linked with `setProjectContacts`. A contact taken off a
project in the project editor stays a contact of its own. A project started
from contacts alone, before an address, is a `draft` project.

## Import

Contact file import (`platform/contact_import/api.ts`) creates contacts with
`createContact` in the caller's branch, stamped with `import_id`, `imported_at`
and `import_source`; an "update" fills what the matched contact leaves blank
and unions tags. Duplicates are judged against the store (email, then phone,
then name). An import records `created_contact_ids`; undo removes each with
`removeUnusedContact`, which keeps a contact that is now linked to a project or
merged.

## Development migration

`src/scripts/contacts_migrate.ts --migrate-development` (development and test
data only) copies embedded contacts into the store
(`migrateOrganizationContacts`), then removes the standalone `contact_only`
project records (`removeStandaloneContactRecords`): a bare one is deleted and
loses its links, one that gathered events or proposals is kept as a `draft`
project. Both steps are idempotent.

## Contact events

The contact writers emit work events after a write commits (`contacts/events.ts`), so
organization rules can start from a contact:

| Event | When | Payload |
| --- | --- | --- |
| `contact.created` | `createContact`, by hand, an import or a lead (not the development migration) | `contact_id`, `name`, `tags` |
| `contact.updated` | `updateContact` changed something | `contact_id`, `changed_fields` (`emails`, `phones`, `addresses`, `tags`, `name`, `company`, `birthday`, `cf.<field>`, ...), `tags_added`, `tags_removed` |
| `contact.tagged` | a tag was added, on create or update; one event per tag | `contact_id`, `tag` |
| `contact.merged` | `mergeContacts` | `contact_id` (the survivor), `merged_contact_id` |
| `contact.date` | the scheduler, for a rule with `schedule.contact_date` | `rule_id`, `contact_id`, `field`, `date`, `on` |

Events carry the contact id in the payload and the context, no project, and the branch of
the contact's first branch (organization rules are read per branch). Their context names the
change source and, for a person, `actor_user_id`.

## Not built

- Readers still read `project.contacts` (the projection) rather than the
  contacts client.
- Pickers still load every contact through `contacts.options`, a contact
  edit rewrites every linked project's projection, and contact import and the
  partner-sharing contact list page through every contact
  ([optimization backlog](../optimization-backlog.md#contact-options-and-projection-fan-out)).

## Phases

1. Store, normalizer, service, routes and publication; the storage bridge;
   migration of existing project contacts. Done.
2. Intake on contacts and opportunities ([opportunities](opportunities.md)). Done.
3. Scope categories and the sales outcome actions. Done.
4. Contact merge, duplicates, project merge. Done.
5. Legacy CRM deleted; Contacts app lists the store. Every writer of project
   contacts uses the contacts API (contact window, project editors, project
   store, import, partner contacts, seeders); the storage bridge is deleted and
   a project write that changes contacts is refused; `contact_only` records are
   migrated away in development. Done.
6. Contact window presentation of embedded projects; CRM lists and bulk actions.

Validation: `tests/contacts-store.test.ts`, `tests/contact-merge.test.ts`,
`tests/contact-references-coverage.test.ts`, `tests/contact-imports.test.ts`,
`tests/lead-receive.test.ts`, `scripts/contacts-library-e2e.mjs` (the contact
window against a mocked contacts client), `npm run test:publication`,
`npm run check`.
