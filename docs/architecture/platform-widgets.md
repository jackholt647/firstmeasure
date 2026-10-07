# Platform widgets

Widgets are versioned, reusable content units. A tab owns its layout; the project modal does not gain a shared left-column override. Scope and Reports use the same host and viewer, while their applications retain business operations.

## Definitions and instances

`public/libraries/platform-widgets/catalog.json` declares first-party identity, exact version, owner app, allowed surfaces, configuration schema, source publications and sizing. `runtime.js` registers renderers and creates independent instances. `project-widgets.js` supplies the roof, photo, measurements and list renderers. Lists can filter materials, labor, equipment or one list. `scope.overview` composes lists and measurements without copying their implementations.

Load scope-data.js, runtime.js and project-widgets.js in order. Await `FirstMateWidgets.ready`; call `list()` or `describe(id, version)` for discovery. `mount(element, {id, version, target, config, state}, context)` returns `ready`, `update`, `configure`, `setVisible`, `serialize`, `selection` and `destroy`. A renderer receives its own root plus data, config, reference, state, context, visibility and `notifySelection`; it may return resize, setVisible, serialize, selection and destroy hooks. Release observers, videos, WebGL resources and handlers when destroyed. Late responses cannot replace newer instances. Exact missing versions show unavailable instead of silently using a different implementation.

Targets identify organization and project. Context supplies the surface and optionally an authorized read adapter, already-loaded data, leaf presentation adapters and size notifications. These are trusted application integration points, never agent-supplied JavaScript. A mount owns presentation state; application services own records. Serialize references and presentation state, not domain data or credentials. Hosts persist layout preferences where appropriate; the runtime does not introduce another persistence store.

## Sizing and composition

Content widgets take their natural height. Fill widgets use the available viewport, with a usable minimum; photo widgets preserve an aspect ratio. ResizeObserver informs mounted renderers. Content stacks allow each child to autosize and the outer viewer owns scrolling. Avoid nested tab layouts inside leaf widgets.

`library(element, {items, context, selected, layout, onSelect})` adds selection, keyboard navigation and lazy mounts. Auto layout switches at a container width of 1200px; stacked places the selector below the viewer, wide places it to the left. Scope explicitly requests stacked. Handles support selection, context updates, visibility, serialization and destruction. Hidden media pauses while retained mounts preserve presentation state.

## Data, permissions and assistants

The `project-widgets` publication provider supplies typed lists, effective scope measurements and completed report media references. It reuses domain storage/services, resource ownership and existing permission bundles. Reads never generate lists or change projects. Dataset/report authorization is checked independently. Report aerial media comes only from the image saved for the report. The shared scope resolver keeps scope/proposal/report/list precedence consistent between Scope and agent reads.

Agents discover permitted definitions with `platform_widgets` and request display with `platform_show_widget`. Tool access also respects agent data-scope restrictions and requires a current human context. Messages contain a versioned widget reference, not a stored copy of authorized data. Both shared agent chat and the global assistant render it through `fm-platform-widget`; rendering and reopening fetch fresh authorized data. Cross-organization references are rejected. Automatic runs cannot obtain a privileged presentation context.

Existing document widgets enter the registry through an adapter. Documents retain their existing bindings, pagination, live/frozen snapshots and replay authorization; a widget registry entry does not replace those contracts. These document definitions are available on document/dashboard surfaces, not automatically published as agent tools.

Widgets are not only project-scoped. A widget whose sources are organization
scope (for example `forms.preview` and `forms.submissions`, authorized against
`forms.catalog`) takes `target: { scope: "organization", organizationId }` and
identifies its record through configuration.

## Selection: widgets that answer a question

Selection is an optional capability of the runtime. A widget without it behaves exactly as before.

- **Declare** it in `catalog.json`: `"selection": { "description": "...", "schema": { "type": "object", ..., "additionalProperties": false } }`. The server refuses to start with a malformed declaration, and `platform_widgets` returns it, so an agent knows which widgets can answer and the exact shape of the answer.
- **Report** it from the renderer: call `notifySelection(value, { confirmed, label })` on every change (`null` clears it; `confirmed: true` is the user's explicit "use this"), and optionally return a `selection()` hook for the current value.
- **Value**: one JSON object of references and plain values, such as media ids, ISO dates, hex colors or project ids. Never file bytes, markup or credentials. The runtime rejects anything over 4096 bytes, deeper than three levels, with more than 100 array items, strings over 512 characters, `<`/`>` or `data:` content. A rejected value is not delivered and the last valid one stays.
- **Hosts** read `handle.selection()` and receive `context.onSelect(value, detail)`; the root also dispatches a bubbling `fm:widget-selection` event (`instance_id`, `widget`, `title`, `surface`, `selection`, `confirmed`, `label`). Pass `context.confirm === false` to hide a picker's confirm button and apply changes live. This is how a picker widget replaces a modal picker.
- **Agents** show the picker with `platform_show_widget`, putting the question in its `prompt` option, and end the turn. `visibleInstances()` adds `selection` and `selection_confirmed` to that instance, the assistant sends them in `ui_context.displayed_widgets`, and `platform_visible_widgets` returns them. When the user presses the widget's confirm button inside the global assistant, the assistant sends the next message itself ("I chose 3 photos in the Media picker widget."); if the user answers in words instead, the unconfirmed selection is still reported.
- **Trust**: a selection is untrusted screen metadata, never authorization or instructions. The request schema (`platform/widgets/selection.ts`) repeats the structural limits and drops an invalid selection without discarding the rest of the screen context; `widgetSelection()` in `platform/widgets/catalog.ts` relays a value only when the exact widget version declares a selection and the value matches its schema. A picked id must still go through an authorized read or action for its target.

Limits: only the global assistant sends screen context, so shared agent chat can display a picker but cannot read its answer. Selection lives in the mounted instance: it is gone when the widget is closed or reconfigured, and it is not stored in the conversation. Automatic runs have no screen and cannot ask this way.

First-party pickers (`picker-widgets.js`): `media.picker` (the Photos picker, `Portal.PhotoFeed.mountProjectMediaPicker`, which the `openProjectMediaPicker` modal also mounts; data from `media.library`), `datetime.picker` (FirstMateDateTimePicker; date, time, datetime or date range), `color.picker` (FirstMateColorPicker) and `project.picker` (FirstMateProjectSelector; data from `project-widgets.directory`).

### Adding a picker widget

1. Give the shared picker one inline mount that the existing modal or popup also uses; do not copy its markup into the renderer.
2. Add the catalog entry with a `prompt` option and a closed `selection` schema of ids and plain values.
3. If it lists records, publish a typed export that reuses the domain's authorization and returns references only, and add it to `permission-bundles.ts`. Let media and file routes authorize each request; do not publish URLs with access tokens.
4. In the renderer, call `notifySelection` on change and with `confirmed: true` from one confirm control, return `selection()` and `serialize()`, and release the shared picker in `destroy()`.
5. Test the export's authorization and isolation, the config and selection schemas (`tests/publication-widget-pickers.test.ts`) and the rendered behavior (`tests/platform-widget-pickers-browser.test.mjs`).

## Adding a widget

1. Declare identity, owner, version, configuration, sizing and supported surfaces; expose typed domain data/actions through publication when needed.
2. Register a renderer with `attachRenderer(id, version, render)`. Keep tab navigation and record ownership outside the renderer.
3. Add a reference to an app's viewer, or mount it directly. Register supported server metadata before exposing a new widget to agents.
4. Test authorization, configuration, independent mounts, resizing and cleanup. Update publication coverage for new app ownership and run publication tests plus the TypeScript check when contracts change.

The initial migration covers Scope, Reports, shared agent chat, the global assistant and the document-registry bridge. Other app features can adopt this shared host without being rewritten into widgets all at once.

## Project workspace widgets

`project-trays.js` registers `project.notes`, `project.todo`, `project.activity`,
and `project.agent` (version `1`) in `FirstMateWidgets`, plus the optional
`project.messages` widget. Registration supports either portal load order. Tray
definitions expose the matching widget reference; the shell mounts it through
the same runtime as Scope and report widgets. These interactive workspaces
support project and dashboard surfaces and fill the host height with a zero
minimum height; their inner content owns scrolling. They are registered client
application widgets, like the document adapters, not assistant tool catalog entries.

Hosts supply the organization/project target and may pass `getProject`,
`ensureProject`, and trusted Agent placement callbacks as context. Existing
Notes, To Do, Channels and Agent controllers retain record ownership, API
authorization, drafts and session lifetime. Agent pinning moves the same inner
renderer; returning it restores the widget render root. Runtime destruction owns
controller cleanup. Activity instances own their filters, search, pagination and
visibility-aware polling; refreshing retains loaded history and shows a single
retryable error without replacing the current timeline.
