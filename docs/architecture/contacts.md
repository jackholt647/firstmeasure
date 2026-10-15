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

Everything that points at a contact stores a bare `contact_id`. The old
`{contact_id, project_id}` reference and the `contact_only` project anchor are
removed. Media for a contact is owned by `{type: "contact", id}` only.

Each module that stores contact ids registers a **reference adapter** in
`contacts/references.ts`:

```ts
registerContactReferences({ id, count(org, contactId), repoint(org, fromId, toId) })
```

`tests/contact-references-coverage.test.ts` fails when a store table has a
`contact_id` column, or a document field holds contact ids, with no adapter.
Projects register the same way for project ids (`projects/references.ts`).

## Projects and contacts

A project's contacts are its rows in `contact_links`. `project.data.contacts`
is a **read-only projection** written by the contact service whenever a linked
contact or a link changes, the same way `work_projection` is written by Work.
It exists so the many readers of `project.contacts` keep working while they move
to the contacts client; it is never the source of truth.

Until every writer is moved, a project write that carries `contacts` is turned
into contact-service calls inside the same storage write (both backends): known
ids update that contact, unknown entries are matched or created, and the links
are replaced. A writer that should not change contacts must not send them.
Phase 5 removes this bridge and makes such a write an error.

## Matching and duplicates

`findContactMatches(org, points)` returns contacts that share a normalized email
or phone (exact), then close candidates scored on name and address (near).

- Intake with an **exact** match uses that contact when the organization's
  `contacts.auto_attach_exact` setting is on (default on). Otherwise it creates
  a contact and records a duplicate suggestion.
- **Near** matches always create a suggestion. Nothing is merged automatically.

## Merge

`mergeContacts(org, survivorId, mergedId, choices)`:

1. Locks both contacts. Refuses a merged or missing contact, or a merge into itself.
2. Writes the survivor: points are unioned, field values come from `choices`
   (default: survivor's value, else the merged one's), tags are unioned.
3. Calls every reference adapter's `repoint(merged -> survivor)` and records
   what each moved in `contact_merges`.
4. Marks the merged contact `merged_into = survivor`. It is kept, not deleted.
5. Publishes `contact.merged`.

`resolveContactId` follows `merged_into`, so a reference an adapter missed still
reaches the survivor. Merging contacts never merges their projects; the merge
screen lists both contacts' opportunities and offers project merge per pair.

Undo replays the log in reverse while nothing has changed since; otherwise it
is refused with what changed.

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

- Data: `contacts.records` (query: text, tags, kind, branch, has open
  opportunity, updated since; cursor paged), `contacts.record`,
  `contacts.duplicates`, `contacts.settings`, `contacts.options`.
- Actions: `contacts.create`, `contacts.update`, `contacts.link_project`,
  `contacts.unlink_project`, `contacts.merge`, `contacts.duplicate.dismiss`,
  `contacts.settings.save`.
- Realtime facts: `contact.created`, `contact.updated`, `contact.merged`.

## Frontend

`public/libraries/contacts-client/` is the one browser client: a cache keyed by
id that follows merges and refreshes on the realtime facts, and the shared
picker, chip, card and contact window used by every app.

## Not built

- Pickers still load every contact through `contacts.options`, and a contact
  edit rewrites every linked project's projection
  ([optimization backlog](../optimization-backlog.md#contact-options-and-projection-fan-out)).

## Phases

1. Store, normalizer, service, reference registry, routes and publication; the
   storage bridge; migration of existing project contacts.
2. Intake on contacts and opportunities ([opportunities](opportunities.md)).
3. Scope categories and the sales outcome actions.
4. Contact merge, duplicates, project merge.
5. Readers and writers moved to the client; bridge removed; legacy CRM deleted.
6. Contact window presentation of embedded projects; CRM lists and bulk actions.

Validation: `tests/contacts-store.test.ts`, `tests/contact-merge.test.ts`,
`tests/contact-references-coverage.test.ts`, `tests/contact-imports.test.ts`,
`npm run test:publication`, `npm run check`.
