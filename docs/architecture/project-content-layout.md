# Project window content ownership

The project window owns the title, tabs, display controls, and split-pane lifetime. It does not provide a shared mutable left column.

Overview (`map`) owns the project-details form inside its `.r-tab-content`, beside its map/overview content. Contacts, address, notes and existing report-order controls remain in this form. Project custom fields show on the right of Overview, in the Overview app's fields slot (`[data-overview-fields]`, below the summary cards, and a card over the map when the map fills the tab); the project window keeps the `#rProjectCustomFields` node and places it there through the `placeProjectCustomFields` host call, returning it to the details form whenever the slot is not mounted. Project identity and tags/stages appear in the window header. Its identity dropdown presents a synchronized second view with unique IDs while the original controls stay mounted in Overview. Edits and actions route through the original handlers; structural changes and field values reconcile into the dropdown without replacing focused inputs. The dropdown address autocomplete uses the same map domain operations. This does not introduce a shared content rail.

`firstmeasure/order/app.js` supplies the Overview details component. Its definition is `overview_details`, not a general modal region app. The form stays mounted across tab changes and panel rebuilds to preserve values, handlers and drafts. A hidden storage element retains the form only while its Overview panel is being rebuilt or unavailable; it is not an app mounting surface.

Scope, Money and legacy Proposals receive a private `.r-tab-sidebar` beneath their own tab panel. Their main renderer receives `.r-tab-main`; their context's `sidebarRoot` is confined to that same tab. These apps cannot replace Overview's details or another tab's rail. Ordinary tab switching and docked tabs use the same content layout.

The Scope app's standard tab label is **Project**, resolved through the existing
`scope.project_tab` terminology key. Its private rail occupies one third of the
width by default; Materials, Labor and Equipment occupy the remaining two thirds.
An app-owned draggable, keyboard accessible divider remembers the proportion
locally. Mobile stacks the rail and resource content. There is no shared rail API.

The rail has four compact icon tabs along its bottom: Measurements, Documents,
Photos and Schedule (three when the organization has scheduling off). Schedule is the scheduling widget: the project's own
schedule panel (`project-schedule/panel.js`) borrowed through `mountWidget` and
handed back with `releaseWidget`. There is one schedule panel and one set of
schedule state per window, so the widget and the Schedule tab are the same code
and never show at once. The widget has no title and no Appointment action,
offers Calendar and Timeline but not Routing, and uses a three-day short range
that is its default. In both forms the top bar ends with Today and its arrows
on the far right, with the views to their left, then view-specific controls,
then Appointment; do not put a control that changes with the view to the right
of one that does not. Measurements is the default and is the 3D roof viewer with its key
(line types, pitches and summary); the rail has no separate list of every
published measurement, and one must not be added back.
Documents mirrors Photos with a document viewer in place of the image viewer:
delivered roof measurement PDFs, customer PDFs and XML appear alongside accepted documents. These report entries reuse the authorized project report-asset loader and do not create material publications. PDFs open in the viewer; XML offers a download. All three use the organization-primary ruler icon, with customer/code badges where appropriate. For accepted documents, the selected document is rendered by FMDocRenderer above its published
materials, and a strip beneath lists every accepted document, with the first
selected. With no accepted documents the same viewer-above-strip layout stays,
showing No document selected and No documents yet. There is no Scope of Work tab and no tile-then-Back navigation. Document membership comes from persisted
material ledger origins, including an accepted snapshot identity, and requires a
signed/completed document. Drafts, standalone presentations, document types and
unpublished module instances do not establish membership. Materialized module
documents qualify through the same accepted-publication contract. Measurement
reads use the existing typed dataset publication provider and retain units. Older
completed reports use the authorized project-widget report/measurement contracts
without importing data; incomplete reports remain excluded.

Each strip entry shows the retained contract total, document type and material
count. The viewer uses neither a modal nor a generic JSON instance viewer. Measurement edits come from the roof key. They use project-local measurement
overrides, never write to the published source, and have the existing override
lifetime.

With no completed report, a project whose scope templates name a measurement
schema shows a measurements editor in the Measurements view instead of the
report's empty state: the schemas' dictionary measurements with labels and
units, required ones first, saved as the project's manual measurement dataset.
Once a report is complete the 3D model is the view again and a "Your entries"
control shows the earlier entries beside the report's numbers until they are
cleared. See [measurements entered by hand](measurement-schemas.md#entered-by-hand).

The right side has a thin action header, described below. Ten pixels of padding match its gutter.
Its three resource panes use the remaining height, scroll independently and narrow
empty panes when another has content. With no items, all three are equal and
show Empty List. First Add creates a missing typed list through the existing
writer and immediately adds an editable row. Later additions reuse that list.
The Price Book control lives in the Materials pane heading. Each actual list
has its own header, ordering/scheduling/compensation controls and direct Add.
Line items are single-line rows at every pane width: a thin drag handle, the
name (truncated when the pane is narrow), the color swatch, a quantity that
sizes to its digits, the unit as plain text that becomes an input on focus, the
read-only line total in whole dollars, and an expander. Expanding a row shows
its variant or pay type, the unit price (shown in whole dollars with
separators, edited as the stored number) and Remove beneath it. The row's hover
summary carries the full name, quantities, price and variant. Keep the
collapsed row to one line; put further per-item fields in the expanded detail.
Dragging the handle reorders an item or moves it to another list of the same
resource type; clicking it offers the same move as a menu. Reordering writes
the list's items as one version.
A list header is one line with no icon: collapse, name, subtotal (when the pane
has several lists or the list is collapsed), icon-only Schedule and Order, and
Delete. A list named after its category shows as Default. Collapsing a list is
local view state. Minimizing applies to a resource type column and leaves a
header pill to restore it. The measured/order units switch is in the action
header and applies to every list.
A list header's icon actions are drawn most used first; when they do not fit
beside the name, the assignee and the total, the least used move into a ⋮ menu
(`fitListActions`), which shows only when it holds something. A labor list's
work order document controls (Generate, or Open, Download and Update; see
[closeout](closeout.md#work-order-documents)) are among them, after Pay out.

**Scheduling off.** With the organization's `platform.scheduling` switch off
(`schedulingOn()` in `materials/project.js`: the host's `schedulingEnabled`
first, then the organization's flags), the Project tab has no Schedule view in
its rail, no Schedule button on any list or in the header, no Reserve equipment
action, no "Not scheduled" state, and starts no schedule placing. Ordering
still works: the order dialog's delivery date and time go in the supplier's
email and onto the order's `scheduled_window`, and neither the browser nor the
server (`createMaterialOrder`) makes or locks a schedule event.

**Equipment off.** With the organization's Equipment app (`apps.equipment`) off,
`listResourceTypes` leaves the equipment column out, so the tab (`equipmentOn()`)
has no equipment column, no Add an equipment list, no Reserve Equipment, no
equipment line item source and no equipment step in Fix all; a requirement that
equipment would meet shows as the work order's. The server refuses to make an
equipment list (`requireResourceType`, error `equipment_app_disabled`), to turn
a list into one, or to save the equipment column, and a scope makes none. An
equipment list made while the app was on is kept: it shows in the work order
column read-only (`equipmentListRetired`), with a note, its lines and Delete;
renaming it is allowed, a scope run leaves it as it is and withdraws its
generated schedule event. Turning the app back on makes it editable again.

**Work orders without assignees.** A work order is assigned to a group of users
or an outside company (users alone are not offered). With the groups app
(`apps.crew`) off, groups are not offered, and when the directory has no
outside company either (`laborAssignmentOn()`), a work order is a plain list of
labor line items added by hand, like materials: no assignment block or control,
no Generate from pay sheet, no Pay out (a list already paid out still shows it
and can be reopened) and no assigning in Fix all. The lines and any stored
assignment are unchanged, so turning groups on brings assignment back.

**Starting minimized.** When the project's requirements include nothing but
material (no work items or functions) and the Work order column has no lines or
assignee, the column opens minimized to its header tab. This is decided once
per project after both the lists and the requirements have loaded; restoring
it keeps it open.

**Assigning.** The assignment block (an unassigned, empty labor list, or a
project with requirements and no work order yet) and the assignment popover
list who does some of the job's work first, ranked by pay, then offer everyone
else who can be assigned behind "Show N more". The choice is never a bare
"nobody": while the directory loads it says so; a failed directory read or
price comparison says what failed and offers a retry; an empty directory says
where assignees are added and that only the caller's branches are listed; a
job nobody is marked for lists everyone and says why. The directory and the
prices redraw only the assignment blocks when they arrive (`syncAssignBlocks`),
so a read that finishes while someone types is not lost.

A labor list's header carries one assignment control, left of Schedule and
Delete, showing the assignee or Unassigned. It opens an app-owned popover, not
native selects: assignable work resources with their kind, member count and
default pay; project pay for an assigned list, with estimated hours beside it
only when the resolved pay uses hours; and salary treatment only when the
assignee's plan includes salary. Labor writers release the saving state before
re-rendering, then rebuild the open popover.
The action header holds restore tabs for minimized resource type columns on the
left and three short, tooltipped actions on the right: Category (new resource
type), Regenerate (generate lists from the scope) and the Measured/Order units
switch. Minimizing a column animates it into its tab and restoring animates it
back out. Dividers between columns are draggable and keyboard adjustable; two
neighbours trade width, the weights are remembered per browser, and
double-click resets them. A custom resource type can be removed from its
column heading through the `materials.resource-type.archive` writer, which
refuses built-in types and any type that still has an unarchived list in any
project; the record is retired, not deleted, so its id is never reused.
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

Pane weights are relative. `project-layout.js` rescales them to average 1 on every arrangement, so a layout restored with normalized weights or a dragged divider never leaves free space; when the last docked pane closes (its X, Close pane in the tab menu, a single-pane layout, the docked document closing, or `clear()`), the remaining pane drops its inline flex and ratio and fills the window. Splitting again starts even.

Projects and Contacts share the [entity window shell](window-shell.md). Its optional persistent sidebar is declared by Contacts; Projects declare none and keep the content ownership above.

## Overview entry workflows and project trays

The Operations Measurements view starts with **No measurements.** when there is
no report or entered dataset. **Order measurement report** enters the same
configured FirstMeasure order session as Overview, preserving the project and
asking for its address when missing; it does not submit an order. Overview keeps
its entry point. **Add measurements manually** opens the existing schema-based
editor; a project without measurement schemas explains that a scope is needed.
Existing manual values open in the editor, and completed reports keep their model.

The project's main Documents gallery also lists the delivered Customer Roof
Report, Roof Measurement Report and Roof Report XML. These are file references,
not new document instances. It uses Reports' asset resolution and release-hold
handling, replacing older PDF references by identity rather than duplicating
them. The default gallery density is Loose (large tiles); an explicit choice is
remembered for the current organization and user in this browser.

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
section dividers. Actions follow the address/type fields; custom fields are in the
right-hand panel and in the header dropdown after the address. Overview project-field autosave is independent of proposal document
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

### Phone trays

On a phone (the window manager's `data-window-mobile`, else a 760px top-window
query) the header has no tray control. The same tray buttons, from the same
`definitions()` list (so a module's `register()`ed tray is there too), move
into a footer bar along the bottom of the project window, under the app and
any bar it draws at its bottom (Take photos), with an icon and a small label
each; the open tray's button is highlighted. Every tray but the Agent opens as
a bottom sheet over the app, above the footer: about 62% of the content height,
a drag handle (also a button that toggles full height), dragged up to grow or
down to close, closed by its ×, Escape or a tap on the dimmed app, one at a
time. Closing slides the sheet away with its content in place. The Agent is the
compact input bar described in [global assistant architecture](global-assistant.md#project-tray-session-lifetime).
The content sets `--fm-safe-bottom: 0px` while the footer is shown, so bars
inside it (the Take photos bar, the agent composer) leave the device's bottom
inset to the footer. Desktop keeps the header icons and right-hand trays.
Test: `tests/project-trays-footer-browser.test.mjs`.

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
