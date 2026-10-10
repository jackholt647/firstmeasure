# Priority fields and published calculations

Priority fields are an ordered list of singular declared data references used
by project quick displays. They are independent of a particular renderer.
The project header consumes the same result that cards, previews, lists,
widgets and developer integrations can consume.

## Ownership and entry points

- Branch configuration: `project_configuration.priority_fields`.
- Backend contracts and publication: `public/v1/priority_fields/`.
- Published calculated custom fields: `custom_fields/calculations.ts`,
  `custom_fields/records.ts` and `custom_fields/publication.ts`.
- Browser picker, editor, resolver and renderer:
  `public/libraries/priority-fields/priority-fields.js`.
- Settings → Projects → Priority fields edits the list. Custom Fields also
  exposes **Calculate from published variables** on ordinary field definitions.
- `priority-fields.contract` publishes the ordered definitions. Organization
  targets can discover a branch configuration before selecting a project.
- `priority-fields.values` resolves that list for one project, preserving a
  separate publication result for every entry.

The providers register in shared publication bootstrap. Their ownership is
listed under Projects in `publication/coverage.ts`, and their permission
bundles are in `publication/permission-bundles.ts`. Existing branch module saves
remain the configuration writer; no extra permission or parallel write API was
introduced. Read and configuration-write authority remain separate.

## One reference per priority

```json
{
  "priority_fields": [
    {
      "id": "contract_value",
      "label": "Contract value",
      "format": "currency",
      "currency": "USD",
      "icon": "fa-dollar-sign",
      "empty": "hide",
      "source": {
        "provider": "custom-fields-project",
        "export": "values",
        "target": {
          "scope": "project",
          "organizationId": "$organization",
          "projectId": "$project"
        },
        "args": { "field": "contract_value" },
        "path": "/contract_value"
      }
    }
  ]
}
```

There are at most 32 entries, with unique stable IDs. The order is meaningful.
An explicit empty list shows no priorities. Property type and stage are not
silently appended to an explicit list. Stage and property-type editing remain
available on their configured compatibility fields in the project header.

Sources use ordinary publication references and JSON pointers within published
exports. The picker discovers permitted provider schemas and declared project
custom fields. For exports with instance-dependent contracts, such as document
parameters, select the published export and configure its instance/field path.
Only the provider's explicitly published values can resolve; typing a pointer
does not expose private domain storage. Scalar export arguments are editable in
the picker, including custom-field paths and signed snapshot IDs.

The target tokens `$organization`, `$project` and `$branch` resolve from the consumer context.
Other source strings and arguments are not interpolated. Every bound reference
passes through normal publication authorization. A tenant/project mismatch
cannot grant access. No arbitrary HTTP or raw collection access is introduced.

## Calculations belong to fields

An ordinary custom-field definition may declare `calculation`. This makes it
read-only. Its result must satisfy the field's declared type/schema and is
published through its existing `custom-fields-<owner>.values` export. It is not
written back as another independently mutable stored value.

```json
{
  "entity": "project",
  "path": "contract_value",
  "label": "Contract value",
  "type": "currency",
  "currency": "USD",
  "calculation": {
    "op": "first",
    "inputs": [
      {
        "op": "source",
        "source": {
          "provider": "documents",
          "export": "params",
          "target": {
            "scope": "project",
            "organizationId": "$organization",
            "projectId": "$project"
          },
          "path": "/total"
        },
        "select": {
          "where": { "template_id": "proposal_a", "status": "signed" },
          "orderBy": "created_at",
          "direction": "desc",
          "pick": "first"
        }
      },
      {
        "op": "source",
        "source": {
          "provider": "documents",
          "export": "params",
          "target": {
            "scope": "project",
            "organizationId": "$organization",
            "projectId": "$project"
          },
          "path": "/grand_total"
        },
        "select": {
          "where": { "template_id": "proposal_b", "status": "signed" },
          "orderBy": "created_at",
          "direction": "desc",
          "pick": "first"
        }
      }
    ]
  }
}
```

For five alternate document variables, add five ordered source nodes. To sum
matched records, use `op: "sum"` around a source node with `select.pick: "all"`.
The priorities still reference only `contract_value`, regardless of how that
field is calculated. A direct source is also a valid field calculation.

Supported nodes:

| Node | Behavior |
| --- | --- |
| `source` | Read one published reference, optionally selecting permitted instances |
| `literal` | A finite number, string, boolean or null |
| `first` | First value other than missing, null or empty string, in declared order |
| `sum` | Add numeric inputs; selected arrays are flattened one level |
| `product` | Multiply numeric inputs |
| `difference` | First numeric input minus subsequent inputs |
| `quotient` | First numeric input divided by subsequent inputs |

Arithmetic defaults to `missing: "propagate"`; any absent input leaves the
result absent. `missing: "skip"` explicitly uses available inputs, with an
all-absent result remaining absent. Zero and false are values. No implicit
string-to-number conversion is performed. Division by zero fails.

Use compatible units/currencies. Display formatting does not convert them.
For example, convert cents in a separate declared numeric calculation using
`product` with literal `0.01`, then reference that field in a dollar sum. There
is no automatic exchange-rate conversion or inferred equivalence between
different templates' totals. Selecting all records can intentionally double
count amendments unless the configuration excludes them; use a specific
instance or an explicit latest-first selector per document/template as needed.

The browser editor supports source rows and common operations. Nested and
literal expressions can be authored through the same branch custom-field
contract; existing nested expressions are preserved by the editor.

## Selection and accepted content

Selection is supported only on exports declaring a publication `list` contract.
`where` matches exact scalar values in published list metadata. `orderBy` sorts
numeric values numerically and other values lexically; `direction` chooses
ascending or descending, and stable `id` breaks ties. The default is ID order.
Every selected row must have a stable ID and is then read through the selected
export's ordinary resource authorization.

Documents `params` and `outputs` publish listable metadata: ID, template ID,
template version ID, status and creation/update times. Listing applies project
ownership and department access and includes only instances declaring the
relevant export. Variable values are read separately, using the existing
explicit publication keys. Unpublished parameters remain unavailable.

`status: "signed"` is a selector on the current document record, not a frozen
accepted-content binding. Use `documents.signed` with the exact snapshot ID,
or a frozen module binding, when the field must represent accepted historical
content. Reading a module output never refreshes or executes that module; its
owner must explicitly evaluate/refresh it at the existing execution boundary.

## Resolution, safety and freshness

Each priority returns `ready`, `missing`, `pending`, `denied` or `error`.
The renderer hides denied/error/pending entries. `empty: "show"` can display
an unset field; it never substitutes a zero. Source denial, pending state or
error stops a calculation, including `first`; it is not treated as absence.
Permitted list selection operates only on the records returned by the provider.

The evaluator uses typed publication reads, never actions or module refresh.
Cycle checks cover both local fields and cross-provider field dependencies.
Definitions are bounded to 128 expression nodes/12 levels and 32 operands per
operation. One resolution session has at most 128 source reads/list pages and
512 evaluated nodes. Selectors inspect at most 1,000 records, with explicit
failure on truncation/budget exhaustion. Repeated references share a source
read/revision within a resolution session. There is no cache shared across
principals or HTTP requests.

Source identity, revisions, schema versions and dependency evidence are retained
with calculated values. Frozen reads reauthorize the field and every captured
source, including transitive custom-field inputs and document publication keys.
A permission revocation cannot be bypassed through a calculated field or
retained priority result.

The project header refreshes its display while visible, after configuration,
project, permission and custom-field events, and on a ten-second visible-window
interval. In-flight results from an invalidated cache are ignored. The immediate
opening header uses the same resolver and updates when results arrive. Other
consumers should refresh at their own display boundary.

## Reuse in another display

```js
const items = await FirstMatePriorityFields.resolve(orgId, projectId);
container.innerHTML = FirstMatePriorityFields.html(items);
// Or use visible(items) and format(item) in a consumer's own layout.
```

Load `priority-fields/priority-fields.js` before the consumer. Built-in application
bundles include it through the canonical manifest. For backend/agent consumers,
read `priority-fields.values` through the shared publication API; no frontend
state or project-modal dependency is necessary.

## Compatibility and migration

Without `priority_fields`, the resolver translates `project_header_pills`, plus
legacy custom-field tag flags and property type, into the new list in memory.
Reads do not save or backfill configuration. Saving the Priority fields editor
persists the explicit list; subsequent edits do not reapply legacy tag flags.
The old configuration remains retained for recovery/older embedded hosts.

`project-summary.details` declares the former project display fields.
`project-summary.value` declares the former project-value fallback chain:
explicit project totals, selected accepted/first proposal totals, then pure
domain pricing over stored proposal content. Value reads require Money and
`view_financials`. Scope type is a project scope-set/template name with a
selected-proposal scope-template fallback. Missing values remain null and valid
zero totals are preserved. New company-specific meanings should be expressed
as declared custom fields rather than extending this compatibility chain.

## Verification

Run in `public/v1`:

```text
npm run check
npm run test:publication
node --experimental-sqlite --import tsx --test --test-force-exit tests/priority-fields.test.ts
node --test tests/priority-fields-browser.test.mjs tests/custom-fields-browser.test.mjs
node tests/run-embedded-postgres.mjs tests/priority-fields.test.ts
```

Coverage includes configuration migration/order, zero/missing behavior,
arithmetic, source revision consistency, document-template selection,
cross-project exclusion, denial, cycles, snapshot revocation, read-only fields,
browser field creation/reordering and the same resolved values rendered by the
header and another compact display.
