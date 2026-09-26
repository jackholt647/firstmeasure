# Custom fields and publication

Custom fields belong to projects, contacts, or the organization. Organization
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
