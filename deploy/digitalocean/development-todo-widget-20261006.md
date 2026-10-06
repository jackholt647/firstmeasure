# Live to-do widget in agent chat — October 6, 2026

Source: `b9855b5c8417822871a685b38d3bc34f8fc13a35` with refresh-denial
cleanup in `2280d3b2cd699d96f609a946059875e29f619501`.

The previous screenshot matches the assistant's generic visualization-table
renderer. The shared widget catalog had no registered to-do widget. The new
`todos.list` version 1 is discoverable by all agents using the shared platform
tools; instructions prefer it when a user asks to show a task/to-do list.
Organization targets show personal cross-project tasks; project targets show
project tasks. Saved table panels remain historical snapshots.

The compact live renderer uses `todos.items`, `work.todos.patch` and
`work.todos.transition`. It adds due-date color and text, priority badges,
project context, search, open/completed/all filters, completion/reopening,
and title/description/date/priority editing. Failed writes show an error;
denied refreshes clear rows and the editor. Writes use existing permissions,
CSRF and fresh idempotency keys. Opening a widget is read-only.

Validation: `npm run check` passes. Widget publication and to-do publication
tests: four pass, including shared agent discovery, organization-target
presentation and restricted-agent denial. Chrome widget tests pass for mutations,
reopen, receipt keys, editing, search, date-only preservation, denial, teardown
and a 390px viewport. The existing assistant widget-placement browser test also
passes. Desktop and mobile fixtures were visually reviewed under
`output/todo-widget-20261006/`; these are test fixtures, not screenshots of a
signed-in live organization. Agent behavior is validated by integration tests;
a live LLM conversation was not exercised.

Deployment evidence is under `output/todo-widget-20261006/` and
`output/todo-widget-refresh-20261006/`. Payloads are task-only overlays on each
role's actual live baseline. The worker's older widget catalog receives only
the new to-do definition; unrelated Forms entries are not imported. The
compatibility runtime retains its existing presentation implementation while
the catalog cache key is updated. No dependency, database or topology change
is required. Previous immutable releases remain available for rollback.

Final verification: worker on `b9855b5c`, compatibility and pool on `2280d3b2`,
and web on concurrent native-camera release `c92852b2`, which preserves all
widget files. The verifier checked five worker files and eight files on each
serving role, plus readiness and development isolation. Public widget JS matched
the committed source, the public catalog contained `todos.list`, and public
readiness returned the ready development release. Role evidence is in
`verified-final.json`; public evidence is in `public-final.json`.

Readiness gates and public probes briefly returned 503 during service restarts
and the concurrent native-camera rollout. Gated operations were retried after
readiness recovered. A duplicate pool activation observed a service restart in
progress and stopped; the independent activation and final verification passed.
Public probes expecting only the task release were superseded by verification
of actual current files and readiness after the web advanced to `c92852b2`.
Development is activated; production was not changed.
