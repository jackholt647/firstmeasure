# Custom fields and publication

Custom fields belong to projects, contacts, users, or the organization. Organization and user
definitions live in the default branch's `custom_fields` module; project and
contact definitions remain branch-specific. Scope templates can contribute
durable project definitions. Organization values use one
`organization_custom_fields/values` record, independent of branch and project.
Settings → Custom Fields includes organization definitions and an Organization
values editor. Other branches include the shared organization definitions.

## Contracts and editing

Existing field types remain supported. `integer` adds whole-number validation
and a number input with step 1. `object` and `array` add nested JSON Schema
contracts and recursive browser controls. Basic `list` remains a string list and
`key_value` remains a string-valued dictionary; use the structured types for
typed subfields, dictionaries of records, or arrays of objects. `json` accepts
arbitrary finite JSON, optionally constrained by a schema.

The schema editor supports `properties`, `items`, `additionalProperties`,
`required`, scalar types, enum/const, numeric bounds/steps, lengths, and
array/object size limits. Supported formats are `date`, `datetime`, `email`,
`phone`, and HTTP(S) `url`. Phone syntax accepts 7–15 digits with common
punctuation; it does not verify that a telephone number exists. Date validation
rejects nonexistent calendar dates. Schemas are bounded to the platform's
tenant schema limits; remote references, schema composition and arbitrary
schema regexes are not supported. A top-level field pattern executes on the
server in a worker with a deadline and input limits.

Example array schema:

```json
{
  "items": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "minLength": 1 },
      "quantity": { "type": "integer", "minimum": 0 },
      "email": { "type": "string", "format": "email" }
    },
    "required": ["name", "quantity"],
    "additionalProperties": false
  },
  "maxItems": 100
}
```

Browser editors check declared constraints. Shared storage preparation and
validation cover legacy API and Work writes on both local and PostgreSQL
backends, including contacts embedded in projects. Unchanged legacy values do
not block unrelated edits; changed values are validated. Required constraints
apply when saving the field payload, rather than preventing unrelated record
updates. Canonical/compatibility value aliases are synchronized. A supplied
declared dictionary or array replaces that field as a unit; sibling fields are
preserved. Contact normalization preserves custom values.

## Shared provider service

These providers register during shared publication bootstrap:

| Provider | Target | Exports |
| --- | --- | --- |
| `custom-fields-project` | project, with `projectId` | `contract`, `values` |
| `custom-fields-contact` | project plus contact `id` for embedded contacts; organization plus customer `id` for standalone legacy customer records | `contract`, `values` |
| `custom-fields-organization` | organization | `contract`, `values` |

`contract` returns field definitions, their nested schemas, writability, and
`recordRevision`. `values` returns a nested value object. Optional `args.field`
selects one declared dotted field path; `path` selects a JSON pointer within
the export. An embedded contact must belong to the target project. Selecting
an absent value returns the publication service's missing status. Reads never
create a record or execute actions.

```json
{
  "provider": "custom-fields-project",
  "export": "values",
  "target": {
    "scope": "project",
    "organizationId": "company",
    "projectId": "job"
  },
  "args": { "field": "inventory" },
  "path": "/inventory"
}
```

Send this to the existing publication `POST /data/read`, or declare it as a
live/frozen data binding in a document module or scope program. The shared agent
tools discover and read the same providers; no app-specific copy or raw storage
access is required. `projects.record` retains its narrow business projection;
custom fields have their own discoverable contracts rather than being appended
as untyped properties to that projection.

Read-only, background, disabled, and retired fields remain publishable.
Previously stored variables without definitions receive inferred read-only
contracts without a backfill. Deleting a definition retains its access metadata
as a retired definition, so private stored data does not become an unrestricted
inferred field. Arithmetic formula fields are evaluated without JavaScript
execution, with bounded dependencies and cycle detection. Missing or private
formula inputs fail explicitly rather than yielding fabricated zeros.

Publication is not public access. Normal resource permissions still apply.
`read_permission` adds a field-level gate; `private: true` defaults that gate to
`manage_company_settings`. This controls the publication surface, not a new
encryption or redaction policy for legacy domain record APIs. `write_permission`
can further narrow writes. These restrictions intersect the caller's authority;
they never grant new authority. Frozen reads recheck every retained field and
formula dependency against current permissions. Broad reads omit inaccessible
fields; explicitly selecting one returns denied.

## Writes

`custom-fields.project.write`, `custom-fields.contact.write`, and
`custom-fields.organization.write` are registered actions for API, agent, Work,
and module execution. They require command mode, the owning resource's write
permission, an idempotency key, and an expected record revision. Organization
creation uses revision 0; other writes use the revision from `contract`.

```json
{
  "values": {
    "inventory": [{ "name": "Chair", "quantity": 4 }]
  },
  "expectedRevision": 3
}
```

Keys in `values` are full dotted field paths. Unknown, read-only, formula,
disabled, and unauthorized fields reject writes. JSON values are validated
before persistence; project assignments retain their domain eligibility check.
Concurrent revisions cannot silently overwrite each other, and retrying the
same action receipt does not repeat the mutation. Legacy HTTP record saves also
check field write restrictions. Trusted owning domain services retain their
ability to populate producer-owned values while storage validates their types.

## Verification

Run from `public/v1`:

```text
npm run check
npm run test:publication
node --experimental-sqlite --import tsx --test --test-force-exit tests/custom-fields-service.test.ts tests/custom-fields-ui-contract.test.mjs
node --test tests/custom-fields-browser.test.mjs
node tests/run-embedded-postgres.mjs tests/publication-custom-fields.test.ts tests/publication-postgres.test.ts
```

The publication tests cover all owners, embedded contact identity, inferred
legacy values, nested validation, private/read-only access, revoked snapshots,
concurrent writes, retries, stale revisions, and alias preservation. The browser
test covers authoring, organization save, integer validation, and nested array
editing. No production activation is part of this source change.

## Project media references and cover

`media`, `photo`, and `video` fields store a bounded reference `{media_id: ...}`
to media in the owning record's library. `photo` requires an image; `video`
requires a video. `cardinality: many` stores an array of references. Project
fields select from the existing project library without copying uploads. The
editor shows each selection as a thumbnail tile, never a dropdown; a click opens
the project media picker (`Portal.PhotoFeed.openProjectMediaPicker`, the picker
behind the `media.picker` widget), and the tile's remove button clears it. The
value rides in a hidden input; `FirstMateCustomFields.setMediaValue` sets it and
repaints the tiles when another surface changes it.

Every project has the built-in optional `cover_photo` field, typed as `photo`
with cardinality `one`. Settings may adjust its presentation, label, and field
access, while its path, image type, availability, and single selection remain
fixed. It uses ordinary `custom_field_values` / `custom_fields` values and the
existing custom-field provider and revision-checked write action. Photos offers
Set as project cover, Remove project cover, and a Cover viewer badge; Overview
provides the same field editor. Choosing another photo replaces the reference.
Trashing or removing the selected photo clears the cover during storage
preparation on both backends; restoring a photo does not reselect it. Other
reference fields retain unavailable values for recovery. Changed references to
trashed project-library entries are rejected. Validation uses the authoritative
document ID even when legacy record data does not repeat it.

Focused verification: `tests/project-cover.test.ts` and
`tests/project-cover-browser.test.mjs`, including PostgreSQL via the embedded
runner.

An empty `cover_photo` means the existing top-down satellite image is the default
primary image. `PlatformAPI.projectMedia.primaryPhoto` resolves a selected library
photo or the satellite; `thumbnail_photo` and its ID are derived display aliases,
not a second selection field. Project tiles and proposal defaults use the primary.
Public customer displays use a cover only when that media is already explicitly
shared; choosing a cover never publishes private media. Measurement maps keep
their actual satellite imagery. Clearing, replacing, or trashing the cover updates
the mounted selection, display aliases, and project-viewer cache together.

User fields belong to organization membership records (`users`), not global login
identities. Their definitions are shared across branches from the default branch.
Settings → Custom Fields → Users defines them; both user editors include them
in Save changes. `custom-fields-user` publishes the contract and values, and
`custom-fields.user.write` saves declared fields with a record revision under
`manage_company_users`, preserving identity, roles, and the seven legacy flags.
Private/read-only field policies and media ownership apply. User media references
must point to that user's existing library. Raw user and authentication responses
omit field values; the authorized field provider is their publication path.
Unrelated user updates preserve fields, including replacement writes without a
field patch. Both storage backends enforce typed validation.


## Resource scopes and platform phones (frontend handoff)

The shared owner catalog in `custom_fields/owners.ts` drives allowed entities,
definition placement, publication access, and value ownership. Supported owners:
`project`, `contact`, `organization`, `user`, `branch`, `department`, `division`,
and `team`. `division` is the existing organizational-unit model: a Region,
Division, or another configured kind uses its stable division ID. `team` refers
to an existing workforce resource group. Adding a domain owner requires one
catalog entry and an authoritative owner resolver; no new field-type library or
publication implementation is needed. It does not invent new resource records.

Branch, department, division/region, and team definitions are shared organization
wide in the default branch module, just like organization and user definitions.
Values live in `resource_custom_fields/<entity>_<sha256(owner-id)>`, independent of domain
catalog/team revisions (hashed keys preserve all existing domain ID formats). Reads verify the owner, never create value records, and
return revision 0 when values have not been saved. Writes require company
settings permission, revision checks, and the existing action receipt/idempotency
contract. Missing, foreign-organization, and mismatched branch owners fail. The
sidecar collection has no generic HTTP record API. Domain edits cannot erase
these values; owner deletion makes retained values inaccessible.

Each owner has `custom-fields-<entity>` exports `contract`, `values`, and `phones`,
and action `custom-fields.<entity>.write`. Grouping targets use
`{scope:"organization", organizationId, id:<domain-owner-id>}`; optional branchId
must match a branch-bound owner. User reads/writes require `manage_company_users`.
The same nested schemas, assignments, media references, formula evaluation,
private/read-only fields, and retired-definition policies apply. Media references
must use the associated owner's library (`team`, `division`, `department`, or
`branch` owner type and its domain ID). No media-library UI is added here.

`custom-fields-catalog.contract` publishes the owner catalog and type metadata
under company settings permission. Frontend developers can use this contract to
build the additional grouping editors. Existing user dialogs already save user
fields. Ordinary Custom Fields settings preserve new owner definitions even
before grouping editors are implemented.

A `platform_phone` is a phone number **issued by the platform**. It is a semantic
phone subtype (`base_type:"phone"`) storing an issuance reference, rather than
an editable telephone string:

```json
{"phone_number":"+12065550123","issuance_id":"<provider-number-id>"}
```

`cardinality:"many"` stores an array of references (bounded to 100 per field);
multiple fields are also supported. Normal `phone` values remain strings.
Platform phone schemas are fixed. Definitions normalize to `read_only:true`,
`producer:"phone-system"`, and `editor:"platform-phone"`. They cannot have default
values or be required, and their type/cardinality cannot be changed to bypass
issuance ownership. Retiring definitions keeps the protection. Ordinary field
editors display existing numbers disabled with phone styling and do not offer
platform phones as a manually selectable type. These are not ordinary picker
widgets or manually entered structured JSON.

Both storage backends reject changed platform references, including clears,
outside the server phone-domain capability. Raw user/project/contact writes,
custom-field actions, module grants, and forged read_only/producer flags cannot
assign or remove them. Replacement updates preserve existing field values.
`setPlatformPhoneField` in `custom_fields/platform-phone.ts` is the server-only
integration seam for an authorized phone-domain command, requiring phone
management and the owner write permission. It checks the declared field and
record revision and accepts only active numbers owned by the organization with
the matching authoritative provider issuance ID. Pass null or [] to unassign;
unassignment never releases a provider number. The dedicated phone-domain action `platform-phones.<entity>.assignment.set` is available
through the existing publication actions API (with ordinary CSRF, authorization,
command mode and idempotency). Input is `{field, phoneNumbers: [E.164
strings], expectedRevision}` and the usual owner target. Empty phoneNumbers
unassigns. The server resolves issuance IDs from the phone system; clients cannot
forge them. Its phone-management permission intersects the owner write and field
permissions, checked again on receipt replay. It is not a custom-field write action and is intended only for the
separate phone-management UI. Generic module/system grants cannot invoke it
without a human authority context. Assignment never purchases, releases or
reroutes a provider number.

Use the `phones` export for contact/user summaries and calling. It lists each
visible declared phone with `field`, `type`, `phone_number`, and `available`;
platform entries include `issuance_id`. A released, inactive, foreign, or
reissued number has `available:false`, even if its historical reference remains.
Never call an unavailable entry. Platform phone assignments remain protected and
listed in this export even when a project changes away from a field's selected
scope. Authorized phone commands can unassign them; visibility never bypasses
issuance ownership. Values retain the historical reference for
tracking; normal custom-field writes cannot erase it. Frozen exports recheck
active platform issuance before replaying captured available references. No
phone number is purchased, released, or routed by reading fields or summaries.

Verification adds `tests/user-custom-fields.test.ts`,
`tests/scoped-custom-fields.test.ts`, `tests/user-custom-fields-browser.test.mjs`,
and the user-field API regression in `tests/platform-workflows.test.ts`. Run the
service tests on both storage backends with the embedded PostgreSQL runner,
`npm run test:publication`, `npm run check`, and the custom-fields/users browser
tests. Grouping editors and dedicated phone assignment UI are the frontend
handoff, not part of this infrastructure release.

## Priority fields

[Priority fields and published calculations](priority-fields.md) describes read-only field calculations over authorized sources, document selection, provenance and reusable quick-display consumers.

## Field homes: people fields are defined on a role, a type or a department

Field **definitions** for people are never made on one user, one group or one
outside company. Each definition has a **home**, stored on it as
`home: { kind, id }`:

| Home `kind` | Owner (`entity`) | A record has the fields of |
| --- | --- | --- |
| `role` | `user` | every access role it holds (`access_role_ids` and `roles` on the user document) |
| `group_type` | `team` | its one group type (the group's `kind_id`) |
| `company_type` | `company` | each of its company types (`assigneeTypeIds` in the assignee base) |
| `department` | `department` | itself: a department's fields belong to that one department |

`company` is the field owner for an outside company (an
`organization_connections` row). Its values live in the same
`resource_custom_fields` sidecar as teams and departments.
`FIELD_HOMES` in `custom_fields/owners.ts` is the catalog; `custom_fields/homes.ts`
holds resolution and the writers. Definitions stay in the default branch's
`custom_fields` module, so every existing rule (typed validation, private and
read-only fields, calculations, platform phones, retired definitions) applies
unchanged inside a home.

**Values** are set and shown on each user, group, company and department, and
stored where they already were (the user document, or the sidecar).

### One path, one meaning

A path is one variable per kind of record, because bindings, selections and
published values address it by path (`fields.cdl_number`).

- Inside one home a path is declared once.
- Two homes of the same owner (two roles, two company types, two departments)
  may each declare the same path only with the **same type and cardinality**.
  Anything else is refused with `custom_field_home_conflict`, naming the home
  that already has it. Use another path for a different kind of value.
- Paths may not nest across homes (`license` and `license.state`).
- A path cannot be both unassigned and in a home: place the unassigned
  definition instead (`custom_field_unassigned_conflict`).

When a record is in two homes that declare the same path it has **one** field
and one stored value. The definition shown is the one from the record's first
home; the field is required, private or read-only if **any** of them says so,
and every read and write permission they name must be held. Each home still
edits its own copy of the definition.

### Leaving a home

A value for a field the record no longer has (a role removed, a company type
dropped) **stays in storage**. It is not published, not offered for editing,
not validated and not inferred as a legacy field. Give the role back and the
value is there again. Retiring a definition (leaving it out of a save) works the
same way and keeps its access rules over what is stored.

### Required fields

Inside a home, required is enforced when **field values are written**
(`custom-fields.<entity>.write`): the write must leave every required field the
caller can fill with a value, or it fails with `custom_field_required`. Saving
the record itself (giving someone a role, renaming a group) is never blocked by
a field that came with a home. Definitions without a home keep the older rule
described under Contracts and editing.

### Definitions without a home

User, team and department definitions made before homes existed name none. They
are **unassigned**: they keep applying to every record of their owner, so
nothing that already reads them changes (the user dialogs, the assignee
directory's `fields`), and they are listed for an administrator to place.
Placing one gives it a home; from then on it applies only there.

### Published

All need `manage_company_settings` except the user exports, which need
`manage_company_users` like the other user field operations. Targets are
`{ scope: "organization", organizationId }`, with `id` for one record.

| Read | Args / target | Value |
| --- | --- | --- |
| `custom-fields-homes.index` | none | `{ homes: [{ kind, id, name, status, exists, fields }], entities }`: every home that exists or holds definitions, with its field count |
| `custom-fields-homes.definitions` | `args: { kind, id }` | `{ home: { kind, id, name, exists }, entity, revision, fields, retired }`. `fields` are in order; each carries `schema` as its author declared it and `value_schema`, the whole contract a value must meet |
| `custom-fields-homes.unassigned` | optional `args: { entity }` | `{ fields, revision }`, each field with `home_kind`, the kind of home it can be placed in |
| `custom-fields-user.resolved`, `custom-fields-team.resolved`, `custom-fields-company.resolved`, `custom-fields-department.resolved` | target `id` | `{ entity, id, recordRevision, homes: [{ kind, id, name, fields: [path] }], unassigned: [path], fields, values }`. `fields` are the contract entries (as in `contract`) each with `homes: [{ kind, id, name }]`; a field two homes declare is listed under both in `homes` |

`custom-fields-company` also has the ordinary `contract`, `values` and `phones`
exports.

| Action | Input | Result |
| --- | --- | --- |
| `custom-fields.definitions.save` | `{ kind, id, fields, expectedRevision }` | `{ kind, id, revision, count }`. `fields` is the home's whole ordered list; a definition left out is retired. `expectedRevision` is the string from `definitions`; it covers that home only, so two people editing different roles do not collide |
| `custom-fields.definitions.place` | `{ path, kind, id, entity? }` | `{ kind, id, revision, count }`: gives an unassigned definition its home |
| `custom-fields.company.write` | `{ values, expectedRevision }` | `{ id, revision }`, as for the other owners |

A home must exist to be saved to: the role in the access role store, the group
type in the workforce configuration, the company type in the assignee base's
`listCompanyTypes`, the department in the department catalog
(`custom_field_home_not_found`). Reads never create anything.

## The department reference type

`department` is a field type like the user, group and company references: a
field anywhere in the application whose value is a department. It stores
`{ "department_id": "sales" }`, or an array of them with `cardinality: "many"`
(at most 100, no repeats). The schema is fixed. A changed value must name
departments in the organization's catalog on both storage backends; the
catalog owns the label and the color, which are never copied into the value.
The existing `organization_user`, `resource_group`, `organization_connection`
and `assignable_subject` types cover users, groups, companies and any assignee.

`public/libraries/platform-widgets/types.json` and `catalog.json` need a
`data-entry.department` row before `tests/publication-widget-types.test.ts`
passes again; those files were outside this change.

## The shared browser library

`public/libraries/custom-fields/firstmate-custom-fields.js` is the one place a
screen gets custom field UI. Three mounts cover every field type. They are
framework free, take data and callbacks, **never fetch**, lay themselves out
from the width of their own container (one column narrow, two wide) and show
titles only: every description or hint is a tooltip.

```js
const cf = window.FirstMateCustomFields;

// (a) The definitions of one home: add, reorder, edit, retire.
const editor = cf.mountDefinitionsEditor(container, {
  fields,                      // custom-fields-homes.definitions -> value.fields
  entity: 'user', home: { kind: 'role', id: 'driver' },
  references,                  // see below
  onSave: fields => invoke('custom-fields.definitions.save', { kind, id, fields, expectedRevision })
});
// -> { getFields, setFields, validate, setErrors, isDirty, destroy }

// (b) The values of one record, grouped by where each field comes from.
const form = cf.mountValuesForm(container, {
  resolved,                    // custom-fields-<entity>.resolved -> value
  references,
  onSave: changes => invoke('custom-fields.user.write', { values: changes, expectedRevision })
});
// -> { getValues, getChanges, validate, setErrors, setValues, destroy }

// (c) A compact read-only value for a list, a summary or a hover card.
cell.innerHTML = cf.renderValue(definition, value, { references, max: 3 });
cf.renderValueText(definition, value, { references });   // plain text
cf.mountValue(container, definition, value, { references }).update(next);
```

`references` is what reference fields point at, supplied by the page:
`{ users, groups, companies, departments, contacts, media }`. Departments are
`{ id, name | label, color, icon?, status? }`; a department chip is tinted with
the department's color and shows its icon when it has one.

Without `onSave` no Save button is shown and the page saves with its own:
`getFields()` / `getChanges()` give what to send, `validate()` shows problems
beside the fields, and `setErrors({ path: message })` shows what the server
refused. An error thrown by `onSave` with `details.path` is placed on that
field. `options.groups` (`[{ id, label, tooltip?, fields }]`) with `values`
replaces `resolved` when the grouping is not by home. Both mounts take
`readOnly: true`.

Rules for anything added to these surfaces: no fetching, no fixed widths (use
the container query on `.fm-cfx` / `.fm-cfd`), no visible description text.

Verification for this section and the two above:
`tests/custom-fields-homes.test.ts` and
`tests/custom-fields-surfaces-browser.test.mjs`, the latter of which reads the
type list from `custom_fields/contracts.ts` and fails when a type has no
editor, read-only rendering, empty state or validation feedback.
