# Platform Celebrations Library

Browser-only effects for small/large celebration moments.

Load in Platform before `platform-notifications.js`:

```html
<script src="../libraries/platform-celebrations/platform-celebrations.js"></script>
```

API:

- `PlatformCelebrations.loadConfig(orgId, branchId)` reads branch module `project_configuration`.
- `PlatformCelebrations.configure({ mode })` sets `mode`: `on`, `small_only`, or `off`.
- `PlatformCelebrations.celebrate('small' | 'large', { force, text })` plays the effect. `force: true` ignores branch settings for settings-page previews. `text` shows a centered toast explaining why the celebration happened.
- `PlatformCelebrations.indicator()` plays the short notification indicator sound. Platform notifications use this when a new visible notification arrives.
- `PlatformCelebrations.fromNotification(notification)` reads `notification.celebration.size` or `notification.context.celebration.size`.

Workflow:

- Backend triggers create lightweight `kind: "celebration"` notifications. Include `celebration.text` when the user should see why the effect fired, for example `"Bill's job was just sold."`.
- `platform-notifications.js` consumes those notifications, calls `PlatformCelebrations.fromNotification()`, marks them completed, and hides them from the visible bell list.
- Default branch behavior is `mode: "on"`. `small_only` demotes large effects to small. `off` suppresses all trigger-driven celebrations.
