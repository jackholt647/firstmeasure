# Platform Action Items Browser Helper

`libraries/platform-action-items/platform-action-items.js` is the reusable browser helper for `/v1/platform` action items. Load it after `libraries/platform-api/platform-api.js`.

The Work API owns the canonical node records, assignment, status, and history. The Platform routes adapt those nodes to this older client shape, while per-user display state remains on the org user record. Frontend code registers kind handlers that decide what clicking an item does.

```js
PlatformActionItems.registerKind('schedule_sold_project', {
  label: 'Schedule project',
  open(item) {
    return ProjectModal.open(item.project_ids[0], { tab: 'scheduling' });
  }
});
```

Core helpers:

- `load(orgId, options)`: loads visible action items for the logged-in user.
- `subscribe(fn)`: receives `{ action_items, active_count, unread_count, overdue_count, loaded_at }`.
- `create(orgId, item)`: creates a manual or library-generated item.
- `claim`, `complete`, `cancel`: status transitions.
- `markSeen`, `hide`, `dismiss`, `pin`, `snooze`: per-user UI state.
- `open(item, context)`: calls the registered frontend handler for the item kind or `frontend_action.kind`.

Backend nodes are org-scoped and are queried by assignment. A blank assignment means any user in the organization can fulfill the item. New code may use `PlatformAPI.work` directly; this helper remains useful for the shared to-do UI and older feature modules.
