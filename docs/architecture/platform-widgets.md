# Platform widgets

Widgets are versioned, reusable content units. A tab owns its layout; the project modal does not gain a shared left-column override. Scope and Reports use the same host and viewer, while their applications retain business operations.

## Definitions and instances

`public/libraries/platform-widgets/catalog.json` declares first-party identity, exact version, owner app, allowed surfaces, configuration schema, source publications and sizing. `runtime.js` registers renderers and creates independent instances. `project-widgets.js` supplies the roof, photo, measurements and list renderers. Lists can filter materials, labor, equipment or one list. `scope.overview` composes lists and measurements without copying their implementations.

Load scope-data.js, runtime.js and project-widgets.js in order. Await `FirstMateWidgets.ready`; call `list()` or `describe(id, version)` for discovery. `mount(element, {id, version, target, config, state}, context)` returns `ready`, `update`, `configure`, `setVisible`, `serialize` and `destroy`. A renderer receives its own root plus data, config, reference, state, context and visibility; it may return resize, setVisible, serialize and destroy hooks. Release observers, videos, WebGL resources and handlers when destroyed. Late responses cannot replace newer instances. Exact missing versions show unavailable instead of silently using a different implementation.

Targets identify organization and project. Context supplies the surface and optionally an authorized read adapter, already-loaded data, leaf presentation adapters and size notifications. These are trusted application integration points, never agent-supplied JavaScript. A mount owns presentation state; application services own records. Serialize references and presentation state, not domain data or credentials. Hosts persist layout preferences where appropriate; the runtime does not introduce another persistence store.

## Sizing and composition

Content widgets take their natural height. Fill widgets use the available viewport, with a usable minimum; photo widgets preserve an aspect ratio. ResizeObserver informs mounted renderers. Content stacks allow each child to autosize and the outer viewer owns scrolling. Avoid nested tab layouts inside leaf widgets.

`library(element, {items, context, selected, layout, onSelect})` adds selection, keyboard navigation and lazy mounts. Auto layout switches at a container width of 1200px; stacked places the selector below the viewer, wide places it to the left. Scope explicitly requests stacked. Handles support selection, context updates, visibility, serialization and destruction. Hidden media pauses while retained mounts preserve presentation state.

## Data, permissions and assistants

The `project-widgets` publication provider supplies typed lists, effective scope measurements and completed report media references. It reuses domain storage/services, resource ownership and existing permission bundles. Reads never generate lists or change projects. Dataset/report authorization is checked independently. Report aerial media comes only from the image saved for the report. The shared scope resolver keeps scope/proposal/report/list precedence consistent between Scope and agent reads.

Agents discover permitted definitions with `platform_widgets` and request display with `platform_show_widget`. Tool access also respects agent data-scope restrictions and requires a current human context. Messages contain a versioned widget reference, not a stored copy of authorized data. Both shared agent chat and the global assistant render it through `fm-platform-widget`; rendering and reopening fetch fresh authorized data. Cross-organization references are rejected. Automatic runs cannot obtain a privileged presentation context.

Existing document widgets enter the registry through an adapter. Documents retain their existing bindings, pagination, live/frozen snapshots and replay authorization; a widget registry entry does not replace those contracts. These document definitions are available on document/dashboard surfaces, not automatically published as agent tools.

## Adding a widget

1. Declare identity, owner, version, configuration, sizing and supported surfaces; expose typed domain data/actions through publication when needed.
2. Register a renderer with `attachRenderer(id, version, render)`. Keep tab navigation and record ownership outside the renderer.
3. Add a reference to an app's viewer, or mount it directly. Register supported server metadata before exposing a new widget to agents.
4. Test authorization, configuration, independent mounts, resizing and cleanup. Update publication coverage for new app ownership and run publication tests plus the TypeScript check when contracts change.

The initial migration covers Scope, Reports, shared agent chat, the global assistant and the document-registry bridge. Other app features can adopt this shared host without being rewritten into widgets all at once.
