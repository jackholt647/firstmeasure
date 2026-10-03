# Activity multi-select filters — October 3, 2026

Source release: `ed1ab8d3c2c75118251bf9b45008a6c626c8fe93`.
Target: `https://dev.1m8.ai`, existing development frontend roles.

Replaces the native Activity select with a custom searchable checkbox dropdown.
Users can combine types, use a row's **Only** action to select one, or restore
**All activity**. Clearing the last selected type restores all activity. Counts
reflect loaded events matching the timeline search; categories combine with OR
and the text search combines with AND. Selections survive refresh and tray
switches within the mounted widget.

The thirteen groups are project changes, to-dos, notes, scheduling, reports and
measurements, files and photos, documents and signatures, scope and materials,
payments and billing, contacts and people, calls and communications, workflow
and stages, and field work and checklists. Existing audience/note visibility
rules and authenticated APIs remain unchanged.

The dropdown supports Tab/Space, ArrowDown opening, Escape with focus return,
outside dismissal, scrolling within the available tray height and independent
widget instances. Hiding or destroying a widget closes its menu and releases
its observer/document listener.

Validation: three focused browser tests passed (expanded Activity coverage,
real tray draft preservation and Agent voice/pin/transfer), plus the assembled
compatibility Activity test. Coverage includes combined selections, Only,
clear-all, category search, keyboard/focus behavior, persistence, mobile bounds,
loaded-page retention, refresh errors and cleanup. Desktop layout was inspected.

Only project-trays.js and its manifest version are overlaid. Each immutable
package preserves its role's existing source baseline. Evidence, hashes,
packages and scripts are in ignored `output/activity-filters-20261003/`.

All three frontend roles activated and passed release identity, source hashes,
readiness and enforced development-isolation checks. Both public assets matched
the package hashes. The served-component browser test also passed with mocked
domain APIs. The previous release is
`f4102a7a867947b6b3d9b28f8f0cec0f9e4e702f` on all three frontend roles. Rollback
restores each recorded `previous_path`, restarts its development service and
reloads PHP, then verifies readiness and outbound isolation. No backend, worker,
configuration, database or production changes are included.
