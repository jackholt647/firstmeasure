# Development project To Do tray

Release: `3eec6a5f7a2f8a3e09669b3dbb8646fe79e07b5c`.

Adds To Do immediately after Notes in the project tray registry, before Activity. Uses `PlatformActionItems.renderTodayList`, the same renderer as the global and existing per-project list, with project ID filtering, upcoming/future sections, completed section, and existing task controls. Suppresses the legacy project to-do dock while the tray is available. New unsaved projects show a placeholder without unscoped task queries. Reopening refreshes the shared list; changing projects disposes the previous controller. Registry-backed default-tray settings and provisional headers discover the new entry automatically.

Validation: 14 targeted browser/behavior checks passed, including the real shared renderer with project-filtered API requests, refresh, draft acquisition, project switching, Notes draft preservation and opening headers.

Deployed and verified on development web, pool and compatibility roles. Live browser verification showed Notes, To Do, Activity, Agent in order and the existing project task list with future/completed sections. Payload preserves each development role's existing source and backend; only project trays, project-request and bundle-version manifest are overlaid. Legacy tray merge retains its existing agent mount behavior. No production or configuration changes.
