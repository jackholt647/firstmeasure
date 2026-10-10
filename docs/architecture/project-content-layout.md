# Project window content ownership

The project window owns the title, tabs, display controls, and split-pane lifetime. It does not provide a shared mutable left column.

Overview (`map`) owns the project-details form inside its `.r-tab-content`, beside its map/overview content. Contacts, address, custom fields, notes and existing report-order controls remain in this form. Project identity and tags/stages appear in the window header. Its identity dropdown presents a synchronized second view with unique IDs while the original controls stay mounted in Overview. Edits and actions route through the original handlers; structural changes and field values reconcile into the dropdown without replacing focused inputs. The dropdown address autocomplete uses the same map domain operations. This does not introduce a shared content rail.

`firstmeasure/order/app.js` supplies the Overview details component. Its definition is `overview_details`, not a general modal region app. The form stays mounted across tab changes and panel rebuilds to preserve values, handlers and drafts. A hidden storage element retains the form only while its Overview panel is being rebuilt or unavailable; it is not an app mounting surface.

Scope, Money and legacy Proposals receive a private `.r-tab-sidebar` beneath their own tab panel. Their main renderer receives `.r-tab-main`; their context's `sidebarRoot` is confined to that same tab. These apps cannot replace Overview's details or another tab's rail. Ordinary tab switching and docked tabs use the same content layout.

The Scope app's standard tab label is **Project**, resolved through the existing
`scope.project_tab` terminology key. Its private rail occupies one third of the
width by default; Materials, Labor and Equipment occupy the remaining two thirds.
An app-owned draggable, keyboard accessible divider remembers the proportion
locally. Mobile stacks the rail and resource content. There is no shared rail API.

The rail has three compact icon tabs along its bottom: Scope of Work, 3D Roof
and Aerial View. Scope of Work shows accepted document publishers first and
published measurement datasets below. Document membership comes from persisted
material ledger origins, including an accepted snapshot identity, and requires a
signed/completed document. Drafts, standalone presentations, document types and
unpublished module instances do not establish membership. Materialized module
documents qualify through the same accepted-publication contract. Measurement
reads use the existing typed dataset publication provider and retain units. Older
completed reports use the authorized project-widget report/measurement contracts
without importing data; incomplete reports remain excluded.

Tiles show retained contract totals when captured, material artifact counts and
measurement summaries. Hover/focus exposes a concise content preview. Opening a
tile replaces this rail's content with readable material/measurement details and
the accepted snapshot rendered by FMDocRenderer; Back restores the tiles. This
uses neither a modal nor a generic JSON instance viewer. Resource list controls
remain available in a compact disclosure beneath the artifact sections.

The right side has no separate heading, toolbar or totals footer. Its three
resource panes use the full available height, scroll independently and narrow
empty panes when another has content. With no items, all three are equal and
show Empty List. First Add creates a missing typed list through the existing
writer and immediately adds an editable row. Later additions reuse that list.
The Price Book control lives in the Materials pane heading.

No manual page-refresh control is exposed. Idle visible background reads update
persisted lists/artifacts without evaluating calculations or creating records.
Focused edits, dialogs and writes defer these reads. Explicit generation,
ordering and scheduling remain domain commands in the resource list controls.

Removed contracts: `project_modal_region_app`, the dynamic left-region registry/mounting pipeline, `leftRegionRoot`, `setLeftColumnOverride`, `isLeftColumnOverridden`, and `projectModal.left`/`leftMode` interpretation. The window layout helper no longer has a shared-sidebar rollback flag or visibility callback. New apps must render their layout within their tab content rather than add shell regions or revive these contracts.

Each docked tab still has its own owned document for legacy app isolation. Realtime transport is shared with its owning portal; do not introduce another independent stream per pane.

Projects and Contacts share the [entity window shell](window-shell.md). Its optional persistent sidebar is declared by Contacts; Projects declare none and keep the content ownership above.

## Overview entry workflows and project trays

Overview also owns the focused New Report project picker and the map-first New Project
form. The same mounted details form provides contacts, address, property type, custom
fields, and initial actions. `firstmeasure.new_report_project` defaults to `auto`:
new reports skip the project picker when the effective `platform.new_button_mode`
is `report`, and use the picker for the selector menu. Explicit `on`/`off` overrides
always start a new project or show the picker, respectively. Existing-project
report/reorder entry points retain their project. Skipping the picker selects the
unsaved new-project form; it does not submit an order or eagerly save a project.
The project header presents a larger New Report heading
only until a project is selected or its address is defined. Known projects always retain
their normal identity and tabs, including unfinished report drafts; report intent changes
the content workflow independently of the header. Existing project selection uses the authoritative project
open path and the existing measurement reorder prefill. Choosing a project or an action
does not submit a report.

Contact controls share the header dropdown's flat rows, communication shortcuts, and
section dividers. Custom fields follow the address/type fields and actions follow the
custom fields. Overview project-field autosave is independent of proposal document
persistence. Loading/hydration guards still prevent provisional records being written.

Shared right trays own the visible Notes composer. The legacy form note controls remain
mounted for compatibility but are hidden in Overview when shared trays are present.
Unsaved projects can mount the Notes workspace without creating a project; explicit note
submission or attachment preparation can request a saved draft. The composer survives
tray changes and acquisition of a project ID.

`FirstMateProjectTrays.definitions()` is the shared, capability-filtered registry for
header tabs and branch settings. Modules can declare additional trays with `register()`.
`project_configuration.default_project_tray` defaults to `notes`; `off` closes all trays.
Explicit tab/layout opens retain their intent, and late configuration does not override
a user's tray interaction. Overview container queries respond to the actual remaining
content width beside the right tray, rather than only the browser viewport.


To Do is registered immediately after Notes and reuses `PlatformActionItems.renderTodayList` with a project filter, including its future and completed sections. The legacy project to-do dock is suppressed when this tray is available. The agent's compact pin occupies 100px below an open tray or floats at the bottom right when no tray is selected. Pinning moves the same renderer and preserves the conversation; session ownership and global transfer are described in [global assistant architecture](global-assistant.md#project-tray-session-lifetime).

Scheduling uses its full tab width, with one + Appointment button opening the shared booking widget. It declares no content sidebar; department, delivery and recurrence configuration belongs to the booking form. See [appointment planning](appointment-planning.md).

The global header also offers an independent dockable To Do tray through
`topbar.todos`. It reuses the shared list across projects and remains available
when the left column is collapsed or disabled. See [to-dos](todos.md).
