# To-dos and agent publication

Work plans and nodes own to-dos. Project trays, the personal global list, sales
follow-ups and the header tray all consume the same records; they do not own
independent copies. The older Platform action-items API remains a compatibility
adapter. Personal display state belongs to the organization user.

## Published data and operations

`todos.items` supports organization and project targets. Organization reads are
the authenticated caller's assignment view; `includeAll` deliberately requests
all assignments with the existing `view_projects` management permission. Project
and branch filters, completed/canceled/future/hidden filters, contact, kind, status
and due-date filters are discoverable. Records include title, description, dates,
priority, assignments, parent identity, notes, follow-up data and the
caller's display state. Read `work.plan.read` with the plan identity for dependency and workflow structure.
Internal automation context is not exported. Bounded
pages use cursors tied to the caller, source and current result. Frozen reads
recheck the caller and current record visibility.

Actions callable through API, agents, modules and authenticated Work contexts:

- `work.todos.list`, `work.todos.read`, `work.todos.history`
- `work.todos.create`, `work.todos.patch`, `work.todos.transition`
- `work.todos.userState`
- `work.followUps.outcome`
- `work.configuration.read`, `work.configuration.save`

Creation shares `work/todos.ts` with the Work HTTP route. Editing and transitions
reuse Work schemas and services; due dates retain the exact requested timestamp.
Mutations require publication receipts. Creation derives a unique task identity
from its receipt, allowing multiple tasks of one kind on the same project.
Resource operations authorize the current caller and project before receipt
replay. Caller display-state writes cannot name another user. Setting seen,
hidden or dismissed to false clears that personal mark.

Read operations require `view_projects`; domain edits and follow-up outcomes
require `manage_projects`. Branch configuration writes require
`manage_company_settings`. Personal state requires authenticated record visibility.
The assistant's project-data scope restriction also covers `todos.items`; disabling
project data denies its discovery and reads. These permissions do not extend
human or autonomous agent authority. Autonomous
system grants without a human principal do not inherit this personal surface;
`work.createTodo.v1` remains available to the trusted Work engine.

Follow-ups keep their configured outcome requirements. Rescheduling creates a
successor through the existing cadence service; scheduled outcomes still require
an actual project appointment. The published outcome does not accept an override
that fabricates appointment completion.

## Global header tray

`topbar.todos` is an independent feature under Top Bar, defaulting on. Disabling
it closes the tray and hides the header/mobile controls; the left-column setting
is independent. `platform-action-items/todo-tray.js` mounts the same shared list
inside the standard dockable window manager, initially at the right. It supports
placement, mobile sizing, project context, completed and future sections. The
content has 12px padding; Close hides the tray and its header control reopens it,
so the minimize button is hidden. Navigation retains the list; branch changes rebuild it with the
new identity. Only an open tray refreshes on focus, task edits and a 30-second
interval. It does not create a second task store or an agent-specific tool list.

Validation: `tests/todo-publication.test.ts`, `tests/todo-tray-browser.test.mjs`,
`tests/project-todo-tray.test.mjs`, `npm run test:publication`, `npm run check`,
and the registered `todos.list` widget's `tests/todo-widgets-browser.test.mjs`.

## Agent to-do widget

`todos.list` version 1 is a registered content-sized widget for assistant,
project and dashboard surfaces. An organization target displays the caller's
cross-project tasks; a project target displays that project's tasks. The compact
renderer in `platform-widgets/todo-widgets.js` reads `todos.items` afresh and uses
receipt-backed `work.todos.patch` and `work.todos.transition` for user edits.
It displays overdue/today/upcoming colors with text labels, priority badges,
project context, search and open/completed/all filters. Clicking a title opens
the title/description/due-date/priority editor; completion controls also reopen
tasks. Errors retain failed edits without falsely reporting success, and a denied
refresh removes prior task rows. Mount teardown removes refresh listeners.

Shared agent instructions prefer this widget to static visualization tables.
The catalog declares its provider so discovery and presentation honor the
assistant's project-data restriction. The browser uses current session and CSRF
authorization for each read/write. Legacy table panels remain immutable chat
snapshots and are not automatically rewritten as live task widgets.
