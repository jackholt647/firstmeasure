# Development software layers

The Development dropdown has Synthetic data and Software layers views. The expand control fills the browser viewport; restoring keeps the selected view and filters.

Software layers is a read-only declaration inventory behind the existing development sandbox organization and company-settings gates. Its session-scoped endpoint is `GET /v1/signup-sandbox/development/software-layers`, optionally with `projectId`. It does not execute actions, create domain records, evaluate module code, fetch external resources or return instance values.

The inventory includes:

- Data provider exports, their schemas and source arguments, legacy document row sources, custom field contracts and current public module exports.
- Actions across every execution kind, with input/output schemas, effects and versions.
- Platform widget definitions, document/client widget declarations and server resolver metadata. The browser merges locally registered interactive app widgets when available.
- Document types and scope artifact categories, labeled by their separate owning registries.
- Dataset type contracts and published document/workflow modules.

Declaration scope (global registry, organization-installed definition, or selected-project custom field) is distinct from supported target scopes. Entries group by declaration scope and layer, then form an expandable hierarchy from dotted namespaces. Children stay collapsed until their parent opens; declaration contracts and their nested schemas expand independently. Search includes nested contract fields. Schema trees render children only when expanded.

Organization custom fields use the session branch; a selected project uses its owning branch and adds its field schema. External connection entries use actual source/action authorization, so foreign organizations, revoked grants and inactive versions are excluded even when cached in the shared process registry. Private module exports and custom fields without read access are excluded.

This inventories registered contracts, not every legacy HTTP route or every project instance. Flexible JSON contracts can have runtime keys beyond their declared schema. Current module versions are listed; historical retained versions are not a separate inventory. Events, business permissions, app capabilities and bindings are supporting catalogs/infrastructure rather than new peer data/action layers.

Validation: TypeScript check, publication suite, development isolation/read-only discovery checks and desktop/mobile browser interaction checks. No deployment is implied.
