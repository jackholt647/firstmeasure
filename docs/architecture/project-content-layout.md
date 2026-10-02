# Project window content ownership

The project window owns the title, tabs, display controls, and split-pane lifetime. It does not provide a shared mutable left column.

Overview (`map`) owns the project-details form inside its `.r-tab-content`, beside its map/overview content. Contacts, address, custom fields, notes and existing report-order controls remain in this form. Project identity and tags/stages appear in the window header. Its identity dropdown presents a synchronized second view with unique IDs while the original controls stay mounted in Overview. Edits and actions route through the original handlers; structural changes and field values reconcile into the dropdown without replacing focused inputs. The dropdown address autocomplete uses the same map domain operations. This does not introduce a shared content rail.

`firstmeasure/order/app.js` supplies the Overview details component. Its definition is `overview_details`, not a general modal region app. The form stays mounted across tab changes and panel rebuilds to preserve values, handlers and drafts. A hidden storage element retains the form only while its Overview panel is being rebuilt or unavailable; it is not an app mounting surface.

Scope, Money, Scheduling and legacy Proposals receive a private `.r-tab-sidebar` beneath their own tab panel. Their main renderer receives `.r-tab-main`; their context's `sidebarRoot` is confined to that same tab. These apps cannot replace Overview's details or another tab's rail. Ordinary tab switching and docked tabs use the same content layout.

Removed contracts: `project_modal_region_app`, the dynamic left-region registry/mounting pipeline, `leftRegionRoot`, `setLeftColumnOverride`, `isLeftColumnOverridden`, and `projectModal.left`/`leftMode` interpretation. The window layout helper no longer has a shared-sidebar rollback flag or visibility callback. New apps must render their layout within their tab content rather than add shell regions or revive these contracts.

Each docked tab still has its own owned document for legacy app isolation. Realtime transport is shared with its owning portal; do not introduce another independent stream per pane.

Projects and Contacts share the [entity window shell](window-shell.md). Its optional persistent sidebar is declared by Contacts; Projects declare none and keep the content ownership above.

## Overview entry workflows and project trays

Overview also owns the focused New Report project picker and the map-first New Project
form. The same mounted details form provides contacts, address, property type, custom
fields, and initial actions; the project header presents a larger New Report heading
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
