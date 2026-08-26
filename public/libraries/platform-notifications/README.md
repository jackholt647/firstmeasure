# Platform Notifications Library

`libraries/platform-notifications/platform-notifications.js` is the browser helper for `/v1/platform` notifications. Load it after `libraries/platform-api/platform-api.js`.

The backend owns notification records and per-user state. Frontend code should not write `user.notification_state` directly.

## Core Calls

```js
await PlatformNotifications.load(orgId, { branchId });
await PlatformNotifications.markSeen(orgId, notificationId);
await PlatformNotifications.dismiss(orgId, notificationId);
await PlatformNotifications.complete(orgId, notificationId);
```

`subscribe(fn)` receives `{ notifications, unread_count, active_count, loaded_at }` whenever the local cache refreshes.

## Notification Shape

Notification records live in the Platform `notifications` collection:

- `target_user_ids`: users who can see it.
- `target_role_ids`: roles who can see it.
- `manual_dismissible`: whether the UI can dismiss it.
- `push`: push delivery intent. For now push logs only to `push_log`.
- `passive`: shown in the branch app bell/dropdown.
- `expires_at`: optional ISO timestamp after which no user sees it.

Per-user state is stored on the user document under `notification_state.{notificationId}` with `seen_at`, `dismissed_at`, and `completed_at`.
