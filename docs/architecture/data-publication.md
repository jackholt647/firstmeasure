# Data publication

All new cross-domain reads use `platform/publication/providers.ts`, not arbitrary
collection names or direct file paths supplied by tenant code. Domain adapters
in `provider-adapters*.ts` own selection, subject checks and explicit field
projections. Register the provider at server bootstrap; UI packages do not
register executable server handlers.

Each version declares named exports, a JSON output schema, schema version,
argument schema and access policy. `authorizeRef` adds instance/argument-specific
checks and runs during frozen replay too. `readPublishedData` validates output,
preserves ready/missing/pending/denied/error, records identity/revision/provenance,
and permits JSON pointers only inside that public export. List implementations
have bounded pages, schema-validated items and context-bound cursors. Current
legacy domain list adapters often load their existing domain list before paging;
these are compatibility adapters, not claims of database-level cursor support.
Comms and chat adapters publish the domain services' bounded recent windows.

Provider discovery describes potential capabilities, not authority to read an
instance. Authentication, enabled applications, permissions, feature capability,
organization/project ownership and specialized subject rules are evaluated at
use. User code cannot manufacture a trusted system grant. Private credentials,
signing links, merchant configuration and arbitrary settings are not exports.

## Project datasets

`datasets.ts` stores named project datasets with registered type/schema version,
role, producer provenance, and native store revision. Initial types are generic
structured data, measurement sets and inventory/cube-sheet items. Additional
specializations register schemas with `registerDatasetType`; they do not need a
separate persistence service. The generic type permits JSON objects/arrays;
specializations enforce stronger field and unit validation. A generic record may declare an immutable valueSchema using the bounded tenant-schema subset; datasets.contract exposes its actual schema.

Each update commits its current value and retained history together, using an
optimistic revision check. No old entry is pruned. This initial representation
keeps history in the record; large/high-frequency datasets will need a
transactional revision-table migration without invalidating recorded identities.
History is not an excuse to bypass current access checks.

`datasets.save` is a command with idempotency and schema validation.
`datasets.select` selects one existing dataset for a project role with project
revision preconditions. Defaults live on the project, so two dataset booleans
cannot both be authoritative. No generic collection HTTP route is exposed.

Measurement values carry explicit units. Producer values and manual overrides
remain separate, and the effective read overlays the validated manual values.
Reimport preserves overrides unless explicitly replaced by an authorized edit.
Changing a dataset's type/schema requires a new dataset, preserving historical
interpretation. Inventory arrays are data, not necessarily document rows.

## FirstMeasure integration

After a completed report manifest is committed, or stored XML changes for a
completed report, `firstmeasure-datasets.ts` projects measurements to linked
platform projects in the same organization. Existing project links identify the
report; address matching is deliberately not used. The projection is retry-safe
for unchanged XML, retains manual overrides, and selects the measurement role
only when no default exists. Projection failure is logged without reversing
already committed report delivery; a later completion/XML update can retry.

The Roofplan adapter uses point geometry for lengths, polygon area for roof area,
and explicitly records the format's feet/ft² convention independently of PDF
display preferences. Segment counts are never lengths. Invalid/missing numeric
fields are omitted rather than converted to zero. Geometry/XML/PDF artifacts
remain in FirstMeasure storage; the dataset retains typed report/XML links.
This adapter currently covers Roofplan roofing quantities; additional exterior
schemas and instant-only result types require their own normalizers.

The shared browser roof-measurement loader first requests the selected effective
project dataset, then supplies compatible numeric keys to existing scope/report
consumers. A missing dataset explicitly enables the legacy artifact path.
Denied/error responses do not silently select another source. Existing reports
are not destructively backfilled. Report completion or an explicit authorized
import populates the new dataset mechanism. The firstmeasure.measurements.import action and report-summary Refresh project measurements button support controlled historical backfill and repair; no bulk backfill is performed.

## Adapter checklist

1. Identify the authoritative domain read service and existing route permissions.
2. Declare public fields and nested schemas; never copy whole storage objects.
3. Implement subject authorization for both reading and frozen-reference replay.
4. Preserve missing/pending/error; do not catch everything as empty/zero.
5. Identify current revision honestly; content hashes do not create history.
6. Provide bounded list semantics and document any recent-window limitation.
7. Register app mappings or document consumer-only apps; a mapping is not proof
   that every field/function in that app is published.
8. Test cross-tenant denial, private fields, invalid schemas, history and pagination.

The old work context namespaces and document row-source sugar remain legacy
compatibility mechanisms. Their broad trusted settings reads do not become new
public exports. New consumers use explicit publication context and bindings.
Referrals publishes the extracted read-only eligibility helper; creating an offer remains an action.

User-filtered channel, training and chat snapshots retain subject IDs in provenance, including when a binding selects a scalar path. Frozen replay checks the original viewer and every captured subject against current permitted subjects. Document snapshots recheck all captured published keys. Revocation denies replay rather than substituting new values.
