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
and Photos. Scope of Work shows accepted document publishers first and
published measurement datasets below. Document membership comes from persisted
material ledger origins, including an accepted snapshot identity, and requires a
signed/completed document. Drafts, standalone presentations, document types and
unpublished module instances do not establish membership. Materialized module
documents qualify through the same accepted-publication contract. Measurement
reads use the existing typed dataset publication provider and retain units. Older
completed reports use the authorized project-widget report/measurement contracts
without importing data; incomplete reports remain excluded.

Document tiles show retained contract totals when captured and material artifact
counts. Hover/focus exposes a concise content preview. Opening a document
tile replaces this rail's content with readable material details and
the accepted snapshot rendered by FMDocRenderer; Back restores the tiles. This
uses neither a modal nor a generic JSON instance viewer. Measurements appear
directly below the documents, with every published value in compact inline editable rows. Each section
measures labels and value widths and uses up to three columns when the rail width permits.
Oversized labels move to full-width rows at the end of a section. Pitch breakdown is a
Pitch/Squares table. Zero and unavailable measurements are hidden by default; the
Measurements heading includes a Show zero measurements toggle. Editable values accept
nonnegative decimal text, never exponent notation.
Pitch and roofing-square explanations are inline control tooltips. Edits use project-local measurement overrides, never write to the published
source, and have the existing override lifetime. Measurement cards have no hover
tooltip or separate detail view.

The right side has a thin action header for New scope list, Generate lists
automatically and minimized-list pills. Ten pixels of padding match its gutter.
Its three resource panes use the remaining height, scroll independently and narrow
empty panes when another has content. With no items, all three are equal and
show Empty List. First Add creates a missing typed list through the existing
writer and immediately adds an editable row. Later additions reuse that list.
The Price Book control lives in the Materials pane heading. Each actual list
has its own header, ordering/scheduling/compensation controls and direct Add.
Minimizing animates the list closed and exposes a header pill to restore it.
Deletion uses the domain archive writer; accepted document material sets cannot
be deleted through that writer and remain available to minimize.

The roof and aerial widgets mount eagerly once per project rail and remain in
memory through view switches, document previews and background rail updates.
Bottom tabs use the company primary color. Aerial images use the reusable image
viewer with cursor-centered scroll zoom, pointer panning, keyboard controls and
Fit. The roof viewer reserves bottom space for its collapsible 15-entry editor
key, uses five/four columns as width permits, and re-centers within the remaining
canvas. The authorized report publication provides bounded saved edge
classifications to recover chimney/transition types folded by the XML exporter;
endpoints absent from the saved geometry remain classified by XML. No report or
editor record is modified.

No manual page-refresh control is exposed. Idle visible background reads update
persisted lists/artifacts without evaluating calculations or creating records.
Focused edits, dialogs and writes defer these reads. Explicit generation,
ordering and scheduling remain domain commands on the right.

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

The Project Photos tab uses the reusable photo gallery over the full rail height.
It reads the authorized completed-report publication and project-scoped Media list
once, selecting the frozen report aerial first. Its image viewer fills the upper
region and centers the largest contained image; a keyboard-accessible horizontal
divider resizes the default scrolling thumbnail row into a multirow grid. Selection,
zoom and divider state survive local tab switches.

The roof key shows published linear feet (falling back to saved XML edge geometry
in feet), with decimal inputs wired to the same project-local overrides as the
Measurements section. Compact type names retain full-name tooltips. Selecting a
type highlights all matching model edges. A top-left Pitch labels control toggles
face-mounted labels; each anchor maximizes interior clearance from the outer
boundary and all openings, avoiding concave voids and penetration holes.
